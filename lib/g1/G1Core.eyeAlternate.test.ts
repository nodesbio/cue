/**
 * Reading-eye auto-alternation (eye-health rotation).
 *
 * The killer comfort feature: in mono (single-lens) mode, rotate which eye
 * shows content on a cadence so one eye isn't loaded for a whole session.
 * OFF by default since 2026-11-27 (mid-scroll swap → blackout) — see EYE_ALT_DEFAULT.
 *
 * BEHAVIOR UNDER TEST:
 *   1. Default: _eyeAlternateEnabled follows EYE_ALT_DEFAULT (OFF).
 *   2. setEyeAlternation(true) arms an interval; (false) clears it.
 *   3. A tick swaps _monoSide L↔R and fires the HUD re-push handler so the new
 *      reading eye lights immediately.
 *   4. GUARD: a tick is a no-op outside mono (_monoSide === null), and a no-op
 *      if either lens is unhealthy (never move the reader onto a dead lens).
 *   5. setEyeAlternationMinutes changes the cadence and restarts a live timer.
 *
 * Drives setEyeAlternation / _tryAlternateEye directly with fake timers;
 * no BLE, no real intervals.
 */

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('react-native-ble-plx', () => ({
  BleManager: jest.fn().mockImplementation(() => ({
    onStateChange: jest.fn(),
    stopDeviceScan: jest.fn(),
    destroy: jest.fn(),
  })),
  State: {},
  BleErrorCode: { DeviceDisconnected: 201, OperationCancelled: 2 },
}));
jest.mock('base-64', () => ({
  encode: (s: string) => Buffer.from(s, 'binary').toString('base64'),
  decode: (s: string) => Buffer.from(s, 'base64').toString('binary'),
}));

import { G1Core, EYE_ALT_DEFAULT, type Side } from './G1Core';

function makeCore() {
  const core = new G1Core({});
  const anyCore = core as any;
  anyCore._log = () => {};
  anyCore._trace = () => {};
  anyCore._warn = () => {};
  // Both lenses healthy by default so the swap guard passes.
  anyCore.status.left.connected = true;  anyCore.status.left.txReady = true;
  anyCore.status.right.connected = true; anyCore.status.right.txReady = true;
  return { core, anyCore };
}

afterEach(() => jest.useRealTimers());

describe('eye-alternation — eye-health rotation', () => {
  it('is OFF by default, via the single exported EYE_ALT_DEFAULT', () => {
    const { anyCore } = makeCore();
    expect(EYE_ALT_DEFAULT).toBe(false);
    expect(anyCore._eyeAlternateEnabled).toBe(EYE_ALT_DEFAULT);
  });

  it('arms a timer on setEyeAlternation(true) and clears it on (false)', () => {
    jest.useFakeTimers();
    const { core, anyCore } = makeCore();
    core.setEyeAlternation(true);
    expect(anyCore._eyeAlternateTimer).not.toBeNull();
    core.setEyeAlternation(false);
    expect(anyCore._eyeAlternateTimer).toBeNull();
  });

  it('swaps the reading eye on tick and fires the re-push handler', () => {
    jest.useFakeTimers();
    const { core, anyCore } = makeCore();
    const swaps: Side[] = [];
    core.setReadingEyeSwapHandler((side) => swaps.push(side));
    anyCore._monoSide = 'L';
    core.setEyeAlternation(true);

    jest.advanceTimersByTime(5 * 60_000); // one cadence
    expect(anyCore._monoSide).toBe('R');
    expect(swaps).toEqual(['R']);

    jest.advanceTimersByTime(5 * 60_000); // and back
    expect(anyCore._monoSide).toBe('L');
    expect(swaps).toEqual(['R', 'L']);
  });

  it('GUARD: no swap when not in mono (_monoSide null)', () => {
    jest.useFakeTimers();
    const { core, anyCore } = makeCore();
    const swaps: Side[] = [];
    core.setReadingEyeSwapHandler((side) => swaps.push(side));
    anyCore._monoSide = null; // stereo
    core.setEyeAlternation(true);
    jest.advanceTimersByTime(5 * 60_000);
    expect(anyCore._monoSide).toBeNull();
    expect(swaps).toEqual([]);
  });

  it('GUARD: no swap when a lens is unhealthy (never move reader onto a dead lens)', () => {
    jest.useFakeTimers();
    const { core, anyCore } = makeCore();
    const swaps: Side[] = [];
    core.setReadingEyeSwapHandler((side) => swaps.push(side));
    anyCore._monoSide = 'L';
    anyCore.status.right.txReady = false; // R not writable
    core.setEyeAlternation(true);
    jest.advanceTimersByTime(5 * 60_000);
    expect(anyCore._monoSide).toBe('L'); // held — would have landed on a bad lens
    expect(swaps).toEqual([]);
  });

  it('setEyeAlternationMinutes changes cadence and restarts a live timer', () => {
    jest.useFakeTimers();
    const { core, anyCore } = makeCore();
    const swaps: Side[] = [];
    core.setReadingEyeSwapHandler((side) => swaps.push(side));
    anyCore._monoSide = 'L';
    core.setEyeAlternation(true);
    core.setEyeAlternationMinutes(1); // 1-min cadence

    jest.advanceTimersByTime(60_000);
    expect(swaps).toEqual(['R']); // fired at the new, faster cadence
  });
});
