/**
 * TeleprompterEngine.test.ts
 * Run with: npx jest lib/teleprompter/TeleprompterEngine.test.ts
 */

import {
  TeleprompterEngine,
  EngineSnapshot,
  SPEED_NORMAL,
  SPEED_FAST,
  SPEED_MANUAL,
} from './TeleprompterEngine';

// Fake timers for all tests
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

import type { TeleprompterEngineOptions } from './TeleprompterEngine';

function makeEngine(overrides: Partial<TeleprompterEngineOptions> = {}) {
  const frames: string[] = [];
  const snaps: EngineSnapshot[] = [];

  const engine = new TeleprompterEngine({
    script: 'Line one.\nLine two.\nLine three.\nLine four.\nLine five.\nLine six.',
    secondsPerLine: SPEED_NORMAL,
    loop: false,
    onFrame: (f) => frames.push(f),
    onStateChange: (s) => snaps.push(s),
    ...overrides,
  });

  return { engine, frames, snaps };
}

// ── Initial state ──────────────────────────────────────────────────────────

describe('initial state', () => {
  it('starts idle', () => {
    const { snaps } = makeEngine();
    expect(snaps[snaps.length - 1].state).toBe('idle');
  });

  it('topIndex is 0', () => {
    const { engine } = makeEngine();
    expect(engine.getSnapshot().topIndex).toBe(0);
  });

  it('emits a frame on construction', () => {
    const { frames } = makeEngine();
    expect(frames.length).toBeGreaterThan(0);
  });
});

// ── play / pause / toggle ─────────────────────────────────────────────────

describe('play / pause', () => {
  it('play sets state to playing', () => {
    const { engine } = makeEngine();
    engine.play();
    expect(engine.getSnapshot().state).toBe('playing');
  });

  it('pause sets state to paused', () => {
    const { engine } = makeEngine();
    engine.play();
    engine.pause();
    expect(engine.getSnapshot().state).toBe('paused');
  });

  it('toggle switches play ↔ pause', () => {
    const { engine } = makeEngine();
    engine.play();
    engine.toggle();
    expect(engine.getSnapshot().state).toBe('paused');
    engine.toggle();
    expect(engine.getSnapshot().state).toBe('playing');
  });

  it('play from ended restarts from line 0', () => {
    const { engine } = makeEngine({ script: 'One line.' });
    engine.play();
    jest.runAllTimers();
    engine.play();
    expect(engine.getSnapshot().topIndex).toBe(0);
    expect(engine.getSnapshot().state).toBe('playing');
  });
});

// ── Timer advances topIndex ───────────────────────────────────────────────

describe('auto-advance via timer', () => {
  it('advances topIndex after one interval', () => {
    const { engine } = makeEngine();
    engine.play();
    expect(engine.getSnapshot().topIndex).toBe(0);
    jest.advanceTimersByTime(SPEED_NORMAL * 1000);
    expect(engine.getSnapshot().topIndex).toBe(1);
  });

  it('advances multiple steps', () => {
    const { engine } = makeEngine();
    engine.play();
    jest.advanceTimersByTime(SPEED_NORMAL * 1000 * 3);
    expect(engine.getSnapshot().topIndex).toBe(3);
  });

  it('pause stops advancing', () => {
    const { engine } = makeEngine();
    engine.play();
    jest.advanceTimersByTime(SPEED_NORMAL * 1000);
    engine.pause();
    jest.advanceTimersByTime(SPEED_NORMAL * 1000 * 5);
    expect(engine.getSnapshot().topIndex).toBe(1);
  });
});

// ── next / prev ──────────────────────────────────────────────────────────

describe('next / prev', () => {
  it('next advances one line', () => {
    const { engine } = makeEngine();
    engine.next();
    expect(engine.getSnapshot().topIndex).toBe(1);
  });

  it('prev goes back one line', () => {
    const { engine } = makeEngine();
    engine.next();
    engine.next();
    engine.prev();
    expect(engine.getSnapshot().topIndex).toBe(1);
  });

  it('prev does not go below 0', () => {
    const { engine } = makeEngine();
    engine.prev();
    expect(engine.getSnapshot().topIndex).toBe(0);
  });

  it('next resets timer if playing', () => {
    const { engine } = makeEngine();
    engine.play();
    jest.advanceTimersByTime(SPEED_NORMAL * 1000 * 0.9); // almost one tick
    engine.next(); // manually advance — should reset timer
    jest.advanceTimersByTime(SPEED_NORMAL * 1000 * 0.5); // half tick more
    // still on line 2 (no auto-advance yet)
    expect(engine.getSnapshot().topIndex).toBe(1);
  });
});

// ── setSpeed ──────────────────────────────────────────────────────────────

describe('setSpeed', () => {
  it('changes secondsPerLine', () => {
    const { engine } = makeEngine();
    engine.setSpeed(SPEED_FAST);
    expect(engine.getSnapshot().secondsPerLine).toBe(SPEED_FAST);
  });

  it('takes effect immediately while playing', () => {
    const { engine } = makeEngine();
    engine.play();
    engine.setSpeed(SPEED_FAST);
    jest.advanceTimersByTime(SPEED_FAST * 1000);
    expect(engine.getSnapshot().topIndex).toBe(1);
  });

  it('manual mode (Infinity) does not auto-advance', () => {
    const { engine } = makeEngine({ secondsPerLine: SPEED_MANUAL });
    engine.play();
    jest.advanceTimersByTime(60_000);
    expect(engine.getSnapshot().topIndex).toBe(0);
  });
});

// ── end-of-script ─────────────────────────────────────────────────────────

describe('end of script', () => {
  it('reaches ended state', () => {
    const { engine } = makeEngine({ script: 'One.\nTwo.' });
    engine.play();
    jest.runAllTimers();
    expect(engine.getSnapshot().state).toBe('ended');
  });

  it('frame includes end-of-script marker', () => {
    const { engine } = makeEngine({ script: 'One.\nTwo.' });
    engine.play();
    jest.runAllTimers();
    expect(engine.getSnapshot().frame).toContain('End of script');
  });
});

// ── loop mode ─────────────────────────────────────────────────────────────

describe('loop mode', () => {
  it('restarts from 0 after delay', () => {
    const { engine } = makeEngine({ script: 'One.\nTwo.', loop: true });
    engine.play();
    // Advance to end-of-script
    jest.advanceTimersByTime(SPEED_NORMAL * 1000 * 10);
    // Now advance past the 3s restart delay
    jest.advanceTimersByTime(3100);
    const snap = engine.getSnapshot();
    // After loop restart the engine resets to 0 and resumes playing.
    // One more interval tick may fire within the 3.1s window, so topIndex ≤ 1.
    expect(snap.state).toBe('playing');
    expect(snap.topIndex).toBeLessThanOrEqual(1);
  });

  it('does not reach ended state when loop=true', () => {
    const { engine, snaps } = makeEngine({ script: 'One.\nTwo.', loop: true });
    engine.play();
    jest.advanceTimersByTime(SPEED_NORMAL * 1000 * 10 + 3500);
    const endedSnap = snaps.find(s => s.state === 'ended');
    expect(endedSnap).toBeUndefined();
  });
});

// ── head gestures ─────────────────────────────────────────────────────────

describe('handleGesture', () => {
  it('head_up advances when playing', () => {
    const { engine } = makeEngine();
    engine.play();
    engine.handleGesture('head_up');
    expect(engine.getSnapshot().topIndex).toBe(1);
  });

  it('head_down goes back when playing', () => {
    const { engine } = makeEngine();
    engine.play();
    engine.next();
    engine.next();
    engine.handleGesture('head_down');
    expect(engine.getSnapshot().topIndex).toBe(1);
  });

  it('gestures ignored when paused', () => {
    const { engine } = makeEngine();
    engine.play();
    engine.pause();
    engine.handleGesture('head_up');
    expect(engine.getSnapshot().topIndex).toBe(0);
  });
});

// ── loadScript ────────────────────────────────────────────────────────────

describe('loadScript', () => {
  it('resets position and state', () => {
    const { engine } = makeEngine();
    engine.play();
    engine.next();
    engine.next();
    engine.loadScript('Fresh script.');
    const snap = engine.getSnapshot();
    expect(snap.topIndex).toBe(0);
    expect(snap.state).toBe('idle');
  });
});

// ── frame format ──────────────────────────────────────────────────────────

describe('frame format', () => {
  it('frame has 5 lines', () => {
    const { engine } = makeEngine();
    const frame = engine.getSnapshot().frame;
    expect(frame.split('\n').length).toBe(5);
  });

  it('status bar contains play/pause indicator', () => {
    const { engine } = makeEngine();
    engine.play();
    expect(engine.getSnapshot().frame.split('\n')[0]).toContain('▶');
    engine.pause();
    expect(engine.getSnapshot().frame.split('\n')[0]).toContain('⏸');
  });

  it('status bar contains line counter', () => {
    const { engine } = makeEngine();
    const bar = engine.getSnapshot().frame.split('\n')[0];
    expect(bar).toMatch(/\d+\/\d+/);
  });
});
