/**
 * StreamQueueStore — persisted, pre-wrapped stream queue (#49 resilience).
 * Round-trips the frozen stream, cheap index-only resume updates, and the
 * Zoracon stance: corrupt / version-mismatched / malformed snapshots SURFACE
 * (throw StreamQueueError), never silently return an empty queue (which would
 * be indistinguishable from "stream finished, lens dark").
 *
 * Team-agnostic: OSU + Nebraska fixtures prove nothing is hardcoded to one team.
 *
 * Same inline in-memory AsyncStorage mock as SeenStore/AudienceStore tests (no
 * jest-expo preset here). __raw lets tests inject corruption the API can't write.
 */

const mem = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: async (k: string, v: string) => void mem.set(k, v),
    removeItem: async (k: string) => void mem.delete(k),
  },
}));

import {
  StreamQueueError,
  loadStreamQueue,
  saveStreamQueue,
  saveResumeIndex,
  clearStreamQueue,
  isResumable,
  type StreamQueueSnapshot,
} from './StreamQueueStore';
import type { StreamLine, SkippedArticle } from './useArticleStream';

const QUEUE_KEY = 'stream_queue_v1';

// ── Fixtures: two different teams so no single-team assumption can hide ────────

const osuLines: StreamLine[] = [
  { articleId: '1001', isHead: true, text: 'Ohio State routs rival in the Shoe' },
  { articleId: '1001', isHead: false, text: 'The Buckeyes controlled from the open' },
  { articleId: '1001', isHead: false, text: ' ing whistle, never trailing once.' },
  { articleId: '1002', isHead: true, text: 'Smith hauls in three touchdowns' },
  { articleId: '1002', isHead: false, text: 'The freshman phenom added another' },
];

const nebLines: StreamLine[] = [
  { articleId: '2001', isHead: true, text: 'Nebraska edges Big Ten foe late' },
  { articleId: '2001', isHead: false, text: 'A fourth-quarter stop sealed it for' },
  { articleId: '2001', isHead: false, text: ' the Cornhuskers in Lincoln.' },
];

const skips: SkippedArticle[] = [
  { articleId: '9001', reason: 'video', detail: 'video clip, no prose' },
];

beforeEach(() => {
  mem.clear();
});

describe('round-trip', () => {
  it('returns null when nothing is saved', async () => {
    expect(await loadStreamQueue()).toBeNull();
  });

  it('round-trips an OSU stream with skips and resume index', async () => {
    await saveStreamQueue(osuLines, skips, 3);
    const snap = await loadStreamQueue();
    expect(snap).not.toBeNull();
    expect(snap!.lines).toEqual(osuLines);
    expect(snap!.skipped).toEqual(skips);
    expect(snap!.index).toBe(3);
    expect(snap!.version).toBe(1);
    expect(typeof snap!.savedAt).toBe('number');
  });

  it('round-trips a Nebraska stream too (team-agnostic)', async () => {
    await saveStreamQueue(nebLines, [], 1);
    const snap = await loadStreamQueue();
    expect(snap!.lines).toEqual(nebLines);
    expect(snap!.index).toBe(1);
  });

  it('clamps an out-of-range index into the lines on save', async () => {
    await saveStreamQueue(nebLines, [], 999);
    const snap = await loadStreamQueue();
    expect(snap!.index).toBe(nebLines.length - 1);
  });

  it('clamps a negative index to 0 on save', async () => {
    await saveStreamQueue(osuLines, [], -5);
    const snap = await loadStreamQueue();
    expect(snap!.index).toBe(0);
  });

  it('saving an empty line list clears the queue (nothing to resume)', async () => {
    await saveStreamQueue(osuLines, skips, 2);
    await saveStreamQueue([], [], 0);
    expect(await loadStreamQueue()).toBeNull();
  });
});

describe('saveResumeIndex (cheap index-only update)', () => {
  it('updates only the index, preserving lines and skips', async () => {
    await saveStreamQueue(osuLines, skips, 0);
    await saveResumeIndex(2);
    const snap = await loadStreamQueue();
    expect(snap!.index).toBe(2);
    expect(snap!.lines).toEqual(osuLines);
    expect(snap!.skipped).toEqual(skips);
  });

  it('clamps the resume index into the saved lines', async () => {
    await saveStreamQueue(nebLines, [], 0);
    await saveResumeIndex(999);
    const snap = await loadStreamQueue();
    expect(snap!.index).toBe(nebLines.length - 1);
  });

  it('is a no-op when no queue is saved', async () => {
    await saveResumeIndex(5);
    expect(await loadStreamQueue()).toBeNull();
  });
});

describe('clearStreamQueue', () => {
  it('wipes the saved queue', async () => {
    await saveStreamQueue(osuLines, skips, 1);
    await clearStreamQueue();
    expect(await loadStreamQueue()).toBeNull();
  });
});

describe('corrupt data SURFACES (Zoracon #32 — never a silent empty queue)', () => {
  it('throws on non-JSON', async () => {
    mem.set(QUEUE_KEY, '{not json');
    await expect(loadStreamQueue()).rejects.toThrow(StreamQueueError);
  });

  it('throws on a JSON array (not an object)', async () => {
    mem.set(QUEUE_KEY, '[]');
    await expect(loadStreamQueue()).rejects.toThrow(StreamQueueError);
  });

  it('throws on a version mismatch (a future schema change is detectable)', async () => {
    mem.set(QUEUE_KEY, JSON.stringify({ version: 2, lines: osuLines, skipped: [], index: 0, savedAt: 1 }));
    await expect(loadStreamQueue()).rejects.toThrow(/version/);
  });

  it('throws on malformed lines (missing isHead)', async () => {
    mem.set(QUEUE_KEY, JSON.stringify({
      version: 1,
      lines: [{ articleId: '1', text: 'x' }],
      skipped: [],
      index: 0,
      savedAt: 1,
    }));
    await expect(loadStreamQueue()).rejects.toThrow(/lines/);
  });

  it('throws on a malformed skipped entry', async () => {
    mem.set(QUEUE_KEY, JSON.stringify({
      version: 1,
      lines: osuLines,
      skipped: [{ reason: 'video' }],
      index: 0,
      savedAt: 1,
    }));
    await expect(loadStreamQueue()).rejects.toThrow(/skipped/);
  });

  it('throws on a non-integer index', async () => {
    mem.set(QUEUE_KEY, JSON.stringify({ version: 1, lines: osuLines, skipped: [], index: 1.5, savedAt: 1 }));
    await expect(loadStreamQueue()).rejects.toThrow(/index/);
  });

  it('clamps an in-range-but-high stored index rather than throwing', async () => {
    // A legit snapshot saved at the last window: index may equal lines.length-1.
    mem.set(QUEUE_KEY, JSON.stringify({ version: 1, lines: nebLines, skipped: [], index: 50, savedAt: 1 }));
    const snap = await loadStreamQueue();
    expect(snap!.index).toBe(nebLines.length - 1);
  });
});

describe('isResumable (pure — offer-resume decision)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const fresh = (index: number): StreamQueueSnapshot => ({
    version: 1, lines: osuLines, skipped: [], index, savedAt: 1_000,
  });

  it('false for null', () => {
    expect(isResumable(null, DAY)).toBe(false);
  });

  it('false for an empty stream', () => {
    expect(isResumable({ ...fresh(0), lines: [] }, DAY, 1_000)).toBe(false);
  });

  it('false when finished (index at last line — nothing left to replay)', () => {
    expect(isResumable(fresh(osuLines.length - 1), DAY, 1_000)).toBe(false);
  });

  it('false when older than the max age (last night = stale picks)', () => {
    expect(isResumable(fresh(1), DAY, 1_000 + 2 * DAY)).toBe(false);
  });

  it('true for a fresh, partially-watched stream', () => {
    expect(isResumable(fresh(1), DAY, 1_000 + 60_000)).toBe(true);
  });
});
