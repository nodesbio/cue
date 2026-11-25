/**
 * registry.ts — the deck registry (SRS Phase 3).
 *
 * store.ts persists the CARDS of a single deck keyed by DeckId. It has no notion
 * of "which decks exist" — the sports path got away with that because the live
 * feed already knew each audience's id out-of-band. A user-authored deck (Evan's
 * psychology set) has no feed to know it exists, so it needs a registry: a small
 * index of DeckMeta (name, source, counts, timestamps) the Decks screen lists,
 * decoupled from the heavier Card[] payload in store.ts.
 *
 * Layering (deliberate):
 *   registry.ts  → metadata index: what decks exist, their names/sources/counts.
 *   store.ts     → per-deck cards + scheduling state (unchanged).
 * Opening a deck reads meta from here and cards from there; the two are joined
 * by DeckId. This keeps the list cheap (no parsing every deck's cards to render
 * a list) and lets metadata evolve without touching the card payload format.
 *
 * CORRUPTION IS SURFACED, NOT SWALLOWED (Zoracon, best-practices #32): reads
 * THROW RegistryError on a bad parse rather than returning [] — a silent empty
 * list would hide every deck the wearer built and invite an overwrite. Same
 * stance as store.ts and AudienceStore. We fix the signal.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DeckId } from './card';

const INDEX_KEY = 'srs_registry_v1';

/** Where a deck's cards come from. Drives which editor/refresh path applies. */
export type DeckSource = 'sports' | 'manual' | 'anki';

/** Lightweight, listable description of a deck. Cards live in store.ts. */
export interface DeckMeta {
  id: DeckId;
  name: string;
  source: DeckSource;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms — bumped on rename / card-count change
  cardCount: number; // denormalised for a cheap list; kept in sync on write
}

/** Raised when the stored registry can't be parsed — surfaced, never swallowed. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

function parseOrThrow(raw: string): DeckMeta[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RegistryError('The deck registry is corrupt and could not be read.');
  }
  if (!Array.isArray(parsed)) {
    throw new RegistryError('The deck registry is malformed (expected a list).');
  }
  return parsed as DeckMeta[];
}

/**
 * All decks, newest-updated first. Returns [] when the registry has never been
 * written (a genuinely empty library) — distinct from a parse failure, which
 * throws. The list is cheap: no per-deck card payloads are read here.
 */
export async function listDecks(): Promise<DeckMeta[]> {
  const raw = await AsyncStorage.getItem(INDEX_KEY);
  if (raw == null) return [];
  const all = parseOrThrow(raw);
  return [...all].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** One deck's metadata, or null if it isn't registered. */
export async function getDeckMeta(id: DeckId): Promise<DeckMeta | null> {
  const all = await listDecks();
  return all.find((d) => d.id === id) ?? null;
}

/** Overwrite the whole index. Internal — callers use the CRUD helpers below. */
async function writeIndex(all: DeckMeta[]): Promise<void> {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(all));
}

/**
 * Register a new deck's metadata (does NOT write cards — the caller saves those
 * via store.saveDeck). Throws if the id is already registered: a duplicate id
 * would collide on store.ts's card key and silently merge two decks' memories.
 */
export async function registerDeck(meta: DeckMeta): Promise<void> {
  const all = await listDecks();
  if (all.some((d) => d.id === meta.id)) {
    throw new RegistryError(`A deck with id "${meta.id}" is already registered.`);
  }
  await writeIndex([...all, meta]);
}

/**
 * Patch an existing deck's mutable fields (name, cardCount) and bump updatedAt.
 * No-op-safe: unknown ids throw so a lost deck can't be silently "updated" into
 * existence with partial data.
 */
export async function updateDeckMeta(
  id: DeckId,
  patch: Partial<Pick<DeckMeta, 'name' | 'cardCount'>>,
  now: number = Date.now(),
): Promise<DeckMeta> {
  const all = await listDecks();
  const idx = all.findIndex((d) => d.id === id);
  if (idx === -1) throw new RegistryError(`No deck registered with id "${id}".`);
  const next: DeckMeta = { ...all[idx], ...patch, updatedAt: now };
  all[idx] = next;
  await writeIndex(all);
  return next;
}

/** Remove a deck from the registry. The caller deletes its cards (store.deleteDeck). */
export async function unregisterDeck(id: DeckId): Promise<void> {
  const all = await listDecks();
  await writeIndex(all.filter((d) => d.id !== id));
}

/** Mint a unique DeckId for a user-authored deck. */
export function newDeckId(now: number = Date.now()): DeckId {
  return `manual_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
