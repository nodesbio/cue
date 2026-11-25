/**
 * sources/manual.ts — user-authored deck source (SRS Phase 3).
 *
 * Sibling to sources/sports.ts: where that adapts ESPN cards, this adapts rows
 * the wearer typed by hand (Evan's psychology terms) into SRS flashcards. This
 * is the source card.ts foretold — "Sports is merely the first deck source" —
 * and the first one with no feed behind it, hence the new registry (registry.ts)
 * to know the deck exists at all.
 *
 * Id stability (the crux of edit-without-losing-progress): a row's SRS card id
 * is derived from the deck id + the row's position-independent content hash, NOT
 * its array index. Re-saving an edited deck therefore keeps scheduling for rows
 * whose text is unchanged (store.mergeDeck matches by id), even if the wearer
 * reorders, inserts, or deletes rows above them. Editing a row's text is treated
 * as a new card (fresh schedule) — correct, since the fact itself changed.
 */

import { makeCard, type Card, type DeckId } from '../card';

/** One hand-authored flashcard before it gains scheduling state. */
export interface ManualRow {
  prompt: string;
  answer: string;
}

/**
 * FNV-1a over prompt+answer. A small, dependency-free stable hash so a row maps
 * to the same id across saves regardless of position. Collisions are astronomically
 * unlikely at deck scale and would at worst share a schedule, never corrupt data.
 */
function contentHash(prompt: string, answer: string): string {
  const s = `${prompt}\u0000${answer}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Stable per-(deck, content) card id. Exported for tests + merge reasoning. */
export function manualCardId(deckId: DeckId, prompt: string, answer: string): string {
  return `${deckId}:${contentHash(prompt, answer)}`;
}

/**
 * Convert hand-authored rows into SRS Cards for a deck. Blank rows (no prompt or
 * no answer after trim) are dropped — a half-typed row is not a card. Duplicate
 * content collapses to one card (same id), so accidentally pasting a term twice
 * doesn't double it. Fresh cards start due-now; store.mergeDeck reattaches earned
 * scheduling for ids that already exist.
 */
export function manualToSrs(deckId: DeckId, rows: ManualRow[], now: number = Date.now()): Card[] {
  const out: Card[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const prompt = row.prompt.trim();
    const answer = row.answer.trim();
    if (!prompt || !answer) continue;
    const id = manualCardId(deckId, prompt, answer);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(makeCard(id, deckId, prompt, answer, `manual:${id}`, now));
  }
  return out;
}
