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
  /** Serialise all _connectLens calls so L and R never race on iOS BLE. */
  private _lensConnectQueue: Promise<void> = Promise.resolve();
  /**
   * Generation counter per side. Incremented each time _connectLens runs.
   * The onDisconnected closure captures its generation at creation time and
   * no-ops if a newer connection has since replaced it — prevents stale
   * disconnect handlers from corrupting a healthy reconnected session.
   */
  private _connGen: Record<Side, number> = { L: 0, R: 0 };
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
    onUpdate: (pairs: Record<string, Partial<Record<Side, Device>> & { firmware?: string }>) => void,
  ): Promise<void> {
    const pairs: Record<string, Partial<Record<Side, Device>> & { firmware?: string }> = {};
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
      this._lensConnectQueue = this._lensConnectQueue.then(async () => {
        if (this.destroyed) return;
        try { await this._connectLens(side, dev); }
        catch { this._scheduleReconnect(side); }
      });
    }
  }

  async disconnect(): Promise<void> {
    this._connectingPromise = null;
    this._lensConnectQueue = Promise.resolve();
    this._stopHeartbeat();
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
      this._setConnected(side, false);
    }
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
   * newScreen defaults to NEW_SCREEN_MANUAL (0x30) — use
   * NewScreen.CONTINUATION_MANUAL (0x40) for subsequent pages of the same
   * logical sequence so the firmware doesn't clear the screen between packets.
   */
  async sendText(
    str: string,
    curLine = 1,
    totalLines = 1,
    newScreen: P.NewScreenValue = P.NewScreen.NEW_SCREEN_MANUAL,
  ): Promise<void> {
    return this._enqueue(async () => {
      const packet = P.text(str, this._nextSeq(), curLine, totalLines, newScreen);
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
    // Brightness only needs to go to right lens per protocol
    await this._send('R', P.brightness(level, auto));
  }

  async requestBattery(): Promise<void> {
    await this._sendBoth(P.batteryRequest());
  }

  async exitToDashboard(): Promise<void> {
    await this._sendBoth(P.exitToDashboard());
  }

  destroy(): void {
    this.destroyed = true;
    this._stopHeartbeat();
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
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        sub.remove();
        reject(new Error('Bluetooth not powered on — check device settings'));
      }, 5000);
      const sub = this.manager.onStateChange((state) => {
        if (state === State.PoweredOn && !settled) {
          settled = true;
          clearTimeout(t);
          sub.remove();
          resolve();
        }
      }, true);
    });
  }

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
      const connected = await this.manager.connectedDevices([P.UART_SVC]);
      const found: Partial<Record<Side, Device>> = {};
      for (const device of connected) {
        const side = this._parseSide(device);
        if (!side) continue;
        if (channel) {
          const ch = this._parseChannel(device);
          if (ch !== channel) continue;
        }
        found[side] = device;
      }
      if (found.L && found.R) {
        this._log('[G1] Both lenses already connected — skipping scan');
        await this._connectLens('L', found.L);
        await this._connectLens('R', found.R);
        this._startHeartbeat();
        return true;
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
            clearTimeout(timeout);
            this.manager.stopDeviceScan();
            done(async () => {
              try {
                await this._connectLens('L', found.L!);
                await this._connectLens('R', found.R!);
                this._startHeartbeat();
                resolve();
              } catch (e) {
                reject(e);
              }
            });
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
        const side: Side = buf[0] === 0x02 ? 'L' : 'R';
        const firmware = String.fromCharCode(...buf.slice(2, 8)).replace(/\0/g, '');
        const serial   = String.fromCharCode(...buf.slice(8, 15)).replace(/\0/g, '');
        if (serial.length > 0) return { side, serial, firmware };
      } catch {}
    }
    // Fallback: parse from name
    const name = device.name ?? '';
    const m = name.match(/G1_(\d+)_([LR])_([0-9A-Fa-f]+)/);
    if (m) {
      return { side: m[2] as Side, serial: `name-ch${m[1]}`, firmware: 'unknown' };
    }
    return null;
  }

  /** Extract channel/pair key from device. Uses serial from manufacturerData (preferred) or channel from name. */
  private _parseChannel(device: Device): string | null {
    const parsed = this._parseManufacturerData(device);
    if (parsed) return parsed.serial;
    // last-resort: name-based channel number
    const m = (device.name ?? '').match(/G1_(\d+)_[LR]/);
    return m ? m[1] : null;
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

  private async _connectLens(side: Side, device: Device): Promise<void> {
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
          // Mark lens as actually usable (not just OS-connected)
          if (side === 'L') this.status.left.txReady = true;
          if (side === 'R') this.status.right.txReady = true;
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

    // Handshake
    await this._send(side, P.handshake());
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
    this._setConnected(side, false);
    this.txChars[side] = undefined;
    this._scheduleReconnect(side);
  }

  private _scheduleReconnect(side: Side): void {
    if (this.destroyed) return;
    const attempts = this.reconnectAttempts[side] ?? 0;
    const delay = RECONNECT_BACKOFF_MS[Math.min(attempts, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempts[side] = attempts + 1;
    setTimeout(async () => {
      if (this.destroyed) return;
      const dev = this.devices[side];
      if (!dev) return;
      // Enqueue so L and R reconnects never race — iOS BLE cancels concurrent connects.
      this._lensConnectQueue = this._lensConnectQueue.then(async () => {
        if (this.destroyed) return;
        try {
          await this._connectLens(side, dev);
        } catch {
          this._scheduleReconnect(side);
        }
      });
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
        // Monitor subscription is dead — ensure state is cleaned up immediately
        // (onDisconnected will fire too, but this closes the gap)
        this._setConnected(side, false);
        this.txChars[side] = undefined;
        return; // not an unexpected error — don't log
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
    const ackKey = `${side}${op.toString(16).padStart(2, '0')}`;
    const pending = this._pendingAck.get(ackKey);
    if (pending) {
      clearTimeout(pending.timer);
      this._pendingAck.delete(ackKey);
      const status = data[1];
      pending.resolve(status === P.R_STATUS_OK || status === P.R_STATUS_OK2);
      return;
    }

    if (op === P.OP_EVENT) {
      const event = P.parseEvent(data, side);
      if (event) this.eventHandlers.forEach(h => h(event));
      return;
    }

    if (op === P.OP_BATTERY) {
      this._log(`[G1] BATTERY raw [${side}]:`, Array.from(data).map(b => b.toString(16).padStart(2,'0')).join(' '));
      // resp[2] = battery % (confirmed from raw log). Each glass reports its own.
      const level = data[2] ?? 0;
      if (side === 'L') this.status.left.batteryPct = level;
      if (side === 'R') this.status.right.batteryPct = level;
      this.onStatusChange?.({ left: { ...this.status.left }, right: { ...this.status.right } });
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
        const timer = setTimeout(() => {
          this._pendingAck.delete(ackKey);
          this._log(`[G1] _send [${side}] ACK timeout op=0x${opHex}`);
          resolve(false);
        }, 2000);
        this._pendingAck.set(ackKey, { resolve, timer });
      });
    }

    try {
      await dev.writeCharacteristicWithResponseForService(
        P.UART_SVC, P.UART_TX, b64,
      );
    } catch (e: any) {
      // Clean up the ACK waiter we registered above.
      if (awaitAck) {
        const waiter = this._pendingAck.get(ackKey);
        if (waiter) { clearTimeout(waiter.timer); this._pendingAck.delete(ackKey); }
      }
      const code = (e as BleError)?.errorCode;
      if (code === BleErrorCode.DeviceDisconnected || code === BleErrorCode.OperationCancelled) return;
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
    this.heartbeatTimer = setInterval(async () => {
      await this._sendBoth(P.heartbeat(this._nextSeq()));
      // Poll battery every 4th heartbeat (~32s)
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
    });
  }
}
