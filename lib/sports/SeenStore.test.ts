/**
 * SeenStore — persisted already-streamed set (#49 dedup). Round-trips, merge,
 * time-based forgetting, and the Zoracon stance: corrupt data SURFACES (throws
 * SeenStoreError), it is never silently treated as an empty set.
 *
 * Same inline in-memory AsyncStorage mock as AudienceStore.test (no jest-expo
 * preset in this repo). __store lets tests inject corruption the API can't write.
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
  SeenStoreError,
  loadSeen,
  markSeen,
  forgetOlderThan,
  clearSeen,
  partitionBySeen,
} from './SeenStore';

const SEEN_KEY = 'articles_seen_v1';

beforeEach(() => mem.clear());

describe('SeenStore — persistence', () => {
  it('empty when nothing stored', async () => {
    expect(await loadSeen()).toEqual({});
  });

  it('markSeen stamps ids and round-trips', async () => {
    await markSeen(['101', '202'], 1000);
    expect(await loadSeen()).toEqual({ '101': 1000, '202': 1000 });
  });

  it('markSeen merges into the existing set and refreshes stamps', async () => {
    await markSeen(['101'], 1000);
    await markSeen(['202', '101'], 2000); // 101 re-marked
    expect(await loadSeen()).toEqual({ '101': 2000, '202': 2000 });
  });

  it('markSeen([]) is a no-op that returns the current set', async () => {
    await markSeen(['101'], 1000);
    expect(await markSeen([], 9999)).toEqual({ '101': 1000 });
  });

  it('clearSeen wipes everything', async () => {
    await markSeen(['101'], 1000);
    await clearSeen();
    expect(await loadSeen()).toEqual({});
  });
});

describe('SeenStore — forgetOlderThan (deliberate recycle)', () => {
  it('drops entries older than the window, keeps recent', async () => {
    await markSeen(['old'], 1000);
    await markSeen(['new'], 10_000);
    const out = await forgetOlderThan(5000, 10_000); // cutoff = 5000
    expect(out).toEqual({ new: 10_000 });
    expect(await loadSeen()).toEqual({ new: 10_000 }); // persisted
  });

  it('no write / no change when nothing is stale', async () => {
    await markSeen(['a', 'b'], 10_000);
    expect(await forgetOlderThan(5000, 11_000)).toEqual({ a: 10_000, b: 10_000 });
  });
});

describe('SeenStore — corrupt data surfaces (Zoracon #32)', () => {
  it('throws on non-JSON, does not return {}', async () => {
    mem.set(SEEN_KEY, '{not valid json');
    await expect(loadSeen()).rejects.toThrow(SeenStoreError);
  });

  it('throws when stored value is an array, not a map', async () => {
    mem.set(SEEN_KEY, JSON.stringify(['101', '202']));
    await expect(loadSeen()).rejects.toThrow(/not an object map/);
  });

  it('throws when stored value is null literal', async () => {
    mem.set(SEEN_KEY, 'null');
    await expect(loadSeen()).rejects.toThrow(SeenStoreError);
  });
});

describe('partitionBySeen — pure picker helper', () => {
  const items = [{ id: '1' }, { id: '2' }, { id: '3' }];

  it('splits fresh vs seen, preserving order', () => {
    const { fresh, seen } = partitionBySeen(items, { '2': 1000 });
    expect(fresh.map((i) => i.id)).toEqual(['1', '3']);
    expect(seen.map((i) => i.id)).toEqual(['2']);
  });

  it('all fresh when seen-set is empty', () => {
    const { fresh, seen } = partitionBySeen(items, {});
    expect(fresh).toHaveLength(3);
    expect(seen).toHaveLength(0);
  });

  it('all seen when every id is in the set', () => {
    const { fresh, seen } = partitionBySeen(items, { '1': 1, '2': 1, '3': 1 });
    expect(fresh).toHaveLength(0);
    expect(seen).toHaveLength(3);
  });
});
