/**
 * packets.ts — pure G1 protocol packet builders.
 * Direct port of g1core/packets.py (EvenBridge, fw 1.6.6).
 * No BLE dependencies — all functions are bytes-in / bytes-out.
 */

// ── Nordic UART Service UUIDs ──────────────────────────────────────────────
export const UART_SVC = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const UART_TX  = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // write → glasses
export const UART_RX  = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // notify ← glasses

// ── Generic response bytes ─────────────────────────────────────────────────
export const R_OK   = 0xC9;
export const R_FAIL = 0xCA;
export const R_CONT = 0xCB;

// ── Opcodes ────────────────────────────────────────────────────────────────
export const OP_BRIGHTNESS = 0x01;
export const OP_SILENT     = 0x03;
export const OP_MIC        = 0x0E;
export const OP_BMP_DATA   = 0x15;
export const OP_BMP_CRC    = 0x16;
export const OP_EXIT       = 0x18;
export const OP_BMP_END    = 0x20;
export const OP_HEARTBEAT  = 0x25;
export const OP_BATTERY    = 0x2C;
export const OP_FW_INFO    = 0x23;
export const OP_SERIAL     = 0x34;
export const OP_TEXT       = 0x4E;
export const OP_AUDIO      = 0xF1;
export const OP_EVENT      = 0xF5;
export const OP_HANDSHAKE  = 0xF4;

// ── BMP constants ──────────────────────────────────────────────────────────
export const BMP_WIDTH  = 576;
export const BMP_HEIGHT = 136;
export const BMP_BYTES  = (BMP_WIDTH * BMP_HEIGHT) / 8; // 9792
export const BMP_ADDR   = new Uint8Array([0x00, 0x1c, 0x00, 0x00]);
export const BMP_CHUNK  = 194;

// Text Show newscreen byte
const NEWSCREEN_TEXT_SHOW = 0x71;

// ── Event name map ─────────────────────────────────────────────────────────
export const EVENT_NAMES: Record<number, string> = {
  0x00: 'double_tap',
  0x01: 'single_tap',
  0x02: 'head_up',
  0x03: 'head_down',
  0x04: 'triple_tap',
  0x05: 'triple_tap',
  0x06: 'glasses_worn',
  0x07: 'glasses_off',
  0x08: 'in_case',
  0x09: 'charging',
  0x0a: 'battery',
  0x0e: 'case_charging',
  0x0f: 'case_battery',
  0x11: 'connection_error',
  0x17: 'ai_start',
  0x18: 'record_over',
  0x1e: 'dashboard_open',
  0x1f: 'dashboard_close',
};

// ── Helpers ────────────────────────────────────────────────────────────────
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function u8(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

// ── System / keep-alive ────────────────────────────────────────────────────

export function handshake(): Uint8Array {
  return u8(OP_HANDSHAKE, 0x01);
}

export function heartbeat(seq: number): Uint8Array {
  const s = seq & 0xff;
  return u8(OP_HEARTBEAT, 0x06, 0x00, s, 0x04, s);
}

// ── Display ────────────────────────────────────────────────────────────────

export function brightness(level: number, auto = false): Uint8Array {
  const l = Math.max(0x00, Math.min(0x2a, Math.round(level)));
  return u8(OP_BRIGHTNESS, l, auto ? 0x01 : 0x00);
}

export function silent(on: boolean): Uint8Array {
  return u8(OP_SILENT, on ? 0x0c : 0x0a);
}

export function mic(on: boolean): Uint8Array {
  return u8(OP_MIC, on ? 0x01 : 0x00);
}

export function exitToDashboard(): Uint8Array {
  return u8(OP_EXIT);
}

/**
 * Single-packet text display (≤191 UTF-8 bytes).
 * Header: [4E, seq, total=1, cur=0, 71, 00, 00, cur_page=1, max_page=1] + text
 */
export function text(str: string, seq: number): Uint8Array {
  const encoded = new TextEncoder().encode(str).slice(0, 191);
  const header = u8(OP_TEXT, seq & 0xff, 1, 0, NEWSCREEN_TEXT_SHOW, 0x00, 0x00, 1, 1);
  return concat(header, encoded);
}

// ── Info requests ──────────────────────────────────────────────────────────

export function batteryRequest(): Uint8Array {
  return u8(OP_BATTERY, 0x02);
}

export function firmwareInfoRequest(): Uint8Array {
  return u8(OP_FW_INFO, 0x74);
}

export function serialRequest(): Uint8Array {
  return u8(OP_SERIAL);
}

// ── BMP (1-bit, 576×136) ───────────────────────────────────────────────────

/** CRC-32 (zlib/XZ) over [00,1C,00,00] + frame_1bit. */
export function bmpCrc32(frame: Uint8Array): number {
  const data = concat(BMP_ADDR, frame);
  return crc32(data);
}

/**
 * Slice 1-bit BMP into 0x15 packets of 194 B.
 * Chunk 0: [0x15, 0x00, 00 1C 00 00, ...194 B]
 * Others:  [0x15, index, ...194 B]
 */
export function bmpDataChunks(frame: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let index = 0;
  for (let off = 0; off < frame.length; off += BMP_CHUNK) {
    const piece = frame.slice(off, off + BMP_CHUNK);
    const header = index === 0
      ? concat(u8(OP_BMP_DATA, 0x00), BMP_ADDR)
      : u8(OP_BMP_DATA, index & 0xff);
    chunks.push(concat(header, piece));
    index++;
  }
  return chunks;
}

export function bmpEnd(): Uint8Array {
  return u8(OP_BMP_END, 0x0d, 0x0e);
}

export function bmpCrc(frame: Uint8Array): Uint8Array {
  const crc = bmpCrc32(frame);
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, crc, false); // big-endian
  return concat(u8(OP_BMP_CRC), new Uint8Array(view.buffer));
}

// ── Parsers ────────────────────────────────────────────────────────────────

export interface BatteryInfo {
  batteryLeft: number;
  batteryRight: number;
  version?: string;
}

export function parseBatteryInfo(resp: Uint8Array): BatteryInfo | null {
  if (!resp || resp.length < 4 || resp[0] !== OP_BATTERY) return null;
  const info: BatteryInfo = { batteryLeft: resp[2], batteryRight: resp[3] };
  if (resp.length >= 13) {
    info.version = `${resp[10]}.${resp[11]}.${resp[12]}`;
  }
  return info;
}

export function parseFirmwareString(resp: Uint8Array): string | null {
  if (!resp || resp.length === 0) return null;
  const nullIdx = resp.indexOf(0x00);
  const slice = nullIdx >= 0 ? resp.slice(0, nullIdx) : resp;
  return new TextDecoder('ascii').decode(slice);
}

export function parseSerial(resp: Uint8Array): string | null {
  if (!resp || resp.length < 18) return null;
  return new TextDecoder('ascii').decode(resp.slice(2, 18)).replace(/\x00/g, '');
}

export interface G1Event {
  subcmd: number;
  name: string;
  raw: Uint8Array;
  side: 'L' | 'R';
}

export function parseEvent(data: Uint8Array, side: 'L' | 'R'): G1Event | null {
  if (!data || data.length < 2 || data[0] !== OP_EVENT) return null;
  const subcmd = data[1];
  return {
    subcmd,
    name: EVENT_NAMES[subcmd] ?? 'unknown',
    raw: data,
    side,
  };
}

// ── CRC-32 (zlib/ISO-3309) — pure TS, no deps ─────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
