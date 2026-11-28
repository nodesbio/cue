/**
 * Auto single-lens is OFF by default (2026-11-28, AUTO_MONO_DEFAULT).
 *
 * Field: every lock / notification pull latched one lens dark for the whole
 * session (2026-11-28 Sports log: 5 latches, L blank each time). The operator
 * has not seen visible doubling in a while.
 *
 * Invariants:
 *  1. Default OFF, from the single exported AUTO_MONO_DEFAULT.
 *  2. OFF: app leaving 'active' keeps both lenses live (no mono, no latch).
 *  3. OFF: a sustained skew breach and an ACK-MISS streak keep stereo, and log
 *     what they would have done (throttled to once per 30s).
 *  4. ON: app leaving 'active' still drops to mono (old path intact).
 *  5. The manual emergency key still drops to mono with auto OFF.
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

import { G1Core, AUTO_MONO_DEFAULT } from './G1Core';

function makeCore() {
  const lines: string[] = [];
  const core = new G1Core({ onLog: (l) => lines.push(l) });
  const anyCore = core as any;
  anyCore.status.left.connected = true;  anyCore.status.left.txReady = true;
  anyCore.status.right.connected = true; anyCore.status.right.txReady = true;
  return { core, anyCore, lines };
}

const suppressed = (lines: string[]) => lines.filter(l => l.includes('auto single-lens OFF — staying stereo'));

describe('auto single-lens default OFF', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('is OFF by default via the single exported AUTO_MONO_DEFAULT', () => {
    const { anyCore } = makeCore();
    expect(AUTO_MONO_DEFAULT).toBe(false);
    expect(anyCore._autoMono).toBe(AUTO_MONO_DEFAULT);
  });

  it('OFF: the automatic trip keeps stereo and does not latch', () => {
    const { anyCore, lines } = makeCore();
    anyCore._autoTripMono('R', 'app left active (inactive)');
    expect(anyCore._monoSide).toBeNull();
    expect(anyCore._stereoLatchedOff).toBe(false);
    expect(suppressed(lines)).toHaveLength(1);
    expect(suppressed(lines)[0]).toContain('would have dropped to R');
  });

  it('OFF: suppressed-trip log is throttled to once per 30s', () => {
    const { anyCore, lines } = makeCore();
    anyCore._autoTripMono('R', 'skew seq=1');
    anyCore._autoTripMono('R', 'skew seq=2');
    jest.advanceTimersByTime(29_999);
    anyCore._autoTripMono('R', 'skew seq=3');
    expect(suppressed(lines)).toHaveLength(1);
    jest.advanceTimersByTime(1);
    anyCore._autoTripMono('L', 'ack-miss x3 side=R');
    expect(suppressed(lines)).toHaveLength(2);
    expect(anyCore._monoSide).toBeNull();
  });

  it('ON: the automatic trip drops to mono (old path intact)', () => {
    const { core, anyCore } = makeCore();
    core.setAutoMono(true);
    anyCore._autoTripMono('R', 'app left active (inactive)');
    expect(anyCore._monoSide).toBe('R');
    expect(anyCore._stereoLatchedOff).toBe(true);
  });

  it('every automatic trigger site goes through the auto gate', () => {
    // Structural guard: a new direct _tripMono call on an automatic path would
    // silently bypass the flag. Only the manual emergency key may call it.
    const src = require('fs').readFileSync(require('path').join(__dirname, 'G1Core.ts'), 'utf8') as string;
    const direct = src.split('\n').filter((l: string) => /this\._tripMono\(/.test(l));
    expect(direct).toHaveLength(2); // emergency key + the gate itself
    expect(direct.some((l: string) => l.includes("'emergency key'"))).toBe(true);
  });
});
