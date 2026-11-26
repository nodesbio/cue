/**
 * newsFeed tests — the pure normalizer for the pickable article list (#49).
 *
 * Proves: every list stub with a usable id becomes a pickable NewsItem joined
 * to the body fetch on `id`; video-type stubs are flagged (not dropped); stubs
 * with no id are dropped (unpickable by construction); URL builders are
 * sport/team-agnostic.
 *
 * GUARDRAIL: fixtures are OSU football (team 194) + Nebraska. The module never
 * hardcodes a team or sport — the caller passes the path/id.
 */
import {
  normalizeNewsList,
  teamNewsUrl,
  leagueNewsUrl,
  fetchNewsList,
  type EspnNewsListResponse,
} from './newsFeed';

// Shape mirrors a real site.api.espn.com .../news payload (narrowed).
const OSU_LIST: EspnNewsListResponse = {
  articles: [
    {
      id: 50546169,
      headline: 'Ohio State stays No. 1 after dominant rivalry win',
      type: 'Recap',
      published: '2026-11-22T18:30:00Z',
      description: 'The Buckeyes rolled to keep their playoff hopes intact.',
    },
    {
      id: 50546523,
      headline: 'Ohio State Buckeyes: Full Highlights',
      type: 'Media', // video clip — no prose body
      published: '2026-11-22T21:00:00Z',
    },
    {
      // no id → cannot join to a body fetch → unpickable
      headline: 'Orphan stub with no id',
      type: 'HeadlineNews',
    },
  ],
};

const NEB_LIST: EspnNewsListResponse = {
  articles: [
    {
      id: '50540001', // ESPN sometimes serves id as string — must still join
      headline: 'Nebraska looks to spring an upset',
      type: 'Preview',
      published: 'not-a-date', // bad date → publishedMs null, item still pickable
    },
  ],
};

describe('normalizeNewsList', () => {
  it('turns OSU stubs into pickable items, joined on id', () => {
    const items = normalizeNewsList(OSU_LIST);
    const recap = items.find((i) => i.id === '50546169');
    expect(recap).toBeDefined();
    expect(recap!.maybeVideo).toBe(false);
    expect(recap!.publishedMs).toBe(Date.parse('2026-11-22T18:30:00Z'));
    expect(recap!.description).toMatch(/playoff hopes/);
  });

  it('flags Media/video stubs with maybeVideo but keeps them', () => {
    const items = normalizeNewsList(OSU_LIST);
    const vid = items.find((i) => i.id === '50546523');
    expect(vid).toBeDefined(); // not dropped — surfaced for the picker to grey
    expect(vid!.maybeVideo).toBe(true);
  });

  it('drops stubs with no id (unpickable, no join key)', () => {
    const items = normalizeNewsList(OSU_LIST);
    expect(items.some((i) => i.headline === 'Orphan stub with no id')).toBe(false);
    expect(items).toHaveLength(2); // recap + media, orphan dropped
  });

  it('accepts a string id and tolerates a bad publish date (Nebraska)', () => {
    const items = normalizeNewsList(NEB_LIST);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('50540001');
    expect(items[0].publishedMs).toBeNull();
    expect(items[0].maybeVideo).toBe(false);
  });

  it('returns [] for an empty or missing articles array', () => {
    expect(normalizeNewsList({})).toEqual([]);
    expect(normalizeNewsList({ articles: [] })).toEqual([]);
  });
});

describe('news URL builders (sport/team-agnostic)', () => {
  // The old /teams/{id}/news path now returns HTTP 200 with an empty `{}` body
  // in every sport (verified 2026-11-25: NFL 4/5, CFB 194, NBA 2, NHL 1,
  // NCAAM 194) — so the Stream picker showed "no articles" for every team.
  // The league endpoint's ?team= filter returns 50 items, 50/50 tagged with
  // that team (unfiltered: 4/50). cards.ts already used this form.
  it('builds a team news URL for OSU football (team 194) via the ?team= filter', () => {
    expect(teamNewsUrl('football/college-football', '194', 25)).toBe(
      'https://site.api.espn.com/apis/site/v2/sports/football/college-football/news?limit=25&team=194',
    );
  });

  it('builds a league news URL for a different sport without code change', () => {
    expect(leagueNewsUrl('basketball/mens-college-basketball')).toBe(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/news?limit=50',
    );
  });
});

describe('fetchNewsList — a missing articles array is an error, not "no articles"', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const respond = (body: unknown) =>
    jest.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response) as typeof fetch;

  it('throws on a 200 with an empty {} body (the dead /teams/{id}/news shape)', async () => {
    global.fetch = respond({});
    await expect(fetchNewsList('https://x/news')).rejects.toThrow(/no articles array/i);
  });

  it('an explicit empty articles list is still a valid empty result', async () => {
    global.fetch = respond({ articles: [] });
    await expect(fetchNewsList('https://x/news')).resolves.toEqual([]);
  });
});
