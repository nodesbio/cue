/**
 * lineWrapper.test.ts — unit tests for wrapParagraph, wrapScript, getWindow, formatFrame.
 * Run with: npx jest lib/teleprompter/lineWrapper.test.ts
 */

import {
  wrapParagraph,
  wrapScript,
  wrapScriptWithOffsets,
  resolveMarkerLine,
  getWindow,
  formatFrame,
  MAX_CHARS,
  WINDOW_SIZE,
  DEFAULT_SCRIPT,
} from './lineWrapper';

// ── wrapParagraph ──────────────────────────────────────────────────────────

describe('wrapParagraph', () => {
  it('returns a single line for short text', () => {
    expect(wrapParagraph('Hello world')).toEqual(['Hello world']);
  });

  it('wraps at word boundary before 45 chars', () => {
    const text = 'This is a sentence that is definitely longer than forty-five characters total';
    const lines = wrapParagraph(text);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(MAX_CHARS);
    }
    // Reassembled text should equal original (words preserved)
    expect(lines.join(' ')).toBe(text);
  });

  it('hard-breaks a word longer than maxChars', () => {
    const longWord = 'a'.repeat(60);
    const lines = wrapParagraph(longWord);
    expect(lines[0].length).toBe(45);
    expect(lines[1].length).toBe(15);
    expect(lines.join('')).toBe(longWord);
  });

  it('handles empty string', () => {
    expect(wrapParagraph('')).toEqual(['']);
  });

  it('handles exactly 45 chars', () => {
    const text = 'a'.repeat(45);
    expect(wrapParagraph(text)).toEqual([text]);
  });

  it('does not produce lines exceeding maxChars', () => {
    const text = 'word '.repeat(30).trim();
    const lines = wrapParagraph(text);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  });
});

// ── wrapScript ─────────────────────────────────────────────────────────────

describe('wrapScript', () => {
  it('returns empty array for empty script', () => {
    expect(wrapScript('')).toEqual([]);
    expect(wrapScript('   \n  \n  ')).toEqual([]);
  });

  it('preserves blank lines between paragraphs', () => {
    const script = 'First paragraph.\n\nSecond paragraph.';
    const lines = wrapScript(script);
    expect(lines).toContain('');
  });

  it('collapses 3+ blank lines to a single blank', () => {
    const script = 'First.\n\n\n\nSecond.';
    const lines = wrapScript(script);
    const blanks = lines.filter(l => l === '');
    expect(blanks.length).toBeLessThanOrEqual(1);
  });

  it('trims leading and trailing blank lines', () => {
    const script = '\n\nHello.\n\n';
    const lines = wrapScript(script);
    expect(lines[0]).not.toBe('');
    expect(lines[lines.length - 1]).not.toBe('');
  });

  it('wraps long paragraphs into multiple lines', () => {
    const para = 'word '.repeat(20).trim(); // ~99 chars
    const lines = wrapScript(para);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  });

  it('processes DEFAULT_SCRIPT without error', () => {
    const lines = wrapScript(DEFAULT_SCRIPT);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  });

  it('normalises Windows line endings', () => {
    const script = 'Hello.\r\nWorld.';
    const lines = wrapScript(script);
    expect(lines).toContain('Hello.');
    expect(lines).toContain('World.');
  });
});

// ── getWindow ──────────────────────────────────────────────────────────────

describe('getWindow', () => {
  const lines = ['a', 'b', 'c', 'd', 'e', 'f'];

  it('returns WINDOW_SIZE lines', () => {
    expect(getWindow(lines, 0).length).toBe(WINDOW_SIZE);
  });

  it('returns correct slice at start', () => {
    expect(getWindow(lines, 0)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns correct slice mid-script', () => {
    expect(getWindow(lines, 2)).toEqual(['c', 'd', 'e', 'f']);
  });

  it('pads with empty strings at end of script', () => {
    expect(getWindow(lines, 4)).toEqual(['e', 'f', '', '']);
    expect(getWindow(lines, 6)).toEqual(['', '', '', '']);
  });
});

// ── formatFrame ────────────────────────────────────────────────────────────

describe('formatFrame', () => {
  it('produces a 5-line string', () => {
    const lines = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    const frame = formatFrame('7:09 PM  ▶ 1/6', lines, 0);
    expect(frame.split('\n').length).toBe(5);
  });

  it('line 1 is the status bar', () => {
    const lines = ['hello', 'world', '', ''];
    const frame = formatFrame('STATUS', lines, 0);
    expect(frame.split('\n')[0]).toBe('STATUS');
  });

  it('content lines follow the window', () => {
    const lines = ['a', 'b', 'c', 'd'];
    const frame = formatFrame('S', lines, 0);
    const [, l2, l3, l4, l5] = frame.split('\n');
    expect([l2, l3, l4, l5]).toEqual(['a', 'b', 'c', 'd']);
  });
});

// ── wrapScriptWithOffsets + resolveMarkerLine (resume markers) ───────────────

describe('wrapScriptWithOffsets', () => {
  it('reports one offset per produced line', () => {
    const { lines, lineStarts } = wrapScriptWithOffsets('Hello world');
    expect(lineStarts.length).toBe(lines.length);
  });

  it('each lineStart points at the start of that line text in the source', () => {
    const src = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi';
    const { lines, lineStarts } = wrapScriptWithOffsets(src);
    for (let i = 0; i < lines.length; i++) {
      const firstWord = lines[i].split(' ')[0];
      if (firstWord === '') continue;
      expect(src.slice(lineStarts[i]).startsWith(firstWord)).toBe(true);
    }
  });

  it('offsets are monotonically non-decreasing', () => {
    const src = DEFAULT_SCRIPT;
    const { lineStarts } = wrapScriptWithOffsets(src);
    for (let i = 1; i < lineStarts.length; i++) {
      expect(lineStarts[i]).toBeGreaterThanOrEqual(lineStarts[i - 1]);
    }
  });

  it('handles multi-paragraph scripts with blank lines', () => {
    const src = 'First para here.\n\nSecond para over here.';
    const { lines, lineStarts } = wrapScriptWithOffsets(src);
    expect(lines.length).toBe(lineStarts.length);
    expect(lines).toContain('');
  });

  it('empty script yields empty arrays', () => {
    expect(wrapScriptWithOffsets('')).toEqual({ lines: [], lineStarts: [] });
  });
});

describe('resolveMarkerLine', () => {
  const starts = [0, 10, 25, 40, 60];

  it('returns 0 for empty', () => {
    expect(resolveMarkerLine([], 123)).toBe(0);
  });

  it('exact match returns that line', () => {
    expect(resolveMarkerLine(starts, 25)).toBe(2);
  });

  it('between starts returns the preceding line', () => {
    expect(resolveMarkerLine(starts, 30)).toBe(2);
    expect(resolveMarkerLine(starts, 59)).toBe(3);
  });

  it('before first start clamps to 0', () => {
    expect(resolveMarkerLine(starts, -5)).toBe(0);
  });

  it('past last start clamps to last line', () => {
    expect(resolveMarkerLine(starts, 9999)).toBe(4);
  });

  it('round-trips: a captured offset resolves back to its own line', () => {
    const src = DEFAULT_SCRIPT;
    const { lines, lineStarts } = wrapScriptWithOffsets(src);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '') continue;
      expect(resolveMarkerLine(lineStarts, lineStarts[i])).toBe(i);
    }
  });
});
