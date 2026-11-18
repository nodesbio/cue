/**
 * readTime.ts — how long a script takes at the current scroll speed.
 *
 * The engine shows one new line every `secondsPerLine` and ends one tick after
 * the last line appears (TeleprompterEngine._advance), so N lines run for
 * N × secondsPerLine from the top. readTime.test.ts pins this against the real
 * engine so the readout cannot drift from what the glasses do.
 */
import { wrapScriptWithOffsets } from './lineWrapper';

/** Seconds until the script ends from `topIndex`, or null in manual mode (no timer). */
export function remainingSeconds(
  topIndex: number,
  totalLines: number,
  secondsPerLine: number,
): number | null {
  if (!Number.isFinite(secondsPerLine) || secondsPerLine <= 0) return null;
  return Math.max(0, totalLines - topIndex) * secondsPerLine;
}

/** Countdown style for the presenter: "4:05", "1:02:07". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Rounded length for the script list: "<1 min", "12 min", "1 hr 5 min". */
export function formatReadTime(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/**
 * Length of a whole script as shown in the Scripts list. Wraps with the same
 * function the engine loads with, so the line count matches the glasses.
 * Manual mode has no pace, so it falls back to the line count.
 */
export function scriptLengthLabel(text: string, secondsPerLine: number): string {
  const lines = wrapScriptWithOffsets(text).lines.length;
  const secs = remainingSeconds(0, lines, secondsPerLine);
  if (secs === null) return `${lines.toLocaleString()} ${lines === 1 ? 'line' : 'lines'}`;
  return formatReadTime(secs);
}
