/**
 * StreamQueueStore.ts — persisted, pre-wrapped stream queue for the core loop
 * (#49, resilience half).
 *
 * The core loop is "fall asleep seeing OSU narratives": pick articles on the
 * phone, drop it in your pocket, and watch full prose scroll past your eyes on
 * the lens. The phone screen WILL lock, the OS WILL background us, and on a bad
 * night it WILL cold-kill the app mid-stream. None of that is an error — it's
 * the expected operating condition for a sleep device.
 *
 * So we persist the ASSEMBLED stream, not just the picked ids: the wrapped
 * ≤45-col lines, the surfaced skips, and the current window top. A cold resume
 * replays exactly where you were WITHOUT a network round-trip — because you
 * cannot assume connectivity at 3am, and re-fetching risks a different article
 * body (ESPN edits stories) or a now-empty body. We froze the prose at pick
 * time; we replay that frozen copy. (Watkins: don't trust the network to still
 * return the same thing; trust the snapshot you took.)
 *
 * LAYOUT: a single versioned key holding the whole snapshot. Like SeenStore and
 * unlike AudienceStore's index+entries split, a stream queue is read/written
 * whole and is small (a 10-article queue of ~50 lines each is ~25KB JSON, far
 * under AsyncStorage's limits), so one atomic key is simplest and correct.
 *
 * CORRUPT DATA (Zoracon, best-practices #32): reads THROW StreamQueueError
 * rather than silently returning an empty queue. A silent empty here would look
 * identical to "you finished the stream" and the lens would just stay dark — a
 * mask of a parse failure as if it were normal completion. Surfacing lets the
 * UI decide (dropping back to the picker is a reasonable response, but it must
 * be a CHOICE). Mirrors SeenStore / AudienceStore stance exactly.
 *
 * Article ids inside the lines are the stable ESPN numeric ids (as strings) —
 * the same key SeenStore, fetchArticleBody, and the picker all join on.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StreamLine, SkippedArticle } from './useArticleStream';

const QUEUE_KEY = 'stream_queue_v1';

/** Schema version baked into the snapshot so a future shape change is detectable. */
const SCHEMA_VERSION = 1;

/**
 * A frozen, resumable stream. `lines` and `skipped` are exactly what
 * assembleStream produced at pick time; `index` is the window top to resume at;
 * `savedAt` stamps when it was frozen (for a future "too stale to resume" rule).
 */
export interface StreamQueueSnapshot {
  version: number;
  lines: StreamLine[];
  skipped: SkippedArticle[];
  index: number;
  savedAt: number;
}

/** Raised when the stored queue can't be parsed — surfaced, never swallowed. */
export class StreamQueueError extends Error {
  constructor(message: string, readonly key: string) {
    super(message);
    this.name = 'StreamQueueError';
  }
}

// ── Validation (strict — a half-valid snapshot is a corrupt snapshot) ─────────

function isStreamLine(v: unknown): v is StreamLine {
  if (v === null || typeof v !== 'object') return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.articleId === 'string' &&
    typeof l.isHead === 'boolean' &&
    typeof l.text === 'string'
  );
}

function isSkipped(v: unknown): v is SkippedArticle {
  if (v === null || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return typeof s.articleId === 'string' && typeof s.reason === 'string';
}

function parseOrThrow(raw: string): StreamQueueSnapshot {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new StreamQueueError(`Stored stream queue at "${QUEUE_KEY}" is corrupt and could not be read.`, QUEUE_KEY);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new StreamQueueError(`Stored stream queue at "${QUEUE_KEY}" is not an object.`, QUEUE_KEY);
  }
  const s = v as Record<string, unknown>;
  if (s.version !== SCHEMA_VERSION) {
    throw new StreamQueueError(
      `Stored stream queue at "${QUEUE_KEY}" has version ${String(s.version)}, expected ${SCHEMA_VERSION}.`,
      QUEUE_KEY,
    );
  }
  if (!Array.isArray(s.lines) || !s.lines.every(isStreamLine)) {
    throw new StreamQueueError(`Stored stream queue at "${QUEUE_KEY}" has malformed lines.`, QUEUE_KEY);
  }
  if (!Array.isArray(s.skipped) || !s.skipped.every(isSkipped)) {
    throw new StreamQueueError(`Stored stream queue at "${QUEUE_KEY}" has malformed skipped list.`, QUEUE_KEY);
  }
  if (typeof s.index !== 'number' || !Number.isInteger(s.index) || s.index < 0) {
    throw new StreamQueueError(`Stored stream queue at "${QUEUE_KEY}" has an invalid index.`, QUEUE_KEY);
  }
  if (typeof s.savedAt !== 'number') {
    throw new StreamQueueError(`Stored stream queue at "${QUEUE_KEY}" has an invalid savedAt.`, QUEUE_KEY);
  }
  // Clamp a resumed index into range — the lines are the source of truth. A
  // snapshot saved at the last window could legitimately sit at lines.length-1.
  return {
    version: SCHEMA_VERSION,
    lines: s.lines as StreamLine[],
    skipped: s.skipped as SkippedArticle[],
    index: Math.min(s.index as number, Math.max(0, (s.lines as StreamLine[]).length - 1)),
    savedAt: s.savedAt as number,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Load the saved stream, or null if none. Throws StreamQueueError on corruption. */
export async function loadStreamQueue(): Promise<StreamQueueSnapshot | null> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return null;
  return parseOrThrow(raw);
}

/**
 * Freeze the given assembled stream so a lock / background / cold-kill can
 * resume it offline. Called once at pick→play and then on index changes so the
 * resume point tracks where you actually are. An empty `lines` clears the queue
 * (nothing to resume into).
 */
export async function saveStreamQueue(
  lines: StreamLine[],
  skipped: SkippedArticle[],
  index: number,
  savedAt: number = Date.now(),
): Promise<void> {
  if (lines.length === 0) {
    await AsyncStorage.removeItem(QUEUE_KEY);
    return;
  }
  const snap: StreamQueueSnapshot = {
    version: SCHEMA_VERSION,
    lines,
    skipped,
    index: Math.max(0, Math.min(index, lines.length - 1)),
    savedAt,
  };
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(snap));
}

/**
 * Update ONLY the resume index of the saved queue, cheaply, without rewriting
 * the (larger) lines payload. No-op if there's no saved queue. Used on every
 * window tick so a cold-kill resumes at the right line without re-serializing
 * all the prose each advance.
 */
export async function saveResumeIndex(index: number): Promise<void> {
  const snap = await loadStreamQueue();
  if (!snap) return;
  snap.index = Math.max(0, Math.min(index, snap.lines.length - 1));
  snap.savedAt = Date.now();
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(snap));
}

/** Clear the saved queue — e.g. play-through-to-end, or "back to picking". */
export async function clearStreamQueue(): Promise<void> {
  await AsyncStorage.removeItem(QUEUE_KEY);
}

// ── Pure helpers (no I/O — unit-testable) ──────────────────────────────────────

/**
 * Is a resumed snapshot still worth replaying? A stream frozen days ago is
 * last night's narratives — you probably want fresh picks, not a stale replay.
 * Pure so the "offer resume?" decision is testable without storage. Returns
 * false for a finished stream (index at/after the last line → nothing left).
 */
export function isResumable(
  snap: StreamQueueSnapshot | null,
  maxAgeMs: number,
  now: number = Date.now(),
): boolean {
  if (!snap || snap.lines.length === 0) return false;
  if (snap.index >= snap.lines.length - 1) return false;
  return now - snap.savedAt <= maxAgeMs;
}
