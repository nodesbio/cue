/**
 * Card normalizers — pure, deterministic. Network is never touched here; we feed
 * fixture payloads shaped from the live keyless responses verified 2026-11-21.
 */
import {
  cardsFromNews,
  cardsFromTeam,
  EspnNewsResponse,
  EspnTeamResponse,
  MAX_NEWS_PER_TOPIC,
  NEWS_FRESHNESS_MS,
  NewsCard,
  RecordCard,
  StandingCard,
  NextGameCard,
} from './cards';
import type { TeamTopic } from './audience';

// A fixed clock so whenLabel / freshness are deterministic.
const NOW = Date.parse('2026-11-23T18:00:00Z');

const cavs = (stance: 'know' | 'learning' = 'know'): TeamTopic => ({
  kind: 'team',
  sport: 'basketball',
  league: 'nba',
  teamId: '5',
  label: 'Cleveland Cavaliers',
  stance,
});

function teamPayload(over: Partial<EspnTeamResponse['team']> = {}): EspnTeamResponse {
  return {
    team: {
      id: '5',
      displayName: 'Cleveland Cavaliers',
      abbreviation: 'CLE',
      standingSummary: '2nd in Central Division',
      record: { items: [{ type: 'total', summary: '9-8', description: 'Overall Record' }] },
      nextEvent: [
        {
          date: '2026-11-24T01:00Z',
          shortName: 'CLE @ CHI',
          competitions: [
            {
              competitors: [
                { homeAway: 'home', team: { id: '4', displayName: 'Chicago Bulls' } },
                { homeAway: 'away', team: { id: '5', displayName: 'Cleveland Cavaliers' } },
              ],
            },
          ],
        },
      ],
      ...over,
    },
  };
}

describe('cardsFromTeam', () => {
  it('builds record, standing and next-game cards from a full payload', () => {
    const cards = cardsFromTeam(cavs(), teamPayload(), NOW);
    const kinds = cards.map((c) => c.kind).sort();
    expect(kinds).toEqual(['nextgame', 'record', 'standing']);

    const rec = cards.find((c) => c.kind === 'record') as RecordCard;
    expect(rec.summary).toBe('9-8');
    expect(rec.text).toBe('Cleveland Cavaliers are 9-8.');

    const st = cards.find((c) => c.kind === 'standing') as StandingCard;
    expect(st.standing).toBe('2nd in Central Division');

    const ng = cards.find((c) => c.kind === 'nextgame') as NextGameCard;
    expect(ng.opponent).toBe('Chicago Bulls');
    expect(ng.isHome).toBe(false); // Cavs are the away competitor
    expect(ng.shortName).toBe('CLE @ CHI');
  });

  it('phrases cards as questions when the stance is learning', () => {
    const cards = cardsFromTeam(cavs('learning'), teamPayload(), NOW);
    const rec = cards.find((c) => c.kind === 'record') as RecordCard;
    expect(rec.text).toContain('?');
    expect(rec.text).toContain('9-8');
  });

  it('drops only the missing source, not the whole payload', () => {
    const cards = cardsFromTeam(cavs(), teamPayload({ record: { items: [] }, standingSummary: undefined }), NOW);
    expect(cards.map((c) => c.kind)).toEqual(['nextgame']);
  });

  it('returns nothing when team is absent', () => {
    expect(cardsFromTeam(cavs(), {}, NOW)).toEqual([]);
  });

  it('skips next-game when the kickoff date is unparseable', () => {
    const payload = teamPayload();
    payload.team!.nextEvent![0].date = 'not-a-date';
    const cards = cardsFromTeam(cavs(), payload, NOW);
    expect(cards.find((c) => c.kind === 'nextgame')).toBeUndefined();
  });

  it('marks isHome true when the topic team is the home competitor', () => {
    const payload = teamPayload();
    const comps = payload.team!.nextEvent![0].competitions![0].competitors!;
    comps[0] = { homeAway: 'home', team: { id: '5', displayName: 'Cleveland Cavaliers' } };
    comps[1] = { homeAway: 'away', team: { id: '4', displayName: 'Chicago Bulls' } };
    const ng = cardsFromTeam(cavs(), payload, NOW).find((c) => c.kind === 'nextgame') as NextGameCard;
    expect(ng.isHome).toBe(true);
    expect(ng.opponent).toBe('Chicago Bulls');
  });
});

describe('cardsFromNews', () => {
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  function newsPayload(): EspnNewsResponse {
    return {
      articles: [
        { headline: 'Cavs win thriller', published: iso(1 * 3600_000), type: 'Recap' },
        { headline: 'Preview: Cavs vs Bulls', published: iso(5 * 3600_000), type: 'Preview' },
        { headline: 'Old news nobody wants', published: iso(72 * 3600_000), type: 'Story' }, // stale
      ],
    };
  }

  it('keeps fresh articles, drops stale ones past the cutoff', () => {
    const cards = cardsFromNews(cavs(), newsPayload(), NOW);
    expect(cards.every((c) => NOW - c.published <= NEWS_FRESHNESS_MS)).toBe(true);
    expect(cards.find((c) => c.headline.includes('Old news'))).toBeUndefined();
  });

  it('sorts newest-first and caps at MAX_NEWS_PER_TOPIC', () => {
    const many: EspnNewsResponse = {
      articles: Array.from({ length: 5 }, (_, i) => ({
        headline: `Story ${i}`,
        published: iso((i + 1) * 3600_000),
        type: 'Story',
      })),
    };
    const cards = cardsFromNews(cavs(), many, NOW);
    expect(cards.length).toBe(MAX_NEWS_PER_TOPIC);
    expect(cards[0].published).toBeGreaterThan(cards[1].published); // newest first
  });

  it('phrases news as a question under the learning stance', () => {
    const cards = cardsFromNews(cavs('learning'), newsPayload(), NOW);
    expect(cards[0].text).toContain('?');
  });

  it('drops articles with no headline or unparseable date', () => {
    const payload: EspnNewsResponse = {
      articles: [
        { published: iso(1000), type: 'Recap' }, // no headline
        { headline: 'No date', type: 'Story' },  // no date
        { headline: 'Good one', published: iso(2 * 3600_000), type: 'Recap' },
      ],
    };
    const cards = cardsFromNews(cavs(), payload, NOW);
    expect(cards.map((c) => c.headline)).toEqual(['Good one']);
  });

  it('returns [] for an empty payload', () => {
    expect(cardsFromNews(cavs(), {}, NOW)).toEqual([] as NewsCard[]);
  });
});
