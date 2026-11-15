import {
  RAMP_MS,
  STAGE_FRAMES,
  TOTAL_FRAMES,
  intervalForFrame,
  stageForFrame,
  linkCeilingMs,
  renderCeilingMs,
  committedPaceMs,
} from './calibrate';

const full = (upTo: number) => {
  const s = new Set<number>();
  for (let i = 1; i <= upTo; i++) s.add(i);
  return s;
};

describe('calibrate ramp schedule', () => {
  it('maps frame index to the right stage interval', () => {
    expect(intervalForFrame(1)).toBe(RAMP_MS[0]);
    expect(intervalForFrame(STAGE_FRAMES)).toBe(RAMP_MS[0]);
    expect(intervalForFrame(STAGE_FRAMES + 1)).toBe(RAMP_MS[1]);
    expect(intervalForFrame(TOTAL_FRAMES)).toBe(RAMP_MS[RAMP_MS.length - 1]);
  });
  it('clamps beyond the last stage', () => {
    expect(stageForFrame(TOTAL_FRAMES + 500)).toBe(RAMP_MS.length - 1);
  });
});

describe('linkCeilingMs — R is link-limited', () => {
  it('clean all the way ⇒ fastest interval (link not the bottleneck)', () => {
    expect(linkCeilingMs(full(TOTAL_FRAMES), TOTAL_FRAMES)).toBe(RAMP_MS[RAMP_MS.length - 1]);
  });
  it('first gap in stage 2 ⇒ ceiling is stage 1 interval', () => {
    // clean through stage 0 and 1, drop one seq inside stage 2
    const acked = full(TOTAL_FRAMES);
    acked.delete(2 * STAGE_FRAMES + 3); // a seq in stage 2
    expect(linkCeilingMs(acked, TOTAL_FRAMES)).toBe(RAMP_MS[1]);
  });
  it('drops in the very first stage ⇒ slowest interval', () => {
    const acked = full(TOTAL_FRAMES);
    acked.delete(5); // stage 0
    expect(linkCeilingMs(acked, TOTAL_FRAMES)).toBe(RAMP_MS[0]);
  });
  it('mirrors the 18:46 R trace: first gap ~seq 25 (stage 0) ⇒ slowest', () => {
    const acked = full(160);
    acked.delete(25);
    expect(linkCeilingMs(acked, 160)).toBe(RAMP_MS[0]);
  });
});

describe('renderCeilingMs — L is render-limited', () => {
  it('null when render phase skipped', () => {
    expect(renderCeilingMs(null)).toBeNull();
  });
  it('froze in stage 1 ⇒ backs off to stage 0 interval (L ~8 f/s)', () => {
    // 18:44 run: L panel froze ~frame 44, which is stage 1
    expect(renderCeilingMs(44)).toBe(RAMP_MS[0]);
  });
  it('never stopped (watched clean to end) ⇒ fastest interval', () => {
    expect(renderCeilingMs(TOTAL_FRAMES)).toBe(RAMP_MS[RAMP_MS.length - 2]);
  });
});

describe('committedPaceMs — slowest wins for safe lockstep', () => {
  it('takes the slowest ceiling across both lenses and layers', () => {
    const pace = committedPaceMs(
      { L: RAMP_MS[5], R: RAMP_MS[2] }, // L link fast, R link mid
      { L: RAMP_MS[0], R: null },       // L render slow (the real binding one)
    );
    expect(pace).toBe(RAMP_MS[0]); // 120ms — matches the eye-confirmed safe pace
  });
  it('ignores null render ceilings', () => {
    const pace = committedPaceMs({ L: RAMP_MS[4], R: RAMP_MS[3] }, { L: null, R: null });
    expect(pace).toBe(RAMP_MS[3]);
  });
});
