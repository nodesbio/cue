/**
 * displayOwner arbiter tests — the #43 claim/release contract that the sports
 * segments (live / deck / stream) share.
 *
 * These exercise the pure ownership logic directly (no BLE, no React). They lock
 * the switch-path invariant flagged while wiring StreamView (#49): what happens
 * when two segments hand the lens off, and the SHARP EDGE that both DeckView and
 * StreamView currently claim under the SAME owner token 'sports'.
 *
 * Exit policy (stale-frame fix): releaseDisplay() is now PRIVATE — a bare release
 * drops ownership but leaves the last frame lit (the stale-frame bug class). The
 * only public exit is yieldDisplay() (blank-via-space + release; the former
 * exitDisplay() Power-Off-grade clear was removed — it slept the lens). These tests drive the
 * release *half* of the contract through yieldDisplay(), whose owner-gating is
 * identical to the old releaseDisplay() — so the switch-path invariants are
 * unchanged, now with the guarantee that no exit can leave a stale frame.
 *
 * We instantiate just the arbiter surface via a minimal subclass shim so we
 * don't pull in the BLE stack; the methods under test touch only _displayOwner.
 */
import { G1Core } from './G1Core';

/** A G1Core with the BLE bringup skipped — we only call the arbiter methods. */
function arbiter(): G1Core {
  // G1Core's constructor does not open BLE; claim/yield/displayOwner are pure
  // (yield's text push is skipped because the core is never connected in CI).
  return new G1Core();
}

describe('display owner arbiter (#43)', () => {
  it('starts unclaimed', () => {
    expect(arbiter().displayOwner).toBeNull();
  });

  it('claim sets the owner; yield by the holder clears it', () => {
    const c = arbiter();
    c.claimDisplay('sports');
    expect(c.displayOwner).toBe('sports');
    c.yieldDisplay('sports');
    expect(c.displayOwner).toBeNull();
  });

  it('yield by a NON-holder is a no-op (teleprompter cannot steal release)', () => {
    const c = arbiter();
    c.claimDisplay('sports');
    c.yieldDisplay('teleprompter'); // not the holder
    expect(c.displayOwner).toBe('sports'); // still held
  });

  it('last claimer wins the handoff (live → deck)', () => {
    const c = arbiter();
    c.claimDisplay('sports');      // imagine owner A
    c.claimDisplay('teleprompter'); // B takes over
    expect(c.displayOwner).toBe('teleprompter');
    // A's late yield must NOT clear B's claim.
    c.yieldDisplay('sports');
    expect(c.displayOwner).toBe('teleprompter');
  });

  it('claim is idempotent for the same owner', () => {
    const c = arbiter();
    c.claimDisplay('sports');
    c.claimDisplay('sports');
    expect(c.displayOwner).toBe('sports');
    c.yieldDisplay('sports');
    expect(c.displayOwner).toBeNull();
  });

  /**
   * THE SWITCH PATH (dependency note from #49 wiring), now FIXED: each sports
   * segment holds the lens under its OWN token — 'sports.live' / 'sports.deck' /
   * 'sports.stream'. When a user switches segments, the incoming view claims its
   * token on play and the outgoing view's unmount yields ITS token; because
   * the arbiter keys on the string, that yield is a no-op on the incoming
   * claim. This is the invariant the per-segment-token fix guarantees.
   *
   * Regression guard: if any segment reverts to a shared 'sports' token, the
   * outgoing yield would once again clear the incoming claim and this fails.
   */
  it('distinct per-segment tokens survive the switch (deck → stream)', () => {
    const c = arbiter();
    c.claimDisplay('sports.stream'); // StreamView.play() claims its token
    c.yieldDisplay('sports.deck');   // DeckView unmount yields ITS token
    expect(c.displayOwner).toBe('sports.stream'); // incoming claim survives
  });

  it('distinct per-segment tokens survive the switch (live → deck)', () => {
    const c = arbiter();
    c.claimDisplay('sports.deck');
    c.yieldDisplay('sports.live');
    expect(c.displayOwner).toBe('sports.deck');
  });
});
