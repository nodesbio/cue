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

// --- Play-by-play (ESPN summary endpoint) ---------------------------------

/** One raw ESPN play, as returned under drives[].plays or a flat plays[]. */
export interface EspnPlay {
  id?: string;
  sequenceNumber?: string;
  text?: string;
  type?: { text?: string };
  period?: { number?: number };
  clock?: { displayValue?: string };
  homeScore?: number;
  awayScore?: number;
  scoringPlay?: boolean;
  /**
   * Which teams are on offense/defense for this play (football). Present on
   * every play in the summary — this is how we disambiguate "#10" to a single
   * team: offensive players (passer/rusher/receiver) resolve against the
   * offense team, tacklers (in the trailing parenthetical) against the defense.
   */
  teamParticipants?: Array<{ id?: string; type?: 'offense' | 'defense' }>;
  /** Possessing team on this play; fallback offense source if participants absent. */
  start?: { team?: { id?: string } };
}

/** One ESPN drive (football), wrapping a list of plays. */
export interface EspnDrive {
  team?: { abbreviation?: string };
  plays?: EspnPlay[];
}

/**
 * ESPN summary payload (…/summary?event={id}). Plays live EITHER as a flat
 * `plays[]` (basketball/hockey) OR nested under `drives` (football). We read
 * whichever is present.
 */
export interface EspnSummary {
  plays?: EspnPlay[];
  drives?: {
    current?: EspnDrive | null;
    previous?: EspnDrive[];
  };
  scoringPlays?: EspnPlay[];
  /**
   * Per-team player stat groups. Carries jersey + full name for everyone who
   * has recorded a stat — the join source for expanding "#10 A.Colandrea" into
   * "Anthony Colandrea" on the lens. Keyless, same payload as plays.
   */
  boxscore?: {
    players?: EspnBoxscoreTeam[];
  };
  /** Competitors carry team id -> abbreviation, used to map play team IDs. */
  header?: {
    competitions?: Array<{
      competitors?: Array<{ team?: { id?: string; abbreviation?: string } }>;
    }>;
  };
}

/** One team's player stat groups inside boxscore.players. */
export interface EspnBoxscoreTeam {
  team?: { abbreviation?: string };
  statistics?: Array<{
    athletes?: Array<{
      athlete?: { jersey?: string; displayName?: string };
    }>;
  }>;
}

/**
 * team+jersey -> full name map for one game. Only unambiguous entries are
 * present: if a jersey number maps to two different names within a team
 * (offense/defense/ST reuse, seen with OSU #25), it is dropped rather than
 * guessed — a wrong name on the lens is worse than an abbreviation.
 */
export type Roster = Map<string, string>;

/** A normalized single play for the play-by-play list, newest first. */
export interface PlayLine {
  /** Stable key for list rendering. */
  id: string;
  /** The play description, e.g. "L.Martin rush middle for 4 yards". */
  text: string;
  /** Period number (quarter/period/half). */
  period: number;
  /** Game clock at the play, e.g. "9:37" (may be empty). */
  clock: string;
  /** Score after the play: "away-home", e.g. "0-3". */
  score: string;
  /** True for scoring plays — the list highlights these. */
  scoring: boolean;
}
