/**
 * ScriptStore.ts — AsyncStorage-backed script library.
 *
 * Index key holds the explicit ordered list of IDs (user drag order,
 * newest/last-opened first by default).  Each entry is stored under
 * its own key so multiGet stays fast.
 *
 * openedAt is updated by touchScript() every time a script is loaded —
 * that also promotes it to the top of the index so the list re-sorts.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export interface ScriptEntry {
  id: string;
  name: string;
  text: string;
  updatedAt: number; // epoch ms — last edited / imported
  openedAt:  number; // epoch ms — last loaded into engine (0 if never)
}

const INDEX_KEY = 'scripts_index_v1';
const entryKey  = (id: string) => `script_entry_v1_${id}`;

function makeId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

async function readIndex(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(INDEX_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

async function writeIndex(ids: string[]): Promise<void> {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(ids));
}

// ── Public API ──────────────────────────────────────────────────────────────

/** List all scripts in the stored index order (newest/last-opened first). */
export async function listScripts(): Promise<ScriptEntry[]> {
  const ids = await readIndex();
  if (ids.length === 0) return [];
  const pairs = await AsyncStorage.multiGet(ids.map(entryKey));
  const map = new Map<string, ScriptEntry>();
  for (const [, val] of pairs) {
    if (!val) continue;
    try {
      const e = JSON.parse(val) as ScriptEntry;
      // Back-fill openedAt for entries saved before this field existed
      if (typeof e.openedAt !== 'number') e.openedAt = 0;
      map.set(e.id, e);
    } catch {}
  }
  // Preserve explicit index order; drop any IDs whose entry is missing
  return ids.flatMap(id => (map.has(id) ? [map.get(id)!] : []));
}

/** Save a new script. Prepends to index (top of list). */
export async function saveScript(name: string, text: string): Promise<ScriptEntry> {
  const entry: ScriptEntry = {
    id: makeId(),
    name: name.trim() || 'Untitled',
    text,
    updatedAt: Date.now(),
    openedAt: 0,
  };
  const ids = await readIndex();
  ids.unshift(entry.id);
  await AsyncStorage.setItem(entryKey(entry.id), JSON.stringify(entry));
  await writeIndex(ids);
  return entry;
}

/** Patch name and/or text. Bumps updatedAt. Does NOT reorder. */
export async function updateScript(
  id: string,
  patch: Partial<Pick<ScriptEntry, 'name' | 'text'>>,
): Promise<ScriptEntry | null> {
  const raw = await AsyncStorage.getItem(entryKey(id));
  if (!raw) return null;
  try {
    const entry: ScriptEntry = {
      ...JSON.parse(raw),
      ...patch,
      updatedAt: Date.now(),
    };
    if (typeof entry.openedAt !== 'number') entry.openedAt = 0;
    await AsyncStorage.setItem(entryKey(id), JSON.stringify(entry));
    return entry;
  } catch { return null; }
}

/**
 * Record that a script was opened. Bumps openedAt and promotes the
 * entry to position 0 in the index so it appears at the top of the list.
 */
export async function touchScript(id: string): Promise<ScriptEntry | null> {
  const raw = await AsyncStorage.getItem(entryKey(id));
  if (!raw) return null;
  try {
    const entry: ScriptEntry = { ...JSON.parse(raw), openedAt: Date.now() };
    await AsyncStorage.setItem(entryKey(id), JSON.stringify(entry));
    // Promote to top of index
    const ids  = await readIndex();
    const next = [id, ...ids.filter(i => i !== id)];
    await writeIndex(next);
    return entry;
  } catch { return null; }
}

/**
 * Persist a new manual order (from drag-to-reorder).
 * ids must be a permutation of the current index — no entries are added/removed.
 */
export async function reorderScripts(ids: string[]): Promise<void> {
  await writeIndex(ids);
}

/** Remove a script entirely. */
export async function deleteScript(id: string): Promise<void> {
  const ids  = await readIndex();
  await AsyncStorage.removeItem(entryKey(id));
  await writeIndex(ids.filter(i => i !== id));
}
