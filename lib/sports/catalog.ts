/**
 * catalog.ts — the pickable set of leagues and teams for the audience builder
 * (#44). This is the menu the builder UI shows; it is NOT the live-games feed
 * (see types.ts `League`, which is deliberately only NBA/NHL/NCAAM).
 *
 * v1 is a static catalog, on purpose. Fetching ESPN's full team lists live is
 * #45's job; the builder just needs a good-enough menu to assemble an audience
 * today. Coverage was verified keyless on 2026-11-21 (NASCAR's feed is dead, so
 * it's intentionally absent). Teams listed are the realistic picks for the
 * seeded audiences plus their obvious league-mates; a user who needs a team we
 * didn't list can still get league-level cards by picking the league itself.
 *
 * ESPN path slugs only (sport/league); ids are unique within a league, never
 * globally (id 5 = Browns / Guardians / Cavs across leagues — see audience.ts).
 */

export interface CatalogTeam {
  teamId: string;
  label: string;
}

export interface CatalogLeague {
  sport: string;  // ESPN path slug, e.g. 'football'
  league: string; // ESPN path slug, e.g. 'nfl'
  label: string;  // display name, e.g. 'NFL'
  /** True when the league itself is a sensible standalone topic (Premier,
   *  Champions, F1). Team-centric leagues set this false. */
  leaguePickable: boolean;
  teams: CatalogTeam[];
}

const team = (teamId: string, label: string): CatalogTeam => ({ teamId, label });

/**
 * Ordered for the picker: the leagues Columbus-area and client audiences care
 * about first, then the international/world set.
 */
export const CATALOG: CatalogLeague[] = [
  {
    sport: 'football', league: 'nfl', label: 'NFL', leaguePickable: false,
    teams: [
      team('4', 'Cincinnati Bengals'),
      team('5', 'Cleveland Browns'),
      team('6', 'Dallas Cowboys'),
      team('15', 'Miami Dolphins'),
      team('30', 'Jacksonville Jaguars'),
      team('34', 'Houston Texans'),
    ],
  },
  {
    sport: 'football', league: 'college-football', label: 'College Football', leaguePickable: false,
    teams: [team('194', 'Ohio State Buckeyes')],
  },
  {
    sport: 'basketball', league: 'nba', label: 'NBA', leaguePickable: false,
    teams: [
      team('5', 'Cleveland Cavaliers'),
      team('6', 'Dallas Mavericks'),
      team('10', 'Houston Rockets'),
      team('14', 'Miami Heat'),
      team('19', 'Orlando Magic'),
      team('24', 'San Antonio Spurs'),
    ],
  },
  {
    sport: 'basketball', league: 'mens-college-basketball', label: "Men's College Basketball", leaguePickable: false,
    teams: [team('194', 'Ohio State Buckeyes')],
  },
  {
    sport: 'baseball', league: 'mlb', label: 'MLB', leaguePickable: false,
    teams: [team('5', 'Cleveland Guardians')],
  },
  {
    sport: 'hockey', league: 'nhl', label: 'NHL', leaguePickable: false,
    teams: [team('29', 'Columbus Blue Jackets')],
  },
  {
    sport: 'soccer', league: 'usa.1', label: 'MLS', leaguePickable: false,
    teams: [team('183', 'Columbus Crew')],
  },
  {
    sport: 'soccer', league: 'eng.1', label: 'Premier League', leaguePickable: true,
    teams: [],
  },
  {
    sport: 'soccer', league: 'uefa.champions', label: 'Champions League', leaguePickable: true,
    teams: [],
  },
  {
    sport: 'racing', league: 'f1', label: 'Formula 1', leaguePickable: true,
    teams: [],
  },
];
