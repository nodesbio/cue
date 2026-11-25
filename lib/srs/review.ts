/**
 * review.ts — the review-session state machine (SRS Phase 2).
 *
 * Pure and side-effect-free: every transition takes a session + returns a NEW
 * session. React/storage bindings live in useReviewSession.ts; keeping the logic
 * pure makes the nav-vs-grade separation (the whole point of this phase) testable
 * without a device.
 *
 * INPUT MODEL (confirmed with John, hardware-grounded against SmartRemoteManager):
 *   next  (▶▶ / single_tap) → advance through the deck   — NAVIGATION ONLY
 *   prev  (◀◀ / double_tap) → rewind through the deck     — NAVIGATION ONLY
 *   done  (⏯ / triple_tap)  → "mark done" = Grade.Good    — GRADES + reschedules
 *
 * So scrubbing never changes a card's memory; only an explicit "mark done"
 * commits a grade. A card the wearer never marks done stays due and resurfaces.
 *
 * REVEAL: `reveal()` flips the current card from prompt-only to prompt+answer.
 * The first `done` on an unrevealed card reveals it rather than grading, so a
 * single remote button can't accidentally grade a card you haven't seen the
 * back of. (The phone UI can reveal explicitly on tap.)
 */

import type { Card } from './card';
import { Grade, isDue } from './card';
import { review as scheduleReview } from './scheduler';

export interface ReviewSession {
  /** The cards in this session, in review order. Scheduling state is live. */
  cards: Card[];
  /** Index of the current card, or -1 when the session is empty/complete. */
  index: number;
  /** Whether the current card's answer is shown. Resets on navigation. */
  revealed: boolean;
}

/** The queue for a session: cards that are due now, in due-date order. */
export function dueCards(cards: Card[], now: number = Date.now()): Card[] {
  return cards
    .filter((c) => isDue(c, now))
    .sort((a, b) => a.srs.due - b.srs.due);
}

/** Start a session over the due subset of a deck. */
export function startSession(cards: Card[], now: number = Date.now()): ReviewSession {
  const queue = dueCards(cards, now);
  return { cards: queue, index: queue.length > 0 ? 0 : -1, revealed: false };
}

/** The card currently under review, or null when the session is empty/done. */
export function currentCard(s: ReviewSession): Card | null {
  return s.index >= 0 && s.index < s.cards.length ? s.cards[s.index] : null;
}

/** Reveal the current card's answer. No-op if already revealed or empty. */
export function reveal(s: ReviewSession): ReviewSession {
  if (s.index < 0 || s.revealed) return s;
  return { ...s, revealed: true };
}

/**
 * Advance to the next card. NAVIGATION ONLY — does not grade. Wraps to stay in
 * range (clamps at the last card; the session ends via `remaining`/filtering,
 * not by falling off the end). Resets reveal so the next card starts face-down.
 */
export function next(s: ReviewSession): ReviewSession {
  if (s.index < 0) return s;
  const i = Math.min(s.index + 1, s.cards.length - 1);
  return { ...s, index: i, revealed: false };
}

/** Rewind to the previous card. NAVIGATION ONLY — does not grade. */
export function prev(s: ReviewSession): ReviewSession {
  if (s.index < 0) return s;
  const i = Math.max(s.index - 1, 0);
  return { ...s, index: i, revealed: false };
}

/**
 * "Mark done" on the current card.
 *   - If the card isn't revealed yet, this REVEALS it (safety: one button can't
 *     grade a card you haven't seen the back of).
 *   - If already revealed, grade it Grade.Good, reschedule via SM-2, drop it from
 *     the session queue (it's now scheduled into the future), and land on the
 *     next card.
 *
 * Returns the new session AND the rescheduled card (or null if it only revealed)
 * so the caller can persist the updated scheduling state.
 */
export function markDone(
  s: ReviewSession,
  now: number = Date.now(),
): { session: ReviewSession; graded: Card | null } {
  const card = currentCard(s);
  if (!card) return { session: s, graded: null };

  if (!s.revealed) {
    return { session: { ...s, revealed: true }, graded: null };
  }

  const graded: Card = { ...card, srs: scheduleReview(card.srs, Grade.Good, now) };

  // Remove the graded card from the session queue; it's scheduled into the
  // future and shouldn't reappear this pass.
  const remaining = s.cards.filter((_, i) => i !== s.index);
  const index = remaining.length === 0 ? -1 : Math.min(s.index, remaining.length - 1);
  return { session: { cards: remaining, index, revealed: false }, graded };
}

/**
 * Grade the current card explicitly (phone UI — exposes the full 4-button
 * scale). Same semantics as markDone's grading branch but with any Grade; does
 * NOT auto-reveal (the phone always reveals before showing grade buttons).
 */
export function grade(
  s: ReviewSession,
  g: Grade,
  now: number = Date.now(),
): { session: ReviewSession; graded: Card | null } {
  const card = currentCard(s);
  if (!card) return { session: s, graded: null };
  const graded: Card = { ...card, srs: scheduleReview(card.srs, g, now) };
  const remaining = s.cards.filter((_, i) => i !== s.index);
  const index = remaining.length === 0 ? -1 : Math.min(s.index, remaining.length - 1);
  return { session: { cards: remaining, index, revealed: false }, graded };
}

/** Cards left in the session queue. */
export function remaining(s: ReviewSession): number {
  return s.index < 0 ? 0 : s.cards.length;
}
