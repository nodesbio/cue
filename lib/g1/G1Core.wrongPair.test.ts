/**
 * Regression test for the 2026-11-04 "connected but HUD dark" log.
 *
 * Two G1 pairs were in range (G1_30 and G1_5 / serial H290028). The core ended
 * up holding G1_30_R + G1_5_L — one lens from each pair. Status said connected,
 * every 0x4e text timed out. When the reconnect scan found the REAL R, the
 * "RX subscription already live" guard in _connectLensInner saw "an R is up"
 * and skipped, so the stranger was held forever.
 *
 * Invariant pinned here: a connect request for peripheral X on side S, while
 * side S holds a different peripheral Y, must evict Y and proceed to X.
 */

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

import { G1Core } from './G1Core';

function makeDevice(id: string, name: string) {
  return {
    id,
    name,
    cancelConnection: jest.fn(async () => undefined),
    // connect() rejects so _connectLensInner stops right after the eviction
    // step — we only care about what happens BEFORE the real connect.
    connect: jest.fn(async () => { throw new Error('stop-here'); }),
  };
}

describe('G1Core wrong-pair eviction', () => {
  const stranger = makeDevice('FE3F0552-STRANGER', 'Even G1_30_R_2AF297');
  const real     = makeDevice('F74C0B3D-REAL',     'Even G1_5_R_000001');

  function makeCoreHoldingStranger() {
    const core = new G1Core({ onStatusChange: () => {} });
    const anyCore = core as any;
    const rxSub = { remove: jest.fn() };
    anyCore.devices = { R: stranger };
    anyCore.txChars = { R: {} };
    anyCore.rxSubs  = { R: rxSub };
    anyCore.status.right.connected = true;
    anyCore.status.right.txReady = true;
    return { anyCore, rxSub };
  }

  beforeEach(() => jest.clearAllMocks());

  it('_connectLensInner evicts the held stranger and proceeds to connect the target', async () => {
    const { anyCore, rxSub } = makeCoreHoldingStranger();

    // G1Core wraps connect() errors in a user-facing message; we only need it to reject.
    await expect(anyCore._connectLensInner('R', real)).rejects.toThrow(/R lens connection failed/);

    expect(rxSub.remove).toHaveBeenCalledTimes(1);
    expect(stranger.cancelConnection).toHaveBeenCalledTimes(1);
    expect(anyCore.status.right.txReady).toBe(false);
    expect(anyCore.status.right.connected).toBe(false);
    expect(real.connect).toHaveBeenCalledTimes(1); // did NOT skip
  });

  it('_connectLensInner still skips when the held lens IS the target', async () => {
    const { anyCore, rxSub } = makeCoreHoldingStranger();

    await anyCore._connectLensInner('R', stranger);

    expect(rxSub.remove).not.toHaveBeenCalled();
    expect(stranger.cancelConnection).not.toHaveBeenCalled();
    expect(stranger.connect).not.toHaveBeenCalled();
    expect(anyCore.status.right.txReady).toBe(true);
  });

  it('_enqueueConnect does not treat a held stranger as "already connected"', () => {
    const { anyCore } = makeCoreHoldingStranger();
    const runOnQueue = jest.spyOn(anyCore, '_runOnQueue').mockImplementation(() => Promise.resolve());

    anyCore._enqueueConnect('R', real);
    expect(runOnQueue).toHaveBeenCalledTimes(1);

    runOnQueue.mockClear();
    anyCore._enqueueConnect('R', stranger);
    expect(runOnQueue).not.toHaveBeenCalled();
  });
});
