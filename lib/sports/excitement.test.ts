/**
 * Excitement scorer — pure, deterministic. Mirrors the apex-exotics thresholds.
 */
import { calculateExcitement } from './excitement';
import type { EspnEvent } from './types';

/** Build a minimal ESPN event for the scorer. */
function game(opts: {
  state?: string;
  homeScore?: number;
  awayScore?: number;
  clock?: string;
  period?: number;
  seasonType?: number;
}): EspnEvent {
  return {
    id: '1',
    status: {
      type: { state: opts.state ?? 'in', detail: 'test' },
      displayClock: opts.clock,
      period: opts.period,
    },
    season: opts.seasonType !== undefined ? { type: opts.seasonType } : undefined,
    competitions: [
      {
        competitors: [
          { score: String(opts.homeScore ?? 0), homeAway: 'home', team: { abbreviation: 'H' } },
          { score: String(opts.awayScore ?? 0), homeAway: 'away', team: { abbreviation: 'A' } },
        ],
      },
    ],
  };
}

describe('calculateExcitement', () => {
  it('returns 0 for games not in progress', () => {
    expect(calculateExcitement(game({ state: 'pre', homeScore: 1, awayScore: 1 }))).toBe(0);
    expect(calculateExcitement(game({ state: 'post', homeScore: 1, awayScore: 1 }))).toBe(0);
  });

  it('scores margin bands (no clock/period bonus with period 1)', () => {
    expect(calculateExcitement(game({ period: 1, homeScore: 10, awayScore: 8 }))).toBe(50);  // margin 2
    expect(calculateExcitement(game({ period: 1, homeScore: 10, awayScore: 4 }))).toBe(35);  // margin 6
    expect(calculateExcitement(game({ period: 1, homeScore: 20, awayScore: 11 }))).toBe(20); // margin 9
    expect(calculateExcitement(game({ period: 1, homeScore: 20, awayScore: 8 }))).toBe(10);  // margin 12
    expect(calculateExcitement(game({ period: 1, homeScore: 40, awayScore: 10 }))).toBe(0);  // margin 30
  });

  it('adds +20 for period >= 2', () => {
    // margin 12 → 10, + period bonus 20 = 30
    expect(calculateExcitement(game({ period: 2, homeScore: 20, awayScore: 8 }))).toBe(30);
  });

  it('adds +30 in the final 5 minutes of a late period', () => {
    // margin 2 → 50, + period 20, + final-mins 30 = 100 (capped)
    expect(calculateExcitement(game({ period: 4, clock: '2:13', homeScore: 90, awayScore: 88 }))).toBe(100);
    // just outside the window
    expect(calculateExcitement(game({ period: 4, clock: '6:00', homeScore: 90, awayScore: 88 }))).toBe(70);
  });

  it('adds +20 postseason bonus (season.type === 3)', () => {
    // margin 9 → 20, + period 20, + postseason 20 = 60
    expect(calculateExcitement(game({ period: 2, seasonType: 3, homeScore: 20, awayScore: 11 }))).toBe(60);
  });

  it('caps at 100', () => {
    expect(
      calculateExcitement(game({ period: 4, clock: '0:30', seasonType: 3, homeScore: 100, awayScore: 99 })),
    ).toBe(100);
  });

  it('returns 0 on unparseable scores', () => {
    const g = game({ homeScore: 1, awayScore: 1 });
    g.competitions[0].competitors[0].score = '';
    expect(calculateExcitement(g)).toBe(0);
  });
});
