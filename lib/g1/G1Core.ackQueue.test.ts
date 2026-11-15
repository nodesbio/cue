/**
 * Regression test for the single-slot `_pendingAck` eviction bug.
 *
 * Before this fix, `_pendingAck` held ONE waiter per ackKey (`${side}${opHex}`).
 * When a second send on the same side+opcode registered while the first was
 * still in flight, the register path EVICTED the first waiter ("evicted stale
 * ACK waiter") and resolved it `false`. The first send then reported a spurious
 * ACK MISS even though its real ACK was still coming — and when that real ACK
 * arrived it resolved the *second* send, so the two sends were off-by-one.
 *
 * The fix makes `_pendingAck` a FIFO queue per key: both sends stay armed, and
 * ACKs resolve oldest-first (BLE notifications are in-order per characteristic).
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

function makeReadyCore() {
  const core = new G1Core({});
  const anyCore = core as any;
  const fakeDev = () => ({
    writeCharacteristicWithResponseForService: jest.fn(async () => {}),
  });
  anyCore.devices = { L: fakeDev(), R: fakeDev() };
  anyCore.txChars = { L: {}, R: {} };
  anyCore.status.left.connected = true;  anyCore.status.left.txReady = true;
  anyCore.status.right.connected = true; anyCore.status.right.txReady = true;
  // Arm the ghost-ACK gate so the first real ACK isn't dropped.
  anyCore._lastTextWriteAt = { L: Date.now(), R: Date.now() };
  // OP_TEXT ACKs resolve by echoed seq (byte[2], see _findAckWaiterBySeq), NOT
  // FIFO head — so the ACK packet must carry the seq of the waiter it resolves.
  // Non-text ops ignore byte[2] and still resolve FIFO head; seq defaults to 0.
  const ack = (side: Side, op: number, seq = 0, status = OK_STATUS) =>
    anyCore._onNotify(side, null, { value: toB64([op, status, seq]) });
  return { core, anyCore, ack };
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }

const TEXT_TIMEOUT_MS = 25_000; // G1Core.ACK_TIMEOUT_TEXT_MS (private static)
const KEY = `L${P.OP_TEXT.toString(16).padStart(2, '0')}`;

describe('G1Core _pendingAck FIFO queue', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('two concurrent same-side TEXT sends both stay armed (no eviction)', async () => {
    const { anyCore } = makeReadyCore();

    // Drive the write phase for two sends on L/OP_TEXT with different seq.
    const first = anyCore._send('L', new Uint8Array([P.OP_TEXT, 0x00]));
    await flush();
    const second = anyCore._send('L', new Uint8Array([P.OP_TEXT, 0x01]));
    await flush();

    // THE BUG: the old single-slot code evicted seq=0 when seq=1 registered,
    // so this would have been length 1. The FIFO queue keeps both.
    const q = anyCore._pendingAck.get(KEY);
    expect(q).toHaveLength(2);
    expect(q.map((w: any) => w.seq)).toEqual([0, 1]); // FIFO order, oldest first

    // Cancel cleanly so the sends settle and timers don't leak into the next test.
    anyCore._drainAckWaiters('L');
    await Promise.all([first, second]);
    expect(anyCore._pendingAck.has(KEY)).toBe(false);
  });

  it('ACKs resolve waiters oldest-first (FIFO)', async () => {
    const { anyCore, ack } = makeReadyCore();
    const first = anyCore._send('L', new Uint8Array([P.OP_TEXT, 0x00]));
    await flush();
    const second = anyCore._send('L', new Uint8Array([P.OP_TEXT, 0x01]));
    await flush();

    const q = anyCore._pendingAck.get(KEY);
    const firstWaiter = q[0];

    ack('L', P.OP_TEXT, 0); // ACK for seq=0 → drops that waiter, not seq=1
    expect(anyCore._pendingAck.get(KEY)).toHaveLength(1);
    expect(anyCore._pendingAck.get(KEY)[0].seq).toBe(1); // seq=1 survives
    expect(q.indexOf(firstWaiter)).toBe(-1);             // seq=0 waiter gone

    ack('L', P.OP_TEXT, 1); // ACK for seq=1 → drains the queue, key removed
    expect(anyCore._pendingAck.has(KEY)).toBe(false);

    await Promise.all([first, second]);
  });

  it('a per-waiter timeout evicts only that waiter, not the whole queue', async () => {
    const { anyCore, ack } = makeReadyCore();
    const first = anyCore._send('L', new Uint8Array([P.OP_TEXT, 0x00]));
    await flush();
    const second = anyCore._send('L', new Uint8Array([P.OP_TEXT, 0x01]));
    await flush();

    ack('L', P.OP_TEXT, 0); // resolve seq=0's waiter
    expect(anyCore._pendingAck.get(KEY)).toHaveLength(1);

    jest.advanceTimersByTime(TEXT_TIMEOUT_MS + 1); // seq=1 times out
    await flush();
    expect(anyCore._pendingAck.has(KEY)).toBe(false);

    await Promise.all([first, second]);
  });
});
