/**
 * audience.ts — the "who am I about to talk to" model for the conversation deck.
 *
 * See issue #44. An Audience is a named, user-built set of sports topics chosen
 * ahead of a conversation (a swim meet, a Texas client, soccer with an
 * international friend). Topics are resolved later (#45) into cards (#46).
 *
 * Identity rule (measured 2026-11-21): a team is identified by ESPN path slug
 * PLUS id, never by id alone — id `5` is the Browns in NFL, the Guardians in
 * MLB and the Cavaliers in NBA. `sport`/`league` are ESPN path slugs
 * (e.g. 'football' / 'college-football'); they are intentionally NOT the
 * `League` union in types.ts, which omits college, MLS, NFL, MLB and racing.
 */

/** Per-topic posture. `know` = the wearer wants something to share;
 *  `learning` = the wearer wants a hook/question to ask. Used by #46. */
export type Stance = 'know' | 'learning';

/** A single ESPN team within a league. */
export interface TeamTopic {
  kind: 'team';
  sport: string;   // ESPN path slug, e.g. 'football'
  league: string;  // ESPN path slug, e.g. 'college-football'
  teamId: string;  // ESPN team id, unique only within sport+league
  label: string;   // display name captured at pick time, e.g. 'Ohio State Buckeyes'
  stance: Stance;
}

/** A whole league (no specific team), e.g. Premier League, F1. */
export interface LeagueTopic {
  kind: 'league';
  sport: string;
  league: string;
  label: string;   // e.g. 'Premier League'
  stance: Stance;
}

export type Topic = TeamTopic | LeagueTopic;

export interface Audience {
  id: string;
  name: string;
  topics: Topic[];
  maxCards: number; // total cards for this audience (default DEFAULT_MAX_CARDS)
  updatedAt: number; // epoch ms
}

/** Proposed default, confirm with John (#44). */
export const DEFAULT_MAX_CARDS = 5;

/**
 * Stable identity for a topic, used to dedupe and to key fetches (#45).
 * Team topics key on slug+id (never id alone); league topics on slug.
 */
export function topicKey(t: Topic): string {
  return t.kind === 'team'
    ? `team:${t.sport}/${t.league}/${t.teamId}`
    : `league:${t.sport}/${t.league}`;
}

/** The ESPN base path for a topic's league, used by the card sources (#45). */
export function topicPath(t: Topic): string {
  return `${t.sport}/${t.league}`;
}
