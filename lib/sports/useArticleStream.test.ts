/**
 * useArticleStream — pure logic tests (#49). The hook's React effects need a
 * renderer harness this repo doesn't set up; the real correctness risk is the
 * "which articles have I actually read?" rule that drives SeenStore, so that's
 * extracted as articlesReadBy and tested directly.
 *
 * WINDOW_SIZE is 4 (lineWrapper). An article is "read" once its last line has
 * scrolled above the window top (index), EXCEPT on the final window where the
 * visible window counts too (play-through-end shows it, then goes dark).
 */
import { articlesReadBy, type StreamLine } from './useArticleStream';
import { WINDOW_SIZE } from '../teleprompter/lineWrapper';

// Build a line list: article 'A' with aLen lines, 'B' with bLen, 'C' with cLen.
function mk(spec: Array<[string, number]>): StreamLine[] {
  const out: StreamLine[] = [];
  for (const [id, n] of spec) {
    for (let i = 0; i < n; i++) out.push({ articleId: id, isHead: i === 0, text: `${id}${i}` });
  }
  return out;
}

describe('articlesReadBy — the seen signal', () => {
  it('nothing read at the very start', () => {
    const lines = mk([['A', 6], ['B', 6]]); // 12 lines
    expect(articlesReadBy(lines, 0)).toEqual([]);
  });

  it('A counts as read once the window top passes its last line', () => {
    const lines = mk([['A', 6], ['B', 6]]); // A = lines 0..5, B = 6..11
    // index 5: A's last line (5) is NOT < 5 → not yet read.
    expect(articlesReadBy(lines, 5)).toEqual([]);
    // index 6: A's last line (5) < 6 → A read; B still ahead and not final window.
    expect(articlesReadBy(lines, 6)).toEqual(['A']);
  });

  it('final window counts articles whose last line is within it (play-through-end)', () => {
    const lines = mk([['A', 6], ['B', 6]]); // 12 lines; final top = 12 - 4 = 8
    // index 8 is the final window (indices 8..11) → B's last line (11) within it.
    expect(articlesReadBy(lines, 8).sort()).toEqual(['A', 'B']);
  });

  it('returns ids in first-seen order, deduped across many lines', () => {
    const lines = mk([['A', 5], ['B', 5], ['C', 5]]); // 15 lines; final top = 11
    // index 10: A (last 4 < 10) and B (last 9 < 10) read; C (10..14) still ahead,
    // and 10 is not the final window (11), so C not yet read.
    expect(articlesReadBy(lines, 10)).toEqual(['A', 'B']);
    // index 11 (final window 11..14): C's last line 14 within it → all three.
    expect(articlesReadBy(lines, 11)).toEqual(['A', 'B', 'C']);
  });

  it('empty line list → empty', () => {
    expect(articlesReadBy([], 0)).toEqual([]);
  });

  it('a stream shorter than one window is all-read on the final window at index 0', () => {
    const lines = mk([['A', 2]]); // 2 lines; final top = 2 - 4 = -2, so index 0 >= -2 → atEnd
    expect(articlesReadBy(lines, 0)).toEqual(['A']);
  });

  it('is consistent with WINDOW_SIZE', () => {
    expect(WINDOW_SIZE).toBe(4); // guards the fixtures above if the window changes
  });
});
