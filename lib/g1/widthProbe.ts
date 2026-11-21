/**
 * widthProbe.ts — MEASURE the real G1 firmware line width, don't trust the spec.
 *
 * We ship raw strings via sendText (0x71 TEXT); the GLASSES FIRMWARE wraps and
 * renders them with its own font. So "36 chars/line" from the teleprompter spec
 * is an unverified claim. This probe produces frames you read off the lens to
 * find the TRUE wrap column — and to see whether the font is monospaced at all
 * (if proportional, "chars per line" isn't even a fixed number).
 *
 * Also exposes the real hard limit the packet layer imposes: text() truncates to
 * 191 UTF-8 BYTES per frame (packets.ts). That's bytes, not chars — multibyte
 * glyphs (·, accented names) eat the budget faster.
 *
 * Usage (dev screen or REPL):
 *   import { WIDTH_PROBE_FRAMES } from '@/lib/g1/widthProbe';
 *   for (const f of WIDTH_PROBE_FRAMES) { await g1.sendText(f.text, 1, 1, false, undefined, OWNER); await wait(2500); }
 * Read each frame on the lens and note where it wraps. The digit ruler lets you
 * count the exact column; the "FILL" lines show whether a run of identical chars
 * wraps at the same column as mixed text (reveals proportional vs monospaced).
 */

/** Per-frame UTF-8 byte cap enforced by packets.text() — the real hard limit. */
export const TEXT_FRAME_BYTE_CAP = 191;

/** UTF-8 byte length of a string (what the firmware truncation actually counts). */
export function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** A tens/units ruler of `n` columns: "123456789012..." so you can read the
 *  wrap column directly off the lens. Pair rows: tens marker above units. */
export function ruler(n: number): string {
  let tens = '';
  let units = '';
  for (let i = 1; i <= n; i++) {
    units += String(i % 10);
    tens += i % 10 === 0 ? String((i / 10) % 10) : ' ';
  }
  return `${tens}\n${units}`;
}

/** A line of exactly `n` identical chars — if the font is monospaced, a FILL of
 *  width W and a mixed-text line of width W wrap at the same column. If FILL
 *  wraps later/earlier than mixed text, the font is PROPORTIONAL. */
export function fill(ch: string, n: number): string {
  return ch.repeat(n);
}

export interface ProbeFrame {
  name: string;
  text: string;
  cols: number;   // intended character width of the probe line
  bytes: number;  // actual UTF-8 bytes (watch for >191)
}

function frame(name: string, text: string, cols: number): ProbeFrame {
  return { name, text, cols, bytes: byteLen(text) };
}

/**
 * The probe set. Each frame tests one hypothesis about the wrap column.
 * Widths bracket the claimed 36 so you can see it wrap short OR long of it.
 */
export const WIDTH_PROBE_FRAMES: ProbeFrame[] = [
  // 1) Ruler: read the exact wrap column off the lens.
  frame('ruler-44', ruler(44), 44),

  // 2) Monospaced-vs-proportional: same width, three char classes. If all three
  //    wrap at the same column → monospaced. If 'W' wraps earlier and 'i' later
  //    → proportional, and a fixed char count is meaningless.
  frame('fill-i-40', fill('i', 40), 40),
  frame('fill-W-40', fill('W', 40), 40),
  frame('fill-M-40', fill('M', 40), 40),

  // 3) Realistic words at bracketing widths. 'x' markers at col 30/34/36/40 so
  //    you can see precisely which fits on one line and which wraps.
  frame('word-30', 'Columbus Blue Jackets host the X', 32),
  frame('word-36', 'New Orleans Pelicans vs. Oklahoma CX', 36),
  frame('word-40', 'New Orleans Pelicans vs. Oklahoma City X', 40),
  frame('word-44', 'New Orleans Pelicans vs. Oklahoma City Thu X', 44),

  // 4) Multibyte reality check: the header middot "·" is 2 UTF-8 bytes. This
  //    string is 36 CHARS but >36 BYTES — shows char count ≠ byte budget.
  frame('middot-36', 'Montréal · Peñarol · São Paulo FC XX', 36),

  // 5) Byte-cap edge: a line near the 191-byte frame cap to confirm truncation
  //    point (everything past 191 bytes is dropped by packets.text()).
  frame('bytecap-190', fill('A', 190), 190),
  frame('bytecap-200', fill('B', 200), 200), // last 9 should be CLIPPED on lens
];
