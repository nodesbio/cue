/**
 * card.ts — the sport-agnostic flashcard model (SRS Phase 1).
 *
 * This is the product's core type, deliberately NOT welded to ESPN/sports.
 * A Card is a two-sided prompt (question → answer) plus spaced-repetition
 * scheduling state. Sports is merely the first *deck source* (lib/sports/cards
 * will adapt its topics into Cards); Anki `.apkg` import is a later source.
 *
 * Design notes:
 *  - `SrsState` mirrors the Anki `cards` table columns we actually need
 *    (ivl, factor/ease, reps, lapses, due) so a future `.apkg` exporter is a
 *    direct field map, not a translation. See docs.ankiweb.net SM-2 scheduler.
 *  - Time is milliseconds-since-epoch everywhere (JS-native). The scheduler
 *    converts interval *days* → a concrete `due` timestamp; nothing downstream
 *    reasons in "days" so DST / timezone drift can't corrupt scheduling.
 *  - This module is pure data + factories. All transitions live in scheduler.ts.
 */

/** Monotonic unique id for a card within a deck. Source adapters mint these. */
export type CardId = string;

/** Opaque id for the deck a card belongs to (e.g. an audience id, an Anki deck). */
export type DeckId = string;

/**
 * Review grade. Anki-faithful 4-button scale so the engine can export to / import
 * from Anki without loss. NOTE: the G1 SmartRemote only ever emits `Good` (via
 * the ⏯ "mark done" button); the full scale is reachable from the phone UI. The
 * engine supports all four regardless of which input surface drives it.
 */
export enum Grade {
  /** Forgot it. Lapse: ease drops, card restarts learning. */
  Again = 'again',
  /** Recalled with difficulty. Smaller-than-normal interval growth. */
  Hard = 'hard',
  /** Normal successful recall. Interval × ease. ("Mark done" on the remote.) */
  Good = 'good',
  /** Trivial. Interval × ease × easy-bonus; ease rises. */
  Easy = 'easy',
}

/**
 * Per-card spaced-repetition state. Field names track Anki's `cards` table:
 *   ivl    → interval in days until next review
 *   ease   → ease factor, stored as a multiplier (Anki stores ×1000 as `factor`)
 *   reps   → total successful reviews
 *   lapses → times graded Again after graduating
 *   due    → epoch-ms the card next becomes reviewable
 *   learning → true until the card graduates out of the initial learning steps
 */
export interface SrsState {
  ivl: number;
  ease: number;
  reps: number;
  lapses: number;
  due: number;
  learning: boolean;
}

/** A reviewable flashcard: two-sided content + its scheduling state. */
export interface Card {
  id: CardId;
  deckId: DeckId;
  /** Front — shown first; the wearer recalls before revealing. */
  prompt: string;
  /** Back — revealed after recall, then graded. */
  answer: string;
  /** Scheduling state. A freshly-created card uses `newSrsState()`. */
  srs: SrsState;
  /** Free-form source tag ('sports:nba:5', 'anki:<guid>') for export/debug. */
  source?: string;
}

/** Anki's default starting ease: 250% → 2.5 as a multiplier. */
export const DEFAULT_EASE = 2.5;

/**
 * Fresh scheduling state for a never-reviewed card. `due = now` so a new card is
 * immediately eligible; `learning: true` routes the first reviews through short
 * learning steps rather than multi-day intervals.
 */
export function newSrsState(now: number = Date.now()): SrsState {
  return { ivl: 0, ease: DEFAULT_EASE, reps: 0, lapses: 0, due: now, learning: true };
}

/** Convenience factory for a brand-new card. */
export function makeCard(
  id: CardId,
  deckId: DeckId,
  prompt: string,
  answer: string,
  source?: string,
  now: number = Date.now(),
): Card {
  return { id, deckId, prompt, answer, srs: newSrsState(now), source };
}

/** A card is due when its scheduled time has arrived. */
export function isDue(card: Card, now: number = Date.now()): boolean {
  return card.srs.due <= now;
}
