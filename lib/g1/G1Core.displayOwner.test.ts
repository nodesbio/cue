/**
 * Display-owner arbiter: exactly one top-level mode may push to the lens at a
 * time. Regression guard for the 2026-11-20 "teleprompter vs sports HUD
 * toggling" bug — two producers were stomping the shared _textGen.
 *
 * We exercise the arbiter logic directly against the drop rule rather than
 * spinning up a full BLE core (no device in CI). The rule under test:
 *   - unclaimed            → every call passes
 *   - claimed by X         → X passes, Y (named) is dropped, untagged passes
 *   - release by non-holder → no-op
 */

// Minimal reimplementation mirror of G1Core's decision, kept in lockstep with
// the production guard in sendText(). If the production rule changes, this file
// must change with it — that coupling is intentional (the test IS the spec).
function shouldSend(holder: string | null, owner: string | undefined): boolean {
  if (owner !== undefined && holder !== null && holder !== owner) return false;
  return true;
}

describe('display-owner arbiter rule', () => {
  it('passes everything when unclaimed', () => {
    expect(shouldSend(null, undefined)).toBe(true);
    expect(shouldSend(null, 'sports')).toBe(true);
    expect(shouldSend(null, 'teleprompter')).toBe(true);
  });

  it('drops a named non-holder while someone holds the display', () => {
    expect(shouldSend('teleprompter', 'sports')).toBe(false);
    expect(shouldSend('sports', 'teleprompter')).toBe(false);
  });

  it('passes the current holder', () => {
    expect(shouldSend('sports', 'sports')).toBe(true);
  });

  it('always passes untagged internal calls even when held', () => {
    // teleprompter resync/foreground re-pushes are untagged and must survive
    expect(shouldSend('sports', undefined)).toBe(true);
    expect(shouldSend('teleprompter', undefined)).toBe(true);
  });
});

// Also verify the real claim/release state machine on a lightly-stubbed core.
// BLE + react-native are mocked at the module boundary (same pattern as the
// other G1Core tests — no device in CI).
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('react-native-ble-plx', () => ({
  BleManager: jest.fn().mockImplementation(() => ({
    onStateChange: jest.fn(),
    stopDeviceScan: jest.fn(),
    destroy: jest.fn(),
  })),
  State: {},
  BleErrorCode: { DeviceDisconnected: 201, OperationCancelled: 2 },
}));

import { G1Core } from './G1Core';

describe('G1Core claim/release', () => {
  function makeCore(): G1Core {
    // G1Core constructor touches BLE manager lazily; instantiate and only poke
    // the arbiter methods, which are pure field mutations.
    return new G1Core();
  }

  it('claim sets owner, release by holder clears it', () => {
    const c = makeCore();
    expect(c.displayOwner).toBeNull();
    c.claimDisplay('sports');
    expect(c.displayOwner).toBe('sports');
    c.releaseDisplay('sports');
    expect(c.displayOwner).toBeNull();
  });

  it('release by a non-holder is a no-op', () => {
    const c = makeCore();
    c.claimDisplay('teleprompter');
    c.releaseDisplay('sports'); // sports never held it
    expect(c.displayOwner).toBe('teleprompter');
  });

  it('last claimer wins the handoff', () => {
    const c = makeCore();
    c.claimDisplay('teleprompter');
    c.claimDisplay('sports');
    expect(c.displayOwner).toBe('sports');
  });
});
