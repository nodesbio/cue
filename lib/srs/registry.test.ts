/**
 * registry.ts — CRUD round-trips, newest-first ordering, and the invariants the
 * Decks UI leans on: duplicate-id registration throws (would collide card keys),
 * unknown-id update/unregister is safe, and corrupt storage is SURFACED, not
 * swallowed (Zoracon) — same stance as store.ts / AudienceStore.
 *
 * In-memory AsyncStorage mock (no jest-expo preset in this repo), mirroring
 * AudienceStore.test.ts.
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
  DeckMeta,
  RegistryError,
  getDeckMeta,
  listDecks,
  newDeckId,
  registerDeck,
  unregisterDeck,
  updateDeckMeta,
} from './registry';

const INDEX_KEY = 'srs_registry_v1';

function meta(id: string, name: string, updatedAt: number, overrides: Partial<DeckMeta> = {}): DeckMeta {
  return { id, name, source: 'manual', createdAt: updatedAt, updatedAt, cardCount: 0, ...overrides };
}

beforeEach(() => mem.clear());

describe('listDecks', () => {
  it('returns [] when nothing has ever been written (empty, not corrupt)', async () => {
    expect(await listDecks()).toEqual([]);
  });

  it('round-trips registered decks newest-updated first', async () => {
    await registerDeck(meta('a', 'Older', 100));
    await registerDeck(meta('b', 'Newer', 200));
    const all = await listDecks();
    expect(all.map((d) => d.id)).toEqual(['b', 'a']);
  });

  it('THROWS on corrupt JSON — never returns [] (Zoracon: surface, not swallow)', async () => {
    mem.set(INDEX_KEY, '{not json');
    await expect(listDecks()).rejects.toBeInstanceOf(RegistryError);
  });

  it('THROWS when the stored index is not an array', async () => {
    mem.set(INDEX_KEY, JSON.stringify({ not: 'a list' }));
    await expect(listDecks()).rejects.toBeInstanceOf(RegistryError);
  });
});

describe('registerDeck', () => {
  it('rejects a duplicate id (would collide store.ts card key)', async () => {
    await registerDeck(meta('dup', 'First', 1));
    await expect(registerDeck(meta('dup', 'Second', 2))).rejects.toBeInstanceOf(RegistryError);
    expect((await listDecks()).length).toBe(1);
  });
});

describe('updateDeckMeta', () => {
  it('patches name + cardCount and bumps updatedAt', async () => {
    await registerDeck(meta('x', 'Psych', 100, { cardCount: 3 }));
    const next = await updateDeckMeta('x', { name: 'Psychology', cardCount: 12 }, 500);
    expect(next).toMatchObject({ name: 'Psychology', cardCount: 12, updatedAt: 500, createdAt: 100 });
    expect(await getDeckMeta('x')).toMatchObject({ name: 'Psychology', cardCount: 12 });
  });

  it('throws on an unknown id instead of inventing a partial deck', async () => {
    await expect(updateDeckMeta('ghost', { name: 'x' })).rejects.toBeInstanceOf(RegistryError);
  });
});

describe('unregisterDeck', () => {
  it('removes only the named deck', async () => {
    await registerDeck(meta('a', 'A', 1));
    await registerDeck(meta('b', 'B', 2));
    await unregisterDeck('a');
    expect((await listDecks()).map((d) => d.id)).toEqual(['b']);
  });

  it('is a no-op for an unknown id', async () => {
    await registerDeck(meta('a', 'A', 1));
    await unregisterDeck('nope');
    expect((await listDecks()).length).toBe(1);
  });
});

describe('newDeckId', () => {
  it('mints distinct ids', () => {
    expect(newDeckId()).not.toBe(newDeckId());
  });
});
