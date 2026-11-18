/**
 * readTime.test.ts — the time readout must agree with the real engine.
 * Run with: npx jest lib/teleprompter/readTime.test.ts
 */
import { TeleprompterEngine, SPEED_MANUAL } from './TeleprompterEngine';
import { remainingSeconds, formatClock, formatReadTime, scriptLengthLabel } from './readTime';

const SCRIPT = ['one', 'two', 'three', 'four', 'five', 'six'].join('\n\n');

describe('remainingSeconds — agrees with TeleprompterEngine', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function makeEngine(secondsPerLine: number) {
    return new TeleprompterEngine({
      onFrame: () => {},
      onStateChange: () => {},
      script: SCRIPT,
      secondsPerLine,
    });
  }

  it('the engine ends exactly when the readout reaches zero', () => {
    const spl = 2;
    const engine = makeEngine(spl);
    const { totalLines } = engine.getSnapshot();
    expect(totalLines).toBeGreaterThan(1);
    const total = remainingSeconds(0, totalLines, spl)!;

    engine.play();
    jest.advanceTimersByTime(total * 1000 - 1);
    expect(engine.getSnapshot().state).toBe('playing');
    jest.advanceTimersByTime(1);
    expect(engine.getSnapshot().state).toBe('ended');
    engine.destroy();
  });

  it('counts down by one line per tick mid-script', () => {
    const spl = 2;
    const engine = makeEngine(spl);
    const { totalLines } = engine.getSnapshot();
    const total = remainingSeconds(0, totalLines, spl)!;

    engine.play();
    jest.advanceTimersByTime(3 * spl * 1000);
    const snap = engine.getSnapshot();
    expect(snap.topIndex).toBe(3);
    expect(remainingSeconds(snap.topIndex, snap.totalLines, spl)).toBe(total - 3 * spl);
    engine.destroy();
  });

  it('is null in manual mode and never negative', () => {
    expect(remainingSeconds(0, 10, SPEED_MANUAL)).toBeNull();
    expect(remainingSeconds(0, 10, 0)).toBeNull();
    expect(remainingSeconds(12, 10, 2)).toBe(0);
  });
});

describe('formatters', () => {
  it('formatClock', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(46.75)).toBe('0:47'); // rounds up: never shows 0:00 with time left
    expect(formatClock(3727)).toBe('1:02:07');
    expect(formatClock(-3)).toBe('0:00');
  });

  it('formatReadTime', () => {
    expect(formatReadTime(20)).toBe('<1 min');
    expect(formatReadTime(60)).toBe('1 min');
    expect(formatReadTime(12 * 60 + 10)).toBe('12 min');
    expect(formatReadTime(3600)).toBe('1 hr');
    expect(formatReadTime(3900)).toBe('1 hr 5 min');
  });

  it('scriptLengthLabel uses pace, and falls back to lines in manual mode', () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    expect(scriptLengthLabel(long, 2)).toBe('2 min'); // 60 lines × 2 s
    expect(scriptLengthLabel(long, SPEED_MANUAL)).toBe('60 lines');
    expect(scriptLengthLabel('just one', SPEED_MANUAL)).toBe('1 line');
  });
});
