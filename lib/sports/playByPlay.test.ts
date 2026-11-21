/**
 * Play-by-play normalizer — pure, deterministic. Covers both ESPN feed shapes
 * (football drives + basketball flat plays), ordering, and the empty guards.
 */
import { extractPlayByPlay } from './playByPlay';
import type { EspnSummary, EspnPlay } from './types';

function play(seq: number, over: Partial<EspnPlay> = {}): EspnPlay {
  return {
    id: `play-${seq}`,
    sequenceNumber: String(seq),
    text: `play ${seq}`,
    period: { number: 1 },
    clock: { displayValue: '10:00' },
    awayScore: 0,
    homeScore: 0,
    scoringPlay: false,
    ...over,
  };
}

describe('extractPlayByPlay', () => {
  it('flattens football drives (previous then current) newest-first', () => {
    const summary: EspnSummary = {
      drives: {
        previous: [
          { team: { abbreviation: 'NEB' }, plays: [play(1), play(2)] },
          { team: { abbreviation: 'OSU' }, plays: [play(3)] },
        ],
        current: { team: { abbreviation: 'NEB' }, plays: [play(4), play(5)] },
      },
    };
    const lines = extractPlayByPlay(summary);
    expect(lines.map((l) => l.text)).toEqual(['play 5', 'play 4', 'play 3', 'play 2', 'play 1']);
  });

  it('reads a flat plays[] for basketball/hockey, newest-first', () => {
    const summary: EspnSummary = { plays: [play(1), play(2), play(3)] };
    expect(extractPlayByPlay(summary).map((l) => l.text)).toEqual(['play 3', 'play 2', 'play 1']);
  });

  it('prefers flat plays[] over drives when both present', () => {
    const summary: EspnSummary = {
      plays: [play(10, { text: 'flat' })],
      drives: { previous: [{ plays: [play(1, { text: 'drive' })] }] },
    };
    expect(extractPlayByPlay(summary).map((l) => l.text)).toEqual(['flat']);
  });

  it('formats score as away-home and flags scoring plays', () => {
    const summary: EspnSummary = {
      plays: [play(1, { awayScore: 0, homeScore: 3, scoringPlay: true, text: 'FG GOOD' })],
    };
    const [l] = extractPlayByPlay(summary);
    expect(l.score).toBe('0-3');
    expect(l.scoring).toBe(true);
    expect(l.period).toBe(1);
    expect(l.clock).toBe('10:00');
  });

  it('leaves score empty when scores are missing (no fake 0-0)', () => {
    const summary: EspnSummary = {
      plays: [play(1, { awayScore: undefined, homeScore: undefined })],
    };
    expect(extractPlayByPlay(summary)[0].score).toBe('');
  });

  it('drops plays with empty/whitespace text', () => {
    const summary: EspnSummary = {
      plays: [play(1, { text: '' }), play(2, { text: '   ' }), play(3, { text: 'real' })],
    };
    expect(extractPlayByPlay(summary).map((l) => l.text)).toEqual(['real']);
  });

  it('returns [] for an empty / play-less payload (surfaced, not faked)', () => {
    expect(extractPlayByPlay({})).toEqual([]);
    expect(extractPlayByPlay({ plays: [] })).toEqual([]);
    expect(extractPlayByPlay({ drives: { previous: [], current: null } })).toEqual([]);
  });

  it('synthesizes a unique id when a play has none', () => {
    const summary: EspnSummary = {
      plays: [play(1, { id: undefined }), play(2, { id: undefined })],
    };
    const ids = extractPlayByPlay(summary).map((l) => l.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps ids unique even when ESPN sends DUPLICATE play ids', () => {
    // Live NCAAF (401858531205) emitted the same play id twice, crashing the
    // React list with a duplicate-key warning and risking dropped rows.
    const summary: EspnSummary = {
      plays: [
        play(1, { id: '401858531205' }),
        play(2, { id: '401858531205' }),
        play(3, { id: '401858531205' }),
      ],
    };
    const lines = extractPlayByPlay(summary);
    expect(lines).toHaveLength(3);
    expect(new Set(lines.map((l) => l.id)).size).toBe(3);
  });
});
