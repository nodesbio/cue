/**
 * templates.ts — starting templates for the conversation deck (#44).
 *
 * Seeded once on first run, then fully editable. These are templates, not the
 * product; the product is the user's own audiences. Team ids were read from
 * ESPN's team lists on 2026-11-21 and re-verified before filing #44.
 *
 * Florida/Texas list only the NFL + NBA teams that were looked up; baseball,
 * hockey, college and the Buccaneers still need adding (noted in #44).
 *
 * Proposed stances, confirm with John (#44): Columbus topics `know`,
 * World topics `learning`.
 */

import { Audience, DEFAULT_MAX_CARDS, Stance, Topic } from './audience';

function team(sport: string, league: string, teamId: string, label: string, stance: Stance): Topic {
  return { kind: 'team', sport, league, teamId, label, stance };
}
function league(sport: string, lg: string, label: string, stance: Stance): Topic {
  return { kind: 'league', sport, league: lg, label, stance };
}

/** Templates WITHOUT ids/updatedAt — the store stamps those on seed. */
export interface AudienceTemplate {
  name: string;
  topics: Topic[];
  maxCards: number;
}

export const AUDIENCE_TEMPLATES: AudienceTemplate[] = [
  {
    name: 'Columbus',
    maxCards: DEFAULT_MAX_CARDS,
    topics: [
      team('football', 'college-football', '194', 'Ohio State Buckeyes', 'know'),
      team('basketball', 'mens-college-basketball', '194', 'Ohio State Buckeyes', 'know'),
      team('football', 'nfl', '4', 'Cincinnati Bengals', 'know'),
      team('football', 'nfl', '5', 'Cleveland Browns', 'know'),
      team('baseball', 'mlb', '5', 'Cleveland Guardians', 'know'),
      team('basketball', 'nba', '5', 'Cleveland Cavaliers', 'know'),
      team('hockey', 'nhl', '29', 'Columbus Blue Jackets', 'know'),
      team('soccer', 'usa.1', '183', 'Columbus Crew', 'know'),
    ],
  },
  {
    name: 'Florida',
    maxCards: DEFAULT_MAX_CARDS,
    topics: [
      team('football', 'nfl', '15', 'Miami Dolphins', 'know'),
      team('football', 'nfl', '30', 'Jacksonville Jaguars', 'know'),
      team('basketball', 'nba', '14', 'Miami Heat', 'know'),
      team('basketball', 'nba', '19', 'Orlando Magic', 'know'),
    ],
  },
  {
    name: 'Texas',
    maxCards: DEFAULT_MAX_CARDS,
    topics: [
      team('football', 'nfl', '6', 'Dallas Cowboys', 'know'),
      team('football', 'nfl', '34', 'Houston Texans', 'know'),
      team('basketball', 'nba', '6', 'Dallas Mavericks', 'know'),
      team('basketball', 'nba', '10', 'Houston Rockets', 'know'),
      team('basketball', 'nba', '24', 'San Antonio Spurs', 'know'),
    ],
  },
  {
    name: 'World',
    maxCards: DEFAULT_MAX_CARDS,
    topics: [
      league('soccer', 'eng.1', 'Premier League', 'learning'),
      league('soccer', 'uefa.champions', 'Champions League', 'learning'),
      league('racing', 'f1', 'Formula 1', 'learning'),
    ],
  },
];
