/**
 * review.test.ts — session state machine + merge invariants (SRS Phase 2).
 *
 * The critical thing under test is the nav-vs-grade separation: scrubbing with
 * next/prev must NEVER change a card's scheduling state; only mark-done/grade do.
 */

import {
  startSession,
  currentCard,
  reveal,
  next,
  prev,
  markDone,
  grade,
  dueCards,
  remaining,
} from './review';
import { mergeDeck } from './store';
import { Grade, makeCard, newSrsState, type Card } from './card';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function deck(n: number): Card[] {
  return Array.from({ length: n }, (_, i) =>
    makeCard(`c${i}`, 'd1', `Q${i}`, `A${i}`, undefined, NOW),
  );
}

describe('due queue', () => {
  it('includes only cards due now, in due-date order', () => {
    const cards = deck(3);
    cards[0].srs.due = NOW + 10 * DAY; // future
    cards[1].srs.due = NOW - DAY;      // overdue
    cards[2].srs.due = NOW;            // due
    const q = dueCards(cards, NOW);
    expect(q.map((c) => c.id)).toEqual(['c1', 'c2']); // overdue first
  });
});

describe('navigation is grade-free', () => {
  it('next/prev never mutate scheduling state', () => {
    let s = startSession(deck(3), NOW);
    const before = s.cards.map((c) => ({ ...c.srs }));
    s = next(s);
    s = next(s);
    s = prev(s);
    expect(s.cards.map((c) => c.srs)).toEqual(before);
  });

  it('next clamps at the last card, prev clamps at the first', () => {
    let s = startSession(deck(2), NOW);
    s = next(s); s = next(s); s = next(s);
    expect(s.index).toBe(1);
    s = prev(s); s = prev(s); s = prev(s);
    expect(s.index).toBe(0);
  });

  it('navigation resets reveal', () => {
    let s = startSession(deck(2), NOW);
    s = reveal(s);
    expect(s.revealed).toBe(true);
    s = next(s);
    expect(s.revealed).toBe(false);
  });
});

describe('mark-done', () => {
  it('first press on an unrevealed card reveals, does not grade', () => {
    const s0 = startSession(deck(2), NOW);
    const { session, graded } = markDone(s0, NOW);
    expect(graded).toBeNull();
    expect(session.revealed).toBe(true);
    expect(remaining(session)).toBe(2); // nothing removed
  });

  it('press on a revealed card grades Good, reschedules, and drops it', () => {
    let s = startSession(deck(2), NOW);
    s = reveal(s);
    const { session, graded } = markDone(s, NOW);
    expect(graded).not.toBeNull();
    expect(graded!.srs.due).toBeGreaterThan(NOW); // scheduled into the future
    expect(graded!.srs.reps).toBe(1);
    expect(remaining(session)).toBe(1); // card removed from queue
  });

  it('marking the last card done ends the session (index -1)', () => {
    let s = startSession(deck(1), NOW);
    s = reveal(s);
    const { session } = markDone(s, NOW);
    expect(currentCard(session)).toBeNull();
    expect(session.index).toBe(-1);
  });
});

describe('explicit grade (phone 4-button)', () => {
  it('Again lapses a GRADUATED card back into learning', () => {
    const cards = deck(1);
    // Graduate the card first (a lapse is only counted on graduated cards).
    cards[0].srs = { ...newSrsState(NOW), ivl: 21, reps: 4, learning: false, due: NOW };
    let s = startSession(cards, NOW);
    s = reveal(s);
    const { graded } = grade(s, Grade.Again, NOW);
    expect(graded!.srs.learning).toBe(true);
    expect(graded!.srs.lapses).toBe(1);
  });
});

describe('mergeDeck preserves earned scheduling', () => {
  it('keeps srs state for cards that still exist, adds new, drops stale', () => {
    const existing = deck(2);
    existing[0].srs = { ...newSrsState(NOW), ivl: 21, reps: 4, learning: false, due: NOW + 21 * DAY };
    // Fresh generation: c0 still present (new text), c1 gone, c2 new.
    const fresh: Card[] = [
      makeCard('c0', 'd1', 'Q0-updated', 'A0-updated', undefined, NOW),
      makeCard('c2', 'd1', 'Q2', 'A2', undefined, NOW),
    ];
    const merged = mergeDeck(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['c0', 'c2']); // stale c1 dropped
    expect(merged[0].prompt).toBe('Q0-updated');           // fresh content
    expect(merged[0].srs.ivl).toBe(21);                    // preserved progress
    expect(merged[1].srs.reps).toBe(0);                    // c2 is brand new
  });
});
