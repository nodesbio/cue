/**
 * deckio.ts — deck import / export serialization (SRS Phase 3, follow-up).
 *
 * A Cue deck file is a single self-describing JSON document: enough to recreate a
 * deck (name + cards + scheduling) on another device or share with another user.
 * This module is PURE (no AsyncStorage, no file system) so the format is the
 * test's spec; the UI layers do the picker / share / persistence around it.
 *
 * Design:
 *  - EXPORT preserves each card's SRS state. Sharing a deck you've studied carries
 *    your earned intervals with it; the recipient can discard them (a re-import
 *    always re-bases, see below) but we never silently drop learned memory.
 *  - IMPORT re-bases every card onto a FRESH deck id and content-stable card ids
 *    (manualCardId), so importing can never collide with — or overwrite — a deck
 *    already on the device. Two imports of the same file produce two decks.
 *  - PARSING THROWS on anything malformed (Zoracon, best-practices #32). A
 *    truncated or hand-edited file must fail loudly, not import a half-deck.
 *
 * Format (v1):
 *   { "format": "cue.deck", "version": 1, "name": "...", "exportedAt": <ms>,
 *     "cards": [ { "prompt": "...", "answer": "...", "srs": {..} , "source"?: ".." } ] }
 */

import { makeCard, newSrsState, type Card, type DeckId, type SrsState } from './card';
import { manualCardId } from './sources/manual';
import { newDeckId, type DeckMeta } from './registry';

export const DECK_FILE_FORMAT = 'cue.deck';
export const DECK_FILE_VERSION = 1;

/** On-disk card: content + scheduling, WITHOUT ids (ids are re-minted on import). */
interface DeckFileCard {
  prompt: string;
  answer: string;
  srs: SrsState;
  source?: string;
}

/** The whole deck file. `exportedAt` is informational; identity is not preserved. */
export interface DeckFile {
  format: typeof DECK_FILE_FORMAT;
  version: typeof DECK_FILE_VERSION;
  name: string;
  exportedAt: number;
  cards: DeckFileCard[];
}

/** Raised when a deck file can't be parsed — surfaced, never swallowed. */
export class DeckFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeckFileError';
  }
}

/**
 * Serialize a deck to its file form. Card ids and deckId are intentionally
 * dropped — they're device-local and re-minted on import — but SRS state is kept.
 * Returns pretty-printed JSON suitable for writing straight to a .cuedeck file.
 */
export function serializeDeck(name: string, cards: Card[]): string {
  const file: DeckFile = {
    format: DECK_FILE_FORMAT,
    version: DECK_FILE_VERSION,
    name,
    exportedAt: Date.now(),
    cards: cards.map((c) => ({
      prompt: c.prompt,
      answer: c.answer,
      srs: c.srs,
      ...(c.source !== undefined ? { source: c.source } : {}),
    })),
  };
  return JSON.stringify(file, null, 2);
}

function isSrsState(v: unknown): v is SrsState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.ivl === 'number' &&
    typeof s.ease === 'number' &&
    typeof s.reps === 'number' &&
    typeof s.lapses === 'number' &&
    typeof s.due === 'number' &&
    typeof s.learning === 'boolean'
  );
}

/**
 * Parse + validate a deck file's raw JSON text. Throws DeckFileError on malformed
 * input (bad JSON, wrong format tag, unsupported version, missing/typed-wrong
 * fields). On success returns the validated DeckFile — call importDeckFile to turn
 * it into persistable Cards under a fresh deck id.
 */
export function parseDeckFile(raw: string): DeckFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeckFileError('This file is not valid JSON — it may be corrupt or incomplete.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new DeckFileError('This file is not a Cue deck.');
  }
  const f = parsed as Record<string, unknown>;
  if (f.format !== DECK_FILE_FORMAT) {
    throw new DeckFileError('This file is not a Cue deck.');
  }
  if (f.version !== DECK_FILE_VERSION) {
    throw new DeckFileError(
      `This deck was exported by a newer version of Cue (format v${String(f.version)}). Update the app to import it.`,
    );
  }
  if (typeof f.name !== 'string' || f.name.trim() === '') {
    throw new DeckFileError('This deck file is missing its name.');
  }
  if (!Array.isArray(f.cards)) {
    throw new DeckFileError('This deck file is malformed (expected a list of cards).');
  }
  const cards: DeckFileCard[] = f.cards.map((c, i) => {
    if (typeof c !== 'object' || c === null) {
      throw new DeckFileError(`Card ${i + 1} is malformed.`);
    }
    const rec = c as Record<string, unknown>;
    if (typeof rec.prompt !== 'string' || typeof rec.answer !== 'string') {
      throw new DeckFileError(`Card ${i + 1} is missing its prompt or answer.`);
    }
    if (!isSrsState(rec.srs)) {
      throw new DeckFileError(`Card ${i + 1} has invalid scheduling data.`);
    }
    return {
      prompt: rec.prompt,
      answer: rec.answer,
      srs: rec.srs,
      ...(typeof rec.source === 'string' ? { source: rec.source } : {}),
    };
  });
  return {
    format: DECK_FILE_FORMAT,
    version: DECK_FILE_VERSION,
    name: f.name,
    exportedAt: typeof f.exportedAt === 'number' ? f.exportedAt : Date.now(),
    cards,
  };
}

/** Result of importing a deck file: metadata to register + cards to persist. */
export interface ImportedDeck {
  meta: DeckMeta;
  cards: Card[];
}

/**
 * Turn a validated DeckFile into a fresh, persistable deck. Mints a new deckId and
 * content-stable card ids (so re-imports never collide), preserving each card's
 * SRS state by default. Pass `resetProgress` to import as brand-new cards (due now)
 * — the right default for sharing a deck you want the recipient to learn cold.
 *
 * Blank cards (empty prompt/answer after trim) and intra-file duplicates collapse,
 * mirroring manualToSrs so an imported file behaves like a hand-authored one.
 */
export function importDeckFile(
  file: DeckFile,
  opts: { source?: DeckMeta['source']; resetProgress?: boolean; now?: number } = {},
): ImportedDeck {
  const { source = 'manual', resetProgress = false, now = Date.now() } = opts;
  const deckId: DeckId = newDeckId(now);

  const cards: Card[] = [];
  const seen = new Set<string>();
  for (const c of file.cards) {
    const prompt = c.prompt.trim();
    const answer = c.answer.trim();
    if (!prompt || !answer) continue;
    const id = manualCardId(deckId, prompt, answer);
    if (seen.has(id)) continue;
    seen.add(id);
    const base = makeCard(id, deckId, prompt, answer, c.source, now);
    cards.push(resetProgress ? base : { ...base, srs: c.srs });
  }

  const meta: DeckMeta = {
    id: deckId,
    name: file.name.trim(),
    source,
    createdAt: now,
    updatedAt: now,
    cardCount: cards.length,
  };
  return { meta, cards };
}

/** Suggest a filesystem-safe file name for an exported deck. */
export function deckFileName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
  return `${slug}.cuedeck.json`;
}

// newSrsState re-exported for callers that import brand-new cards without a file.
export { newSrsState };
