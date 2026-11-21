/**
 * AudienceStore.ts — AsyncStorage-backed audience library for the
 * conversation deck (#44).
 *
 * Mirrors ScriptStore's shape: an index key holds an ordered list of ids,
 * each audience is stored under its own entry key, multiGet keeps listing
 * fast. See ScriptStore.ts for the rationale behind that layout.
 *
 * ONE DELIBERATE DIVERGENCE FROM ScriptStore (Zoracon, best-practices #32):
 * ScriptStore swallows corrupt JSON (`catch {}` / `catch { return [] }`) so a
 * single bad entry silently vanishes. For audiences that's the wrong trade —
 * an audience the user hand-built and relies on before a conversation must not
 * disappear without a word. Reads here THROW `AudienceStoreError` on corrupt
 * data so the UI can show "couldn't load your audiences" instead of rendering
 * an empty, apparently-wiped list. We fix the signal; we don't silence it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audience } from './audience';
import { AUDIENCE_TEMPLATES } from './templates';

const INDEX_KEY = 'audiences_index_v1';
const SEEDED_KEY = 'audiences_seeded_v1';
const entryKey = (id: string) => `audience_entry_v1_${id}`;

/** Raised when stored data can't be parsed — surfaced, never swallowed. */
export class AudienceStoreError extends Error {
  constructor(message: string, readonly key: string) {
    super(message);
    this.name = 'AudienceStoreError';
  }
}

function makeId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function parseOrThrow<T>(raw: string, key: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new AudienceStoreError(`Stored data at "${key}" is corrupt and could not be read.`, key);
  }
}

async function readIndex(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(INDEX_KEY);
  if (!raw) return [];
  return parseOrThrow<string[]>(raw, INDEX_KEY);
}

async function writeIndex(ids: string[]): Promise<void> {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(ids));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * List all audiences in stored index order. Throws AudienceStoreError if the
 * index or any referenced entry is corrupt — the caller decides how to surface
 * it. (Contrast ScriptStore.listScripts, which drops corrupt entries silently.)
 */
export async function listAudiences(): Promise<Audience[]> {
  const ids = await readIndex();
  if (ids.length === 0) return [];
  const pairs = await AsyncStorage.multiGet(ids.map(entryKey));
  const map = new Map<string, Audience>();
  for (const [key, val] of pairs) {
    if (!val) continue; // missing entry (deleted out from under us) is tolerated
    const a = parseOrThrow<Audience>(val, key);
    map.set(a.id, a);
  }
  return ids.flatMap(id => (map.has(id) ? [map.get(id)!] : []));
}

/** Fetch one audience by id, or null if the key is absent. Throws on corrupt. */
export async function getAudience(id: string): Promise<Audience | null> {
  const raw = await AsyncStorage.getItem(entryKey(id));
  if (!raw) return null;
  return parseOrThrow<Audience>(raw, entryKey(id));
}

/** Create a new audience from name + topics. Prepends to the index. */
export async function saveAudience(
  data: Pick<Audience, 'name' | 'topics' | 'maxCards'>,
): Promise<Audience> {
  const entry: Audience = {
    id: makeId(),
    name: data.name.trim() || 'Untitled',
    topics: data.topics,
    maxCards: data.maxCards,
    updatedAt: Date.now(),
  };
  const ids = await readIndex();
  ids.unshift(entry.id);
  await AsyncStorage.setItem(entryKey(entry.id), JSON.stringify(entry));
  await writeIndex(ids);
  return entry;
}

/** Patch an existing audience. Bumps updatedAt. Does NOT reorder. */
export async function updateAudience(
  id: string,
  patch: Partial<Pick<Audience, 'name' | 'topics' | 'maxCards'>>,
): Promise<Audience | null> {
  const prev = await getAudience(id);
  if (!prev) return null;
  const entry: Audience = { ...prev, ...patch, updatedAt: Date.now() };
  await AsyncStorage.setItem(entryKey(id), JSON.stringify(entry));
  return entry;
}

/** Persist a new manual order (drag-to-reorder). ids must be a permutation. */
export async function reorderAudiences(ids: string[]): Promise<void> {
  await writeIndex(ids);
}

/** Remove an audience entirely. */
export async function deleteAudience(id: string): Promise<void> {
  const ids = await readIndex();
  await AsyncStorage.removeItem(entryKey(id));
  await writeIndex(ids.filter(i => i !== id));
}

/**
 * Seed the starting templates exactly once (first run). A sentinel key marks
 * completion so re-seeding never clobbers edits or resurrects deleted
 * templates. Returns the seeded audiences, or [] if seeding already happened.
 */
export async function seedTemplatesOnce(): Promise<Audience[]> {
  const done = await AsyncStorage.getItem(SEEDED_KEY);
  if (done) return [];
  const seeded: Audience[] = [];
  // Seed in template order; saveAudience prepends, so save in reverse to keep
  // the first template at the top of the list.
  for (let i = AUDIENCE_TEMPLATES.length - 1; i >= 0; i--) {
    const t = AUDIENCE_TEMPLATES[i];
    seeded.unshift(await saveAudience({ name: t.name, topics: t.topics, maxCards: t.maxCards }));
  }
  await AsyncStorage.setItem(SEEDED_KEY, '1');
  return seeded;
}
