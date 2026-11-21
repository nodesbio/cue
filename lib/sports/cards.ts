/**
 * cards.ts — turn an audience Topic into conversation cards from ESPN (#45).
 *
 * A Card is one thing to say (or ask) about a topic: the team's record, where
 * they sit in the standings, their next game, or a fresh news beat. The deck
 * (#46) renders these on the lens and steps through them.
 *
 * Namespace note: this module works in ESPN *path slug* space (football/nfl,
 * basketball/nba, soccer/eng.1 …) via topicPath()/topicKey() from audience.ts —
 * NOT the narrow `League` union in types.ts (which is scoreboard-only: NBA/NHL/
 * NCAAM). Do not conflate the two; a college-football topic has no League value.
 *
 * Keyless, verified live 2026-11-21:
 *   - team endpoint  …/{sport}/{league}/teams/{id}  → record, standingSummary,
 *     nextEvent all in ONE call.
 *   - news endpoint  …/{sport}/{league}/news?team={id}&limit=N  → articles.
 * Both are public site.api.espn.com, no auth. HTTPS (mobile ATS blocks cleartext).
 *
 * Templating, not generation: per #44/#46 there is no model call. We build the
 * card `text` from fixed templates and the topic's stance — `know` yields a
 * statement to share, `learning` yields a question to ask. Structured facts ride
 * along so #46 can re-render without re-fetching.
 */

import type { Stance, TeamTopic, Topic } from './audience';
// topicKey is aliased to topicKeyOf to avoid clashing with the Card.topicKey field.
import { topicKey as topicKeyOf, topicPath } from './audience';

// ── Freshness / sizing defaults (proposed in #45; confirm with John) ───────────

/** News older than this is dropped. 48h per the backlog default. */
export const NEWS_FRESHNESS_MS = 48 * 60 * 60 * 1000;
/** Max news cards per topic (the rest of the deck is record/standing/nextgame). */
export const MAX_NEWS_PER_TOPIC = 2;
/**
 * A "next game" is only conversational if it's reasonably near. ESPN's
 * `nextEvent` happily returns a game months out when a team is between seasons
 * (an MLB team in November points at spring training / next season). Beyond this
 * horizon the team is effectively out of season, so we drop the card rather than
 * surface "the Guardians visit the Reds on Feb 19" in the middle of November.
 */
export const NEXT_GAME_HORIZON_MS = 10 * 24 * 60 * 60 * 1000;

// ── Card model ─────────────────────────────────────────────────────────────────

export type CardKind = 'record' | 'standing' | 'nextgame' | 'news';

interface CardBase {
  /** Stable id for dedupe/keys within a deck. */
  id: string;
  kind: CardKind;
  /** The topic this card came from (its key). */
  topicKey: string;
  /** Short topic label for the card header, e.g. 'Cleveland Cavaliers'. */
  topicLabel: string;
  /** The topic's stance — drives whether `text` is a statement or a question. */
  stance: Stance;
  /** Ready-to-read line for the lens, built from a template + the facts below. */
  text: string;
  /** For ordering: epoch ms the underlying fact is anchored to (game time,
   *  publish time). Record/standing have none → undefined (sorted last). */
  freshAt?: number;
}

export interface RecordCard extends CardBase {
  kind: 'record';
  summary: string; // e.g. '9-8'
}

export interface StandingCard extends CardBase {
  kind: 'standing';
  standing: string; // e.g. '2nd in Central Division'
}

export interface NextGameCard extends CardBase {
  kind: 'nextgame';
  opponent: string; // other team's display name
  isHome: boolean;  // true = topic team hosts
  kickoff: number;  // epoch ms
  shortName: string; // e.g. 'CLE @ CHI'
}

export interface NewsCard extends CardBase {
  kind: 'news';
  headline: string;
  articleType: string; // ESPN 'type': Recap | Preview | Story | Media …
  published: number;   // epoch ms
  /** ESPN's blurb — the substance worth reading in ambient reader mode (#47).
   *  Omitted when empty OR equal to the headline (Media/highlight rows set
   *  description === headline, so there is nothing to expand to). */
  description?: string;
}

export type Card = RecordCard | StandingCard | NextGameCard | NewsCard;

// ── Raw ESPN shapes (only the fields we read) ──────────────────────────────────

export interface EspnTeamResponse {
  team?: {
    id?: string;
    displayName?: string;
    abbreviation?: string;
    standingSummary?: string;
    record?: {
      items?: Array<{
        type?: string;        // 'total'
        summary?: string;     // '9-8'
        description?: string; // 'Overall Record'
      }>;
    };
    nextEvent?: Array<{
      date?: string;      // ISO
      shortName?: string; // 'CLE @ CHI'
      competitions?: Array<{
        competitors?: Array<{
          homeAway?: 'home' | 'away';
          team?: { id?: string; displayName?: string };
        }>;
      }>;
    }>;
  };
}

export interface EspnNewsResponse {
  articles?: Array<{
    headline?: string;
    published?: string; // ISO
    type?: string;      // Recap | Preview | Story | Media …
    description?: string;
  }>;
}

// ── Templating ─────────────────────────────────────────────────────────────────

/**
 * Build the lens line for a card from its facts + stance. `know` → a statement
 * the wearer can share; `learning` → a question/hook they can ask. No model
 * call: these are fixed templates (backlog decision, #44/#46).
 */
function renderText(
  kind: CardKind,
  stance: Stance,
  team: string,
  facts: { record?: string; standing?: string; opponent?: string; isHome?: boolean; when?: string; headline?: string },
): string {
  const know = stance === 'know';
  switch (kind) {
    case 'record':
      return know
        ? `${team} are ${facts.record}.`
        : `How are ${team} doing this year? (${facts.record})`;
    case 'standing':
      return know
        ? `${team}: ${facts.standing}.`
        : `Where do ${team} sit right now? (${facts.standing})`;
    case 'nextgame': {
      const vs = facts.isHome ? `host ${facts.opponent}` : `visit ${facts.opponent}`;
      return know
        ? `${team} ${vs} ${facts.when}.`
        : `Catching the ${team} game ${facts.when}? They ${vs}.`;
    }
    case 'news':
      return know
        ? `${facts.headline}`
        : `Did you see this? ${facts.headline}`;
  }
}

/** Compact, human kickoff phrasing relative to now: 'tonight', 'tomorrow',
 *  'Fri', else a short date. Pure given `now`. */
function whenLabel(kickoffMs: number, now: number): string {
  const diffDays = Math.floor((startOfDay(kickoffMs) - startOfDay(now)) / 86_400_000);
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays < 7) return new Date(kickoffMs).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(kickoffMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ── Pure normalizers (no I/O) ──────────────────────────────────────────────────

/**
 * Build record / standing / next-game cards from one team endpoint payload.
 * Each source is independent — a missing field drops only its own card, never
 * the others. `now` is injected so tests are deterministic.
 */
export function cardsFromTeam(topic: TeamTopic, res: EspnTeamResponse, now = Date.now()): Card[] {
  const t = res.team;
  if (!t) return [];
  const key = topicKeyOf(topic);
  const label = topic.label;
  const out: Card[] = [];

  // Record — prefer the 'total'/'Overall' item, else the first with a summary.
  const recItem =
    t.record?.items?.find((i) => i.type === 'total') ??
    t.record?.items?.find((i) => i.summary);
  if (recItem?.summary) {
    out.push({
      id: `${key}#record`,
      kind: 'record',
      topicKey: key,
      topicLabel: label,
      stance: topic.stance,
      summary: recItem.summary,
      text: renderText('record', topic.stance, label, { record: recItem.summary }),
    });
  }

  // Standing
  if (t.standingSummary) {
    out.push({
      id: `${key}#standing`,
      kind: 'standing',
      topicKey: key,
      topicLabel: label,
      stance: topic.stance,
      standing: t.standingSummary,
      text: renderText('standing', topic.stance, label, { standing: t.standingSummary }),
    });
  }

  // Next game
  const ev = t.nextEvent?.[0];
  const comp = ev?.competitions?.[0];
  const kickoff = ev?.date ? Date.parse(ev.date) : NaN;
  // Skip games already started/past and games beyond the relevance horizon
  // (out-of-season teams whose nextEvent points at next season).
  const inHorizon = Number.isFinite(kickoff) && kickoff >= now && kickoff - now <= NEXT_GAME_HORIZON_MS;
  if (comp && inHorizon) {
    const me = comp.competitors?.find((c) => c.team?.id === topic.teamId);
    const other = comp.competitors?.find((c) => c.team?.id !== topic.teamId);
    const opponent = other?.team?.displayName;
    if (opponent && me?.homeAway) {
      const isHome = me.homeAway === 'home';
      const when = whenLabel(kickoff, now);
      out.push({
        id: `${key}#nextgame`,
        kind: 'nextgame',
        topicKey: key,
        topicLabel: label,
        stance: topic.stance,
        opponent,
        isHome,
        kickoff,
        shortName: ev?.shortName ?? '',
        freshAt: kickoff,
        text: renderText('nextgame', topic.stance, label, { opponent, isHome, when }),
      });
    }
  }

  return out;
}

/**
 * Build news cards from a news payload. Drops articles older than
 * NEWS_FRESHNESS_MS, sorts newest-first, and caps at MAX_NEWS_PER_TOPIC.
 * `now` injected for deterministic tests.
 */
export function cardsFromNews(topic: Topic, res: EspnNewsResponse, now = Date.now()): NewsCard[] {
  const key = topicKeyOf(topic);
  const label = topic.label;
  return (res.articles ?? [])
    .map((a) => {
      const published = a.published ? Date.parse(a.published) : NaN;
      if (!a.headline || !Number.isFinite(published)) return null;
      if (now - published > NEWS_FRESHNESS_MS) return null; // stale
      // Keep the blurb only when it adds something over the headline. ESPN sets
      // description === headline for Media/highlight rows — nothing to expand to.
      const blurb = a.description?.trim();
      const description = blurb && blurb !== a.headline.trim() ? blurb : undefined;
      // Drop raw clip labels: Media rows whose blurb adds nothing are bare video
      // tiles like "Team vs. Team: Game Highlights" — not conversational, and
      // headline-only so there's nothing to read. Media items that DO carry their
      // own substance (description !== headline) are kept. Verified live 2026-11-21.
      if (a.type === 'Media' && !description) return null;
      const card: NewsCard = {
        id: `${key}#news:${published}`,
        kind: 'news',
        topicKey: key,
        topicLabel: label,
        stance: topic.stance,
        headline: a.headline,
        articleType: a.type ?? '',
        published,
        freshAt: published,
        description,
        text: renderText('news', topic.stance, label, { headline: a.headline }),
      };
      return card;
    })
    .filter((c): c is NewsCard => c !== null)
    .sort((a, b) => b.published - a.published)
    .slice(0, MAX_NEWS_PER_TOPIC);
}

// ── Thin fetch wrapper ─────────────────────────────────────────────────────────

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`ESPN HTTP ${resp.status} for ${url}`);
  return (await resp.json()) as T;
}

/**
 * Fetch all cards for one topic. League topics (no team id) currently yield only
 * league news; team topics yield record/standing/nextgame + team news.
 *
 * Per-source failure is isolated with Promise.allSettled — ESPN routinely 503s
 * one endpoint while the other is fine, and a dead source should cost its own
 * cards, not the whole topic. This is NOT masking a bug: the caller still gets a
 * useful, smaller deck, and failures are surfaced via console.warn (Zoracon:
 * we log the signal, we don't swallow it silently).
 */
export async function fetchTopicCards(topic: Topic, signal?: AbortSignal): Promise<Card[]> {
  const path = topicPath(topic); // e.g. 'basketball/nba'
  const jobs: Promise<Card[]>[] = [];

  if (topic.kind === 'team') {
    const teamUrl = `${BASE}/${path}/teams/${topic.teamId}`;
    jobs.push(getJson<EspnTeamResponse>(teamUrl, signal).then((r) => cardsFromTeam(topic, r)));
  }

  const teamQ = topic.kind === 'team' ? `?team=${topic.teamId}&limit=10` : '?limit=10';
  const newsUrl = `${BASE}/${path}/news${teamQ}`;
  jobs.push(getJson<EspnNewsResponse>(newsUrl, signal).then((r) => cardsFromNews(topic, r)));

  const settled = await Promise.allSettled(jobs);
  const cards: Card[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') cards.push(...s.value);
    else console.warn(`[sports] card source failed for ${topicKeyOf(topic)}:`, s.reason?.message ?? s.reason);
  }
  return cards;
}
