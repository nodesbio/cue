/**
 * Regression test for the 2026-11-22 "Settings says H290028, the lenses are
 * H290036" report.
 *
 * connect(serial) rebound the core to the requested pair and then returned
 * early because lenses were already up: the OTHER pair's lenses. The caller
 * saw success and saved the new serial; the link never changed.
 *
 * Invariants pinned here:
 *   1. connect(X) while holding lenses bound to Y drops them and looks for X.
 *   2. connect(X) while holding X is still a no-op.
 *   3. connect(X) while an attempt for Y is in flight does not rebind until
 *      that attempt settles. The scan checks each advertisement against the
 *      bound serial at the moment it arrives, so rebinding mid-scan can keep
 *      one lens from each pair.
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

import { G1Core } from './G1Core';

function makeDevice(id: string, name: string) {
  return { id, name, cancelConnection: jest.fn(async () => undefined) };
}

function makeCore(boundSerial: string) {
  const core = new G1Core({ onStatusChange: () => {} });
  const anyCore = core as any;
  anyCore._pairedSerial = boundSerial;
  // Stop at the point where device selection would start.
  anyCore._ensureBleReady = jest.fn(async () => undefined);
  anyCore._resumeAlreadyConnected = jest.fn(async () => false);
  anyCore._scan = jest.fn(async () => undefined);
  return { core, anyCore };
}

function hold(anyCore: any, L: ReturnType<typeof makeDevice>, R: ReturnType<typeof makeDevice>) {
  anyCore.devices = { L, R };
  anyCore.txChars = { L: {}, R: {} };
  anyCore.rxSubs = { L: { remove: jest.fn() }, R: { remove: jest.fn() } };
  anyCore._pairedIds = { L: L.id, R: R.id };
  for (const s of ['left', 'right'] as const) {
    anyCore.status[s].connected = true;
    anyCore.status[s].txReady = true;
  }
}

describe('G1Core switching pairs', () => {
  it('connect(other serial) drops the held lenses and looks for the requested pair', async () => {
    const { core, anyCore } = makeCore('H290036');
    const L = makeDevice('ID-36-L', 'Even G1_30_L_91C189');
    const R = makeDevice('ID-36-R', 'Even G1_30_R_2AF297');
    hold(anyCore, L, R);

    await core.connect('H290028');

    expect(L.cancelConnection).toHaveBeenCalledTimes(1);
    expect(R.cancelConnection).toHaveBeenCalledTimes(1);
    expect(core.isConnected).toBe(false);
    expect(anyCore._pairedSerial).toBe('H290028');
    expect(anyCore._pairedIds).toEqual({});
    expect(anyCore._scan).toHaveBeenCalledWith('H290028');
  });

  it('connect(same serial) while connected leaves the link alone', async () => {
    const { core, anyCore } = makeCore('H290036');
    const L = makeDevice('ID-36-L', 'Even G1_30_L_91C189');
    const R = makeDevice('ID-36-R', 'Even G1_30_R_2AF297');
    hold(anyCore, L, R);

    await core.connect('H290036');

    expect(L.cancelConnection).not.toHaveBeenCalled();
    expect(R.cancelConnection).not.toHaveBeenCalled();
    expect(core.isConnected).toBe(true);
    expect(anyCore._pairedIds).toEqual({ L: 'ID-36-L', R: 'ID-36-R' });
    expect(anyCore._scan).not.toHaveBeenCalled();
  });

  it('connect(other serial) does not rebind while an earlier attempt is in flight', async () => {
    const { core, anyCore } = makeCore('H290036');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Same shape as the real one: clears itself when it settles.
    anyCore._connectingPromise = gate.then(() => { anyCore._connectingPromise = null; });

    const switching = core.connect('H290028');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(anyCore._pairedSerial).toBe('H290036');
    expect(anyCore._scan).not.toHaveBeenCalled();

    release();
    await switching;
    expect(anyCore._pairedSerial).toBe('H290028');
    expect(anyCore._scan).toHaveBeenCalledWith('H290028');
  });
});
