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
