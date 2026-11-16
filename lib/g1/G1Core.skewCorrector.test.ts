/**
 * Regression test for unbounded L/R lens skew under asymmetric ACK latency.
 *
 * FIELD EVIDENCE (cue-logs-2026-11-15T19-16-51-339Z.txt):
 *   Both lenses' ACK latency climbs over a run (iOS background radio
 *   throttling), but NOT equally. L and R diverge past the fusion limit.
 *   NOTE: the original read of this log called the drift monotonic/hysteretic
 *   ("ratchets, never recovers"). Later captures (19-37, 03-58) corrected that:
 *   instantaneous skew OSCILLATES (-9ms↔-320ms+) and recovers between spikes on
 *   a healthy-but-throttled link. The corrector is for that case — catch a
 *   SUSTAINED excursion and re-anchor. On a DEGRADED link (03-58: NACK storm,
 *   disconnects) re-push instead makes skew grow, which is why mono-fallback
 *   (G1Core.monoFallback.test.ts) escalates past the corrector. Pacing the send
 *   rate (b99f94f) did nothing: frames aren't too fast, ACKs come back too slow.
 *
 * THE FIX UNDER TEST: a closed-loop corrector. When instantaneous |skew|
 * exceeds SKEW_RESYNC_THRESHOLD_MS for SKEW_RESYNC_BREACH_COUNT consecutive
 * paired frames, the core must invoke a resync callback (the same re-anchor
 * the manual PLAY-BUTTON path triggers) and reset its breach counter. This is
 * drift CORRECTION, not prevention — we can't stop iOS throttling the radio,
 * but we can detect the resulting divergence and re-sync both lenses.
 *
 * This test drives _recordTextAckSeq directly with the real field ACK-time
 * profile; no BLE, no timers.
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

/**
 * Feed one paired frame into the skew path: L acked at lAckAt, R at rAckAt
 * (absolute ms). writeMs/ackLatMs are telemetry-only for the log line; the
 * corrector keys off the ack-arrival skew = lAckAt - rAckAt.
 */
function feedPair(anyCore: any, seq: number, lAckAt: number, rAckAt: number): void {
  // Order within a pair doesn't matter — the skew is computed when the second
  // side of the pair arrives. Feed L then R.
  anyCore._recordTextAckSeq('L' as Side, seq, lAckAt, 20, 900);
  anyCore._recordTextAckSeq('R' as Side, seq, rAckAt, 20, 900);
}

function makeCore() {
  const core = new G1Core({});
  const anyCore = core as any;
  anyCore._log = () => {}; // silence telemetry noise
  return { core, anyCore };
}

describe('skew corrector — hysteretic divergence under asymmetric ACK latency', () => {
  it('fires a resync when instantaneous |skew| stays over threshold for N frames', () => {
    const { anyCore } = makeCore();
    const resyncs: number[] = []; // seq at which each resync fired
    anyCore.setSkewResyncHandler((seq: number) => resyncs.push(seq));

    // Field profile: start synced, then R's ACK time pulls progressively ahead
    // of L's (R leads by a growing margin) — the seq 16→104 signature.
    let t = 1_000_000;
    // seq 1-5: in sync (|skew| small) — no resync should fire.
    for (let seq = 1; seq <= 5; seq++) {
      t += 2000;
      feedPair(anyCore, seq, t, t + 20); // +20ms, under threshold
    }
    expect(resyncs).toHaveLength(0);

    // seq 6-12: sustained divergence, R leads by 250ms every frame.
    for (let seq = 6; seq <= 12; seq++) {
      t += 2000;
      feedPair(anyCore, seq, t + 250, t); // L acks 250ms after R ⇒ skew=+250
    }

    // With threshold=150ms and breach count=3, the corrector must have fired
    // at least once during the sustained-divergence window.
    expect(resyncs.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT fire on transient one-frame spikes', () => {
    const { anyCore } = makeCore();
    const resyncs: number[] = [];
    anyCore.setSkewResyncHandler((seq: number) => resyncs.push(seq));

    let t = 1_000_000;
    for (let seq = 1; seq <= 20; seq++) {
      t += 2000;
      // One isolated 300ms spike at seq 10; everything else well under threshold.
      const skew = seq === 10 ? 300 : 15;
      feedPair(anyCore, seq, t + skew, t);
    }
    expect(resyncs).toHaveLength(0);
  });

  it('resets the breach counter after a resync so it can re-arm', () => {
    const { anyCore } = makeCore();
    const resyncs: number[] = [];
    anyCore.setSkewResyncHandler((seq: number) => resyncs.push(seq));

    let t = 1_000_000;
    // 12 straight frames of hard divergence should trigger MORE than one resync
    // (one per breach-count window), proving the counter re-arms rather than
    // firing once and latching.
    for (let seq = 1; seq <= 12; seq++) {
      t += 2000;
      feedPair(anyCore, seq, t + 250, t);
    }
    expect(resyncs.length).toBeGreaterThanOrEqual(2);
  });
});
