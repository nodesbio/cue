/**
 * buildDeck — pure ordering + cap. Fixtures only, deterministic.
 */
import { buildDeck } from './deck';
import { topicKey } from './audience';
import type { Audience, TeamTopic } from './audience';
import type { Card } from './cards';

const cavs: TeamTopic = {
  kind: 'team', sport: 'basketball', league: 'nba', teamId: '5',
  label: 'Cleveland Cavaliers', stance: 'know',
};
const bulls: TeamTopic = {
  kind: 'team', sport: 'basketball', league: 'nba', teamId: '4',
  label: 'Chicago Bulls', stance: 'know',
};

const cavsKey = topicKey(cavs);
const bullsKey = topicKey(bulls);

function audience(over: Partial<Audience> = {}): Audience {
  return {
    id: 'a1', name: 'Columbus', topics: [cavs, bulls],
    maxCards: 5, updatedAt: 0, ...over,
  };
}

/** Minimal card factory; only the fields buildDeck reads matter. */
function card(topicKeyVal: string, kind: Card['kind'], freshAt?: number): Card {
  return {
    id: `${topicKeyVal}#${kind}:${freshAt ?? 'static'}`,
    kind, topicKey: topicKeyVal, topicLabel: 'x', stance: 'know',
    text: `${kind} card`, freshAt,
  } as Card;
}

describe('buildDeck', () => {
  it('orders time-anchored cards newest-first, static cards last', () => {
    const byTopic = {
      [cavsKey]: [
        card(cavsKey, 'record'),             // static
        card(cavsKey, 'news', 1000),         // older
        card(cavsKey, 'nextgame', 5000),     // newest
      ],
    };
    const deck = buildDeck(audience({ topics: [cavs] }), byTopic);
    expect(deck.map((c) => c.kind)).toEqual(['nextgame', 'news', 'record']);
  });

  it('promotes cards from live topics to the very front', () => {
    const byTopic = {
      [cavsKey]: [card(cavsKey, 'record')],            // static, not live
      [bullsKey]: [card(bullsKey, 'standing')],        // static, LIVE topic
    };
    const deck = buildDeck(
      audience(),
      byTopic,
      { liveTopicKeys: new Set([bullsKey]) },
    );
    expect(deck[0].topicKey).toBe(bullsKey); // live beats topic order
  });

  it('caps the deck at audience.maxCards', () => {
    const byTopic = {
      [cavsKey]: [
        card(cavsKey, 'news', 3000),
        card(cavsKey, 'news', 2000),
        card(cavsKey, 'record'),
      ],
    };
    const deck = buildDeck(audience({ topics: [cavs], maxCards: 2 }), byTopic);
    expect(deck.length).toBe(2);
    expect(deck.map((c) => c.freshAt)).toEqual([3000, 2000]); // kept the freshest
  });

  it('keeps per-topic interleaving stable within a tier (topic order on ties)', () => {
    // Two static cards, equal rank + no freshAt → original topic order wins.
    const byTopic = {
      [cavsKey]: [card(cavsKey, 'record')],
      [bullsKey]: [card(bullsKey, 'record')],
    };
    const deck = buildDeck(audience(), byTopic);
    expect(deck.map((c) => c.topicKey)).toEqual([cavsKey, bullsKey]);
  });

  it('ignores topics missing from the card map without breaking others', () => {
    const byTopic = { [cavsKey]: [card(cavsKey, 'record')] }; // bulls absent
    const deck = buildDeck(audience(), byTopic);
    expect(deck.map((c) => c.topicKey)).toEqual([cavsKey]);
  });

  it('returns [] for an empty card map', () => {
    expect(buildDeck(audience(), {})).toEqual([]);
  });

  it('treats maxCards<=0 as uncapped', () => {
    const byTopic = {
      [cavsKey]: [card(cavsKey, 'record'), card(cavsKey, 'standing')],
    };
    const deck = buildDeck(audience({ topics: [cavs], maxCards: 0 }), byTopic);
    expect(deck.length).toBe(2);
  });
});
