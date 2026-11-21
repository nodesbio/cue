import { ruler, fill, byteLen, WIDTH_PROBE_FRAMES, TEXT_FRAME_BYTE_CAP } from './widthProbe';

describe('widthProbe', () => {
  it('byteLen counts UTF-8 bytes, not chars (middot is 2 bytes)', () => {
    expect(byteLen('abc')).toBe(3);
    expect(byteLen('·')).toBe(2); // U+00B7 → 2 bytes
    expect(byteLen('é')).toBe(2);
    // 36 chars with middots is MORE than 36 bytes — the trap the spec ignores.
    expect(byteLen('A · B'.padEnd(36, 'x')).valueOf()).toBeGreaterThan(36);
  });

  it('ruler produces a units row of exactly n columns', () => {
    const units = ruler(44).split('\n')[1];
    expect(units.length).toBe(44);
    expect(units.slice(0, 10)).toBe('1234567890');
    expect(units[43]).toBe('4'); // col 44 → "44" → last digit 4
  });

  it('fill produces exactly n identical chars', () => {
    expect(fill('W', 40)).toHaveLength(40);
    expect([...new Set(fill('W', 40))]).toEqual(['W']);
  });

  it('flags frames that exceed the 191-byte packet cap', () => {
    const overCap = WIDTH_PROBE_FRAMES.filter((f) => f.bytes > TEXT_FRAME_BYTE_CAP);
    // Exactly the bytecap-200 frame is intentionally over — it tests truncation.
    expect(overCap.map((f) => f.name)).toEqual(['bytecap-200']);
  });

  it('reports each frame bytes consistently with byteLen', () => {
    for (const f of WIDTH_PROBE_FRAMES) {
      expect(f.bytes).toBe(byteLen(f.text));
    }
  });
});
