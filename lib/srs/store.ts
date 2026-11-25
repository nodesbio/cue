/**
 * store.ts — AsyncStorage persistence for SRS cards (SRS Phase 2).
 *
 * Cards are stored per deck: one entry key holds the full Card[] for a deckId.
 * Scheduling state lives *inside* each card (card.srs), so persisting the deck
 * persists its memory — no separate revlog table in v1.
 *
 * CORRUPTION IS SURFACED, NOT SWALLOWED (Zoracon, best-practices #32): this
 * mirrors AudienceStore's deliberate divergence. A wearer's review progress —
 * weeks of earned intervals — must not silently vanish on a bad parse. Reads
 * THROW SrsStoreError so the UI can say "couldn't load your deck" instead of
 * rendering an empty, apparently-reset deck and then over-writing it with
 * fresh cards (which would destroy the real data). We fix the signal.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Card, DeckId } from './card';

const deckKey = (deckId: DeckId) => `srs_deck_v1_${deckId}`;

/** Raised when stored card data can't be parsed — surfaced, never swallowed. */
export class SrsStoreError extends Error {
  constructor(message: string, readonly key: string) {
    super(message);
    this.name = 'SrsStoreError';
  }
}

function parseOrThrow<T>(raw: string, key: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new SrsStoreError(`Stored SRS data at "${key}" is corrupt and could not be read.`, key);
  }
}

/**
 * Load a deck's cards (with their scheduling state). Returns null when the deck
 * has never been persisted — distinct from an empty [] deck — so callers can
 * tell "needs generating" from "generated but empty". Throws on corrupt data.
 */
export async function loadDeck(deckId: DeckId): Promise<Card[] | null> {
  const raw = await AsyncStorage.getItem(deckKey(deckId));
  if (raw == null) return null;
  return parseOrThrow<Card[]>(raw, deckKey(deckId));
}

/** Persist a deck's cards + scheduling state, replacing any prior snapshot. */
export async function saveDeck(deckId: DeckId, cards: Card[]): Promise<void> {
  await AsyncStorage.setItem(deckKey(deckId), JSON.stringify(cards));
}

/** Delete a deck's stored cards entirely. */
export async function deleteDeck(deckId: DeckId): Promise<void> {
  await AsyncStorage.removeItem(deckKey(deckId));
}

/**
 * Merge freshly-generated cards into a stored deck, PRESERVING scheduling state
 * for cards that already exist (matched by id). New cards are appended; stale
 * cards no longer produced by the source are dropped. This is the crux of
 * "regenerate the deck without losing what the wearer has learned": a card the
 * wearer pushed out to a 3-week interval keeps that interval even after a
 * refresh pulls fresh facts for other cards.
 */
export function mergeDeck(existing: Card[], fresh: Card[]): Card[] {
  const bySrsId = new Map(existing.map((c) => [c.id, c.srs]));
  return fresh.map((c) => {
    const keptSrs = bySrsId.get(c.id);
    return keptSrs ? { ...c, srs: keptSrs } : c;
  });
}
