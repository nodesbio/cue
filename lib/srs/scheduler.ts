/**
 * scheduler.ts — the SM-2 spaced-repetition engine (SRS Phase 1).
 *
 * Pure, side-effect-free: `review(state, grade, now)` → next state. No I/O, no
 * storage, no UI — that keeps it exhaustively testable and makes the Anki
 * mapping a straight field copy later.
 *
 * Algorithm: Anki's classic SM-2 scheduler (NOT FSRS — chosen for simplicity
 * and clean .apkg export; see docs.ankiweb.net/faqs/what-spaced-repetition-
 * algorithm). Verified against Anki's documented button behaviour 2026-11:
 *
 *   Button  Ease Δ         Review-card interval
 *   Again   −0.20          lapse → relearn (ivl resets to LEARN step)
 *   Hard    −0.15          ivl × HARD_FACTOR (1.2)
 *   Good     0             ivl × ease
 *   Easy    +0.15          ivl × ease × EASY_BONUS (1.3)
 *
 * New/learning cards don't use the ease multiplier: the buttons walk fixed
 * learning steps (Again → step 0, Good → graduate to GRAD_IVL, Easy → jump to
 * EASY_IVL). Ease floors at MIN_EASE so a chronically-hard card can't collapse
 * to zero-day intervals.
 *
 * "Mark done" on the SmartRemote maps to Grade.Good (see card.ts). A card the
 * wearer never marks done simply stays due and keeps resurfacing — exactly the
 * desired loop.
 */

import { Grade, type SrsState } from './card';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Tunables (Anki defaults) ────────────────────────────────────────────────
/** Ease never drops below this, so intervals can't collapse to nothing. */
export const MIN_EASE = 1.3;
/** Hard multiplies the *current* interval by this (not the ease). */
export const HARD_FACTOR = 1.2;
/** Easy adds this bonus on top of the ease multiplier. */
export const EASY_BONUS = 1.3;
/** Interval (days) a card graduates to on first Good out of learning. */
export const GRAD_IVL = 1;
/** Interval (days) a card jumps to when graduated via Easy. */
export const EASY_IVL = 4;
/** Learning-step interval (days) used for Again/relearn and pre-graduation. */
export const LEARN_IVL = 0; // same-session: due immediately (now), re-review this pass
/** Hard cap so runaway intervals stay sane. */
export const MAX_IVL = 365 * 10;

const EASE_DELTA: Record<Grade, number> = {
  [Grade.Again]: -0.2,
  [Grade.Hard]: -0.15,
  [Grade.Good]: 0,
  [Grade.Easy]: 0.15,
};

/** Clamp an interval (days) to [0, MAX_IVL]. */
function clampIvl(days: number): number {
  return Math.max(0, Math.min(MAX_IVL, Math.round(days)));
}

/** Apply the per-grade ease change, floored at MIN_EASE. */
function nextEase(ease: number, grade: Grade): number {
  return Math.max(MIN_EASE, ease + EASE_DELTA[grade]);
}

/**
 * Advance a card's scheduling state by one review.
 *
 * @param state  current scheduling state
 * @param grade  the wearer's grade for this review
 * @param now    epoch-ms of the review (injectable for deterministic tests)
 * @returns      a NEW SrsState — the input is never mutated
 */
export function review(state: SrsState, grade: Grade, now: number = Date.now()): SrsState {
  const ease = nextEase(state.ease, grade);

  // ── Learning / relearning phase ────────────────────────────────────────────
  // A new card, or one that just lapsed, walks fixed steps before it earns a
  // multi-day interval. Ease still moves so a card that's hard even in learning
  // starts its graduated life with a lower factor.
  if (state.learning) {
    if (grade === Grade.Again) {
      // Stay in learning, same-session re-review, no rep credit.
      return { ivl: LEARN_IVL, ease, reps: state.reps, lapses: state.lapses, due: now, learning: true };
    }
    if (grade === Grade.Easy) {
      return {
        ivl: EASY_IVL, ease, reps: state.reps + 1, lapses: state.lapses,
        due: now + EASY_IVL * MS_PER_DAY, learning: false,
      };
    }
    // Hard or Good → graduate to the base interval.
    return {
      ivl: GRAD_IVL, ease, reps: state.reps + 1, lapses: state.lapses,
      due: now + GRAD_IVL * MS_PER_DAY, learning: false,
    };
  }

  // ── Review phase (graduated cards) ──────────────────────────────────────────
  if (grade === Grade.Again) {
    // Lapse: back into learning, interval resets, lapse counted, ease already
    // dropped above. The card is due again this session (LEARN_IVL = now).
    return {
      ivl: LEARN_IVL, ease, reps: state.reps, lapses: state.lapses + 1,
      due: now, learning: true,
    };
  }

  const base = Math.max(1, state.ivl); // a graduated card has ivl ≥ 1
  let ivl: number;
  if (grade === Grade.Hard) {
    ivl = clampIvl(base * HARD_FACTOR);
  } else if (grade === Grade.Easy) {
    ivl = clampIvl(base * ease * EASY_BONUS);
  } else {
    // Good
    ivl = clampIvl(base * ease);
  }

  return {
    ivl, ease, reps: state.reps + 1, lapses: state.lapses,
    due: now + ivl * MS_PER_DAY, learning: false,
  };
}
