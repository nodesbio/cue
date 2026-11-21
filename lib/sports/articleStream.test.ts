/**
 * articleStream tests — pure normalization + guards. Network is stubbed; the
 * fixtures are shaped from live content.core.api.espn.com responses verified
 * 2026-11-21.
 *
 * GUARDRAIL: every behavior is proven with BOTH an Ohio State and a Nebraska
 * fixture. OSU is a data example, never hardcoded in the module. If any literal
 * team/league ever sneaks into articleStream.ts, the Nebraska cases break.
 */
import {
  proseFromContent,
  htmlToText,
  isVideo,
  fetchArticleBody,
  articleUrl,
  ArticleUnavailableError,
  CONTENT_CORE_BASE,
  type EspnContentResponse,
} from './articleStream';
import { wrapScript, MAX_CHARS } from '../teleprompter/lineWrapper';

// ── Fixtures (two different teams — proves team-agnosticism) ──────────────────

const osuStory: EspnContentResponse = {
  headlines: [
    {
      id: 50532919,
      type: 'Story',
      headline: 'Which teams have the best odds to make the College Football Playoff?',
      published: '2026-11-19T15:00:00Z',
      story:
        '<p>With two weeks remaining in the season, the top four teams in the ' +
        'College Football Playoff rankings remain unchanged.</p>' +
        '<p>Ohio State, now No. 1, held its spot after a dominant win.</p>',
      links: { web: { href: 'https://www.espn.com/college-football/story/_/id/50532919/x' } },
    },
  ],
};

const nebraskaStory: EspnContentResponse = {
  headlines: [
    {
      id: 50540001,
      type: 'Story',
      headline: 'Nebraska looks to spring an upset at Memorial Stadium',
      published: '2026-11-20T12:00:00Z',
      story:
        '<p>Matt Rhule&rsquo;s Cornhuskers enter as heavy underdogs.</p>' +
        '<p>Anthony Colandrea will need a near-perfect game.</p>',
      links: { web: { href: 'https://www.espn.com/college-football/story/_/id/50540001/y' } },
    },
  ],
};

// A video item (no prose) — the Jeremiah Smith "No. 1 pick" clip shape.
const osuVideo: EspnContentResponse = {
  headlines: [
    {
      id: 50522531,
      type: 'Media',
      headline: 'Why Jordan Reid has the Titans taking Jeremiah Smith at No. 1',
      links: {
        web: { href: 'https://www.espn.com/video/clip/_/id/50522531/x' },
        api: { self: { href: 'https://content.core.api.espn.com/v1/video/clips/50522531' } },
      },
    },
  ],
};

const nebraskaEmpty: EspnContentResponse = {
  headlines: [{ id: 50540002, type: 'Story', headline: 'Game notes', story: '   ' }],
};

// ── htmlToText ────────────────────────────────────────────────────────────────

describe('htmlToText', () => {
  it('strips tags and splits paragraphs on block closers', () => {
    const out = htmlToText('<p>First para.</p><p>Second para.</p>');
    expect(out).toBe('First para.\n\nSecond para.');
  });

  it('decodes the entities ESPN emits', () => {
    expect(htmlToText('<p>Rhule&rsquo;s team &amp; the &ldquo;win&rdquo;</p>')).toBe(
      'Rhule\u2019s team & the "win"'.replace('\u2019', "'"),
    );
  });

  it('returns empty string for tag-only / whitespace html', () => {
    expect(htmlToText('<p></p>')).toBe('');
    expect(htmlToText('   ')).toBe('');
  });
});

// ── isVideo guard ─────────────────────────────────────────────────────────────

describe('isVideo', () => {
  it('flags Media type and /video/ links', () => {
    expect(isVideo(osuVideo.headlines![0])).toBe(true);
  });
  it('passes real stories (OSU and Nebraska)', () => {
    expect(isVideo(osuStory.headlines![0])).toBe(false);
    expect(isVideo(nebraskaStory.headlines![0])).toBe(false);
  });
});

// ── proseFromContent — the core, both teams ──────────────────────────────────

describe('proseFromContent', () => {
  it('extracts clean prose for an OSU story', () => {
    const p = proseFromContent('50532919', osuStory);
    expect(p.headline).toMatch(/College Football Playoff/);
    expect(p.body).toContain('top four teams');
    expect(p.body).toContain('Ohio State, now No. 1');
    expect(p.body).not.toContain('<p>');
    expect(p.readSeconds).toBeGreaterThan(0);
    expect(p.publishedMs).toBe(Date.parse('2026-11-19T15:00:00Z'));
  });

  it('extracts clean prose for a Nebraska story (not team-pinned)', () => {
    const p = proseFromContent('50540001', nebraskaStory);
    expect(p.body).toContain('Cornhuskers enter as heavy underdogs');
    expect(p.body).toContain("Rhule's"); // entity decoded
    expect(p.body).not.toContain('&rsquo;');
  });

  it('rejects video items with reason "video"', () => {
    expect(() => proseFromContent('50522531', osuVideo)).toThrow(ArticleUnavailableError);
    try {
      proseFromContent('50522531', osuVideo);
    } catch (e) {
      expect((e as ArticleUnavailableError).reason).toBe('video');
    }
  });

  it('rejects empty bodies with reason "empty-body" (never returns "")', () => {
    try {
      proseFromContent('50540002', nebraskaEmpty);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ArticleUnavailableError);
      expect((e as ArticleUnavailableError).reason).toBe('empty-body');
    }
  });

  it('rejects missing headlines with reason "not-found"', () => {
    try {
      proseFromContent('x', { headlines: [] });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ArticleUnavailableError).reason).toBe('not-found');
    }
  });
});

// ── prose → teleprompter wrap (the reuse that makes this streamable) ──────────

describe('prose streams through the teleprompter wrapper', () => {
  it('wraps OSU prose into ≤45-col lens lines', () => {
    const p = proseFromContent('50532919', osuStory);
    const lines = wrapScript(p.body, MAX_CHARS);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(MAX_CHARS);
  });
});

// ── fetchArticleBody — network stubbed ───────────────────────────────────────

describe('fetchArticleBody', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('hits the content.core endpoint by id (no team/league in the url)', async () => {
    const url = articleUrl('50540001');
    expect(url).toBe(`${CONTENT_CORE_BASE}/50540001`);
    expect(url).not.toMatch(/college-football|nebraska|194|ohio/i);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => nebraskaStory,
    }) as unknown as typeof fetch;

    const p = await fetchArticleBody('50540001');
    expect(p.body).toContain('Cornhuskers');
  });

  it('maps HTTP 404 to a not-found ArticleUnavailableError', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    await expect(fetchArticleBody('nope')).rejects.toMatchObject({ reason: 'not-found' });
  });

  it('does NOT mask a real HTTP 503 (Zoracon: surface network failures)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    await expect(fetchArticleBody('x')).rejects.toThrow(/HTTP 503/);
  });
});
