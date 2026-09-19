/**
 * ScriptStore.ts — simple AsyncStorage-backed script library.
 *
 * Each saved script is a ScriptEntry stored under a per-entry key.
 * An index key holds the ordered list of IDs.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export interface ScriptEntry {
  id: string;
  name: string;
  text: string;
  updatedAt: number; // epoch ms
}

const INDEX_KEY  = 'scripts_index_v1';
const entryKey   = (id: string) => `script_entry_v1_${id}`;

function makeId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Return ordered list of script IDs. */
async function readIndex(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(INDEX_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

async function writeIndex(ids: string[]): Promise<void> {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(ids));
}

/** List all saved scripts, newest first. */
export async function listScripts(): Promise<ScriptEntry[]> {
  const ids  = await readIndex();
  if (ids.length === 0) return [];
  const keys = ids.map(entryKey);
  const pairs = await AsyncStorage.multiGet(keys);
  const entries: ScriptEntry[] = [];
  for (const [, val] of pairs) {
    if (!val) continue;
    try { entries.push(JSON.parse(val) as ScriptEntry); } catch {}
  }
  // Preserve index order (newest first — index is prepended on save)
  entries.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  return entries;
}

/** Save a new script. Returns the new entry. */
export async function saveScript(name: string, text: string): Promise<ScriptEntry> {
  const entry: ScriptEntry = { id: makeId(), name: name.trim() || 'Untitled', text, updatedAt: Date.now() };
  const ids = await readIndex();
  ids.unshift(entry.id); // newest first
  await AsyncStorage.setItem(entryKey(entry.id), JSON.stringify(entry));
  await writeIndex(ids);
  return entry;
}

/** Overwrite an existing entry's text (and bump updatedAt). */
export async function updateScript(id: string, patch: Partial<Pick<ScriptEntry, 'name' | 'text'>>): Promise<ScriptEntry | null> {
  const raw = await AsyncStorage.getItem(entryKey(id));
  if (!raw) return null;
  try {
    const entry: ScriptEntry = { ...JSON.parse(raw), ...patch, updatedAt: Date.now() };
    await AsyncStorage.setItem(entryKey(id), JSON.stringify(entry));
    return entry;
  } catch { return null; }
}

/** Delete a script by ID. */
export async function deleteScript(id: string): Promise<void> {
  const ids = await readIndex();
  const next = ids.filter(i => i !== id);
  await AsyncStorage.removeItem(entryKey(id));
  await writeIndex(next);
}
