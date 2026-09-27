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
    left:  { device: null, connected: false, txReady: false, batteryPct: null, rssi: null },
    right: { device: null, connected: false, txReady: false, batteryPct: null, rssi: null },
    firmwareVersion: null,
  };

  private eventHandlers = new Set<EventHandler>();
  private onStatusChange?: StatusHandler;
  private onLog?: (line: string) => void;

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

  async connect(channel?: string): Promise<void> {
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
   * isLastPage: true on the final packet of a sequence — sends NewScreen.AUTO_LAST
   * (0x41) so the firmware knows the transmission is complete. All other packets
   * use NewScreen.AUTO_MID (0x31). Pass newScreen explicitly to override.
   */
  async sendText(
    str: string,
    curLine = 1,
    totalLines = 1,
    isLastPage = false,
    newScreen?: P.NewScreenValue,
  ): Promise<void> {
    const ns = newScreen ?? (isLastPage ? P.NewScreen.AUTO_LAST : P.NewScreen.AUTO_MID);
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
  async sendTestDisplay(side: Side): Promise<void> {
    const st = side === 'L' ? this.status.left : this.status.right;
    const bat  = st.batteryPct != null ? `${st.batteryPct}%` : '--';
    const rssi = st.rssi       != null ? `${st.rssi}dBm`     : '--';
    const label = side === 'L' ? 'Left' : 'Right';
    const line = `${label}: 🔋${bat}  📶${rssi}`;
    return this._enqueue(async () => {
      const packet = P.text(line, this._nextSeq(), 1, 1, P.NewScreen.AUTO_LAST);
      await this._send(side, packet);
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
          if (channel) {
            const ch = this._parseChannel(device);
            // _parseChannel returns the mfr-data serial when available, but
            // connectedDevices() returns devices WITHOUT advertisementdata on
            // iOS resume — so ch is the hex name-suffix ("810D29") while
            // channel is the real paired serial ("H290028"). Accept the device if:
            //   (a) keys match exactly, OR
            //   (b) the device name contains the stored channel as a substring
            //       (the hex suffix "810D29" appears in "Even G1_5_L_810D29"),
            //       OR
            //   (c) ch starts with "name-ch" (legacy fallback), OR
            //   (d) device.manufacturerData is null — iOS connectedDevices never
            //       returns mfr data; the UART service filter already guarantees
            //       this peripheral is our bonded G1, so trust _parseSide alone.
            const nameMatch    = channel && (device.name ?? '').includes(channel);
            const nameChFallback = ch?.startsWith('name-ch');
            const noMfrData    = device.manufacturerData == null;
            if (ch !== channel && !nameMatch && !nameChFallback && !noMfrData) continue;
          }
          found[side] = device;
        }
        // Assign any unidentified G1 devices to missing sides by position.
        for (const s of ['L', 'R'] as Side[]) {
          if (!found[s] && unidentified.length > 0) {
            found[s] = unidentified.shift();
            this._log(`[G1] _resumeAlreadyConnected: assigned unidentified device to [${s}] by position`);
          }
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
        try {
          // Each side has its own queue — any prior reconnect attempt for that
          // side is naturally serialised without blocking the other side.
          await new Promise<void>((resolve, reject) => {
            this._connectFoundPair(found as { L: Device; R: Device }, resolve, reject);
          });
          return true;
        } catch (e: any) {
          // Partial resume — tear down whatever connected so scan starts clean.
          this._log(`[G1] _resumeAlreadyConnected partial failure: ${e?.message ?? e} — falling through to scan`);
          for (const s of ['L', 'R'] as Side[]) {
            this.rxSubs[s]?.remove(); this.rxSubs[s] = undefined;
            this.txChars[s] = undefined;
            this._setConnected(s, false);
          }
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

          // If a channel filter is set, skip devices that don't match
          if (channel) {
            const ch = this._parseChannel(device);
            if (ch !== channel) return;
          }

          found[side] = device;

          if (found.L && found.R) {
            // Both lenses found — connect in parallel via per-side queues.
            clearTimeout(timeout);
            this.manager.stopDeviceScan();
            done(() => this._connectFoundPair(found as { L: Device; R: Device }, resolve, reject));
          } else {
            // One lens found — give the other a short window to advertise before
            // resolving with one. Reconnect loop handles the missing side.
            setTimeout(() => {
              const sides = (['L', 'R'] as Side[]).filter(s => found[s]);
              if (sides.length === 0 || settled) return;
              clearTimeout(timeout);
              this.manager.stopDeviceScan();
              done(() => {
                // For the one-lens case we need heartbeat + missing-side kick.
                // Build a fake "both" map so _connectFoundPair handles
                // the queue/heartbeat/resolve, then schedule the missing side.
                // If only one lens was found, fill the found pair with only the
                // discovered side and wire them up individually.
                const ps = sides.map(s =>
                  (this._connectQueue[s] = this._connectQueue[s].then(() => this._connectLens(s, found[s]!))),
                );
                Promise.all(ps)
                  .then(() => {
                    this._startHeartbeat();
                    for (const s of ['L', 'R'] as Side[]) {
                      if (!found[s]) this._scheduleReconnect(s);
                    }
                    resolve();
                  })
                  .catch(reject);
              });
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
          this._log(`[G1] _parseManufacturerData: unknown side byte 0x${buf[0].toString(16).padStart(2,'0')} for "${device.name}" — falling through to name parse`);
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
    if (this.destroyed || this.txChars[side] || this._connectingOnSide[side]) {
      this._log(`[G1] _enqueueConnect [${side}] skipped — destroyed=${this.destroyed} txChars=${!!this.txChars[side]} connecting=${this._connectingOnSide[side]}`);
      return;
    }
    this._connectQueue[side] = this._connectQueue[side].then(async () => {
      if (this.destroyed || this.txChars[side]) return; // re-check: may have connected while queued
      try { await this._connectLens(side, device); }
      catch { this._scheduleReconnect(side); }
    });
  }

  /**
   * Connect both lenses from a `found` map, start the heartbeat, then
   * settle the surrounding promise.  Used by _scan (both-at-once path) and
   * _resumeAlreadyConnected.
   */
  private _connectFoundPair(
    found: { L: Device; R: Device },
    resolve: () => void,
    reject: (e: unknown) => void,
  ): void {
    const pL = (this._connectQueue.L = this._connectQueue.L.then(() => this._connectLens('L', found.L)));
    const pR = (this._connectQueue.R = this._connectQueue.R.then(() => this._connectLens('R', found.R)));
    Promise.all([pL, pR])
      .then(() => { this._startHeartbeat(); resolve(); })
      .catch(reject);
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
    if (this.rxSubs[side]) {
      this._log(`[G1] _connectLensInner [${side}] skipped — RX subscription already live`);
      return;
    }
    const connected = await device.connect({ autoConnect: false });
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
      const silentOk = await this._sendForResult(side, P.silent(true), 12000);
      if (!silentOk) {
        this._log(`[G1] _connectLens [${side}] silent ACK failed — aborting init, will reconnect`);
        this.txChars[side] = undefined;   // #21/#22: clear so _enqueueConnect can retry and UI shows no telemetry
        // Also tear down the RX subscription — _connectLensInner guards on rxSubs
        // being null to detect "not yet initialised". Leaving it set causes the
        // reconnect attempt to hit the early-return and silently do nothing forever.
        this.rxSubs[side]?.remove();
        this.rxSubs[side] = undefined;
        this._scheduleReconnect(side);
        return;
      }
    }

    // Mark TX as ready only after init sequence is complete — the RX monitor
    // is already live (set up in the loop above) so ACKs are handled correctly.
    if (side === 'L') this.status.left.txReady = true;
    if (side === 'R') this.status.right.txReady = true;
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
    discovered.onDisconnected(() => {
      if (this._connGen[side] !== gen) return; // stale — a newer connection replaced this one
      this._onDisconnected(side);
    });
  }

  private _onDisconnected(side: Side): void {
    // Cancel all pending ACK waiters — a disconnected lens will never respond.
    // This prevents stale waiters from timing out sequentially and producing
    // a cascade of false-alarm log lines after reconnect.
    this._drainAckWaiters(side);
    this._setConnected(side, false);
    this.txChars[side] = undefined;
    this._scheduleReconnect(side);
  }

  private _scheduleReconnect(side: Side): void {
    if (this.destroyed) return;
    // Cancel any existing timer for this side before scheduling a new one.
    clearTimeout(this._reconnectTimers[side]);
    const attempts = this.reconnectAttempts[side] ?? 0;
    const delay = RECONNECT_BACKOFF_MS[Math.min(attempts, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempts[side] = attempts + 1;
    this._reconnectTimers[side] = setTimeout(async () => {
      this._reconnectTimers[side] = undefined;
      if (this.destroyed) return;
      const dev = this.devices[side];

      if (!dev) {
        // This side was never found during the initial scan (e.g. L didn't
        // advertise in time). Run a short targeted scan to find it now.
        this._log(`[G1] _scheduleReconnect [${side}] no cached device — scanning`);
        try {
          await this._ensureBleReady();
          const found = await new Promise<Device | null>((resolve) => {
            const t = setTimeout(() => { this.manager.stopDeviceScan(); resolve(null); }, 5000);
            this.manager.startDeviceScan(null, { allowDuplicates: true }, (_err, device) => {
              if (!device?.name) return;
              if (this._parseSide(device) === side) {
                clearTimeout(t);
                this.manager.stopDeviceScan();
                resolve(device);
              }
            });
          });
          if (found) {
            this._enqueueConnect(side, found);
          } else {
            this._scheduleReconnect(side); // scan timed out, try again
          }
        } catch {
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
        this._onDisconnected(side);
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

    const op = data[0];
    this._log(`[G1 RX ${side}] op=0x${op.toString(16).padStart(2,'0')} len=${data.length} raw=${Array.from(data).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);

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
    // _connectLens already gave up and rescheduled). Record the timestamp anyway
    // so the next _connectLens attempt can skip its 12s wait.
    if (op === P.OP_SILENT) {
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
          // the firmware successfully received the text. The _sendQueue
          // serialisation already prevents the re-silent from racing the
          // in-flight text — it will queue behind it naturally.
          //
          // _drainAckWaiters is still appropriate before a full reconnect
          // (called in _onDisconnected path) but NOT for display-takeover events.
          const delay = event.name === 'dashboard_open' ? 0 : 300;
          setTimeout(() => this._sendSilent(side), delay);
        }

        this.eventHandlers.forEach(h => h(event));
      }
      return;
    }

    if (op === P.OP_BATTERY) {
      this._log(`[G1] BATTERY raw [${side}]:`, Array.from(data).map(b => b.toString(16).padStart(2,'0')).join(' '));
      // resp[2] = battery % (confirmed from raw log). Each glass reports its own.
      const level = data[2] ?? 0;
      if (side === 'L') this.status.left.batteryPct = level;
      if (side === 'R') this.status.right.batteryPct = level;
      this.onStatusChange?.({ left: { ...this.status.left }, right: { ...this.status.right }, firmwareVersion: this.status.firmwareVersion });
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
    this._send(side, P.silent(true)).catch(() => {});
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
    if (!ch || !dev) return;

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
    }
  }

  /**
   * Send to LEFT, await ACK, then send to RIGHT.
   * This is the mandatory order required by the G1 firmware — sending both
   * in parallel (Promise.all) results in dropped or corrupted frames.
   */
  private async _sendBoth(data: Uint8Array): Promise<void> {
    await this._send('L', data);
    await this._send('R', data);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  private _hbCount = 0;

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this._hbCount = 0;
    // Heartbeat direction: the firmware sends 0x25 to us and we echo it back
    // in _onNotify. We only use this timer for periodic battery polling.
    this.heartbeatTimer = setInterval(async () => {
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

  private _setConnected(side: Side, connected: boolean): void {
    if (side === 'L') {
      this.status.left.connected = connected;
      if (!connected) { this.status.left.rssi = null; this.status.left.txReady = false; }
    }
    if (side === 'R') {
      this.status.right.connected = connected;
      if (!connected) { this.status.right.rssi = null; this.status.right.txReady = false; }
    }
    this.onStatusChange?.({
      left:  { ...this.status.left },
      right: { ...this.status.right },
      firmwareVersion: this.status.firmwareVersion,
    });
  }
}
