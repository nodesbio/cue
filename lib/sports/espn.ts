/**
 * ESPN scoreboard fetch + normalization.
 *
 * Uses ESPN's public site.api.espn.com endpoints — no API key, no auth. Ported
 * from apex-exotics/sports-monitor/excitement_engine.py (get_excitement_rankings),
 * but split into a pure normalizer (`rankScoreboard`) and a thin fetch wrapper
 * (`fetchLiveGames`) so the ranking logic is testable without network I/O.
 *
 * HTTPS (the Python original used http://; we upgrade — mobile ATS blocks
 * cleartext and there's no reason to send cleartext here).
 */
import { calculateExcitement } from './excitement';
import type { EspnEvent, EspnScoreboard, GameSnapshot, Leader, League } from './types';

/** ESPN category name → our short stat label + display priority (lower first). */
const STAT_MAP: Record<string, { label: string; priority: number }> = {
  points: { label: 'PTS', priority: 0 },
  rebounds: { label: 'REB', priority: 1 },
  assists: { label: 'AST', priority: 2 },
};

/**
 * Pull the top PTS/REB/AST performer across both teams from a competition's
 * per-competitor `leaders` blocks. Pure. Returns [] when the feed carries no
 * leaders (pre-game, or sports that don't populate them). For each stat we keep
 * the higher numeric value between the two teams' category leaders, so the HUD
 * shows e.g. the game's top scorer, not one arbitrary team's.
 *
 * `displayValue` can be "14" or "14 PTS, 8 REB" (the 'rating' category) — we
 * only read points/rebounds/assists, whose displayValue is a bare number, and
 * parseInt tolerates a trailing unit just in case.
 */
export function extractLeaders(comp: EspnEvent['competitions'][number]): Leader[] {
  const best = new Map<string, Leader>(); // keyed by stat label
  for (const c of comp.competitors) {
    for (const cat of c.leaders ?? []) {
      const m = STAT_MAP[cat.name];
      if (!m) continue;
      const top = cat.leaders?.[0];
      const ath = top?.athlete;
      if (!top || !ath?.shortName) continue;
      const value = top.displayValue ?? '';
      const num = parseInt(value, 10);
      if (!Number.isFinite(num)) continue;
      const cand: Leader = {
        stat: m.label,
        value: String(num),
        player: ath.shortName,
        team: c.team.abbreviation,
        pos: ath.position?.abbreviation ?? '',
      };
      const existing = best.get(m.label);
      if (!existing || num > parseInt(existing.value, 10)) best.set(m.label, cand);
    }
  }
  return [...best.values()].sort(
    (a, b) => STAT_MAP[statKey(a.stat)].priority - STAT_MAP[statKey(b.stat)].priority,
  );
}

function statKey(label: string): string {
  return label === 'PTS' ? 'points' : label === 'REB' ? 'rebounds' : 'assists';
}

const ENDPOINTS: Record<League, string> = {
  NBA: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
  NHL: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
  NCAAM: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard',
  NCAAW: 'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/scoreboard',
  NCAAF: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
  NFL: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
};

/** Human label for a league (used in the HUD line). */
export const LEAGUE_LABEL: Record<League, string> = {
  NBA: 'NBA',
  NHL: 'NHL',
  NCAAM: 'NCAA',
  NCAAW: 'NCAAW',
  NCAAF: 'CFB',
  NFL: 'NFL',
};

/**
 * Normalize one ESPN scoreboard payload into ranked, in-progress GameSnapshots.
 * Pure — no I/O. Games not in progress (excitement 0) are dropped.
 */
export function rankScoreboard(board: EspnScoreboard, league: League): GameSnapshot[] {
  const out: GameSnapshot[] = [];
  for (const event of board.events ?? []) {
    const excitement = calculateExcitement(event, league);
    if (excitement <= 0) continue;

    const comp = event.competitions?.[0];
    if (!comp || comp.competitors.length < 2) continue;

    // Select by homeAway, not array position: ESPN orders competitors
    // differently across sports (NBA lists home first, NHL often away first),
    // so [0]/[1] indexing would silently swap teams. Verified against live
    // NBA scoreboard 2026-11 (competitors[0].homeAway === 'home').
    const homeC = comp.competitors.find((c) => c.homeAway === 'home') ?? comp.competitors[0];
    const awayC = comp.competitors.find((c) => c.homeAway === 'away') ?? comp.competitors[1];

    out.push({
      gameId: event.id,
      league,
      excitement,
      home: homeC.team.abbreviation,
      away: awayC.team.abbreviation,
      homeFull: homeC.team.displayName ?? homeC.team.abbreviation,
      awayFull: awayC.team.displayName ?? awayC.team.abbreviation,
      homeScore: homeC.score,
      awayScore: awayC.score,
      status: event.status?.type?.detail ?? '',
      leaders: extractLeaders(comp),
    });
  }
  out.sort((a, b) => b.excitement - a.excitement);
  return out;
}

async function fetchBoard(league: League, signal?: AbortSignal): Promise<EspnScoreboard> {
  const resp = await fetch(ENDPOINTS[league], { signal });
  if (!resp.ok) throw new Error(`ESPN ${league} HTTP ${resp.status}`);
  return (await resp.json()) as EspnScoreboard;
}

/**
 * Fetch and rank live games across the requested leagues (default: all of them),
 * merged and sorted by excitement. A single league's failure does not sink the
 * whole call — it's logged and skipped, matching the Python original's per-sport
 * try/except. (This is NOT masking a bug: ESPN routinely 503s one sport while
 * the others are fine; the caller still gets a useful feed.)
 */
export async function fetchLiveGames(
  leagues: League[] = ['NBA', 'NHL', 'NCAAM', 'NCAAW', 'NCAAF', 'NFL'],
  signal?: AbortSignal,
): Promise<GameSnapshot[]> {
  const results = await Promise.allSettled(
    leagues.map(async (lg) => rankScoreboard(await fetchBoard(lg, signal), lg)),
  );

  const games: GameSnapshot[] = [];
  const failures: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') games.push(...r.value);
    else {
      const msg = r.reason?.message ?? String(r.reason);
      failures.push(msg);
      console.warn(`[sports] ${leagues[i]} fetch failed:`, msg);
    }
  });
  // Every league failing (offline / ESPN down) is an error, not a quiet night:
  // returning [] here put "No live games right now" on the lens and onError
  // never fired. Partial failure is still tolerated (above).
  if (leagues.length > 0 && failures.length === leagues.length) {
    throw new Error(`All ${leagues.length} leagues failed: ${failures[0]}`);
  }
  games.sort((a, b) => b.excitement - a.excitement);
  return games;
}
