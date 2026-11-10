/**
 * Regression tests for #24 / #25 / #26 — OP_TEXT ACK handling in G1Core.
 *
 * The firmware's master lens defers the 0x4e ACK to its display thread, so a
 * lens whose display is idle (in case) never ACKs text. These tests pin the
 * invariants that the 2026-10-25 log showed us violating:
 *   - a text NACK on one side must NOT disconnect that side (#24)
 *   - a slow/absent R ACK must NOT block L's next line (#25)
 *   - the NACK must surface as status.<side>.displayIdle (#26)
 *
 * BLE is mocked at the module boundary; we drive _send/_onNotify directly.
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
import * as P from './packets';

const OK_STATUS = 0xc9;

function toB64(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64');
}

/** Build a G1Core with both lenses "txReady" and a fake write path. */
function makeReadyCore() {
  const statusLog: Array<{ side: Side; displayIdle: boolean }> = [];
  const core = new G1Core({
    onStatusChange: (st) => {
      statusLog.push({ side: 'L', displayIdle: st.left.displayIdle });
      statusLog.push({ side: 'R', displayIdle: st.right.displayIdle });
    },
  });
  const anyCore = core as any;
  const writes: Side[] = [];
  const fakeDev = (side: Side) => ({
    writeCharacteristicWithResponseForService: jest.fn(async () => { writes.push(side); }),
  });
  anyCore.devices = { L: fakeDev('L'), R: fakeDev('R') };
  anyCore.txChars = { L: {}, R: {} };
  anyCore.status.left.connected = true;  anyCore.status.left.txReady = true;
  anyCore.status.right.connected = true; anyCore.status.right.txReady = true;
  const onDisconnected = jest.spyOn(anyCore, '_onDisconnected');
  const ack = (side: Side, op: number, status = OK_STATUS) =>
    anyCore._onNotify(side, null, { value: toB64([op, status]) });
  return { core, anyCore, writes, ack, onDisconnected, statusLog };
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }

const TEXT = new Uint8Array([P.OP_TEXT, 0x00, 0x01]);

describe('G1Core OP_TEXT ACK handling', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('#25: _sendBoth resolves on L ACK alone; R write still issued', async () => {
    const { anyCore, writes, ack } = makeReadyCore();
    const p = anyCore._sendBoth(TEXT);
    await flush();
    expect(writes).toEqual(['R', 'L']);     // R first so slave holds the seq before master's ESB sync
    ack('L', P.OP_TEXT);
    await expect(p).resolves.toBeUndefined(); // R never ACKed, queue not blocked
  });

  it('#24: R text NACK (timeout) does NOT call _onDisconnected', async () => {
    const { anyCore, ack, onDisconnected } = makeReadyCore();
    const p = anyCore._sendBoth(TEXT);
    await flush();
    ack('L', P.OP_TEXT);
    await p;
    jest.advanceTimersByTime(25_000 + 1);  // R's ACK_TIMEOUT_TEXT_MS fires
    await flush();
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(anyCore.txChars.R).toBeDefined();  // R still usable
  });

  it('#26: R text NACK sets right.displayIdle; next R ACK clears it', async () => {
    const { anyCore, ack } = makeReadyCore();
    const p1 = anyCore._sendBoth(TEXT);
    await flush();
    ack('L', P.OP_TEXT);
    await p1;
    jest.advanceTimersByTime(25_000 + 1);
    await flush();
    expect(anyCore.status.right.displayIdle).toBe(true);
    expect(anyCore.status.left.displayIdle).toBe(false);

    const p2 = anyCore._sendBoth(TEXT);
    await flush();
    ack('L', P.OP_TEXT);
    ack('R', P.OP_TEXT);
    await p2;
    await flush();
    expect(anyCore.status.right.displayIdle).toBe(false);
  });

  it('#26: displayIdle is not set on a side that is no longer txReady', async () => {
    const { anyCore } = makeReadyCore();
    anyCore.status.right.txReady = false;
    anyCore._setDisplayIdle('R', true);
    expect(anyCore.status.right.displayIdle).toBe(false);
  });
});
