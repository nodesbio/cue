/**
 * assembleStream tests — the pure, network-injectable core of the ambient
 * article stream (#49). No device, no React, no live ESPN.
 *
 * Proves the untethered-critical behaviors:
 *   - all prose is wrapped to ≤45-col lens lines BEFORE streaming (no network
 *     mid-stream),
 *   - queue order == read order,
 *   - unstreamable articles are SURFACED in `skipped` with a reason, never
 *     dropped into a blank stretch (Zoracon),
 *   - abort stops cleanly.
 *
 * GUARDRAIL: fixtures use OSU and Nebraska. assembleStream never sees a team id.
 */
import { assembleStream } from './useArticleStream';
import { ArticleUnavailableError, type ArticleProse } from './articleStream';
import { MAX_CHARS } from '../teleprompter/lineWrapper';

function prose(id: string, headline: string, body: string): ArticleProse {
  return { articleId: id, headline, body, readSeconds: 10, publishedMs: null };
}

const OSU = prose(
  '50532919',
  'Which teams have the best odds to make the College Football Playoff?',
  'With two weeks remaining, the top four teams remain unchanged. ' +
    'Ohio State, now No. 1, held its spot after a dominant win over its rival. ' +
    'The committee praised the Buckeyes defense as the best in the country.',
);
const NEB = prose(
  '50540001',
  'Nebraska looks to spring an upset',
  "Matt Rhule's Cornhuskers enter as heavy underdogs but have played spoiler before.",
);

/**
 * Fetcher that serves fixtures by id. A fixture may be prose (resolve) or any
 * Error (reject) — the latter lets us model both typed ArticleUnavailableError
 * and a raw network/HTTP failure.
 */
function fakeFetcher(map: Record<string, ArticleProse | Error>) {
  return async (id: string): Promise<ArticleProse> => {
    const v = map[id];
    if (!v) throw new ArticleUnavailableError(id, 'not-found');
    if (v instanceof Error) throw v;
    return v;
  };
}

describe('assembleStream', () => {
  it('flattens prose into ≤45-col lens lines, headline first', async () => {
    const { lines, skipped } = await assembleStream(
      fakeFetcher({ '50532919': OSU }),
      ['50532919'],
    );
    expect(skipped).toEqual([]);
    expect(lines[0].isHead).toBe(true);
    expect(lines[0].articleId).toBe('50532919');
    for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(MAX_CHARS);
    // body made it past the headline
    expect(lines.some((l) => /Buckeyes defense/.test(l.text))).toBe(true);
  });

  it('preserves queue order across articles (OSU then Nebraska)', async () => {
    const { lines } = await assembleStream(
      fakeFetcher({ '50532919': OSU, '50540001': NEB }),
      ['50532919', '50540001'],
    );
    const heads = lines.filter((l) => l.isHead).map((l) => l.articleId);
    expect(heads).toEqual(['50532919', '50540001']);
  });

  it('SURFACES video items in skipped, never in the line stream (Zoracon)', async () => {
    const { lines, skipped } = await assembleStream(
      fakeFetcher({
        '50532919': OSU,
        vid: new ArticleUnavailableError('vid', 'video'),
        '50540001': NEB,
      }),
      ['50532919', 'vid', '50540001'],
    );
    expect(skipped).toEqual([
      expect.objectContaining({ articleId: 'vid', reason: 'video' }),
    ]);
    // no line belongs to the skipped article, but the stream still flows
    expect(lines.some((l) => l.articleId === 'vid')).toBe(false);
    expect(lines.filter((l) => l.isHead).map((l) => l.articleId)).toEqual([
      '50532919',
      '50540001',
    ]);
  });

  it('surfaces empty-body and network failures with distinct reasons', async () => {
    const { skipped } = await assembleStream(
      fakeFetcher({
        empty: new ArticleUnavailableError('empty', 'empty-body'),
        down: new Error('content.core HTTP 503'),
      }),
      ['empty', 'down'],
    );
    expect(skipped).toEqual([
      expect.objectContaining({ articleId: 'empty', reason: 'empty-body' }),
      expect.objectContaining({ articleId: 'down', reason: 'network' }),
    ]);
  });

  it('returns empty when the queue is empty', async () => {
    const { lines, skipped } = await assembleStream(fakeFetcher({}), []);
    expect(lines).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('stops cleanly when aborted mid-queue', async () => {
    const ctrl = new AbortController();
    const slow = fakeFetcher({ '50532919': OSU, '50540001': NEB });
    const wrapped = async (id: string) => {
      if (id === '50540001') ctrl.abort(); // abort before 2nd completes
      return slow(id);
    };
    const { lines } = await assembleStream(wrapped, ['50532919', '50540001'], ctrl.signal);
    // only the first article made it in
    expect(lines.filter((l) => l.isHead).map((l) => l.articleId)).toEqual(['50532919']);
  });
});
