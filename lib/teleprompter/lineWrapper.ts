/**
 * lineWrapper.ts — pure text → string[] line list.
 *
 * Converts a raw script string into a flat array of display lines,
 * each ≤ MAX_CHARS characters, word-wrapped. Blank lines in the source
 * are preserved as empty strings (natural paragraph pauses in the rolling
 * window).
 *
 * No side-effects, no BLE dependencies — fully unit-testable.
 */

export const MAX_CHARS = 45;

/**
 * Wrap a single paragraph (no newlines) into lines of ≤ maxChars.
 * Breaks at word boundaries; hard-breaks words longer than maxChars.
 */
export function wrapParagraph(text: string, maxChars = MAX_CHARS): string[] {
  if (text.trim() === '') return [''];

  const lines: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  let current = '';

  for (const word of words) {
    // Word itself exceeds maxChars — hard break it
    if (word.length > maxChars) {
      if (current.length > 0) {
        lines.push(current);
        current = '';
      }
      let remaining = word;
      while (remaining.length > maxChars) {
        lines.push(remaining.slice(0, maxChars));
        remaining = remaining.slice(maxChars);
      }
      current = remaining;
      continue;
    }

    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Convert a full script string into a flat array of display lines.
 *
 * Rules:
 * - Split on newlines to get paragraphs
 * - Each non-empty paragraph is word-wrapped at maxChars
 * - Empty lines (blank lines between paragraphs) are preserved as ''
 *   so the rolling window shows a natural pause/gap
 * - Leading/trailing blank lines in the script are trimmed
 */
export function wrapScript(script: string, maxChars = MAX_CHARS): string[] {
  // Normalise line endings
  const raw = script.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Collapse 3+ consecutive blank lines to 2 (one visible gap is enough)
  const collapsed = raw.replace(/\n{3,}/g, '\n\n');

  // Trim leading/trailing whitespace
  const trimmed = collapsed.trim();

  if (trimmed === '') return [];

  const paragraphs = trimmed.split('\n');
  const lines: string[] = [];

  for (const para of paragraphs) {
    if (para.trim() === '') {
      lines.push(''); // preserve paragraph break as blank display line
    } else {
      lines.push(...wrapParagraph(para.trim(), maxChars));
    }
  }

  return lines;
}

/**
 * Given the flat line array and the current top-of-window index (0-based),
 * return the 4 content lines to display (lines 2–5; line 1 = status bar).
 *
 * Always returns exactly WINDOW_SIZE strings — pads with '' if near end.
 */
export const WINDOW_SIZE = 4;

export function getWindow(lines: string[], topIndex: number): string[] {
  const window: string[] = [];
  for (let i = topIndex; i < topIndex + WINDOW_SIZE; i++) {
    window.push(i < lines.length ? lines[i] : '');
  }
  return window;
}

/**
 * Format the full 5-line string to send to the glasses.
 *
 * Line 1: status bar  — e.g. "7:09 PM  ▶ 14/56"
 * Lines 2–5: content window
 */
export function formatFrame(
  statusBar: string,
  lines: string[],
  topIndex: number,
): string {
  const window = getWindow(lines, topIndex);
  return [statusBar, ...window].join('\n');
}

// ── Source-offset mapping (for resume markers) ──────────────────────────────

/**
 * Wrap a script AND report, for each produced display line, the character
 * offset into the ORIGINAL (untrimmed) source string where that line's text
 * begins. This is what makes a resume marker survive edits: we store a source
 * char offset, not a fragile wrapped-line index.
 *
 * The returned `lineStarts[i]` is the source offset of `lines[i]`. Blank
 * display lines (paragraph breaks) carry the offset of the blank source line.
 *
 * Implementation note: wrapScript() trims and collapses blank runs before
 * wrapping, so offsets are computed against the SAME normalised string the
 * caller passes in. Callers that need offsets relative to the raw stored text
 * should pass the raw text here and to wrapScript alike — both normalise
 * identically, so a marker captured via lineStarts round-trips through
 * resolveMarkerLine without drift.
 */
export interface WrappedWithOffsets {
  lines: string[];
  lineStarts: number[]; // lineStarts[i] = source char offset of lines[i]
}

export function wrapScriptWithOffsets(script: string, maxChars = MAX_CHARS): WrappedWithOffsets {
  const normalised = script.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const collapsed = normalised.replace(/\n{3,}/g, '\n\n');
  const trimmed = collapsed.trim();
  if (trimmed === '') return { lines: [], lineStarts: [] };

  // Offset of `trimmed` within `collapsed` (leading whitespace length).
  const leadOffset = collapsed.length - collapsed.trimStart().length;

  const lines: string[] = [];
  const lineStarts: number[] = [];

  // Walk paragraphs, tracking the running offset within `trimmed`.
  let cursor = 0; // offset into `trimmed`
  const paragraphs = trimmed.split('\n');
  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p];
    if (para.trim() === '') {
      lines.push('');
      lineStarts.push(leadOffset + cursor);
    } else {
      // Leading whitespace inside the paragraph is trimmed by wrapParagraph's
      // input; account for it so the first wrapped line points at the first word.
      const innerLead = para.length - para.trimStart().length;
      const wrapped = wrapParagraph(para.trim(), maxChars);
      // Find each wrapped line's offset by locating it within the paragraph,
      // scanning forward so repeated phrases map monotonically.
      let searchFrom = innerLead;
      for (const wl of wrapped) {
        const firstWord = wl.split(' ')[0] ?? '';
        const idx = para.indexOf(firstWord, searchFrom);
        const off = idx >= 0 ? idx : searchFrom;
        lines.push(wl);
        lineStarts.push(leadOffset + cursor + off);
        searchFrom = off + wl.length;
      }
    }
    cursor += para.length + 1; // +1 for the '\n' consumed by split
  }

  return { lines, lineStarts };
}

/**
 * Resolve a stored source char offset to the wrapped display-line index that
 * contains (or immediately follows) it. Returns the index of the last line
 * whose start is <= offset, clamped to [0, lines.length-1]. Returns 0 for an
 * empty script. Pure; safe to call on every load.
 */
export function resolveMarkerLine(lineStarts: number[], offset: number): number {
  if (lineStarts.length === 0) return 0;
  let lo = 0;
  let hi = lineStarts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) { ans = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return ans;
}

// ── Default onboarding script ──────────────────────────────────────────────

export const DEFAULT_SCRIPT = `Welcome to Cue.

This is your teleprompter.
Lines roll past one at a time
at your chosen pace.

Load your own script
from the Scripts tab,
or type one here.

Adjust speed with the
slider below. Tap Pause
any time to stop.

Tap Next to advance
one line manually, or let
Cue roll automatically.`;
