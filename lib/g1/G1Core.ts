/**
 * G1Core.ts — BLE connection manager for Even Realities G1 glasses.
 * Manages both lenses (L + R), heartbeat, ACK sequencing, and event callbacks.
 * Port of g1core/core.py (EvenBridge).
 */

import { BleManager, Device, State, Characteristic } from 'react-native-ble-plx';
import { encode as btoa } from 'base-64';
import * as P from './packets';

// ── Types ──────────────────────────────────────────────────────────────────

export type Side = 'L' | 'R';

export interface LensState {
  device: Device | null;
  connected: boolean;
  batteryPct: number;
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
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

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
  private seq = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts: Partial<Record<Side, number>> = { L: 0, R: 0 };

  public status: G1Status = {
    left:  { device: null, connected: false, batteryPct: 0 },
    right: { device: null, connected: false, batteryPct: 0 },
    firmwareVersion: null,
  };

  private onEvent?: EventHandler;
  private onStatusChange?: StatusHandler;

  constructor(opts?: { onEvent?: EventHandler; onStatusChange?: StatusHandler }) {
    this.manager = new BleManager();
    this.onEvent = opts?.onEvent;
    this.onStatusChange = opts?.onStatusChange;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    await this._ensureBleReady();
    await this._scan();
  }

  async disconnect(): Promise<void> {
    this._stopHeartbeat();
    for (const side of ['L', 'R'] as Side[]) {
      const dev = this.devices[side];
      if (dev) {
        try { await dev.cancelConnection(); } catch {}
        this.devices[side] = undefined;
        this.txChars[side] = undefined;
        this._setConnected(side, false);
      }
    }
  }

  get isConnected(): boolean {
    return !!(this.status.left.connected && this.status.right.connected);
  }

  /** Send a text string to both lenses. */
  async sendText(str: string): Promise<void> {
    const packet = P.text(str, this._nextSeq());
    await this._sendBoth(packet);
  }

  /** Send a pre-rendered 1-bit BMP frame to both lenses. */
  async sendBmp(frame: Uint8Array): Promise<void> {
    const chunks = P.bmpDataChunks(frame);
    for (const chunk of chunks) {
      await this._sendBoth(chunk);
    }
    await this._sendBoth(P.bmpCrc(frame));
    await this._sendBoth(P.bmpEnd());
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
    this._stopHeartbeat();
    this.manager.destroy();
  }

  // ── Scanning ──────────────────────────────────────────────────────────────

  private async _ensureBleReady(): Promise<void> {
    // Request permission (iOS 13+ / Android 12+)
    const granted = await this.manager.requestPermissions();
    if (!granted) throw new Error('Bluetooth permission denied');
    // Wait for BLE to power on (up to 5s)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Bluetooth not powered on')), 5000);
      this.manager.onStateChange((state) => {
        if (state === State.PoweredOn) { clearTimeout(t); resolve(); }
      }, true);
    });
  }

  /** Scan all BLE devices (no filter) and log names — for debugging. */
  async scanDebug(durationMs = 8000): Promise<string[]> {
    await this._ensureBleReady();
    const found: string[] = [];
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.manager.stopDeviceScan();
        resolve(found);
      }, durationMs);
      this.manager.startDeviceScan(null, { allowDuplicates: false }, (_err, device) => {
        if (device?.name) {
          const entry = `${device.name} [${device.id}]`;
          if (!found.includes(entry)) {
            found.push(entry);
            console.log('[BLE DEBUG]', entry);
          }
        }
      });
    });
  }

  private async _scan(): Promise<void> {
    return new Promise((resolve, reject) => {
      const found: Partial<Record<Side, Device>> = {};
      const timeout = setTimeout(() => {
        this.manager.stopDeviceScan();
        if (!found.L || !found.R) {
          reject(new Error('G1 glasses not found. Make sure they are on and in range.'));
        }
      }, SCAN_TIMEOUT_MS);

      this.manager.startDeviceScan(
        [P.UART_SVC],
        { allowDuplicates: false },
        async (error, device) => {
          if (error) {
            clearTimeout(timeout);
            reject(error);
            return;
          }
          if (!device?.name) return;

          const side = this._parseSide(device.name);
          if (!side) return;
          if (found[side]) return; // already found this side

          found[side] = device;

          if (found.L && found.R) {
            clearTimeout(timeout);
            this.manager.stopDeviceScan();
            try {
              await this._connectLens('L', found.L!);
              await this._connectLens('R', found.R!);
              this._startHeartbeat();
              resolve();
            } catch (e) {
              reject(e);
            }
          }
        },
      );
    });
  }

  /** Parse "Even G1_<ch>_L_<serial>" or legacy "G1_..._L_..." → Side */
  private _parseSide(name: string): Side | null {
    const normalized = name.replace('Even G1', 'G1');
    if (!normalized.startsWith('G1_')) return null;
    const parts = normalized.split('_');
    // format: G1_<ch>_L_<serial>  or  G1_L_<serial>
    for (const part of parts) {
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

    // Find TX characteristic (write)
    const services = await discovered.services();
    for (const svc of services) {
      if (svc.uuid.toLowerCase() !== P.UART_SVC) continue;
      const chars = await svc.characteristics();
      for (const ch of chars) {
        if (ch.uuid.toLowerCase() === P.UART_TX) {
          this.txChars[side] = ch;
        }
        if (ch.uuid.toLowerCase() === P.UART_RX && ch.isNotifiable) {
          await discovered.monitorCharacteristicForService(
            svc.uuid, P.UART_RX,
            (err, char) => this._onNotify(side, err, char),
          );
        }
      }
    }

    // Handshake
    await this._send(side, P.handshake());
    this._setConnected(side, true);
    this.reconnectAttempts[side] = 0;

    // Watch for disconnection
    discovered.onDisconnected(() => this._onDisconnected(side));
  }

  private _onDisconnected(side: Side): void {
    this._setConnected(side, false);
    this.txChars[side] = undefined;
    this._scheduleReconnect(side);
  }

  private _scheduleReconnect(side: Side): void {
    const attempts = this.reconnectAttempts[side] ?? 0;
    const delay = RECONNECT_BACKOFF_MS[Math.min(attempts, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempts[side] = attempts + 1;
    setTimeout(async () => {
      const dev = this.devices[side];
      if (!dev) return;
      try {
        await this._connectLens(side, dev);
      } catch {
        this._scheduleReconnect(side);
      }
    }, delay);
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  private _onNotify(side: Side, error: Error | null, char: Characteristic | null): void {
    if (error || !char?.value) return;
    const data = base64ToUint8(char.value);
    if (!data.length) return;

    const op = data[0];

    if (op === P.OP_EVENT) {
      const event = P.parseEvent(data, side);
      if (event) this.onEvent?.(event);
      return;
    }

    if (op === P.OP_BATTERY) {
      const info = P.parseBatteryInfo(data);
      if (info) {
        if (side === 'L') this.status.left.batteryPct = info.batteryLeft;
        if (side === 'R') {
          this.status.right.batteryPct = info.batteryRight;
          if (info.version) this.status.firmwareVersion = info.version;
        }
        this.onStatusChange?.(this.status);
      }
      return;
    }
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  private async _send(side: Side, data: Uint8Array): Promise<void> {
    const ch = this.txChars[side];
    const dev = this.devices[side];
    if (!ch || !dev) return;
    const b64 = uint8ToBase64(data);
    // writeWithoutResponse is fastest for streaming
    await dev.writeCharacteristicWithoutResponseForService(
      P.UART_SVC, P.UART_TX, b64,
    );
  }

  /** Send to left first, then right (per protocol ACK order). */
  private async _sendBoth(data: Uint8Array): Promise<void> {
    await this._send('L', data);
    await this._send('R', data);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      const packet = P.heartbeat(this._nextSeq());
      await this._sendBoth(packet);
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
    if (side === 'L') this.status.left.connected = connected;
    if (side === 'R') this.status.right.connected = connected;
    this.onStatusChange?.({ ...this.status });
  }
}
