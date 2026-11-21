/**
 * deck.ts — assemble an ordered conversation deck from an audience (#46).
 *
 * Inputs: the audience (topics, maxCards) and the cards fetched per topic (#45).
 * Output: a single flat, ordered, capped list of cards the lens steps through.
 *
 * Ordering (backlog decision "live games first, then freshest"):
 *   1. Cards whose topic has a live game right now (promoted to the front).
 *   2. Then by |freshAt - now| ascending — the card anchored closest to *now*
 *      floats up. This is the recent past for news and the near future for a
 *      next game, so tonight's kickoff beats next week's and today's recap beats
 *      yesterday's, all under one rule.
 *   3. Static cards (record/standing, no freshAt) sink to the bottom.
 * Within each tier we keep per-topic interleaving stable so one chatty topic
 * can't monopolise the top of the deck.
 *
 * Pure: no I/O, no clock of its own — `liveTopicKeys` is passed in (derived from
 * the live SportsFeed in the UI layer). This keeps ordering testable.
 */

import type { Audience } from './audience';
import { topicKey as topicKeyFor } from './audience';
import type { Card } from './cards';

export interface BuildDeckOpts {
  /** topicKey()s that currently have a live game — promoted to the front. */
  liveTopicKeys?: ReadonlySet<string>;
  /** Reference time for proximity ordering (default Date.now()). Injectable for tests. */
  now?: number;
}

/** Sort rank for a card: lower sorts first. */
function rank(card: Card, live: ReadonlySet<string>): number {
  if (live.has(card.topicKey)) return 0; // live topic — top tier
  if (card.freshAt !== undefined) return 1; // time-anchored (news, next game)
  return 2; // static (record, standing)
}

/**
 * Build the ordered, capped deck. `cardsByTopic` maps topicKey → that topic's
 * cards (as returned by fetchTopicCards). Topics absent from the map contribute
 * nothing (e.g. a dead feed) without breaking the rest of the deck.
 */
export function buildDeck(
  audience: Audience,
  cardsByTopic: Record<string, Card[]>,
  opts: BuildDeckOpts = {},
): Card[] {
  const live = opts.liveTopicKeys ?? new Set<string>();
  const now = opts.now ?? Date.now();

  // Flatten in the audience's topic order so interleaving is deterministic.
  const all: Card[] = [];
  for (const topic of audience.topics) {
    const key = topicKeyFor(topic);
    const cards = cardsByTopic[key];
    if (cards?.length) all.push(...cards);
  }

  // Stable sort by (tier, then proximity to now within the time-anchored tier).
  // Array.prototype.sort is stable in modern JS engines (incl. Hermes/V8), so
  // equal-rank cards keep their topic-order interleaving.
  const ordered = all
    .map((card, i) => ({ card, i }))
    .sort((a, b) => {
      const ra = rank(a.card, live);
      const rb = rank(b.card, live);
      if (ra !== rb) return ra - rb;
      // Within the time-anchored tier, the card anchored closest to now first.
      const da = a.card.freshAt !== undefined ? Math.abs(a.card.freshAt - now) : Infinity;
      const db = b.card.freshAt !== undefined ? Math.abs(b.card.freshAt - now) : Infinity;
      if (da !== db) return da - db;
      return a.i - b.i; // preserve original order on ties
    })
    .map((x) => x.card);

  const cap = audience.maxCards > 0 ? audience.maxCards : ordered.length;
  return ordered.slice(0, cap);
}
