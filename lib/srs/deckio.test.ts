/**
 * deckio.test.ts — the import/export format spec. The test IS the contract: the
 * UI (picker/share/persist) trusts these pure functions, so correctness lives here.
 */

import {
  serializeDeck,
  parseDeckFile,
  importDeckFile,
  deckFileName,
  DeckFileError,
  DECK_FILE_FORMAT,
  DECK_FILE_VERSION,
} from './deckio';
import { makeCard, type Card } from './card';

const card = (prompt: string, answer: string, overrides: Partial<Card> = {}): Card => ({
  ...makeCard(`id_${prompt}`, 'deckX', prompt, answer, `manual:${prompt}`, 1000),
  ...overrides,
});

describe('serializeDeck → parseDeckFile round-trip', () => {
  it('preserves name, card content, and SRS state; drops device-local ids', () => {
    const learned = card('capital of France?', 'Paris', {
      srs: { ivl: 21, ease: 2.6, reps: 5, lapses: 1, due: 9_999, learning: false },
    });
    const file = parseDeckFile(serializeDeck('Geography', [learned, card('2+2', '4')]));

    expect(file.format).toBe(DECK_FILE_FORMAT);
    expect(file.version).toBe(DECK_FILE_VERSION);
    expect(file.name).toBe('Geography');
    expect(file.cards).toHaveLength(2);
    expect(file.cards[0]).toMatchObject({ prompt: 'capital of France?', answer: 'Paris' });
    expect(file.cards[0].srs).toEqual(learned.srs); // intervals survive the trip
    expect(file.cards[0]).not.toHaveProperty('id'); // ids are not exported
  });

  it('emits pretty-printed, human-diffable JSON', () => {
    expect(serializeDeck('X', [card('q', 'a')])).toContain('\n  ');
  });
});

describe('importDeckFile', () => {
  const file = parseDeckFile(
    serializeDeck('Psych 101', [
      card('operant conditioning?', 'reinforcement shapes behavior', {
        srs: { ivl: 10, ease: 2.4, reps: 3, lapses: 0, due: 5_000, learning: false },
      }),
    ]),
  );

  it('mints a fresh deck id so imports never collide with existing decks', () => {
    const a = importDeckFile(file, { now: 1 });
    const b = importDeckFile(file, { now: 2 });
    expect(a.meta.id).not.toBe(b.meta.id);
    expect(a.cards[0].deckId).toBe(a.meta.id);
    expect(a.cards[0].id).not.toBe(b.cards[0].id); // ids re-based onto new deckId
  });

  it('preserves SRS state by default', () => {
    const { cards } = importDeckFile(file, { now: 1 });
    expect(cards[0].srs).toMatchObject({ ivl: 10, reps: 3, learning: false });
  });

  it('resets progress to due-now when asked', () => {
    const { cards } = importDeckFile(file, { resetProgress: true, now: 1 });
    expect(cards[0].srs).toMatchObject({ ivl: 0, reps: 0, learning: true, due: 1 });
  });

  it('sets meta cardCount and defaults source to manual', () => {
    const { meta } = importDeckFile(file, { now: 1 });
    expect(meta).toMatchObject({ name: 'Psych 101', source: 'manual', cardCount: 1 });
  });

  it('drops blank cards and collapses duplicates', () => {
    const raw = parseDeckFile(
      serializeDeck('Dirty', [card('q', 'a'), card('q', 'a'), card('  ', 'x'), card('y', '  ')]),
    );
    expect(importDeckFile(raw, { now: 1 }).cards).toHaveLength(1);
  });
});

describe('parseDeckFile rejects malformed input (surfaced, not swallowed)', () => {
  it('throws on non-JSON', () => {
    expect(() => parseDeckFile('{not json')).toThrow(DeckFileError);
  });

  it('throws on a non-object / non-Cue file', () => {
    expect(() => parseDeckFile('[]')).toThrow(/not a Cue deck/);
    expect(() => parseDeckFile(JSON.stringify({ format: 'something.else' }))).toThrow(/not a Cue deck/);
  });

  it('throws on an unsupported newer version', () => {
    const future = JSON.stringify({ format: DECK_FILE_FORMAT, version: 99, name: 'x', cards: [] });
    expect(() => parseDeckFile(future)).toThrow(/newer version/);
  });

  it('throws on a missing name', () => {
    const noName = JSON.stringify({ format: DECK_FILE_FORMAT, version: 1, name: '  ', cards: [] });
    expect(() => parseDeckFile(noName)).toThrow(/missing its name/);
  });

  it('throws when cards is not a list', () => {
    const bad = JSON.stringify({ format: DECK_FILE_FORMAT, version: 1, name: 'x', cards: {} });
    expect(() => parseDeckFile(bad)).toThrow(/expected a list/);
  });

  it('throws on a card missing prompt/answer', () => {
    const bad = JSON.stringify({
      format: DECK_FILE_FORMAT, version: 1, name: 'x',
      cards: [{ prompt: 'q', srs: { ivl: 0, ease: 2.5, reps: 0, lapses: 0, due: 0, learning: true } }],
    });
    expect(() => parseDeckFile(bad)).toThrow(/prompt or answer/);
  });

  it('throws on a card with invalid scheduling data', () => {
    const bad = JSON.stringify({
      format: DECK_FILE_FORMAT, version: 1, name: 'x',
      cards: [{ prompt: 'q', answer: 'a', srs: { ivl: 'nope' } }],
    });
    expect(() => parseDeckFile(bad)).toThrow(/scheduling data/);
  });

  it('accepts an empty deck (zero cards is valid)', () => {
    const empty = JSON.stringify({ format: DECK_FILE_FORMAT, version: 1, name: 'Empty', cards: [] });
    expect(parseDeckFile(empty).cards).toEqual([]);
  });
});

describe('deckFileName', () => {
  it('slugifies to a safe .cuedeck.json name', () => {
    expect(deckFileName('Psych 101: Unit 3!')).toBe('psych-101-unit-3.cuedeck.json');
  });
  it('falls back to "deck" for an all-symbol name', () => {
    expect(deckFileName('!!!')).toBe('deck.cuedeck.json');
  });
});
