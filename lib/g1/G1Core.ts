/**
 * G1Core.ts — BLE connection manager for Even Realities G1 glasses.
 * Manages both lenses (L + R), heartbeat, ACK sequencing, and event callbacks.
 * Port of g1core/core.py (EvenBridge).
 */

import { BleManager, Device, State, Characteristic, Subscription, BleError, BleErrorCode } from 'react-native-ble-plx';
import { encode as btoa } from 'base-64';
import * as P from './packets';

// ── Types ──────────────────────────────────────────────────────────────────

export type Side = 'L' | 'R';

export interface LensState {
  device: Device | null;
  connected: boolean;
  /** TX characteristic was discovered — lens is actually usable, not just OS-connected */
  txReady: boolean;
  /**
   * Link is up and the firmware answers control opcodes, but the last OP_TEXT
   * went un-ACKed. The master lens defers the 0x4e ACK to its display thread
   * (ble_process_req_dispatch.c:316 → display_dispatch_thread.c:703), so this
   * means "display pipeline not rendering" (glasses in case / asleep) — NOT a
   * BLE fault. Cleared on the next text ACK or on (re)connect. See #26.
   */
  displayIdle: boolean;
  /**
   * BLE link is up but the firmware is not responding at all (no 0x03 ACK, no
   * events). Glasses are in the case / powered down. We hold the connection
   * and wait for the first unsolicited frame instead of reconnect-looping. #27
   */
  asleep: boolean;
  batteryPct: number | null;
  rssi: number | null;
}

export interface G1Status {
  left: LensState;
  right: LensState;
  firmwareVersion: string | null;
}

export type EventHandler = (event: P.G1Event) => void;
export type StatusHandler = (status: G1Status) => void;

// ── Constants ──────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 8_000;
const SCAN_TIMEOUT_MS = 12_000;
// Faster cap — 30 s is too long during a live session. Keeps retrying at 10 s.
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

function uint8ToBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ── G1Core ─────────────────────────────────────────────────────────────────

export class G1Core {
  private manager: BleManager;
  private devices: Partial<Record<Side, Device>> = {};
  private txChars: Partial<Record<Side, Characteristic>> = {};
  private rxSubs: Partial<Record<Side, Subscription>> = {};
  private seq = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts: Partial<Record<Side, number>> = { L: 0, R: 0 };
  private destroyed = false;
  /** Mutex: if a connect/scan is already in flight, callers share the same promise. */
  private _connectingPromise: Promise<void> | null = null;
  /**
   * Single-slot send queue for user-visible sends (sendText, sendBmp).
   * If a new frame arrives while a previous one is still in-flight, we
   * discard the in-flight and send only the latest — same behaviour as the
   * official app's "cancel stale" pattern. This prevents the queue from
   * growing unboundedly during rapid scrolling while still ensuring every
   * frame eventually reaches the glasses (the last one always wins).
   *
   * Implemented as a tail-swap: _nextSend holds the most recent pending
   * frame; _sendQueue is the in-flight chain. Callers await _sendQueue
   * being free then execute.
   */
  private _sendQueue: Promise<void> = Promise.resolve();
  private _nextSendResolve: (() => void) | null = null;
  /**
   * Per-side connect queues. Each side serialises its own _connectLens calls
   * independently. A shared queue meant R's reconnect blocked on L's (and
   * vice-versa), producing paired reconnect storms. iOS BLE does not require
   * that L and R connects be serialised against each other — only that we
   * don't issue two connects to the *same* peripheral concurrently.
   */
  private _connectQueue: Record<Side, Promise<void>> = { L: Promise.resolve(), R: Promise.resolve() };
  /**
   * True while a _connectLens call is actively executing for that side.
   * Used to gate _scheduleReconnect / reconnectSide so a burst of reconnect
   * requests doesn't pile up a queue of redundant attempts behind an in-flight
   * connection.
   */
  private _connectingOnSide: Record<Side, boolean> = { L: false, R: false };

  /** True while any _connectLens call is actively executing. Surfaced to G1Context. */
  get isReconnecting(): boolean {
    return this._connectingOnSide.L || this._connectingOnSide.R;
  }
  /** Timestamp of the last reconnectSide() call per side — used to debounce UI taps. */
  private _lastReconnectSideAt: Record<Side, number> = { L: 0, R: 0 };
  private static readonly RECONNECT_SIDE_DEBOUNCE_MS = 1500;
  /**
   * Generation counter per side. Incremented each time _connectLens runs.
   * The onDisconnected closure captures its generation at creation time and
   * no-ops if a newer connection has since replaced it — prevents stale
   * disconnect handlers from corrupting a healthy reconnected session.
   */
  private _connGen: Record<Side, number> = { L: 0, R: 0 };
  /** Pending reconnect timeout handles — cancelled on disconnect/destroy. */
  private _reconnectTimers: Partial<Record<Side, ReturnType<typeof setTimeout>>> = {};
  /**
   * The pair we are bound to. `_pairedSerial` is the mfr-data serial
   * ("H290036"); `_pairedIds` are the CoreBluetooth peripheral UUIDs learned
   * the first time each side connects with mfr data verifying the serial.
   * iOS connectedDevices() and some resume paths return devices WITHOUT mfr
   * data, so the ids are the only way to tell G1_30 from G1_5 there. Every
   * device-selection path (scan, resume, targeted reconnect scan) must go
   * through _matchesPair — with two pairs in range, an unfiltered path
   * connects one lens from each set.
   */
  private _pairedSerial: string | null = null;
  private _pairedIds: Partial<Record<Side, string>> = {};
  /** Lens peripheral ids verified against the paired serial. Persist these. */
  get pairedIds(): Partial<Record<Side, string>> { return { ...this._pairedIds }; }
  /**
   * Timestamp (ms) of the last silent(true) send per side, used to rate-limit
   * connection_error re-silences and avoid a re-silence storm.
   */
  private _lastSilentAt: Record<Side, number> = { L: 0, R: 0 };
  /**
   * Timestamp (ms) of the last received OP_SILENT (0x03) ACK from the glass,
   * per side. If a successful ACK arrived within the last SILENT_ACK_REUSE_MS,
   * _connectLens skips the 12-second _sendForResult wait (the glass already
   * accepted silent mode and won't send another 0x03 ACK for the same power-on).
   */
  private _lastSilentAckAt: Record<Side, number> = { L: 0, R: 0 };
  private static readonly SILENT_ACK_REUSE_MS = 60_000;
  /**
   * Consecutive OP_TEXT NACK counter per side — telemetry only. Reset to 0 on
   * any successful text ACK or on connect.
   *
   * #24: this used to force _onDisconnected at threshold=1. That flapped R
   * every 27 s (38×/session), dropped 2 queued lines per cycle, and recovered
   * 0 times — because an un-ACKed 0x4e is a display-thread state, not a link
   * fault (see LensState.displayIdle). We now surface it instead.
   */
  private _textNackCount: Record<Side, number> = { L: 0, R: 0 };
  /**
   * #27: resolver for "first RX frame from this side", armed while a lens is
   * asleep during init. Resolved by _onNotify (wake) or _onDisconnected (abort).
   */
  private _wakeWaiters: Record<Side, (() => void) | undefined> = { L: undefined, R: undefined };
  /**
   * Pending ACK resolvers. Key = "<side><opcode_hex>" (e.g. "L4e", "R15").
   * The firmware echoes the command opcode in data[0] and puts the status in
   * data[1] (0xC9 or 0xCB = ok). The key must include the opcode so concurrent
   * sends on different opcodes (e.g. heartbeat and battery) don't clobber each
   * other's resolvers. We register BEFORE the write to avoid a race on fast ACK.
   */
  private _pendingAck: Map<string, {
    resolve: (ok: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();

  public status: G1Status = {
    left:  { device: null, connected: false, txReady: false, displayIdle: false, asleep: false, batteryPct: null, rssi: null },
    right: { device: null, connected: false, txReady: false, displayIdle: false, asleep: false, batteryPct: null, rssi: null },
    firmwareVersion: null,
  };

  private eventHandlers = new Set<EventHandler>();
  private onStatusChange?: StatusHandler;
  private onLog?: (line: string) => void;

  /** When true, raw RX frames and routine heartbeat events are included in the log.
   *  Off by default — these account for ~55% of log lines and push lifecycle
   *  events out of the ring buffer before they can be captured. */
  public verbose = false;

  constructor(opts?: { onEvent?: EventHandler; onStatusChange?: StatusHandler; onLog?: (line: string) => void }) {
    this.manager = new BleManager();
    if (opts?.onEvent) this.eventHandlers.add(opts.onEvent);
    this.onStatusChange = opts?.onStatusChange;
    this.onLog = opts?.onLog;
  }

  addEventHandler(h: EventHandler): void    { this.eventHandlers.add(h); }
  removeEventHandler(h: EventHandler): void { this.eventHandlers.delete(h); }
  setStatusCallback(cb: StatusHandler): void { this.onStatusChange = cb; }
  setLogCallback(cb: (line: string) => void): void { this.onLog = cb; }

  private _log(...args: unknown[]): void {
    const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    console.log(line);
    this.onLog?.(line);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Start a continuous BLE scan for G1 pairs, calling `onUpdate` each time a
   * new lens is discovered. Call `stopStreamingScan()` to stop.
   * Safe to call when BLE is not yet ready — waits internally.
   */
  async startStreamingScan(
    onUpdate: (pairs: Record<string, Partial<Record<Side, Device>> & { serial?: string; firmware?: string }>) => void,
  ): Promise<void> {
    const pairs: Record<string, Partial<Record<Side, Device>> & { serial?: string; firmware?: string }> = {};
    await this._ensureBleReady();
    this.manager.startDeviceScan(
      null,
      { allowDuplicates: true },
      (_err, device) => {
        if (!device?.name?.includes('G1')) return;
        const parsed = this._parseManufacturerData(device);
        if (!parsed) return;
        const { side, serial, firmware } = parsed;
        if (!pairs[serial]) pairs[serial] = { serial, firmware };
        pairs[serial][side] = device;
        onUpdate({ ...pairs });
      },
    );
  }

  /** Stop a streaming scan started with `startStreamingScan`. */
  stopStreamingScan(): void {
    this.manager.stopDeviceScan();
  }

  /** Scan and return all discovered pairs (channel → {L,R} device). */
  async scanPairs(durationMs = 8000): Promise<Record<string, Partial<Record<Side, Device>>>> {
    await this._ensureBleReady();
    return new Promise((resolve) => {
      const pairs: Record<string, Partial<Record<Side, Device>>> = {};
      const timeout = setTimeout(() => {
        this.manager.stopDeviceScan();
        resolve(pairs);
      }, durationMs);

      this.manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
        if (error || !device?.name) return;
        const side = this._parseSide(device);
        if (!side) return;
        const ch = this._parseChannel(device);
        if (!ch) return;
        if (!pairs[ch]) pairs[ch] = {};
        pairs[ch][side] = device;
        // Resolve early if we have 2+ complete pairs
        const complete = Object.values(pairs).filter(p => p.L && p.R).length;
        if (complete >= 2) { clearTimeout(timeout); this.manager.stopDeviceScan(); resolve(pairs); }
      });
    });
  }

  async connect(channel?: string, knownIds?: Partial<Record<Side, string>>): Promise<void> {
    // Bind to the requested pair before any device selection runs.
    if (channel && channel !== this._pairedSerial) {
      this._pairedSerial = channel;
      this._pairedIds = {};
    }
    if (knownIds) this._pairedIds = { ...this._pairedIds, ...knownIds };
    // If already connected, nothing to do.
    if (this.isConnected) return;

    // If a connection attempt is already in flight, share it instead of
    // starting a second scan (which would cancel the first and throw
    // "Operation was cancelled").
    if (this._connectingPromise) {
      return this._connectingPromise;
    }

    this._connectingPromise = (async () => {
      try {
        await this._ensureBleReady();
        const resumed = await this._resumeAlreadyConnected(channel);
        if (!resumed) await this._scan(channel);
      } finally {
        this._connectingPromise = null;
      }
    })();

    return this._connectingPromise;
  }

  /**
   * Immediately attempt to reconnect any dropped lens without waiting for the
   * next backoff tick. Resets the backoff counter so the next auto-attempt also
   * starts from the short end. Safe to call when already fully connected.
   */
  async reconnectDropped(): Promise<void> {
    if (this.destroyed) return;
    for (const side of ['L', 'R'] as Side[]) {
      if (this.status[side === 'L' ? 'left' : 'right'].connected) continue;
      const dev = this.devices[side];
      if (!dev) continue;
      this.reconnectAttempts[side] = 0; // reset backoff
      this._enqueueConnect(side, dev);
    }
  }

  async disconnect(): Promise<void> {
    this._connectingPromise = null;
    this._connectQueue = { L: Promise.resolve(), R: Promise.resolve() };
    this._stopHeartbeat();
    clearTimeout(this._reconnectTimers.L); this._reconnectTimers.L = undefined;
    clearTimeout(this._reconnectTimers.R); this._reconnectTimers.R = undefined;
    for (const side of ['L', 'R'] as Side[]) {
      this.rxSubs[side]?.remove();
      this.rxSubs[side] = undefined;
      const dev = this.devices[side];
      if (dev) {
        try { await dev.cancelConnection(); } catch {}
      }
      this.devices[side] = undefined;
      this.txChars[side] = undefined;
      this.reconnectAttempts[side] = 0;
      this._lastSilentAckAt[side] = 0;
      this._setConnected(side, false);
    }
  }

  /**
   * "Power off" — the G1 has no off state (firmware decomp has no power-down
   * path in the BLE dispatcher; only the case stops it). Silent mode ON
   * (03 0C) suspends the display thread and drops to standby, which is the
   * closest thing. Send to both arms, then disconnect so we don't immediately
   * wake them back up with a reconnect-init silent(false).
   */
  async powerOff(): Promise<void> {
    const sides = (['L', 'R'] as Side[]).filter(s => this.txChars[s]);
    await Promise.allSettled(sides.map(s => this._send(s, P.silent(true))));
    await this.disconnect();
  }

  /**
   * Disconnect a single lens and stop any pending reconnect timer for it.
   * The other lens is left untouched. Does NOT reset pairedSerial — a
   * subsequent reconnectSide() call will re-scan and reconnect just that side.
   */
  async disconnectSide(side: Side): Promise<void> {
    this._log(`[G1] disconnectSide [${side}] — user-initiated`);
    clearTimeout(this._reconnectTimers[side]);
    this._reconnectTimers[side] = undefined;
    this._connectQueue[side] = Promise.resolve(); // flush any queued attempts
    this.rxSubs[side]?.remove();
    this.rxSubs[side] = undefined;
    const dev = this.devices[side];
    if (dev) {
      try { await dev.cancelConnection(); } catch {}
    }
    this.devices[side] = undefined;
    this.txChars[side] = undefined;
    this.reconnectAttempts[side] = 0;
    this._lastSilentAckAt[side] = 0; // force full silent handshake on next connect
    this._setConnected(side, false);
  }

  /**
   * Reconnect a single lens. Resets backoff and immediately schedules a
   * _connectLens attempt for this side only. The other lens is unaffected.
   * Requires a prior connect() call to have set the paired serial so the
   * reconnect scan knows what device to look for.
   */
  reconnectSide(side: Side): void {
    // Debounce: ignore taps within RECONNECT_SIDE_DEBOUNCE_MS of the last call.
    const now = Date.now();
    if (now - this._lastReconnectSideAt[side] < G1Core.RECONNECT_SIDE_DEBOUNCE_MS) {
      this._log(`[G1] reconnectSide [${side}] — debounced (too soon)`);
      return;
    }
    this._lastReconnectSideAt[side] = now;

    // In-flight guard: if _connectLens is already executing for this side,
    // there's nothing to add — the running attempt will either succeed or
    // call _scheduleReconnect itself on failure.
    if (this._connectingOnSide[side]) {
      this._log(`[G1] reconnectSide [${side}] — already connecting, ignored`);
      return;
    }

    this._log(`[G1] reconnectSide [${side}] — user-initiated`);
    clearTimeout(this._reconnectTimers[side]);
    this._reconnectTimers[side] = undefined;
    this.reconnectAttempts[side] = 0; // reset backoff so it tries immediately
    this._scheduleReconnect(side);
  }

  /** Both lenses OS-connected AND UART TX characteristic discovered (actually usable). */
  get isConnected(): boolean {
    return !!(this.status.left.txReady && this.status.right.txReady);
  }

  /** OS reports connected but TX not ready — partial/half-bonded state. */
  get isPartiallyConnected(): boolean {
    const l = this.status.left; const r = this.status.right;
    return (l.connected || r.connected) && !this.isConnected;
  }

  /**
   * Enqueue a user-visible send (sendText / sendBmp).
   *
   * Uses a "latest wins" strategy: if a send is already in-flight and a new
   * one arrives, we don't cancel the in-flight (BLE can't abort mid-write)
   * but we do discard any queued-but-not-yet-started work and replace it
   * with the new task. This keeps the glasses showing the most recent frame
   * without letting the queue grow unboundedly during rapid scrolling.
   */
  private _enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this._sendQueue.then(() => fn()).catch((e) => {
      // Log real errors; swallow only disconnect noise.
      const code = (e as BleError)?.errorCode;
      if (code !== BleErrorCode.DeviceDisconnected && code !== BleErrorCode.OperationCancelled) {
        this._log('[G1] send error:', e?.message ?? e);
      }
    });
    this._sendQueue = run;
    return run;
  }

  /**
   * Send a text string to both lenses.
   * curLine / totalLines populate the status bar counter (e.g. "▶ 2/14").
   *
   * Screen byte defaults to NewScreen.MANUAL (0x51) — see note in the body.
   * Pass newScreen explicitly to override.
   */
  async sendText(
    str: string,
    curLine = 1,
    totalLines = 1,
    isLastPage = false,
    newScreen?: P.NewScreenValue,
  ): Promise<void> {
    // Default TEXT (0x71) — the byte the official text_service.dart uses.
    // 0x41/0x51 are Even AI session bytes; without an open AI session the
    // firmware stores the frame but never switches to it, then emits F5 00
    // ("exit to dashboard") once a second — which we were decoding as
    // double-tap and rewinding the script. See NewScreen in packets.ts.
    // isLastPage is kept for callers but no longer selects the screen byte.
    void isLastPage;
    const ns = newScreen ?? P.NewScreen.TEXT;
    return this._enqueue(async () => {
      const packet = P.text(str, this._nextSeq(), curLine, totalLines, ns);
      await this._sendBoth(packet);
    });
  }

  /**
   * Send a pre-rendered 1-bit BMP frame to both lenses.
   *
   * Matches EvenDemoApp's requestList behaviour (verified from source):
   *   - L and R receive each packet IN PARALLEL (not sequential) — the
   *     firmware handles each side independently; sequential L→R doubles
   *     the BMP transfer time with no correctness benefit.
   *   - Intermediate data chunks: fire-and-forget (awaitAck=false) to
   *     keep throughput high.
   *   - Final packet (bmpEnd): awaits ACK on both sides so callers know
   *     the frame is committed before sending the next one.
   *   - writeCharacteristicWithResponse on every packet still provides
   *     OS-level flow control even without the protocol ACK wait.
   */
  async sendBmp(frame: Uint8Array): Promise<void> {
    return this._enqueue(async () => this._sendBmpRaw(frame));
  }

  private async _sendBmpRaw(frame: Uint8Array): Promise<void> {
    const chunks = P.bmpDataChunks(frame);

    // Send all data chunks to L and R in parallel, no ACK wait
    for (const chunk of chunks) {
      await Promise.all([
        this._send('L', chunk, false),
        this._send('R', chunk, false),
      ]);
    }

    // CRC packet — parallel, no ACK
    await Promise.all([
      this._send('L', P.bmpCrc(frame), false),
      this._send('R', P.bmpCrc(frame), false),
    ]);

    // End packet — parallel, AWAIT ACK on both sides
    await Promise.all([
      this._send('L', P.bmpEnd(), true),
      this._send('R', P.bmpEnd(), true),
    ]);
  }

  async setBrightness(level: number, auto = false): Promise<void> {
    await this._sendBoth(P.brightness(level, auto));
  }

  async requestBattery(): Promise<void> {
    await this._sendBoth(P.batteryRequest());
  }

  async exitToDashboard(): Promise<void> {
    await this._sendBoth(P.exitToDashboard());
  }

  /**
   * Send a single-line test message to ONE lens only, showing its battery and
   * RSSI so the user can verify the HUD is alive and the telemetry is correct.
   * Uses the existing send queue so it doesn't race active teleprompter sends.
   */
  async sendTestDisplay(): Promise<void> {
    const fmt = (st: typeof this.status.left, label: string) => {
      const bat  = st.batteryPct != null ? `${st.batteryPct}%` : '--';
      const rssi = st.rssi       != null ? `${st.rssi}dBm`     : '--';
      return `${label} 🔋${bat} 📶${rssi}`;
    };
    const line = `${fmt(this.status.left, 'L:')}  ${fmt(this.status.right, 'R:')}`;
    this._log(`[G1] sendTestDisplay txReady L=${this.status.left.txReady} R=${this.status.right.txReady}`);
    return this._enqueue(async () => {
      // No silent(false) before the text write. The lens already left silent
      // mode in _connectLensInner (that ACK is what gates txReady), and the
      // firmware ACKs 0x03 once per boot, so a second one is unverifiable
      // noise. Per firmware decomp (even-g1-companion docs), 03 0a =
      // exit_silent_mode rewrites the live screen id and resumes the master
      // display thread — not something to fire 0 ms before a 0x4E. The
      // 2026-11-04 "Even AI listening" flash was AUTO_LAST (0x41) handing the
      // surface back to the firmware's Even AI task — TEXT (0x71) is the
      // only byte the firmware renders without an open AI session.
      const packet = P.text(line, this._nextSeq(), 1, 1, P.NewScreen.TEXT);
      await this._sendBoth(packet);
    });
  }

  /**
   * Clear the HUD on ONE lens by sending silent(true) to re-assert Cue ownership,
   * which causes the firmware to blank the display.
   */
  async clearDisplay(side: Side): Promise<void> {
    return this._enqueue(async () => {
      await this._send(side, P.silent(true));
    });
  }

  destroy(): void {
    this.destroyed = true;
    this._stopHeartbeat();
    this._resolveWake('L'); this._resolveWake('R'); // #27: don't leave _connectLensInner parked forever
    clearTimeout(this._reconnectTimers.L); this._reconnectTimers.L = undefined;
    clearTimeout(this._reconnectTimers.R); this._reconnectTimers.R = undefined;
    this.rxSubs.L?.remove();
    this.rxSubs.R?.remove();
    this.manager.destroy();
  }

  // ── Scanning ──────────────────────────────────────────────────────────────

  private async _ensureBleReady(): Promise<void> {
    // iOS prompts for BLE permission automatically on first scan (via Info.plist entries).
    // We just need to wait for the manager to reach PoweredOn state (up to 5s).
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      // sub may be assigned AFTER the callback fires if BLE is already PoweredOn
      // (emitCurrentValue=true fires synchronously). Use a holder so the closure
      // always has a reference regardless of assignment order.
      const holder: { sub?: { remove(): void } } = {};
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        holder.sub?.remove();
        reject(new Error('Bluetooth not powered on — check device settings'));
      }, 5000);
      holder.sub = this.manager.onStateChange((state) => {
        if (state === State.PoweredOn && !settled) {
          settled = true;
          clearTimeout(t);
          holder.sub?.remove();
          resolve();
        }
      }, true);
    });
  }

  // FIXME: stopDeviceScan() is global on the shared BleManager — calling scanPairs/
  // startStreamingScan while connect() is scanning will cancel the pairing scan.
  // Callers must ensure connect() is not in flight before calling these methods.
  /** Scan all BLE devices and return rich debug info per device. */
  async scanDebug(durationMs = 8000): Promise<string[]> {
    await this._ensureBleReady();
    const found: string[] = [];
    const seen = new Set<string>();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.manager.stopDeviceScan();
        resolve(found);
      }, durationMs);
      this.manager.startDeviceScan(null, { allowDuplicates: false }, (_err, device) => {
        if (!device?.name) return;
        if (seen.has(device.id)) return;
        seen.add(device.id);

        const isG1 = device.name.includes('G1');
        const parsed = isG1 ? this._parseManufacturerData(device) : null;
        const info = isG1
          ? {
              name: device.name,
              id: device.id,
              rssi: device.rssi,
              isConnectable: device.isConnectable,
              txPower: device.txPowerLevel,
              serviceUUIDs: device.serviceUUIDs,
              manufacturerData: device.manufacturerData,
              localName: device.localName,
              mtu: device.mtu,
              decoded: parsed,
            }
          : { name: device.name, id: device.id };

        if (isG1) {
          // Also log raw manufacturer bytes for in-case detection research
          if (device.manufacturerData) {
            const buf = base64ToUint8(device.manufacturerData);
            const hex = Array.from(buf).map(b => b.toString(16).padStart(2,'0')).join(' ');
            this._log(`[G1 MFR RAW] ${device.name} bytes[${buf.length}]: ${hex}`);
          }
          this._log('[G1 DEBUG]', JSON.stringify(info, null, 2));
        }
        else       this._log('[BLE DEBUG]', device.name, `[${device.id}]`);

        const entry = isG1
          ? `${device.name} rssi=${device.rssi} connectable=${device.isConnectable}`
          : `${device.name} [${device.id}]`;
        found.push(entry);
      });
    });
  }

  /**
   * Fast-path: if iOS already has both lenses connected at the OS level,
   * skip scanning and go straight to _connectLens (service discovery + handshake).
   * Returns true if both lenses were resumed, false if we need to scan.
   */
  private async _resumeAlreadyConnected(channel?: string): Promise<boolean> {
    try {
      // iOS registers UART service on bonded peripherals asynchronously — one lens
      // may not appear in connectedDevices([UART_SVC]) for several seconds after
      // the other. Logs show R taking >6s; poll up to ~10s (5 × 2s) before giving up.
      const POLL_INTERVAL_MS = 2000;
      const POLL_ATTEMPTS    = 5;

      const parseBatch = (devices: Device[]): { found: Partial<Record<Side, Device>>; unidentified: Device[] } => {
        const found: Partial<Record<Side, Device>> = {};
        const unidentified: Device[] = [];
        for (const device of devices) {
          const side = this._parseSide(device);
          if (!side) {
            if (device.name?.includes('G1') || device.name == null) unidentified.push(device);
            continue;
          }
          // connectedDevices() on iOS carries no mfr data. With two pairs in
          // range (G1_30 + G1_5) the old rule "no mfr data → trust it" is how
          // we ended up with one lens from each set. Only accept a peripheral
          // whose id we've previously verified against the paired serial.
          if (!this._matchesPair(device, side)) {
            this._log(`[G1] _resumeAlreadyConnected: ${device.name ?? device.id} [${side}] is not the paired ${this._pairedSerial} — skipped`);
            continue;
          }
          found[side] = device;
        }
        // Unidentified (nameless) peripherals: only accept by known id.
        for (const s of ['L', 'R'] as Side[]) {
          if (found[s]) continue;
          const idx = unidentified.findIndex(d => d.id === this._pairedIds[s]);
          if (idx >= 0) found[s] = unidentified.splice(idx, 1)[0];
        }
        return { found, unidentified };
      };

      let found: Partial<Record<Side, Device>> = {};
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        const connected = await this.manager.connectedDevices([P.UART_SVC]);
        this._log(`[G1] connectedDevices attempt ${attempt + 1}/${POLL_ATTEMPTS} returned ${connected.length}: ${connected.map(d => `${d.name ?? 'noname'}[${d.id}] mfr=${d.manufacturerData ?? 'null'}`).join(', ')}`);
        const batch = parseBatch(connected);
        // Merge — keep any side already found in a prior attempt.
        found = { ...batch.found, ...found };
        if (found.L && found.R) break;
        this._log(`[G1] _resumeAlreadyConnected attempt ${attempt + 1}: found L=${!!found.L} R=${!!found.R} — ${found.L && found.R ? 'done' : 'waiting'}`);
      }

      if (found.L && found.R) {
        this._log('[G1] Both lenses already connected — skipping scan');
        // _connectFound resolves if ≥1 lens comes up and schedules the other's
        // reconnect itself. A total failure throws → fall through to scan.
        try {
          await this._connectFound(found);
          return true;
        } catch (e: any) {
          this._log(`[G1] _resumeAlreadyConnected failed: ${e?.message ?? e} — falling through to scan`);
          return false;
        }
      }
      if (found.L || found.R) {
        // 2026-11-04 log: R sat in connectedDevices for all 5 polls (10s) while
        // L was absent — we then threw it away and ran a full 12s scan that
        // re-found R and had to redo discovery. Resume the side we have NOW and
        // let _scheduleReconnect's targeted scan pick up the missing side.
        this._log(`[G1] One lens already connected (${found.L ? 'L' : 'R'}) — resuming it, scanning for the other`);
        try {
          await this._connectFound(found);
          return true;
        } catch (e: any) {
          this._log(`[G1] _resumeAlreadyConnected single-side failed: ${e?.message ?? e} — falling through to scan`);
          return false;
        }
      }
    } catch (e: any) {
      console.warn('[G1] _resumeAlreadyConnected failed:', e?.message ?? e);
    }
    return false;
  }

  private async _scan(channel?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void | Promise<void>) => { if (settled) return; settled = true; fn(); };
      const found: Partial<Record<Side, Device>> = {};
      const timeout = setTimeout(() => {
        this.manager.stopDeviceScan();
        done(() => reject(new Error('G1 glasses not found. Make sure they are on and in range.')));
      }, SCAN_TIMEOUT_MS);

      this.manager.startDeviceScan(
        null,
        { allowDuplicates: true },
        async (error, device) => {
          if (error) { clearTimeout(timeout); done(() => reject(error)); return; }
          if (!device?.name) return;

          const side = this._parseSide(device);
          if (!side) return;
          if (found[side]) return;
          if (!this._matchesPair(device, side)) return;
          this._learnPairedId(device, side);

          found[side] = device;

          if (found.L && found.R) {
            // Both lenses found — connect in parallel via per-side queues.
            clearTimeout(timeout);
            this.manager.stopDeviceScan();
            done(() => this._connectFound(found).then(resolve, reject));
          } else {
            // One lens found — give the other a short window to advertise before
            // resolving with one. _connectFound schedules the missing side.
            setTimeout(() => {
              if (settled) return;
              clearTimeout(timeout);
              this.manager.stopDeviceScan();
              done(() => this._connectFound(found).then(resolve, reject));
            }, 1500);
          }
        },
      );
    });
  }

  /**
   * Decode G1 manufacturer advertisement data.
   * Format: [side(1)] [S] [firmware(6)] [serial(7)] [padding(5)]
   *   side: 0x01 = Right, 0x02 = Left
   *   serial: e.g. "H290028" or "H290036" — unique per physical pair
   *
   * Falls back to name parsing if manufacturerData is absent.
   */
  private _parseManufacturerData(device: Device): { side: Side; serial: string; firmware: string } | null {
    if (device.manufacturerData) {
      try {
        const buf = base64ToUint8(device.manufacturerData);
        // Side byte: 0x01 = R, 0x02 = L (confirmed from EvenBridge source).
        // Log unknown values so we can diagnose without silently masking them.
        let side: Side;
        if (buf[0] === 0x02) side = 'L';
        else if (buf[0] === 0x01) side = 'R';
        else {
          // Only log the unknown-byte warning for devices that look like G1 glasses
          // (name contains "G1"). Samsung TVs, Quest headsets, etc. all have mfr
          // data — logging every one pollutes the log and buries real signal.
          if (device.name?.includes('G1')) {
            this._log(`[G1] _parseManufacturerData: unknown side byte 0x${buf[0].toString(16).padStart(2,'0')} for "${device.name}" — falling through to name parse`);
          }
          // Fall through to name-based parsing below rather than guessing.
          throw new Error('unknown side byte');
        }
        const firmware = String.fromCharCode(...buf.slice(2, 8)).replace(/\0/g, '');
        const serial   = String.fromCharCode(...buf.slice(8, 15)).replace(/\0/g, '');
        if (serial.length > 0) return { side, serial, firmware };
      } catch {}
    }
    // Fallback: parse from name.
    // Normalize "Even G1_..." → "G1_..." so the regex matches regardless of prefix.
    // Channel segment may contain letters as well as digits (e.g. "5L" in "G1_5L_L_810D29"),
    // so use [A-Za-z0-9]+ rather than \d+.
    const name = (device.name ?? '').replace(/^Even G1/, 'G1');
    const m = name.match(/G1_([A-Za-z0-9]+)_([LR])_([0-9A-Fa-f]+)/);
    if (m) {
      // Strip any trailing side letter from the channel token so "5L" and "5" both
      // normalise to "5" — keeping L and R in the same logical pair.
      const ch = m[1].replace(/[LR]$/i, '');
      return { side: m[2] as Side, serial: `name-ch${ch}`, firmware: 'unknown' };
    }
    return null;
  }

  /** Extract channel/pair key from device. Uses serial from manufacturerData (preferred) or hex suffix from name. */
  private _parseChannel(device: Device): string | null {
    const parsed = this._parseManufacturerData(device);
    if (parsed) return parsed.serial;
    // Name format: "Even G1_5_L_810D29" or "G1_5L_R_D55156"
    // The hex suffix (e.g. "810D29") is the same serial stored during pairing when
    // manufacturerData was available. Extract it as the canonical channel key so
    // reconnect channel-filter matching works even when mfr=null (iOS connectedDevices).
    const name = (device.name ?? '').replace(/^Even G1/, 'G1');
    const mHex = name.match(/G1_[A-Za-z0-9]+_[LR]_([0-9A-Fa-f]+)/);
    if (mHex) return mHex[1];
    // last-resort: channel number only (loses hex, but allows unfiltered reconnect)
    const mCh = name.match(/G1_([A-Za-z0-9]+)_[LR]/);
    return mCh ? mCh[1].replace(/[LR]$/i, '') : null;
  }

  /**
   * Is this peripheral the `side` lens of the pair we're bound to?
   *   1. No paired serial yet (first pairing) → accept.
   *   2. We've learned this side's peripheral id → exact id match only.
   *   3. Otherwise require mfr-data serial === paired serial.
   *   4. No mfr data and no known id → reject. The name hex suffix is NOT the
   *      serial and connectedDevices() on iOS never carries mfr data, so there
   *      is nothing to verify against; the scan path (which has mfr data) will
   *      find it and record the id.
   */
  private _matchesPair(device: Device, side: Side): boolean {
    if (!this._pairedSerial) return true;
    const knownId = this._pairedIds[side];
    if (knownId) return device.id === knownId;
    const parsed = this._parseManufacturerData(device);
    return !!parsed && parsed.serial === this._pairedSerial;
  }

  /** Record a verified peripheral id for `side` once mfr data confirms the serial. */
  private _learnPairedId(device: Device, side: Side): void {
    const parsed = this._parseManufacturerData(device);
    if (!parsed || parsed.serial.startsWith('name-ch')) return;
    if (!this._pairedSerial) this._pairedSerial = parsed.serial;
    if (parsed.serial !== this._pairedSerial) return;
    if (this._pairedIds[side] !== device.id) {
      this._pairedIds[side] = device.id;
      this._log(`[G1] _learnPairedId [${side}] ${parsed.serial} → ${device.id}`);
      this._emitStatus();
    }
  }

  /** Parse Side from device. Uses manufacturerData byte (preferred) or name. */
  private _parseSide(device: Device): Side | null {
    const parsed = this._parseManufacturerData(device);
    if (parsed) return parsed.side;
    // last-resort: name-based
    const name = (device.name ?? '').replace('Even G1', 'G1');
    if (!name.startsWith('G1_')) return null;
    for (const part of name.split('_')) {
      if (part === 'L') return 'L';
      if (part === 'R') return 'R';
    }
    return null;
  }

  // ── Connection ────────────────────────────────────────────────────────────

  /**
   * Canonical enqueue point for all _connectLens calls.
   *
   * Guards:
   *   - destroyed: class is torn down
   *   - txChars[side]: already connected — no-op
   *   - _connectingOnSide[side]: a _connectLens is mid-execution — no-op
   *
   * Previously this pattern was copy-pasted four times (_reconnectDropped,
   * _scheduleReconnect×2, _resumeAlreadyConnected). Each copy had subtly
   * different guards, which caused the Bug #10 scan storm (txChars guard
   * missing from two sites). Centralising here ensures every code path is
   * consistent.
   */
  private _enqueueConnect(side: Side, device: Device): void {
    // "Already up" only counts if the lens we hold IS the one being requested.
    // Holding a different peripheral (other pair's lens) must not block the
    // correct one — _connectLensInner evicts the stranger.
    const holdingThis = () => !!this.txChars[side] && this.devices[side]?.id === device.id;
    if (this.destroyed || holdingThis() || this._connectingOnSide[side]) {
      this._log(`[G1] _enqueueConnect [${side}] skipped — destroyed=${this.destroyed} txChars=${!!this.txChars[side]} connecting=${this._connectingOnSide[side]}`);
      return;
    }
    void this._runOnQueue(side, async () => {
      if (this.destroyed || holdingThis()) return; // re-check: may have connected while queued
      try { await this._connectLens(side, device); }
      catch { this._scheduleReconnect(side); }
    });
  }

  /**
   * Serialise `fn` on the per-side connect queue. The queue itself NEVER holds
   * a rejected promise — the 2026-11-04 log showed L's queue poisoned by a
   * single connect() timeout at 14:34:55, after which every later
   * _enqueueConnect('L') chained `.then()` onto a rejected promise and silently
   * never ran. User "Reconnect L" taps found the lens via scan and did nothing.
   * Callers still see the rejection via the returned promise.
   */
  private _runOnQueue<T>(side: Side, fn: () => Promise<T>): Promise<T> {
    const p = this._connectQueue[side].then(fn);
    this._connectQueue[side] = p.then(() => undefined, () => undefined);
    return p;
  }

  /**
   * Connect whichever lenses are in `found` (one or both). Resolves if at
   * least one lens reaches txReady; rejects only if every attempted lens
   * failed. Any side that is missing or failed gets its device cached (so the
   * reconnect path can skip scanning) and a _scheduleReconnect — previously a
   * failed side in a pair-connect was orphaned: no timer, no cached device.
   * Used by _scan (both paths) and _resumeAlreadyConnected.
   */
  private async _connectFound(found: Partial<Record<Side, Device>>): Promise<void> {
    const sides = (['L', 'R'] as Side[]).filter(s => found[s]);
    for (const s of sides) {
      // Cache before connecting so a connect() failure still leaves
      // _scheduleReconnect with a device to retry (no re-scan needed).
      // Do NOT overwrite a cached different peripheral here — _connectLensInner
      // uses devices[s].id !== found.id to detect and evict a wrong-pair lens.
      if (!this.devices[s]) this.devices[s] = found[s]!;
    }
    const results = await Promise.allSettled(
      sides.map(s => this._runOnQueue(s, () => this._connectLens(s, found[s]!))),
    );
    const okSides = sides.filter((_, i) => results[i].status === 'fulfilled');
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    for (const s of ['L', 'R'] as Side[]) {
      if (!okSides.includes(s)) {
        this._log(`[G1] _connectFound [${s}] ${found[s] ? 'failed' : 'not found'} — scheduling reconnect`);
        this.reconnectAttempts[s] = 0;
        this._scheduleReconnect(s);
      }
    }

    if (okSides.length === 0) throw failures[0]?.reason ?? new Error('G1 glasses not found. Make sure they are on and in range.');
    this._startHeartbeat();
  }

  private async _connectLens(side: Side, device: Device): Promise<void> {
    this._connectingOnSide[side] = true;
    try {
      await this._connectLensInner(side, device);
    } finally {
      this._connectingOnSide[side] = false;
    }
  }

  private async _connectLensInner(side: Side, device: Device): Promise<void> {
    // #23: iOS BLE fires onDeviceConnected repeatedly for an already-connected
    // peripheral. The fast silent-ACK-reuse path resolves in ~100ms, making
    // _connectingOnSide briefly false — letting subsequent callbacks in.
    // Gate here on rxSubs (live notification subscription) as the definitive
    // "already initialised" signal, independent of timing.
    //
    // Zoracon: don't silently bail if the lens is in a broken half-init state
    // (rxSubs live but txReady false — e.g. a prior silent-ACK timeout left the
    // sub wired but aborted before _setConnected). Tear down and re-enter so the
    // reconnect path actually recovers instead of looping on a dead state.
    if (this.rxSubs[side]) {
      const held = this.devices[side];
      const txReady = side === 'L' ? this.status.left.txReady : this.status.right.txReady;
      if (held && held.id !== device.id) {
        // 2026-11-04 log: rxSubs[R] was live for G1_30_R (the other pair's
        // lens, grabbed before the pair filter existed) when the reconnect
        // scan found the real H290028 R. The old guard saw "an R is up" and
        // skipped — so we held the stranger forever and every 0x4e text
        // timed out. The live sub is for the WRONG peripheral: drop it.
        this._log(`[G1] _connectLensInner [${side}] held ${held.name ?? held.id} ≠ target ${device.name ?? device.id} — dropping wrong lens`);
        this.rxSubs[side]!.remove();
        this.rxSubs[side] = undefined;
        this.txChars[side] = undefined;
        this.devices[side] = undefined;
        this._lastSilentAckAt[side] = 0;
        this._setConnected(side, false);
        try { await held.cancelConnection(); } catch (e: any) {
          this._log(`[G1] _connectLensInner [${side}] cancelConnection on wrong lens failed: ${e?.message ?? e}`);
        }
      } else if (txReady) {
        this._log(`[G1] _connectLensInner [${side}] skipped — RX subscription already live and txReady`);
        return;
      } else {
        this._log(`[G1] _connectLensInner [${side}] stale rxSub (txReady=false) — tearing down and re-entering`);
        this.rxSubs[side]!.remove();
        this.rxSubs[side] = undefined;
      }
    }
    this._log(`[G1] _connectLensInner [${side}] enter — device=${device.name ?? device.id}`);
    let connected: Device;
    try {
      // Explicit timeout prevents CoreBluetooth from hanging indefinitely when
      // the lens is out of range or held by another central. Without it,
      // connect() never rejects → _connectingOnSide stays true → the per-side
      // queue blocks → L never retries even after R has been running for hours.
      connected = await device.connect({ autoConnect: false, timeout: 15000 });
    } catch (e: any) {
      // DeviceConnectionFailed (200) is iOS didFailToConnect — the CoreBluetooth
      // code is the only thing that distinguishes "stale bond, Forget in
      // Settings" (CBError 14) from "held by another central" (6/7). Log it and
      // put it in the message so a screenshot of the pairing screen is enough.
      const be = e as BleError;
      this._log(
        `[G1] _connectLensInner [${side}] connect() failed name=${device.name} ` +
        `code=${be?.errorCode ?? '?'} ios=${be?.iosErrorCode ?? '?'} att=${be?.attErrorCode ?? '?'} reason=${be?.reason ?? '—'}`,
      );
      if (be?.errorCode === BleErrorCode.DeviceConnectionFailed) {
        // CBError.peerRemovedPairingInformation = 14; ble-plx's BleIOSErrorCode
        // enum stops at 12 so compare as a plain number.
        const hint = (be.iosErrorCode as number | null) === 14
          ? 'Pairing is stale — Settings → Bluetooth → Forget both lenses, then retry.'
          : 'Make sure the Even app (and any other phone) is fully closed.';
        throw new Error(`${side} lens connection failed (iOS ${be.iosErrorCode ?? '?'}). ${hint}`);
      }
      throw e;
    }
    const discovered = await connected.discoverAllServicesAndCharacteristics();
    this.devices[side] = discovered;
    // Capture RSSI at connect time
    if (side === 'L') this.status.left.rssi = device.rssi ?? null;
    if (side === 'R') this.status.right.rssi = device.rssi ?? null;

    // Find TX characteristic (write)
    const services = await discovered.services();
    for (const svc of services) {
      if (svc.uuid.toLowerCase() !== P.UART_SVC) continue;
      const chars = await svc.characteristics();
      for (const ch of chars) {
        if (ch.uuid.toLowerCase() === P.UART_TX) {
          this.txChars[side] = ch;
          // txReady is set after both TX and RX are wired — see _setConnected call below.
        }
        if (ch.uuid.toLowerCase() === P.UART_RX) {
          this._log(`[G1] RX found [${side}] notifiable=${ch.isNotifiable}`);
          this.rxSubs[side]?.remove();
          try {
            this.rxSubs[side] = discovered.monitorCharacteristicForService(
              svc.uuid, P.UART_RX,
              (err, char) => this._onNotify(side, err, char),
            );
          } catch (monErr: any) {
            console.warn(`[G1] monitor setup failed [${side}]:`, monErr?.message ?? monErr);
          }
        }
      }
    }

    // NOTE: txReady is intentionally set AFTER handshake + silent complete below.
    // Setting it here would flip isConnected immediately and trigger React effects
    // (e.g. the reconnect-send useEffect in index.tsx) before the glass is ready,
    // causing 0x4e ACK timeouts and a connection_error loop.

    // Handshake — firmware does not ACK 0xF4, fire-and-forget.
    await this._send(side, P.handshake(), false);
    // Suppress firmware notification overlays (e.g. "Even AI unable to connect")
    // so they don't clobber our teleprompter display.
    // Use _sendForResult so we verify the ACK before marking txReady — a
    // fire-and-forget silent that times out must not silently promote the lens
    // to ready state (reproduces as one lens blank on startup, L vs R race).
    this._lastSilentAt[side] = Date.now();
    // If the glass already ACK'd OP_SILENT during this power-on cycle (e.g. the
    // ACK arrived while a prior _connectLens attempt was still waiting, or after
    // it timed out and gave up), skip the 12s wait entirely — the glass will NOT
    // send a second 0x03 ACK for the same boot cycle and we'd always time out.
    const silentAlreadyAckd = (Date.now() - this._lastSilentAckAt[side]) < G1Core.SILENT_ACK_REUSE_MS;
    if (silentAlreadyAckd) {
      this._log(`[G1] _connectLens [${side}] reusing recent silent ACK — skipping 12s wait`);
    } else {
      // Firmware ACK for OP_SILENT (0x03) arrives 5–8s after BLE connection in
      // observed logs — well outside the default 2s window. Use a generous 12s
      // timeout here so we don't reconnect-loop while the firmware is still
      // initialising. The 2s default is still appropriate for mid-session sends.
      // silent(false) = EXIT silent mode (03 0a). Firmware decomp
      // (display_dispatch_thread.c) shows silent mode SUSPENDS the master
      // lens's display thread — which both blanks the HUD and defers the
      // 0x4e text ACK indefinitely (ble_process_req_dispatch.c case 0x4e:
      // master defers ACK to the display thread via DAT_20019a69).
      // We previously sent silent(true) here believing it asserted display
      // ownership; it actually turned the display OFF. Same opcode, same
      // ACK path, so txReady gating is unchanged.
      let silentOk = await this._sendForResult(side, P.silent(false), 12000);
      // #27: no 0x03 ACK means the firmware is asleep (in case / powered down),
      // not that the link is bad — in the 2026-10-25 log both lenses were
      // BLE-connected for 2.5 min with zero RX of any kind, then R emitted a
      // 0xf5 event and ACK'd 0x03 100 ms later. Tearing down + rediscovering
      // 12× per side bought nothing. Hold the link, wait for the first
      // unsolicited frame, and retry the silent command.
      while (!silentOk) {
        if (this.destroyed || !this.rxSubs[side]) return; // _onDisconnected owns cleanup + reconnect
        this._setAsleep(side, true);
        this._log(`[G1] _connectLens [${side}] no silent ACK — firmware asleep, holding link until first RX`);
        await this._waitForWake(side);
        if (this.destroyed) return;
        if (!this.rxSubs[side]) { this._scheduleReconnect(side); return; } // link dropped while asleep
        this._log(`[G1] _connectLens [${side}] woke — re-sending silent(false)`);
        this._lastSilentAt[side] = Date.now();
        silentOk = await this._sendForResult(side, P.silent(false), 12000);
      }
      this._setAsleep(side, false);
    }

    // Mark TX as ready only after init sequence is complete — the RX monitor
    // is already live (set up in the loop above) so ACKs are handled correctly.
    this._textNackCount[side] = 0; // fresh link — restart telemetry streak
    if (side === 'L') this.status.left.txReady = true;
    if (side === 'R') this.status.right.txReady = true;
    this._log(`[G1] _connectLensInner [${side}] txReady — init complete`);
    this._setConnected(side, true);
    this.reconnectAttempts[side] = 0;

    // Request battery level after connect
    setTimeout(() => this._send(side, P.batteryRequest()), 500);

    // Watch for disconnection.
    // Capture the generation counter at registration time. If _connectLens
    // runs again (reconnect) before this fires, the generation increments and
    // this stale handler becomes a no-op — preventing it from corrupting the
    // new healthy connection.
    const gen = ++this._connGen[side];
    discovered.onDisconnected((err) => {
      if (this._connGen[side] !== gen) return; // stale — a newer connection replaced this one
      this._onDisconnected(side, err ?? undefined);
    });
  }

  private _onDisconnected(side: Side, err?: Error): void {
    const be = err as BleError | undefined;
    this._log(
      `[G1] onDisconnected [${side}]` +
      (be ? ` code=${be.errorCode ?? '?'} ios=${be.iosErrorCode ?? '?'} reason=${be.reason ?? '—'}` : ' (no error)'),
    );
    // One BLE drop surfaces here up to 3× within ~5ms: the RX monitor error
    // (no code), the OS onDisconnected (201), then OperationCancelled (2) from
    // the monitor being torn down. Each call used to bump reconnectAttempts,
    // so the FIRST retry after a single drop waited 4s instead of 1s and the
    // backoff hit its 10s ceiling after two drops. Only the first call tears
    // down + schedules; the rest are duplicates of a drop already handled.
    if (!this.rxSubs[side] && !this.txChars[side] && this._reconnectTimers[side]) {
      this._log(`[G1] onDisconnected [${side}] — duplicate, reconnect already scheduled`);
      return;
    }
    // Cancel all pending ACK waiters — a disconnected lens will never respond.
    // This prevents stale waiters from timing out sequentially and producing
    // a cascade of false-alarm log lines after reconnect.
    this._drainAckWaiters(side);
    this._setConnected(side, false);
    this.txChars[side] = undefined;
    // #27: rxSubs is nulled below, so the asleep-wait loop in
    // _connectLensInner sees the drop and exits after we resolve it.
    // Tear down the RX subscription so _connectLensInner's rxSubs guard
    // doesn't mistake a stale subscription for "already initialised" and
    // silently skip the reconnect attempt. This is the same invariant as the
    // silent-ACK abort path — any exit from a connect lifecycle must leave
    // rxSubs null so the next _enqueueConnect enters _connectLensInner cleanly.
    this.rxSubs[side]?.remove();
    this.rxSubs[side] = undefined;
    this._resolveWake(side);
    // Invalidate the silent-ACK reuse timestamp.  _onDisconnected is called
    // either on a genuine BLE disconnect or when we force-disconnect after
    // consecutive text NACKs (display-dead).  In both cases the firmware may
    // have rebooted and will send a fresh 0x03 ACK on the next connect — the
    // old timestamp is no longer valid, and reusing it would skip the 12s
    // _sendForResult wait and promote a still-initialising firmware to txReady.
    this._lastSilentAckAt[side] = 0;
    // Also zero the send-timestamp so the no-waiter OP_SILENT ACK handler
    // (see _onNotify) cannot stamp _lastSilentAckAt from a ghost buffered ACK
    // that iOS delivers on the new RX subscription before we've actually sent
    // the silent command in the new connection cycle.  The handler gates on
    // _lastSilentAt[side] !== 0, which is only true after _connectLensInner
    // (or _sendSilent) has written the command.
    this._lastSilentAt[side] = 0;
    this._scheduleReconnect(side);
  }

  private _scheduleReconnect(side: Side): void {
    if (this.destroyed) return;
    // Cancel any existing timer for this side before scheduling a new one.
    clearTimeout(this._reconnectTimers[side]);
    const attempts = this.reconnectAttempts[side] ?? 0;
    const delay = RECONNECT_BACKOFF_MS[Math.min(attempts, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempts[side] = attempts + 1;
    this._log(`[G1] _scheduleReconnect [${side}] attempt=${attempts + 1} delay=${delay}ms`);
    this._reconnectTimers[side] = setTimeout(async () => {
      this._reconnectTimers[side] = undefined;
      if (this.destroyed) return;
      let dev = this.devices[side];
      if (dev && !this._matchesPair(dev, side)) {
        // Cached device predates the pair binding (or belongs to the other
        // set). Reconnecting it would re-grab the wrong lens — drop and scan.
        this._log(`[G1] _scheduleReconnect [${side}] cached ${dev.name ?? dev.id} is not the paired ${this._pairedSerial} — discarding`);
        this.devices[side] = undefined;
        dev = undefined;
      }

      if (!dev) {
        // This side was never found during the initial scan (e.g. L didn't
        // advertise in time). Run a short targeted scan to find it now.
        if (this._connectingOnSide[side]) {
          this._log(`[G1] _scheduleReconnect [${side}] scan already in progress — skipped`);
          return;
        }
        this._log(`[G1] _scheduleReconnect [${side}] no cached device — scanning`);
        // Mark in-flight for the scan's duration so reconnectSide()/_enqueueConnect
        // treat it like an active connect and don't start a competing scan.
        this._connectingOnSide[side] = true;
        try {
          await this._ensureBleReady();
          const found = await new Promise<Device | null>((resolve) => {
            const t = setTimeout(() => { this.manager.stopDeviceScan(); resolve(null); }, 5000);
            this.manager.startDeviceScan(null, { allowDuplicates: true }, (_err, device) => {
              if (!device?.name) return;
              // Same pair filter as the main scan — this unfiltered path was
              // the one that grabbed the other set's lens during reconnect.
              if (this._parseSide(device) === side && this._matchesPair(device, side)) {
                this._learnPairedId(device, side);
                clearTimeout(t);
                this.manager.stopDeviceScan();
                resolve(device);
              }
            });
          });
          this._connectingOnSide[side] = false;
          if (found) {
            this._enqueueConnect(side, found);
          } else {
            this._scheduleReconnect(side); // scan timed out, try again
          }
        } catch {
          this._connectingOnSide[side] = false;
          this._scheduleReconnect(side);
        }
        return;
      }

      // _enqueueConnect handles the _connectingOnSide / destroyed / txChars guards.
      this._enqueueConnect(side, dev);
    }, delay);
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  private _onNotify(side: Side, error: Error | null, char: Characteristic | null): void {
    if (error) {
      const bleErr = error as BleError;
      const isDisconnect =
        bleErr.errorCode === BleErrorCode.DeviceDisconnected ||
        bleErr.errorCode === BleErrorCode.OperationCancelled;
      if (isDisconnect) {
        // Monitor subscription is dead — drive _onDisconnected directly so
        // cleanup + reconnect scheduling happen immediately rather than waiting
        // for the OS-level onDisconnected callback (which may arrive later or
        // not at all if the notify fires first on this iOS version).
        this._onDisconnected(side, error);
        return;
      }
      console.warn(
        `[G1] notify error [${side}] code=${bleErr.errorCode} reason=${bleErr.reason ?? '—'}:`,
        bleErr.message,
      );
      return;
    }
    if (!char?.value) return;
    const data = base64ToUint8(char.value);
    if (!data.length) return;
    this._resolveWake(side); // #27: any frame from a sleeping lens means it woke

    const op = data[0];
    if (this.verbose) {
      this._log(`[G1 RX ${side}] op=0x${op.toString(16).padStart(2,'0')} len=${data.length} raw=${Array.from(data).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);
    }

    // ── Protocol-level ACK ────────────────────────────────────────────────
    // The firmware echoes the command opcode in data[0] and puts the result
    // in data[1]: 0xC9 or 0xCB = ok, anything else = nack.
    // Look up the pending waiter by side+opcode key (e.g. "L4e").
    //
    // Exception: OP_BATTERY (0x2C) responses use a different status format —
    // data[1]=0x66 is a battery-specific status byte, not a protocol ACK.
    // Always route battery packets directly to the OP_BATTERY handler below.
    const ackKey = `${side}${op.toString(16).padStart(2, '0')}`;
    const pending = this._pendingAck.get(ackKey);
    if (pending && op !== P.OP_BATTERY) {
      clearTimeout(pending.timer);
      this._pendingAck.delete(ackKey);
      const status = data[1];
      const ok = status === P.R_STATUS_OK || status === P.R_STATUS_OK2;
      // Track silent ACK receipt so _connectLens can skip the 12s wait on
      // reconnect if the glass already ACK'd during this power-on cycle.
      if (op === P.OP_SILENT && ok) this._lastSilentAckAt[side] = Date.now();
      pending.resolve(ok);
      return;
    }
    // OP_SILENT ACK arrived with no pending waiter (e.g. arrived after a prior
    // _connectLens already gave up and rescheduled). Record the timestamp so the
    // next _connectLens attempt can skip its 12s wait — BUT only if we have
    // actually sent a silent in this connection cycle (_lastSilentAt[side] !== 0).
    // If _lastSilentAt is 0 the ACK is a ghost: a buffered iOS notification from
    // the previous connection, delivered on the new RX subscription before we have
    // written anything.  Accepting it would incorrectly enable the fast-path and
    // let _connectLensInner skip the full firmware-init wait, leaving R in a state
    // where it never ACKs 0x4e.  (Bug #10 resurfacing — fixed 2026-09-27.)
    if (op === P.OP_SILENT && this._lastSilentAt[side] !== 0) {
      const status = data[1];
      if (status === P.R_STATUS_OK || status === P.R_STATUS_OK2) {
        this._lastSilentAckAt[side] = Date.now();
        this._log(`[G1] OP_SILENT late ACK [${side}] — recorded for next _connectLens`);
      }
    }
    // Clean up any battery ACK waiter — it resolves successfully since we got a response.
    if (op === P.OP_BATTERY && pending) {
      clearTimeout(pending.timer);
      this._pendingAck.delete(ackKey);
      pending.resolve(true);
    }

    // ── Heartbeat (firmware-initiated) ───────────────────────────────────
    // The glasses send 0x25 to us; we echo it straight back. We do NOT send
    // unsolicited heartbeats — the firmware owns the heartbeat clock.
    if (op === P.OP_HEARTBEAT) {
      this._send(side, data, false).catch(() => {});
      return;
    }

    if (op === P.OP_EVENT) {
      const event = P.parseEvent(data, side);
      if (event) {
        // Routine housekeeping events fire every ~47s (status_ping, battery,
        // charging). Log them only in verbose mode — they account for ~45% of
        // ring-buffer lines and push lifecycle events out before capture.
        const isRoutine = event.name === 'status_ping' || event.name === 'battery' || event.name === 'charging';
        if (!isRoutine || this.verbose) {
          this._log(`[G1 EVENT ${side}] subcmd=0x${event.subcmd.toString(16).padStart(2,'0')} name="${event.name}"`);
        }
        // op=0x11 ('status_ping') — fires after every battery poll response
        // (0x2c) as a routine firmware heartbeat. Confirmed from log correlation:
        // f5 11 always arrives within ~300ms of a 0x2c battery packet on R.
        // It is NOT a display-takeover signal. Genuine reconnects are handled
        // by _connectLens (which calls _sendSilent before setting txReady).
        // Intentionally ignored here. See issue #18 for full diagnosis.

        // Even AI / dashboard overlays steal the display. When the firmware
        // signals that a foreign overlay has opened or closed, re-assert Cue's
        // silent-mode ownership so we can push content again.
        // dashboard_open  (0x1e): overlay appeared — silence immediately so we
        //   don't fight the firmware mid-animation.
        // dashboard_close (0x1f): overlay dismissed — re-silence to reclaim.
        // ai_start        (0x17): triple-tap fired Even AI — same treatment.
        //
        // NOTE: opcode semantics for 0x1e/0x1f/0x17 are also community-sourced,
        // not verified from firmware. Treat as working assumptions (see issue #18).
        if (
          event.name === 'dashboard_open' ||
          event.name === 'dashboard_close' ||
          event.name === 'ai_start'
        ) {
          this._log(`[G1] display takeover event "${event.name}" [${side}] — re-asserting silent`);
          // Do NOT drain ACK waiters here. Draining kills in-flight OP_TEXT
          // sends whose ACK simply hasn't arrived yet (R delays 15-19s when
          // audio is streaming). Draining causes those sends to NACK, the
          // _enqueue swallows the error, and the HUD goes blank even though
          // the firmware successfully received the text.
          //
          // _drainAckWaiters is appropriate before a full reconnect
          // (_onDisconnected path) but NOT for display-takeover events.
          //
          // _sendSilent goes through _enqueue, so any sendText enqueued by
          // index.tsx's event handler will sequence behind it in _sendQueue —
          // no timing race between the silent and the content re-push.
          // For dashboard_open, silence immediately.
          // For close/ai_start, defer 300ms to let the overlay animation finish.
          if (event.name === 'dashboard_open') {
            this._sendSilent(side);
          } else {
            setTimeout(() => this._sendSilent(side), 300);
          }
        }

        this.eventHandlers.forEach(h => h(event));
      }
      return;
    }

    if (op === P.OP_BATTERY) {
      if (this.verbose) {
        this._log(`[G1] BATTERY raw [${side}]:`, Array.from(data).map(b => b.toString(16).padStart(2,'0')).join(' '));
      }
      // resp[2] = battery % (confirmed from raw log). Each glass reports its own.
      const level = data[2] ?? 0;
      if (side === 'L') this.status.left.batteryPct = level;
      if (side === 'R') this.status.right.batteryPct = level;
      this._emitStatus();
      return;
    }
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  /**
   * Write one packet to one lens and (optionally) await the protocol-level ACK.
   *
   * ACK protocol (verified against official EvenDemoApp source):
   *   - Firmware echoes the command opcode in data[0]
   *   - Status is in data[1]: 0xC9 or 0xCB = ok, anything else = nack
   *   - Resolver is keyed by "<side><opcode_hex>" (e.g. "L4e") so concurrent
   *     sends on different opcodes don't clobber each other
   *   - We register the resolver BEFORE the write to avoid a race on fast ACK
   *
   * Uses writeCharacteristicWithResponse so iOS BLE won't silently drop
   * packets when the TX queue is full.
   *
   * Timeout: 2 s per packet. On timeout or NACK we log a warning but do not
   * throw — the caller's sequence continues. This matches the official app.
   */
  /**
   * Send silent(true) and record the timestamp so callers can rate-limit
   * subsequent re-silences (e.g. connection_error storms).
   */
  private _sendSilent(side: Side): void {
    // Do NOT send while the init sequence is in flight — txReady is only set
    // after the init silent ACK is received. An event-triggered silent here
    // would register a second R03/L03 waiter that evicts the init waiter,
    // resolving it false and triggering an unnecessary reconnect. (Bug #10.)
    const st = side === 'L' ? this.status.left : this.status.right;
    if (!st.txReady) {
      this._log(`[G1] _sendSilent [${side}] suppressed — init in progress (txReady=false)`);
      return;
    }
    this._lastSilentAt[side] = Date.now();
    // Route through _enqueue so this silent is ordered in the same queue as
    // any subsequent sendText call. A bare _send here would race a sendText
    // enqueued by index.tsx's event handler — the silent could arrive on the
    // glasses AFTER the text, leaving "Silent" as the last visible frame.
    // silent(false): EXIT silent mode. silent(true) here would SUSPEND the
    // master lens's display thread (firmware decomp) — the opposite of
    // reclaiming the display after an overlay.
    this._enqueue(() => this._send(side, P.silent(false))).catch(() => {});
  }

  /**
   * Cancel and remove all pending ACK waiters for a given side.
   * Call before re-silencing after a connection_error so stale waiters don't
   * time out sequentially and produce a cascade of false-alarm log lines.
   */
  private _drainAckWaiters(side: Side): void {
    for (const [key, waiter] of this._pendingAck.entries()) {
      if (key.startsWith(side)) {
        clearTimeout(waiter.timer);
        waiter.resolve(false);
        this._pendingAck.delete(key);
        this._log(`[G1] _drainAckWaiters: cancelled stale waiter key=${key}`);
      }
    }
  }

  /**
   * Like _send but returns true on ACK ok, false on NACK/timeout/write-error.
   * Used by the heartbeat monitor to detect zombied lenses.
   */
  private async _sendForResult(side: Side, data: Uint8Array, timeoutMs = 2000): Promise<boolean> {
    const ch = this.txChars[side];
    const dev = this.devices[side];
    if (!ch || !dev) return false;

    const opHex = data[0].toString(16).padStart(2, '0');
    const ackKey = `${side}${opHex}`;
    const b64 = uint8ToBase64(data);

    const stale = this._pendingAck.get(ackKey);
    if (stale) {
      clearTimeout(stale.timer);
      this._pendingAck.delete(ackKey);
      stale.resolve(false); // don't orphan the previous awaiter
    }

    const ackPromise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this._pendingAck.delete(ackKey);
        this._log(`[G1] _sendForResult [${side}] ACK timeout op=0x${opHex} after ${timeoutMs}ms`);
        resolve(false);
      }, timeoutMs);
      this._pendingAck.set(ackKey, { resolve, timer });
    });

    try {
      await Promise.race([
        dev.writeCharacteristicWithResponseForService(P.UART_SVC, P.UART_TX, b64),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('write timeout')), 3000)),
      ]);
    } catch (e: any) {
      const waiter = this._pendingAck.get(ackKey);
      if (waiter) { clearTimeout(waiter.timer); this._pendingAck.delete(ackKey); }
      const be = e as BleError;
      this._log(
        `[G1] _sendForResult [${side}] WRITE failed op=0x${opHex} ` +
        `code=${be?.errorCode ?? '?'} reason=${be?.reason ?? '—'} msg=${e?.message ?? e}`,
      );
      return false;
    }

    return ackPromise;
  }

  // OP_TEXT ACKs can arrive up to ~20s late on the right lens when audio is
  // streaming (0xf1 frames from the mic pipeline saturate firmware processing).
  // Give text sends a generous timeout so we don't NACK and blank the HUD.
  private static readonly ACK_TIMEOUT_TEXT_MS = 25_000;
  private static readonly ACK_TIMEOUT_DEFAULT_MS = 2_000;

  private async _send(side: Side, data: Uint8Array, awaitAck = true): Promise<void> {
    const ch = this.txChars[side];
    const dev = this.devices[side];
    if (!ch || !dev) {
      const opHex = data[0].toString(16).padStart(2, '0');
      this._log(`[G1] _send [${side}] DROP op=0x${opHex} — txChars=${!!ch} dev=${!!dev} txReady=${side === 'L' ? this.status.left.txReady : this.status.right.txReady}`);
      return;
    }

    const opHex = data[0].toString(16).padStart(2, '0');
    const ackKey = `${side}${opHex}`;
    const b64 = uint8ToBase64(data);

    // Register ACK waiter BEFORE the write to prevent the fast-ACK race.
    let ackPromise: Promise<boolean> | null = null;
    if (awaitAck) {
      // If a previous send on this same opcode timed out without being cleaned
      // up, evict it now rather than letting two resolvers compete.
      const stale = this._pendingAck.get(ackKey);
      if (stale) {
        clearTimeout(stale.timer);
        this._pendingAck.delete(ackKey);
        this._log(`[G1] _send [${side}] evicted stale ACK waiter op=0x${opHex}`);
      }
      ackPromise = new Promise<boolean>((resolve) => {
        const ackTimeout = data[0] === P.OP_TEXT
          ? G1Core.ACK_TIMEOUT_TEXT_MS
          : G1Core.ACK_TIMEOUT_DEFAULT_MS;
        const timer = setTimeout(() => {
          this._pendingAck.delete(ackKey);
          this._log(`[G1] _send [${side}] ACK timeout op=0x${opHex} after ${ackTimeout}ms`);
          resolve(false);
        }, ackTimeout);
        this._pendingAck.set(ackKey, { resolve, timer });
      });
    }

    // Race the BLE write against a hard timeout — firmware can stall the radio
    // and writeCharacteristicWithResponse has no built-in deadline, which would
    // block _sendQueue indefinitely and freeze all subsequent sends.
    const WRITE_TIMEOUT_MS = 3000;
    try {
      await Promise.race([
        dev.writeCharacteristicWithResponseForService(P.UART_SVC, P.UART_TX, b64),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('write timeout')), WRITE_TIMEOUT_MS)),
      ]);
    } catch (e: any) {
      // Clean up the ACK waiter we registered above.
      if (awaitAck) {
        const waiter = this._pendingAck.get(ackKey);
        if (waiter) { clearTimeout(waiter.timer); this._pendingAck.delete(ackKey); }
      }
      const code = (e as BleError)?.errorCode;
      if (code === BleErrorCode.DeviceDisconnected || code === BleErrorCode.OperationCancelled) return;
      if (e?.message === 'write timeout') {
        this._log(`[G1] _send [${side}] write stalled >3s op=0x${opHex} — dropping`);
        return;
      }
      console.warn(
        `[G1] _send [${side}] write failed code=${code ?? '?'} reason=${(e as BleError)?.reason ?? '—'}:`,
        e?.message ?? e,
      );
      return;
    }

    if (!awaitAck || !ackPromise) return;

    const ok = await ackPromise;
    if (!ok) {
      this._log(`[G1] _send [${side}] NACK op=0x${opHex}`);
      if (data[0] === P.OP_TEXT) {
        this._textNackCount[side]++;
        this._log(`[G1] _send [${side}] consecutive text NACKs=${this._textNackCount[side]}`);
        this._setDisplayIdle(side, true);
      }
    } else if (data[0] === P.OP_TEXT) {
      this._textNackCount[side] = 0;
      this._setDisplayIdle(side, false);
    }
  }

  /**
   * #26: flip LensState.displayIdle and notify subscribers. Only fires a status
   * change on an actual transition so the UI doesn't re-render per line.
   * Note: a NACK on a side that is already disconnected (drained waiter) must
   * not mark it idle — _onDisconnected owns that state.
   */
  private _setDisplayIdle(side: Side, idle: boolean): void {
    const lens = side === 'L' ? this.status.left : this.status.right;
    if (lens.displayIdle === idle) return;
    if (idle && !lens.txReady) return;
    lens.displayIdle = idle;
    this._log(`[G1] displayIdle [${side}] = ${idle}`);
    this._emitStatus();
  }

  private _setAsleep(side: Side, asleep: boolean): void {
    const lens = side === 'L' ? this.status.left : this.status.right;
    if (lens.asleep === asleep) return;
    lens.asleep = asleep;
    this._log(`[G1] asleep [${side}] = ${asleep}`);
    this._emitStatus();
  }

  /** #27: resolves on the next RX frame from `side`, or when the side disconnects. */
  private _waitForWake(side: Side): Promise<void> {
    return new Promise<void>((resolve) => {
      this._wakeWaiters[side]?.();
      this._wakeWaiters[side] = resolve;
    });
  }

  private _resolveWake(side: Side): void {
    const w = this._wakeWaiters[side];
    if (!w) return;
    this._wakeWaiters[side] = undefined;
    w();
  }

  /**
   * Write to LEFT then RIGHT back-to-back; the queue gate is LEFT's ACK only.
   *
   * #25: the master lens defers its OP_TEXT ACK to the display thread, so a
   * right lens whose display is idle holds the ACK for the full
   * ACK_TIMEOUT_TEXT_MS. Awaiting it serially here throttled a *healthy* left
   * lens to one line per 25 s (L ACKs arrived in bursts right after each R
   * timeout). R's waiter still runs — logs, NACK counter and displayIdle all
   * see its result — it just no longer blocks the next send.
   *
   * The two writes are still issued in L→R order on the wire; only the
   * awaiting changed. sendBmp already issues both sides in parallel.
   */
  private async _sendBoth(data: Uint8Array): Promise<void> {
    const left = this._send('L', data);
    const right = this._send('R', data);
    right.catch((e) => this._log(`[G1] _sendBoth [R] background send error: ${e?.message ?? e}`));
    await left;
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  private _hbCount = 0;

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this._hbCount = 0;
    // EXPERIMENT (2026-11-04): firmware low_speed_peripheral_dispatch_thread.c:217
    // disconnects (reason 0x13) when no app sync packet arrives for 30s, and
    // ble_process_put_req.c:6689 case 0x25 logs "received app send sync packet"
    // — the heartbeat is APP→GLASSES, not the reverse as previously assumed.
    // Log shows R dropping every ~31s with ios=7 (remote terminated). Send the
    // official-app heartbeat every 8s: 25 06 00 <seq> 04 <seq>.
    this.heartbeatTimer = setInterval(async () => {
      const seq = this._hbCount & 0xff;
      const hb = new Uint8Array([0x25, 0x06, 0x00, seq, 0x04, seq]);
      this._send('L', hb, false).catch(() => {});
      this._send('R', hb, false).catch(() => {});
      if (++this._hbCount % 4 === 0) {
        await this._send('L', P.batteryRequest());
        await this._send('R', P.batteryRequest());
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _nextSeq(): number {
    const s = this.seq & 0xff;
    this.seq = (this.seq + 1) & 0xff;
    return s;
  }

  private _emitStatus(): void {
    this.onStatusChange?.({
      left:  { ...this.status.left },
      right: { ...this.status.right },
      firmwareVersion: this.status.firmwareVersion,
    });
  }

  private _setConnected(side: Side, connected: boolean): void {
    const lens = side === 'L' ? this.status.left : this.status.right;
    lens.connected = connected;
    lens.displayIdle = false; // #26: fresh link, no evidence yet either way
    if (!connected) lens.asleep = false;
    if (!connected) { lens.rssi = null; lens.txReady = false; }
    this._emitStatus();
    // Issue #7: restart heartbeat whenever both lenses are now up — covers the
    // single-lens reconnect path (_scheduleReconnect → _connectLens) which never
    // called _startHeartbeat. _startHeartbeat calls _stopHeartbeat first so this
    // is safe to call even if the timer is already running.
    if (connected && this.status.left.txReady && this.status.right.txReady) {
      this._startHeartbeat();
    }
  }
}
