/**
 * sources/manual.ts — the user-authored deck source.
 *
 * The load-bearing invariant: a row's card id depends only on its CONTENT, not
 * its position, so reordering/inserting/deleting rows above an unchanged row
 * keeps that row's id (and therefore its earned scheduling, via store.mergeDeck).
 * Editing a row's text yields a new id (fresh schedule) — correct, the fact changed.
 */

import { manualCardId, manualToSrs, type ManualRow } from './manual';
import { isDue } from '../card';

const rows = (...pairs: [string, string][]): ManualRow[] =>
  pairs.map(([prompt, answer]) => ({ prompt, answer }));

describe('manualToSrs', () => {
  it('converts rows into due-now, learning cards with manual: source tags', () => {
    const cards = manualToSrs('d1', rows(['Operant conditioning?', 'Reinforcement-driven learning']));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ deckId: 'd1', prompt: 'Operant conditioning?', answer: 'Reinforcement-driven learning' });
    expect(cards[0].source).toMatch(/^manual:/);
    expect(cards[0].srs.learning).toBe(true);
    expect(isDue(cards[0], Date.now())).toBe(true);
  });

  it('drops half-typed rows (missing prompt or answer after trim)', () => {
    const cards = manualToSrs('d1', rows(['Q only', ''], ['', 'A only'], ['  ', '  '], ['Good', 'Row']));
    expect(cards.map((c) => c.prompt)).toEqual(['Good']);
  });

  it('collapses duplicate content to a single card', () => {
    const cards = manualToSrs('d1', rows(['Same', 'Thing'], ['Same', 'Thing']));
    expect(cards).toHaveLength(1);
  });

  it('trims surrounding whitespace in prompt and answer', () => {
    const [c] = manualToSrs('d1', rows(['  Freud?  ', '  id/ego/superego  ']));
    expect(c.prompt).toBe('Freud?');
    expect(c.answer).toBe('id/ego/superego');
  });

  describe('id stability (edit-without-losing-progress)', () => {
    it('keeps a row id when rows are reordered/inserted above it', () => {
      const before = manualToSrs('d1', rows(['A', '1'], ['B', '2']));
      const after = manualToSrs('d1', rows(['NEW', '0'], ['B', '2'], ['A', '1']));
      const idB_before = before.find((c) => c.prompt === 'B')!.id;
      const idB_after = after.find((c) => c.prompt === 'B')!.id;
      expect(idB_after).toBe(idB_before);
    });

    it('changes a row id when its text is edited (new fact = fresh schedule)', () => {
      const v1 = manualToSrs('d1', rows(['Q', 'old answer']))[0].id;
      const v2 = manualToSrs('d1', rows(['Q', 'new answer']))[0].id;
      expect(v2).not.toBe(v1);
    });

    it('namespaces ids by deck so identical content in two decks never collides', () => {
      expect(manualCardId('deckA', 'Q', 'A')).not.toBe(manualCardId('deckB', 'Q', 'A'));
    });
  });
});
