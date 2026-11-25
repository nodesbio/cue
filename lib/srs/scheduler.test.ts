/**
 * scheduler.test.ts — invariants for the SM-2 engine (SRS Phase 1).
 *
 * These formalize Anki's documented SM-2 behaviour. If a future tweak (or FSRS
 * swap) changes an interval, these tests say exactly which rule moved.
 */

import {
  review,
  MIN_EASE,
  HARD_FACTOR,
  EASY_BONUS,
  GRAD_IVL,
  EASY_IVL,
  MAX_IVL,
} from './scheduler';
import { Grade, newSrsState, DEFAULT_EASE, type SrsState } from './card';

const NOW = 1_700_000_000_000; // fixed epoch-ms for deterministic due dates
const DAY = 24 * 60 * 60 * 1000;

/** A graduated review card: out of learning, with a known interval/ease. */
function graduated(ivl: number, ease = DEFAULT_EASE): SrsState {
  return { ivl, ease, reps: 5, lapses: 0, due: NOW, learning: false };
}

describe('learning phase', () => {
  it('Good graduates a new card to the base interval', () => {
    const next = review(newSrsState(NOW), Grade.Good, NOW);
    expect(next.learning).toBe(false);
    expect(next.ivl).toBe(GRAD_IVL);
    expect(next.due).toBe(NOW + GRAD_IVL * DAY);
    expect(next.reps).toBe(1);
  });

  it('Easy graduates a new card straight to the easy interval', () => {
    const next = review(newSrsState(NOW), Grade.Easy, NOW);
    expect(next.learning).toBe(false);
    expect(next.ivl).toBe(EASY_IVL);
    expect(next.due).toBe(NOW + EASY_IVL * DAY);
  });

  it('Again keeps a new card in learning, due immediately, no rep credit', () => {
    const next = review(newSrsState(NOW), Grade.Again, NOW);
    expect(next.learning).toBe(true);
    expect(next.due).toBe(NOW); // same-session re-review
    expect(next.reps).toBe(0);
  });
});

describe('review phase intervals', () => {
  it('Good multiplies interval by ease', () => {
    const next = review(graduated(10, 2.5), Grade.Good, NOW);
    expect(next.ivl).toBe(25); // 10 × 2.5
    expect(next.ease).toBe(2.5); // Good leaves ease unchanged
    expect(next.due).toBe(NOW + 25 * DAY);
  });

  it('Hard multiplies interval by HARD_FACTOR and drops ease', () => {
    const next = review(graduated(10, 2.5), Grade.Hard, NOW);
    expect(next.ivl).toBe(Math.round(10 * HARD_FACTOR)); // 12
    expect(next.ease).toBeCloseTo(2.35);
  });

  it('Easy applies ease × EASY_BONUS and raises ease', () => {
    const next = review(graduated(10, 2.5), Grade.Easy, NOW);
    // ease rises to 2.65 first, then 10 × 2.65 × 1.3
    expect(next.ease).toBeCloseTo(2.65);
    expect(next.ivl).toBe(Math.round(10 * 2.65 * EASY_BONUS)); // 34
  });
});

describe('lapses', () => {
  it('Again on a graduated card lapses it back into learning', () => {
    const next = review(graduated(30, 2.5), Grade.Again, NOW);
    expect(next.learning).toBe(true);
    expect(next.lapses).toBe(1);
    expect(next.ease).toBeCloseTo(2.3); // −0.20
    expect(next.due).toBe(NOW); // due again this session
  });
});

describe('ease floor', () => {
  it('ease never drops below MIN_EASE no matter how many Agains', () => {
    let s = graduated(5, 1.35);
    for (let i = 0; i < 10; i++) s = review(s, Grade.Again, NOW);
    expect(s.ease).toBe(MIN_EASE);
  });
});

describe('interval cap', () => {
  it('intervals are capped at MAX_IVL', () => {
    const next = review(graduated(MAX_IVL, 2.5), Grade.Easy, NOW);
    expect(next.ivl).toBeLessThanOrEqual(MAX_IVL);
  });
});

describe('purity', () => {
  it('does not mutate the input state', () => {
    const before = graduated(10, 2.5);
    const snapshot = { ...before };
    review(before, Grade.Good, NOW);
    expect(before).toEqual(snapshot);
  });
});

describe('the product loop: mark-done (Good) pushes the card out of rotation', () => {
  it('repeated Good grades grow the interval monotonically into weeks', () => {
    // A card graduates, then is "marked done" each subsequent session. Its due
    // date should march steadily into the future — i.e. it leaves rotation.
    let s = review(newSrsState(NOW), Grade.Good, NOW); // graduate → ivl 1
    const intervals: number[] = [s.ivl];
    let t = s.due;
    for (let i = 0; i < 4; i++) {
      s = review(s, Grade.Good, t);
      intervals.push(s.ivl);
      t = s.due;
    }
    // Strictly increasing, and well past a week by the end.
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i]).toBeGreaterThan(intervals[i - 1]);
    }
    expect(intervals[intervals.length - 1]).toBeGreaterThan(7);
  });
});
