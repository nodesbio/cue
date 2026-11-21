/**
 * AudienceStore — persistence round-trips, ordering, one-time seeding, and the
 * one behaviour that diverges from ScriptStore on purpose: corrupt JSON is
 * SURFACED (throws AudienceStoreError), never silently dropped (#44, Zoracon).
 *
 * No jest-expo preset in this repo, so no auto AsyncStorage mock. We install a
 * tiny in-memory Map mock inline — no new deps. The mock is exposed via
 * __store so tests can inject corruption the public API would never write.
 */

// ── In-memory AsyncStorage mock ───────────────────────────────────────────────
const mem = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: async (k: string, v: string) => void mem.set(k, v),
    removeItem: async (k: string) => void mem.delete(k),
    multiGet: async (keys: string[]) =>
      keys.map((k) => [k, mem.has(k) ? mem.get(k)! : null] as [string, string | null]),
  },
}));

import {
  AudienceStoreError,
  deleteAudience,
  getAudience,
  listAudiences,
  reorderAudiences,
  saveAudience,
  seedTemplatesOnce,
  updateAudience,
} from './AudienceStore';
import { AUDIENCE_TEMPLATES } from './templates';
import { Topic } from './audience';

const t = (label: string): Topic => ({
  kind: 'league',
  sport: 'racing',
  league: 'f1',
  label,
  stance: 'learning',
});

beforeEach(() => mem.clear());

describe('round-trip', () => {
  it('saves and reads back an audience', async () => {
    const a = await saveAudience({ name: 'Swim meet', topics: [t('F1')], maxCards: 5 });
    expect(a.id).toBeTruthy();
    expect(a.updatedAt).toBeGreaterThan(0);
    const got = await getAudience(a.id);
    expect(got).toEqual(a);
  });

  it('defaults a blank name to Untitled', async () => {
    const a = await saveAudience({ name: '   ', topics: [], maxCards: 5 });
    expect(a.name).toBe('Untitled');
  });

  it('returns null for a missing id', async () => {
    expect(await getAudience('nope')).toBeNull();
  });

  it('lists newest-first (save prepends)', async () => {
    const first = await saveAudience({ name: 'A', topics: [], maxCards: 5 });
    const second = await saveAudience({ name: 'B', topics: [], maxCards: 5 });
    const list = await listAudiences();
    expect(list.map((a) => a.id)).toEqual([second.id, first.id]);
  });
});

describe('update / reorder / delete', () => {
  it('patches fields and bumps updatedAt without reordering', async () => {
    const a = await saveAudience({ name: 'A', topics: [], maxCards: 5 });
    const b = await saveAudience({ name: 'B', topics: [], maxCards: 5 });
    const before = (await getAudience(a.id))!.updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    const up = await updateAudience(a.id, { name: 'A2', maxCards: 3 });
    expect(up!.name).toBe('A2');
    expect(up!.maxCards).toBe(3);
    expect(up!.updatedAt).toBeGreaterThan(before);
    // order unchanged: b still first
    expect((await listAudiences()).map((x) => x.id)).toEqual([b.id, a.id]);
  });

  it('returns null updating a missing id', async () => {
    expect(await updateAudience('ghost', { name: 'x' })).toBeNull();
  });

  it('applies a new explicit order', async () => {
    const a = await saveAudience({ name: 'A', topics: [], maxCards: 5 });
    const b = await saveAudience({ name: 'B', topics: [], maxCards: 5 });
    await reorderAudiences([a.id, b.id]);
    expect((await listAudiences()).map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it('deletes an entry and drops it from the index', async () => {
    const a = await saveAudience({ name: 'A', topics: [], maxCards: 5 });
    const b = await saveAudience({ name: 'B', topics: [], maxCards: 5 });
    await deleteAudience(a.id);
    expect(await getAudience(a.id)).toBeNull();
    expect((await listAudiences()).map((x) => x.id)).toEqual([b.id]);
  });
});

describe('seeding', () => {
  it('seeds every template once, in template order', async () => {
    const seeded = await seedTemplatesOnce();
    expect(seeded.map((a) => a.name)).toEqual(AUDIENCE_TEMPLATES.map((x) => x.name));
    expect((await listAudiences()).map((a) => a.name)).toEqual(
      AUDIENCE_TEMPLATES.map((x) => x.name),
    );
  });

  it('is a no-op on the second run (never resurrects deletions)', async () => {
    await seedTemplatesOnce();
    const list = await listAudiences();
    await deleteAudience(list[0].id);
    const again = await seedTemplatesOnce();
    expect(again).toEqual([]);
    expect((await listAudiences()).length).toBe(AUDIENCE_TEMPLATES.length - 1);
  });
});

describe('corrupt data is surfaced, not swallowed (Zoracon #32)', () => {
  it('throws AudienceStoreError when an entry is corrupt', async () => {
    const a = await saveAudience({ name: 'A', topics: [], maxCards: 5 });
    mem.set(`audience_entry_v1_${a.id}`, '{ not json');
    await expect(listAudiences()).rejects.toBeInstanceOf(AudienceStoreError);
    await expect(getAudience(a.id)).rejects.toBeInstanceOf(AudienceStoreError);
  });

  it('throws AudienceStoreError when the index itself is corrupt', async () => {
    mem.set('audiences_index_v1', 'nope{');
    await expect(listAudiences()).rejects.toBeInstanceOf(AudienceStoreError);
  });

  it('tolerates a missing entry referenced by the index (deleted out from under)', async () => {
    const a = await saveAudience({ name: 'A', topics: [], maxCards: 5 });
    const b = await saveAudience({ name: 'B', topics: [], maxCards: 5 });
    mem.delete(`audience_entry_v1_${a.id}`); // index still lists it
    const list = await listAudiences();
    expect(list.map((x) => x.id)).toEqual([b.id]);
  });
});
