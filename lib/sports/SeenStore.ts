/**
 * SeenStore.ts — persisted "already streamed" set for the article picker (#49
 * content depth, dedup half).
 *
 * The 20 catalog sources give ~1000 pickable articles, but a NIGHTLY listener
 * recycles the same team's recent headlines night after night. This store
 * records which article ids you've already streamed to the end so the picker can
 * mark/hide them and always surface what's NEW. That's the retention lever: the
 * well only feels bottomless if you never re-see last night's articles.
 *
 * LAYOUT: a single versioned key holding an { articleId: seenAtMs } map. Unlike
 * AudienceStore's index+entries layout, a seen-set is small and always
 * read/written whole, so one key is simpler and atomic. We store a TIMESTAMP,
 * not a bare bool, so a future "forget after N days" lets content recycle
 * deliberately (you WANT to re-read a great article a month later) instead of
 * never — see forgetOlderThan.
 *
 * CORRUPT DATA (Zoracon, best-practices #32): reads THROW SeenStoreError rather
 * than silently returning an empty set. An empty set here means "you've seen
 * nothing" → the picker would resurface everything as if new; surfacing the
 * error lets the UI decide (show-all is a reasonable fallback, but it must be a
 * CHOICE, not a silent mask of a parse failure). Mirrors AudienceStore's stance.
 *
 * Article ids are the stable ESPN numeric ids (as strings) that join the picker
 * list to fetchArticleBody — the same key everything else in #49 uses.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const SEEN_KEY = 'articles_seen_v1';

/** id → epoch ms when it was streamed to the end. */
export type SeenMap = Record<string, number>;

/** Raised when the stored seen-set can't be parsed — surfaced, never swallowed. */
export class SeenStoreError extends Error {
  constructor(message: string, readonly key: string) {
    super(message);
    this.name = 'SeenStoreError';
  }
}

function parseOrThrow(raw: string): SeenMap {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new SeenStoreError(`Stored seen-set at "${SEEN_KEY}" is corrupt and could not be read.`, SEEN_KEY);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new SeenStoreError(`Stored seen-set at "${SEEN_KEY}" is not an object map.`, SEEN_KEY);
  }
  return v as SeenMap;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Load the full seen-set. Throws SeenStoreError on corrupt data. */
export async function loadSeen(): Promise<SeenMap> {
  const raw = await AsyncStorage.getItem(SEEN_KEY);
  if (!raw) return {};
  return parseOrThrow(raw);
}

/**
 * Mark one or more article ids as streamed-to-end, stamping each with `at`
 * (default now). Merges into the existing set; re-marking refreshes the stamp.
 * No-op for an empty id list.
 */
export async function markSeen(ids: string[], at: number = Date.now()): Promise<SeenMap> {
  if (ids.length === 0) return loadSeen();
  const seen = await loadSeen();
  for (const id of ids) seen[id] = at;
  await AsyncStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  return seen;
}

/**
 * Drop entries older than `maxAgeMs` (relative to `now`) so content recycles
 * deliberately — a great article re-surfaces after the window instead of being
 * suppressed forever. Returns the pruned set. No write if nothing was dropped.
 */
export async function forgetOlderThan(maxAgeMs: number, now: number = Date.now()): Promise<SeenMap> {
  const seen = await loadSeen();
  const cutoff = now - maxAgeMs;
  let dropped = false;
  for (const [id, at] of Object.entries(seen)) {
    if (at < cutoff) { delete seen[id]; dropped = true; }
  }
  if (dropped) await AsyncStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  return seen;
}

/** Wipe the entire seen-set (e.g. a "show me everything again" reset). */
export async function clearSeen(): Promise<void> {
  await AsyncStorage.removeItem(SEEN_KEY);
}

// ── Pure helpers (no I/O — unit-testable) ────────────────────────────────────

/** An item carrying the id the seen-set keys on. NewsItem satisfies this. */
export interface HasId { id: string; }

/** Split a list into { fresh, seen } by membership in the seen-set. Order-stable. */
export function partitionBySeen<T extends HasId>(items: T[], seen: SeenMap): { fresh: T[]; seen: T[] } {
  const freshOut: T[] = [];
  const seenOut: T[] = [];
  for (const it of items) {
    if (Object.prototype.hasOwnProperty.call(seen, it.id)) seenOut.push(it);
    else freshOut.push(it);
  }
  return { fresh: freshOut, seen: seenOut };
}
