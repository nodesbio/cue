/**
 * ESPN scoreboard shapes (the subset we consume) + our normalized snapshot.
 *
 * Source: ESPN's public site.api.espn.com scoreboard endpoints — no API key,
 * no auth. We type only the fields the excitement scorer and feed formatter
 * actually read; everything else is intentionally omitted (the payload is huge).
 */

/** The raw ESPN "event" object, trimmed to what we read. */
export interface EspnEvent {
  id: string;
  status: {
    type: {
      state: 'pre' | 'in' | 'post' | string;
      detail: string;
    };
    displayClock?: string;
    period?: number;
  };
  season?: { type?: number };
  competitions: Array<{
    competitors: Array<{
      score: string;
      homeAway?: 'home' | 'away';
      team: {
        id?: string;
        abbreviation: string;
        displayName?: string;
      };
      /**
       * Per-competitor stat leaders. Rides along in the SAME scoreboard call —
       * no extra request, still keyless. Verified live 2026-11-20 (NBA):
       * categories points/rebounds/assists/rating, each with displayValue and
       * the athlete's shortName + position. We read points/rebounds/assists.
       */
      leaders?: Array<EspnLeaderCategory>;
    }>;
  }>;
}

/** One stat category block inside a competitor's `leaders` array. */
export interface EspnLeaderCategory {
  name: string;              // 'points' | 'rebounds' | 'assists' | 'rating' | ...
  shortDisplayName?: string; // 'Pts' | 'Reb' | 'Ast'
  leaders?: Array<{
    displayValue: string;    // '14' or '14 PTS'
    athlete?: {
      shortName?: string;    // 'J. Johnson'
      position?: { abbreviation?: string }; // 'F' | 'G' | 'C'
    };
  }>;
}

export interface EspnScoreboard {
  events?: EspnEvent[];
}

/** League key → used for endpoint selection and display labels. */
export type League = 'NBA' | 'NHL' | 'NCAAM' | 'NCAAF';

/** A normalized, UI/HUD-ready view of one live game. */
export interface GameSnapshot {
  gameId: string;
  league: League;
  excitement: number; // 0-100
  home: string;       // abbreviation
  away: string;
  homeFull: string;
  awayFull: string;
  homeScore: string;
  awayScore: string;
  /** ESPN status detail, e.g. "4th Quarter - 2:13" or "Final". */
  status: string;
  /**
   * Top stat performers across both teams, highest first by category priority
   * (points > rebounds > assists). Empty for pre-game / leaderless feeds.
   * This is the conversational payload — "Wemby's got 28 and 9" — that makes
   * the HUD worth talking about, not just a scoreboard.
   */
  leaders: Leader[];
}

/** A normalized single stat leader for the HUD/list. */
export interface Leader {
  /** 'PTS' | 'REB' | 'AST' */
  stat: string;
  /** Numeric/display value, e.g. "28". */
  value: string;
  /** Player short name, e.g. "V. Wembanyama". */
  player: string;
  /** Team abbreviation the player belongs to. */
  team: string;
  /** Position abbreviation, e.g. "C" (may be empty). */
  pos: string;
}
