/**
 * Excitement scoring for live games (0-100).
 *
 * Ported from apex-exotics/sports-monitor/excitement_engine.py (calculate_excitement).
 * Pure function over an ESPN event — no I/O — so it is fully unit-testable and
 * deterministic. The thresholds are the proven March-Madness-tuned values from
 * the original; preserved verbatim (Watkins: don't "improve" field-tuned
 * constants without evidence).
 *
 * The march-madness tossup-boost (an apex-exotics-local JSON file) is
 * intentionally NOT ported — it's event-specific and irrelevant to a general
 * 24x7 sports HUD.
 */
import type { EspnEvent, League } from './types';

/** Score margin band → points. Closer game = more exciting. */
function marginPoints(margin: number): number {
  if (margin === 0) return 55; // dead tie — the single most exciting state;
                               // must outrank a one-score game (margin 1-3 → 50)
                               // so a tied 1st-quarter game beats a 3-pt 2nd-quarter one.
  if (margin <= 3) return 50;
  if (margin <= 7) return 35;
  if (margin <= 10) return 20;
  if (margin <= 15) return 10;
  return 0;
}

/**
 * First period that counts as "the back half" of the game for the time-pressure
 * bonus. Basketball/hockey split into halves-worth-of-drama at period 2; football
 * has 4 quarters, so the back half starts at period 3. Default is the
 * basketball-tuned value (2) so league-less callers (and the original tests)
 * keep their proven behavior.
 */
function latePeriodStart(league?: League): number {
  return league === 'NCAAF' ? 3 : 2;
}

/**
 * Calculate excitement (0-100) for a game. Returns 0 for anything not currently
 * in progress (state !== 'in'), so the caller can filter with `> 0`.
 */
export function calculateExcitement(event: EspnEvent, league?: League): number {
  const status = event.status?.type;
  if (!status || status.state !== 'in') return 0;

  const comp = event.competitions?.[0];
  if (!comp || comp.competitors.length < 2) return 0;

  const homeScore = parseInt(comp.competitors[0].score, 10);
  const awayScore = parseInt(comp.competitors[1].score, 10);
  if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) return 0;

  let score = marginPoints(Math.abs(homeScore - awayScore));

  // Time pressure: second half / later periods, and the final minutes.
  const clock = event.status.displayClock;
  const period = event.status.period ?? 2;
  if (period >= latePeriodStart(league)) {
    score += 20;
    if (clock && clock.includes(':')) {
      const mins = parseInt(clock.split(':')[0], 10);
      if (!Number.isNaN(mins) && mins <= 5) score += 30;
    }
  }

  // Postseason bonus (ESPN season.type === 3).
  if (event.season?.type === 3) score += 20;

  return Math.min(score, 100);
}
