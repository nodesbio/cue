/**
 * Mono-fallback: legible-mono beats garbled-stereo.
 *
 * FIELD EVIDENCE (cue-logs-2026-11-16T03-58-37-901Z.txt):
 *   On a DEGRADED link (205 NACK, 87 ACK-timeouts all at the 2000ms max, 7
 *   disconnects, L lens dropped for ~22s) instantaneous skew spent most of the
 *   session >400ms and spiked to ~8000ms (L showing text 8s behind R). The
 *   operator's report: "barely usable... I have to close one eye physically to
 *   read one of the two lenses." The two eyes cannot fuse a >~200ms text
 *   offset, so a skewed STEREO image is unreadable — worse than one clean MONO
 *   image.
 *
 *   The skew CORRECTOR made it worse here: the frame after each AUTO-RESYNC
 *   showed skew GROWING (+187→+609→+1478ms), because re-pushing adds frames to
 *   an already-choked link. The corrector's precondition (healthy link, minor
 *   recoverable skew) was not met.
 *
 * BEHAVIOR UNDER TEST:
 *   1. When skew is sustained BEYOND what re-push can fix (|windowed mean| over
 *      SKEW_MONO_THRESHOLD_MS for SKEW_MONO_BREACH_COUNT paired frames), the
 *      core enters MONO mode: it blanks the LAGGARD lens and drives text to the
 *      HEALTHIER lens only. Laggard = the side whose ACKs arrive later =
 *      sign of the windowed skew mean (mean>0 ⇒ L lags ⇒ keep R).
 *   2. In mono mode _sendBoth drives ONLY the mono side (via the existing
 *      single-lens _send path) and does NOT run the dual-lens R-first barrier.
 *   3. When the link recovers (|skew| back under threshold for a sustained
 *      window), mono mode clears and both lenses resume.
 *
 * Drives _recordTextAckSeq + _sendBoth directly; no BLE, no timers.
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

function feedPair(anyCore: any, seq: number, lAckAt: number, rAckAt: number): void {
  anyCore._recordTextAckSeq('L' as Side, seq, lAckAt, 20, 900);
  anyCore._recordTextAckSeq('R' as Side, seq, rAckAt, 20, 900);
}

function makeCore() {
  const core = new G1Core({});
  const anyCore = core as any;
  anyCore._log = () => {};
  anyCore._trace = () => {};
  anyCore._warn = () => {};
  // Stub the per-lens send so _sendBoth can be exercised without BLE. Records
  // which side each frame went to and resolves the R-written barrier promise.
  const sends: Side[] = [];
  anyCore._send = (side: Side, _data: Uint8Array, _ack?: boolean, written?: () => void) => {
    sends.push(side);
    if (written) written();
    return Promise.resolve();
  };
  return { core, anyCore, sends };
}

const TEXT = (anyCore: any, seq: number) =>
  // minimal OP_TEXT frame: [OP_TEXT, seq, ...]; _sendBoth only reads [0] and [1]
  Uint8Array.from([0x4e /* OP_TEXT */, seq & 0xff]);

describe('mono-fallback — legible-mono beats garbled-stereo', () => {
  it('enters mono on the HEALTHIER lens after sustained un-fusible skew', () => {
    const { anyCore } = makeCore();
    let t = 1_000_000;
    // Sustained R-leads divergence: L acks 500ms after R every frame ⇒ L is the
    // laggard. Well past any fusible threshold.
    for (let seq = 1; seq <= 12; seq++) {
      t += 2000;
      feedPair(anyCore, seq, t + 500, t);
    }
    // Keep R (healthy), blank L (laggard).
    expect(anyCore._monoSide).toBe('R');
  });

  it('in mono mode drives ONLY the mono side, not the dual-lens barrier', async () => {
    const { anyCore, sends } = makeCore();
    anyCore._monoSide = 'R';          // forced mono on R
    anyCore._monoBlanked = { L: true, R: true }; // pretend blank already issued
    sends.length = 0;
    await anyCore._sendBoth(TEXT(anyCore, 1));
    // Exactly one real text frame, to R only. No L frame (would be the laggard).
    expect(sends.filter((s) => s === 'R')).toHaveLength(1);
    expect(sends.filter((s) => s === 'L')).toHaveLength(0);
  });

  it('clears mono mode when skew recovers for a sustained window', () => {
    const { anyCore } = makeCore();
    let t = 1_000_000;
    for (let seq = 1; seq <= 12; seq++) { t += 2000; feedPair(anyCore, seq, t + 500, t); }
    expect(anyCore._monoSide).toBe('R'); // entered mono

    // Link recovers: skew back to ~10ms for a full window.
    for (let seq = 13; seq <= 40; seq++) { t += 2000; feedPair(anyCore, seq, t + 10, t); }
    expect(anyCore._monoSide).toBeNull(); // resumed stereo
  });

  it('does NOT enter mono on a transient un-fusible spike', () => {
    const { anyCore } = makeCore();
    let t = 1_000_000;
    for (let seq = 1; seq <= 20; seq++) {
      t += 2000;
      const skew = seq === 10 ? 600 : 12; // one isolated spike
      feedPair(anyCore, seq, t + skew, t);
    }
    expect(anyCore._monoSide).toBeNull();
  });
});
