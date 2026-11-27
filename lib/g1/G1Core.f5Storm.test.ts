/**
 * F5 00 ('exit_to_dashboard') storm detector.
 *
 * A burst of F5 00 is the firmware rejecting the current screen: the lens
 * ACKs text but renders nothing (2026-11-27 field log: both lenses dark ~5 min
 * after a mid-scroll eye swap, self-recovered). Individual event lines were
 * easy to miss; the detector turns a burst into one always-on warning with
 * sync context, and logs when it ends so recovery time is measurable.
 *
 * Invariants:
 *  1. ≥2 distinct F5 00 on one lens within 5s → one storm warning for it.
 *     Events <600ms apart are one event (firmware sends each as a ~450ms pair).
 *  2. A single (paired) event, or events spread over >5s, → no warning.
 *  3. 10s with no F5 00 → one "ended" line with the event count.
 *  4. A later burst after the end warns again; lenses are tracked separately.
 *  5. F5 00 still reaches event handlers (no behaviour change).
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

import { G1Core, type Side } from './G1Core';

function makeCore() {
  const lines: string[] = [];
  const events: string[] = [];
  const core = new G1Core({ onLog: (l) => lines.push(l), onEvent: (e: any) => events.push(e.name) });
  const anyCore = core as any;
  const f5 = (side: Side) =>
    anyCore._onNotify(side, null, { value: Buffer.from([0xf5, 0x00]).toString('base64') });
  const storms = (side?: Side) =>
    lines.filter(l => l.includes('F5 00 storm') && !l.includes('ended') && (!side || l.includes(`[${side}]`)));
  const ends = (side?: Side) =>
    lines.filter(l => l.includes('F5 00 storm') && l.includes('ended') && (!side || l.includes(`[${side}]`)));
  return { anyCore, lines, events, f5, storms, ends };
}

// One firmware F5 00 event = a pair ~450ms apart (field logs).
const PAIR_MS = 450;

describe('G1Core F5 00 storm detector', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  const pair = (f5: (s: Side) => void, side: Side) => {
    f5(side); jest.advanceTimersByTime(PAIR_MS); f5(side);
  };

  it('warns once when 2 distinct F5 00 land on one lens within 5s', () => {
    const { f5, storms, anyCore } = makeCore();
    anyCore._monoSide = 'L';
    pair(f5, 'L'); jest.advanceTimersByTime(2_000);
    pair(f5, 'L'); jest.advanceTimersByTime(1_000);
    pair(f5, 'L');
    expect(storms('L')).toHaveLength(1);
    expect(storms('L')[0]).toContain('⚠️');
    expect(storms('L')[0]).toContain('mono reader=L');
  });

  it('does not warn for a single paired event (the firmware double-send)', () => {
    const { f5, storms } = makeCore();
    pair(f5, 'R');
    expect(storms()).toHaveLength(0);
  });

  it('does not warn for distinct events more than 5s apart', () => {
    const { f5, storms } = makeCore();
    pair(f5, 'R'); jest.advanceTimersByTime(6_000);
    pair(f5, 'R');
    expect(storms()).toHaveLength(0);
  });

  it('replays the 2026-11-27 blackout: flags both lenses', () => {
    const { f5, storms } = makeCore();
    // 21:09:33.203 L, .241 R, .690 R, 35.811 L, .865 R, 36.314 R
    const seq: [number, Side][] = [[0,'L'],[38,'R'],[487,'R'],[2608,'L'],[2662,'R'],[3111,'R']];
    let t = 0;
    for (const [at, side] of seq) { jest.advanceTimersByTime(at - t); t = at; f5(side); }
    expect(storms('L')).toHaveLength(1);
    expect(storms('R')).toHaveLength(1);
  });

  it('logs the end after 10s quiet, counting distinct events', () => {
    const { f5, ends } = makeCore();
    pair(f5, 'L'); jest.advanceTimersByTime(1_000);
    pair(f5, 'L'); jest.advanceTimersByTime(2_000);
    pair(f5, 'L');
    jest.advanceTimersByTime(9_999);
    expect(ends()).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(ends('L')).toHaveLength(1);
    expect(ends('L')[0]).toContain('3 events over 4s');
  });

  it('warns again for a later burst, and tracks lenses separately', () => {
    const { f5, storms } = makeCore();
    pair(f5, 'L'); jest.advanceTimersByTime(1_000); pair(f5, 'L');
    jest.advanceTimersByTime(15_000);
    pair(f5, 'L'); jest.advanceTimersByTime(1_000); pair(f5, 'L');
    pair(f5, 'R'); jest.advanceTimersByTime(1_000); pair(f5, 'R');
    expect(storms('L')).toHaveLength(2);
    expect(storms('R')).toHaveLength(1);
  });

  it('still delivers every F5 00 to event handlers', () => {
    const { f5, events } = makeCore();
    pair(f5, 'L'); pair(f5, 'L');
    expect(events.filter(n => n === 'exit_to_dashboard')).toHaveLength(4);
  });
});
