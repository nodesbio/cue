import { framePlay } from './useLivePlay';
import { MAX_CHARS } from '../teleprompter/lineWrapper';
import type { PlayLine } from './types';

const base: PlayLine = {
  id: 'p1',
  text: 'Smith rushes for 4 yards to the OSU 48.',
  period: 2,
  clock: '7:12',
  score: '14-10',
  scoring: false,
};

describe('framePlay', () => {
  it('puts a Q·clock·score meta line above the play text', () => {
    const lines = framePlay(base, 'NCAAF').split('\n');
    expect(lines[0]).toBe('Q2  7:12  14-10');
    expect(lines.some((l) => l.includes('Smith rushes'))).toBe(true);
  });

  it('omits empty meta fields (no fake 0-0, no blank Q)', () => {
    const frame = framePlay({ ...base, period: 0, clock: '', score: '' }, 'NCAAF');
    // No meta line at all → first line is the play text.
    expect(frame.split('\n')[0]).toMatch(/Smith rushes/);
  });

  it('wraps long play text to the lens width (≤45 cols)', () => {
    const long = {
      ...base,
      text:
        'Jeremiah Smith catches a deep pass down the right sideline and is finally dragged down at the 3 yard line after a 62 yard gain.',
    };
    for (const line of framePlay(long, 'NCAAF').split('\n')) {
      expect(line.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  });

  it('labels the period the way the league does', () => {
    expect(framePlay(base, 'NCAAM').split('\n')[0]).toBe('H2  7:12  14-10');
    expect(framePlay(base, 'NHL').split('\n')[0]).toBe('P2  7:12  14-10');
  });

  it('is team-agnostic — renders a Nebraska play identically', () => {
    const neb = { ...base, text: 'Raiola completes to Coleman for 11 yards.', score: '7-21' };
    const lines = framePlay(neb, 'NCAAF').split('\n');
    expect(lines[0]).toBe('Q2  7:12  7-21');
    expect(lines.some((l) => l.includes('Raiola'))).toBe(true);
  });
});
