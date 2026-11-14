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

// ── Manual resync (double-click) ───────────────────────────────────────────
// Root cause of the field bug: double-click re-pushed the frame but left the
// scroll timer running, so the glasses synced then immediately drifted. A
// resync must PAUSE so the line holds.
describe('resync', () => {
  it('pauses auto-scroll so the synced line holds', () => {
    const { engine } = makeEngine();
    engine.play();
    expect(engine.getSnapshot().state).toBe('playing');

    engine.resync();
    expect(engine.getSnapshot().state).toBe('paused');

    const lineAtSync = engine.getSnapshot().topIndex;
    // Advance well past one scroll interval — a running timer would move us.
    jest.advanceTimersByTime(SPEED_NORMAL * 1000 * 5);
    expect(engine.getSnapshot().topIndex).toBe(lineAtSync);
  });

  it('flags justSynced on the snapshot when resynced', () => {
    const { engine } = makeEngine();
    engine.play();
    engine.resync();
    expect(engine.getSnapshot().justSynced).toBe(true);
  });

  it('clears justSynced once playback resumes', () => {
    const { engine } = makeEngine();
    engine.play();
    engine.resync();
    engine.play();
    expect(engine.getSnapshot().justSynced).toBe(false);
  });

  it('clears justSynced when the line advances', () => {
    const { engine } = makeEngine();
    engine.play();
    engine.resync();
    engine.next();
    expect(engine.getSnapshot().justSynced).toBe(false);
  });

  it('is a no-op-safe when already paused (still flags synced)', () => {
    const { engine } = makeEngine();
    engine.play();
    engine.pause();
    engine.resync();
    expect(engine.getSnapshot().state).toBe('paused');
    expect(engine.getSnapshot().justSynced).toBe(true);
  });

  // ── Last-writer invariant ────────────────────────────────────────────────
  // The field concern: on pause/resync the glasses must END on the resync'd
  // line, never on a stale frame queued behind it. The transport layer
  // (G1Core._textGen supersede) guarantees the resync sendText wins over any
  // queued scroll frame — but ONLY if the engine stops emitting new frames the
  // instant resync() is called. If a timer tick fired AFTER resync(), it would
  // enqueue a newer frame that supersedes the re-push (the "sync then drift"
  // field bug) and defeat the transport guarantee. These tests lock the engine
  // side of that contract: resync() is the final frame until play() resumes.
  it('emits no further frames after resync until resumed (last-writer lock)', () => {
    const { engine, frames } = makeEngine();
    engine.play();
    jest.advanceTimersByTime(SPEED_NORMAL * 1000 * 2); // scroll to line 2
    engine.resync();
    const frameCountAtResync = frames.length;
    // A surviving timer would emit at least one more frame here.
    jest.advanceTimersByTime(SPEED_NORMAL * 1000 * 10);
    expect(frames.length).toBe(frameCountAtResync);
  });

  it('resync re-emits the current held line as its final frame', () => {
    const { engine, frames } = makeEngine();
    engine.play();
    jest.advanceTimersByTime(SPEED_NORMAL * 1000 * 2); // on line index 2
    engine.resync();
    const heldIndex = engine.getSnapshot().topIndex;
    // The last frame emitted must be the resync frame for the held line —
    // this is the exact string app/(tabs)/index.tsx re-pushes to both lenses.
    expect(frames[frames.length - 1]).toBe(engine.getSnapshot().frame);
    expect(heldIndex).toBe(2);
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

  it('head_down suspends auto-scroll timer', () => {
    const { engine } = makeEngine();
    engine.play();
    engine.next();
    engine.handleGesture('head_down');
    const snap = engine.getSnapshot();
    // Still "playing" logically, but timer is suspended
    expect(snap.state).toBe('playing');
    expect(snap.timerSuspended).toBe(true);
    // Timer should not advance while suspended
    jest.advanceTimersByTime(SPEED_NORMAL * 1000 * 5);
    expect(engine.getSnapshot().topIndex).toBe(0);
  });

  it('head_up after head_down resumes auto-scroll', () => {
    const { engine } = makeEngine();
    engine.play();
    engine.next();
    engine.handleGesture('head_down'); // suspend
    engine.handleGesture('head_up');   // resume + advance
    const snap = engine.getSnapshot();
    expect(snap.timerSuspended).toBe(false);
    expect(snap.topIndex).toBe(1);
    // Timer should now be running again
    jest.advanceTimersByTime(SPEED_NORMAL * 1000);
    expect(engine.getSnapshot().topIndex).toBe(2);
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
