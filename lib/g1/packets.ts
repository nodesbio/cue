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
// Response status bytes — appear at data[1] in firmware ACK packets.
// data[0] echoes back the command opcode (e.g. 0x4E for text, 0x15 for BMP).
// 0xC9 and 0xCB both indicate success; anything else is a NACK.
export const R_STATUS_OK  = 0xC9;
export const R_STATUS_OK2 = 0xCB; // also success — used in BMP/list responses
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

/**
 * newScreen byte — composite of two independent nibbles per the official spec:
 *
 *   Upper nibble (Even AI / display mode):
 *     0x30 = Even AI displaying — automatic mode (mid-scroll)
 *     0x40 = Even AI display complete — last page of automatic mode
 *     0x50 = Even AI manual mode
 *     0x60 = Even AI network error
 *
 *   Lower nibble (screen action):
 *     0x01 = display new content  ← must always be set; 0x00 = no-op
 *
 *     0x70 = Text / teleprompter surface (undocumented in README; it is what
 *            the official text_service.dart sends for EVERY frame)
 *
 *   Lower nibble (screen action):
 *     0x01 = display new content  ← must always be set; 0x00 = no-op
 *
 * Firmware behaviour (even_realities_decomp ble_process_req_dispatch.c, case
 * 0x4e, final chunk):
 *   0x6x → always accepted, state 10 (Even AI reply)
 *   0x7x → always accepted, state 0x0f (text surface)
 *   0x3x/0x4x/0x5x → only accepted when dashboard state is already ≥ 7,
 *                    i.e. an Even AI session is open. Without one the frame
 *                    is stored but the state machine does NOT switch to it,
 *                    and the firmware starts emitting F5 00 ("exit to
 *                    dashboard") about once a second until it is cleared.
 *
 * That F5 00 storm (104 events in one 2026-11-04 session) was being decoded
 * as a user double-tap and rewinding the script. 0x71 is the only byte that
 * renders unconditionally for a non-AI app. Verified on-device 2026-11-04:
 * "PROBE 0x71" rendered on both lenses with zero F5 00 events afterwards.
 */
export const NewScreen = {
  /** Auto-display, mid-scroll (Even AI session only). */
  AUTO_MID:     0x31,
  /** Auto-display, last page (Even AI session only). */
  AUTO_LAST:    0x41,
  /** Manual mode (Even AI session only) — do NOT use for teleprompter text. */
  MANUAL:       0x51,
  /** Network/AI error state. */
  ERROR:        0x61,
  /** Teleprompter / plain text surface. Use this for all Cue frames. */
  TEXT:         0x71,
} as const;
export type NewScreenValue = typeof NewScreen[keyof typeof NewScreen];

// ── Event name map ─────────────────────────────────────────────────────────
// WARNING: these opcode→name mappings are derived from community reverse-
// engineering of the Even Realities G1 app, NOT from firmware source.
// Treat all names as working hypotheses until verified against a primary
// source (firmware disassembly or official SDK). In particular:
//   0x11 ('connection_error') — observed firing during active teleprompter
//         use with no visible overlay; true semantics unclear. See issue #18.
//   0x17 ('ai_start')        — assumed triple-tap / Even AI trigger.
//   0x1e/0x1f ('dashboard_open/close') — assumed dashboard gesture.
export const EVENT_NAMES: Record<number, string> = {
  // 0x00 is NOT a tap. Per EvenDemoApp README ("subcmd 0: exit to dashboard
  // manually — stop all advanced features") and ble_manager.dart (case 0 →
  // App.exitAll()). The firmware emits it ~1/s while it is rejecting the
  // current screen (see NewScreen doc). Gesture handlers must ignore it.
  0x00: 'exit_to_dashboard',
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
  0x11: 'status_ping',       // fires after every battery poll response (0x2c); NOT an overlay signal
  0x12: 'brightness_level',  // decomp deal_event_to_phone.c: F5 12 <level>; sent once after connect
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
 * Header: [4E, seq, total=1, cur=0, newScreen, 00, 00, cur_page, max_page] + text
 *
 * curPage / maxPage are used by the status bar to show e.g. "▶ 14/56".
 * For the teleprompter, pass the current line index and total line count.
 *
 * isLastPage: set true on the final packet of a sequence so the firmware
 * receives NewScreen.AUTO_LAST (0x41) and knows the transmission is complete.
 * All other packets use NewScreen.AUTO_MID (0x31) — the "displaying" state.
 *
 * Pass newScreen explicitly to override (e.g. NewScreen.MANUAL for manual mode).
 */
export function text(
  str: string,
  seq: number,
  curPage = 1,
  maxPage = 1,
  newScreen: NewScreenValue = NewScreen.AUTO_MID,
): Uint8Array {
  const encoded = new TextEncoder().encode(str).slice(0, 191);
  const header = u8(OP_TEXT, seq & 0xff, 1, 0, newScreen, 0x00, 0x00, curPage & 0xff, maxPage & 0xff);
  return concat(header, encoded);
}

// ── Info requests ──────────────────────────────────────────────────────────

/**
 * 0x2C device-info/battery request. data[1] is the PHONE PLATFORM, not a
 * sub-command: firmware ble_proto.c:3238 sets phone_is_ios = (data[1]==2).
 * threads.c:2992 arms a 30 s no-RX disconnect watchdog only when
 * !phone_is_ios — always sending 0x01 from an iPhone opted us into that
 * watchdog (the ~31 s R drops the heartbeat experiment was masking).
 * Caller passes the platform so this module stays free of RN imports.
 */
export const PHONE_ANDROID = 0x01;
export const PHONE_IOS = 0x02;
export function batteryRequest(phone: number = PHONE_ANDROID): Uint8Array {
  return u8(OP_BATTERY, phone);
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

/**
 * Parse a per-lens battery notification.
 * Each lens sends: [2C] [status=66] [battery_pct 0-100] [voltage_hi] [voltage_lo] ...
 * batteryLeft/Right are the same value — caller assigns to the correct side.
 */
export function parseBatteryInfo(resp: Uint8Array): BatteryInfo | null {
  if (!resp || resp.length < 3 || resp[0] !== OP_BATTERY) return null;
  const pct = resp[2];
  return { batteryLeft: pct, batteryRight: pct };
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
