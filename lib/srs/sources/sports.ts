/**
 * sources/sports.ts — adapt sports Cards into SRS flashcards (SRS Phase 2).
 *
 * This is the first "deck source": it turns the existing ESPN-derived sports
 * Card (record/standing/nextgame/news) into the sport-agnostic SRS Card the
 * review engine consumes. Anki `.apkg` will be a sibling adapter later.
 *
 * THE STANCE FLIP LIVES HERE. The old sports model used `stance` to choose
 * "statement to say" vs "question to ask the audience". That framing is gone:
 * the Deck is now the wearer's private study tool, so EVERY card is a two-sided
 * flashcard — a question on the front, the fact on the back. "Know vs learning"
 * collapses into "every card is a timed question/answer"; the wearer decides
 * what to share in the live conversation, not the deck.
 *
 *   sports kind   prompt (front, recalled)              answer (back, revealed)
 *   record        "What's <team>'s record?"             "9-8"
 *   standing      "Where do <team> sit?"                "2nd in Central Division"
 *   nextgame      "Who/when is <team>'s next game?"      "Host CLE, Fri"
 *   news          "<team> headline?"                    the headline (+ blurb)
 *
 * The SRS card id is the sports card id (stable per topic+kind), so regenerating
 * the deck preserves scheduling via store.mergeDeck.
 */

import type { Card as SportsCard } from '../../sports/cards';
import { makeCard, type Card, type DeckId } from '../card';

/** Front/back text for one sports card. Pure; no model call (v1 templates). */
function promptAnswer(c: SportsCard): { prompt: string; answer: string } {
  const team = c.topicLabel;
  switch (c.kind) {
    case 'record':
      return { prompt: `What's ${team}'s record this season?`, answer: c.summary };
    case 'standing':
      return { prompt: `Where do ${team} sit in the standings?`, answer: c.standing };
    case 'nextgame': {
      const vs = c.isHome ? `host ${c.opponent}` : `visit ${c.opponent}`;
      return { prompt: `When is ${team}'s next game, and who against?`, answer: `${capitalize(vs)} — ${c.shortName}` };
    }
    case 'news':
      return {
        prompt: `What's the latest ${team} headline?`,
        answer: c.description && c.description !== c.headline ? `${c.headline}\n\n${c.description}` : c.headline,
      };
  }
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Convert a deck of sports Cards into SRS Cards for the given deckId (an
 * audience id). Fresh cards start unseen/due-now via makeCard; store.mergeDeck
 * reattaches earned scheduling for ids that already exist.
 */
export function sportsToSrs(deckId: DeckId, sportsCards: SportsCard[], now: number = Date.now()): Card[] {
  return sportsCards.map((c) => {
    const { prompt, answer } = promptAnswer(c);
    return makeCard(c.id, deckId, prompt, answer, `sports:${c.topicKey}:${c.kind}`, now);
  });
}
