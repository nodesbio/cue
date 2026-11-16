/**
 * Mono-fallback: legible-mono beats garbled-stereo — at ANY offset.
 *
 * FIELD EVIDENCE (cue-logs-2026-11-16T03-58-37-901Z.txt) + operator:
 *   On a degraded link skew spent most of a session >400ms and spiked to
 *   ~8000ms; the skew CORRECTOR made it worse (re-push on a choked link grew
 *   skew +187→+1478ms). Operator verdict: "the doubling is bad at ANY offset —
 *   1 lens clean is much better than any offset." So mono-clean is the
 *   PREFERRED state, not a last resort: we enter mono fast on any perceptible
 *   skew and resume stereo only when the link proves it can hold skew
 *   imperceptibly tight.
 *
 * BEHAVIOR UNDER TEST:
 *   1. Enter mono FAST: |windowed mean| >= SKEW_MONO_THRESHOLD_MS (40ms) for
 *      SKEW_MONO_BREACH_COUNT (3) paired frames.
 *   2. Resume stereo SLOW: |mean| < SKEW_MONO_RECOVER_MS (25ms) for
 *      SKEW_MONO_RECOVER_COUNT (15) frames. Steep hysteresis = clean-mono is
 *      home base; stereo only when the link is proven clean.
 *   3. Mono-side selection, in priority order:
 *        a. preferred eye (UI toggle) IF its link is healthy (txReady+connected)
 *        b. else the single healthy lens (dead-lens override)
 *        c. else (both healthy, no preference) drop the laggard = sign of mean
 *   4. In mono, _sendBoth drives ONLY the mono side; no dual-lens barrier.
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
  // Both lenses healthy by default so selection falls through to skew-sign.
  anyCore.status.left.connected = true;  anyCore.status.left.txReady = true;
  anyCore.status.right.connected = true; anyCore.status.right.txReady = true;
  const sends: Side[] = [];
  anyCore._send = (side: Side, _data: Uint8Array, _ack?: boolean, written?: () => void) => {
    sends.push(side);
    if (written) written();
    return Promise.resolve();
  };
  return { core, anyCore, sends };
}

const TEXT = (seq: number) => Uint8Array.from([0x4e /* OP_TEXT */, seq & 0xff]);

describe('mono-fallback — clean-mono is home base', () => {
  it('enters mono FAST (3 frames @ 40ms) on sustained perceptible skew', () => {
    const { anyCore } = makeCore();
    let t = 1_000_000;
    for (let seq = 1; seq <= 5; seq++) { t += 2000; feedPair(anyCore, seq, t + 60, t); }
    // L lags (mean>0 ⇒ R leads ⇒ keep R) — no preference set.
    expect(anyCore._monoSide).toBe('R');
  });

  it('does NOT enter mono below the 40ms fusion threshold', () => {
    const { anyCore } = makeCore();
    let t = 1_000_000;
    for (let seq = 1; seq <= 20; seq++) { t += 2000; feedPair(anyCore, seq, t + 30, t); }
    expect(anyCore._monoSide).toBeNull();
  });

  it('does NOT enter mono on a single un-fusible spike', () => {
    const { anyCore } = makeCore();
    let t = 1_000_000;
    for (let seq = 1; seq <= 20; seq++) {
      t += 2000;
      feedPair(anyCore, seq, t + (seq === 10 ? 600 : 10), t);
    }
    expect(anyCore._monoSide).toBeNull();
  });

  it('STAGE RULE: stays mono for the session — never auto-resumes stereo', () => {
    // Replaces the old "resumes stereo after 15 clean frames" test. The field
    // rule changed: once dropped to mono, the engine must NOT flicker the echo
    // back on its own mid-presentation, no matter how clean the link gets.
    const { anyCore } = makeCore();
    let t = 1_000_000;
    for (let seq = 1; seq <= 6; seq++) { t += 2000; feedPair(anyCore, seq, t + 60, t); }
    expect(anyCore._monoSide).toBe('R');
    expect(anyCore._stereoLatchedOff).toBe(true); // auto-drop latches the session
    // Feed a LONG run of perfectly clean frames — far past the old 15-frame
    // recover window. Stereo must still NOT come back on its own.
    for (let seq = 7; seq <= 60; seq++) { t += 2000; feedPair(anyCore, seq, t, t); }
    expect(anyCore._monoSide).toBe('R'); // still mono — latched for the session
  });

  it('LOG REPRO: sign-flipping skew that cancels in the mean STILL trips mono', () => {
    // 2026-11-15 field log: per-frame L-R oscillated across zero
    // (+50, -24, -39, -85, +61, -72 …) so the windowed MEAN hovered ~27ms and
    // the old "mean >= 40" entry gate was BLIND to it — yet the operator saw
    // doubling because the EYE integrates each frame's |offset|, not the mean.
    // Entry now gates on per-frame skew alone, so this sustained swing trips.
    const { anyCore } = makeCore();
    let t = 1_000_000;
    const offs = [50, -60, 55, -70, 48, -65]; // |each| >= 40, mean ~ +2ms
    offs.forEach((o, i) => {
      t += 2000;
      // positive o ⇒ L acks later ⇒ L lags; negative ⇒ R lags.
      feedPair(anyCore, i + 1, o >= 0 ? t + o : t, o >= 0 ? t : t - o);
    });
    expect(anyCore._monoSide).not.toBeNull(); // the bug: previously stayed stereo
  });

  it('emergencyMono() forces a clean single lens and latches stereo off', async () => {
    const { anyCore } = makeCore();
    expect(anyCore._monoSide).toBeNull();
    await anyCore.emergencyMono();
    expect(anyCore._monoSide).not.toBeNull(); // picked a lens immediately
    expect(anyCore._stereoLatchedOff).toBe(true);
    const chosen = anyCore._monoSide;
    // Even a long clean run cannot bring stereo back after an emergency drop.
    let t = 1_000_000;
    for (let seq = 1; seq <= 60; seq++) { t += 2000; feedPair(anyCore, seq, t, t); }
    expect(anyCore._monoSide).toBe(chosen);
  });

  it('emergencyMono() drops to mono; the next _sendBoth drives kept lens + blanks laggard', async () => {
    // FIELD BUG (2026-11-16, device logs): pressing Next >> logged "EMERGENCY-MONO
    // → keeping X; stereo latched off" but BOTH lenses stayed lit. Two causes in
    // discovery order: (1) the blank was issued lazily in _sendBoth, gated on the
    // NEXT OP_TEXT — never fired during a pause; (2) a hand-rolled raw _send(drop,
    // blank) in emergencyMono() bypassed the firmware R-first ESB sync, so the ESB
    // slave rejected the lone frame and when keeping R both lenses stayed on.
    // FIX: emergencyMono() sets only the DECISION; the caller re-pushes the current
    // frame through _sendBoth's proven mono branch. This test models that re-push.
    const { anyCore } = makeCore();
    await anyCore.emergencyMono();
    const keep: Side = anyCore._monoSide;
    const drop: Side = keep === 'L' ? 'R' : 'L';
    expect(keep).not.toBeNull();
    const driven: Side[] = [];
    anyCore._send = (side: Side, _d: Uint8Array, _a?: boolean, w?: () => void) => {
      driven.push(side); if (w) w(); return Promise.resolve();
    };
    await anyCore._sendBoth(TEXT(42)); // caller's re-push
    expect(driven).toContain(keep); // kept lens driven with real text
    expect(driven).toContain(drop); // laggard blanked once
    expect(anyCore._monoBlanked[drop]).toBe(true);
    expect(anyCore._monoBlanked[keep]).toBe(true);
  });

  it('isMono reflects drop state — the seam the UI gates the Next key on', async () => {
    // The Next (single_tap) key is dual-purpose: first press drops to mono, every
    // press after advances a line. index.tsx gates that on core.isMono, so this
    // getter must flip exactly with _monoSide.
    const { anyCore, core } = makeCore();
    expect(core.isMono).toBe(false);
    await anyCore.emergencyMono();
    expect(core.isMono).toBe(true);
    anyCore.resetLensSession();
    expect(core.isMono).toBe(false); // deliberate re-enable clears it
  });

  it('mono branch blanks the drop lens only ONCE across repeated frames', async () => {
    const { anyCore } = makeCore();
    await anyCore.emergencyMono();
    const keep: Side = anyCore._monoSide;
    const drop: Side = keep === 'L' ? 'R' : 'L';
    const driven: Side[] = [];
    anyCore._send = (side: Side, _d: Uint8Array, _a?: boolean, w?: () => void) => {
      driven.push(side); if (w) w(); return Promise.resolve();
    };
    await anyCore._sendBoth(TEXT(1));
    await anyCore._sendBoth(TEXT(2));
    await anyCore._sendBoth(TEXT(3));
    expect(driven.filter((s) => s === drop).length).toBe(1); // blanked once
    expect(driven.filter((s) => s === keep).length).toBe(3); // driven every frame
  });

  it('emergencyMono() is idempotent — repeat press keeps the same lens', async () => {
    const { anyCore } = makeCore();
    await anyCore.emergencyMono();
    const first = anyCore._monoSide;
    await anyCore.emergencyMono();
    expect(anyCore._monoSide).toBe(first); // no flip, no re-pick
  });

  it('resetLensSession() re-enables stereo (deliberate pre-show action only)', () => {
    const { anyCore } = makeCore();
    anyCore.emergencyMono();
    expect(anyCore._stereoLatchedOff).toBe(true);
    anyCore.resetLensSession();
    expect(anyCore._stereoLatchedOff).toBe(false);
    expect(anyCore._monoSide).toBeNull(); // back to stereo home base
  });

  it('keeps the PREFERRED eye when both links are healthy, ignoring skew sign', () => {
    const { anyCore } = makeCore();
    anyCore.setPreferredEye('L'); // operator prefers reading with left
    let t = 1_000_000;
    // Skew sign says keep R (L lags), but preference + healthy L wins → keep L.
    for (let seq = 1; seq <= 6; seq++) { t += 2000; feedPair(anyCore, seq, t + 60, t); }
    expect(anyCore._monoSide).toBe('L');
  });

  it('OVERRIDES preference to the healthy lens when the preferred lens is dead', () => {
    const { anyCore } = makeCore();
    anyCore.setPreferredEye('L');
    anyCore.status.left.txReady = false; // preferred lens link is dead
    let t = 1_000_000;
    for (let seq = 1; seq <= 6; seq++) { t += 2000; feedPair(anyCore, seq, t + 60, t); }
    expect(anyCore._monoSide).toBe('R'); // forced to the only healthy lens
  });

  it("Auto preference (null) falls through to skew-sign selection", () => {
    const { anyCore } = makeCore();
    anyCore.setPreferredEye(null); // Auto
    let t = 1_000_000;
    for (let seq = 1; seq <= 6; seq++) { t += 2000; feedPair(anyCore, seq, t, t + 60); } // R lags
    expect(anyCore._monoSide).toBe('L'); // keep the leader
  });

  it('in mono mode drives ONLY the mono side, not the dual-lens barrier', async () => {
    const { anyCore, sends } = makeCore();
    anyCore._monoSide = 'R';
    anyCore._monoBlanked = { L: true, R: true };
    sends.length = 0;
    await anyCore._sendBoth(TEXT(1));
    expect(sends.filter((s) => s === 'R')).toHaveLength(1);
    expect(sends.filter((s) => s === 'L')).toHaveLength(0);
  });
});
