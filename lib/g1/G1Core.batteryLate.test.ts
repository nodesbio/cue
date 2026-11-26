/**
 * Observability invariants for the 0x2C battery/device-info poll.
 *
 * Field logs (2026-11-10 → 11-26) show long runs of `ACK timeout op=0x2c`
 * on one or both lenses while text ACKs on the same link keep working. Quiet
 * (non-verbose) exports could not tell "reply never arrived" from "reply
 * arrived after the 2s timeout": the late reply was handled at trace level
 * only, and the timeout line printed the platform byte as `seq=2`.
 *
 * Invariants:
 *  1. A 0x2C timeout labels data[1] as the platform byte, not a seq.
 *  2. A 0x2C reply that lands after its waiter timed out is still recorded as
 *     the lens battery level AND is reported (warn) as late, with the delay.
 *  3. A reply that resolves a live waiter, or that follows no timeout, is not
 *     reported as late.
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

const DEFAULT_TIMEOUT_MS = 2_000; // G1Core.ACK_TIMEOUT_DEFAULT_MS (private static)

function toB64(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64');
}

function makeReadyCore() {
  const lines: string[] = [];
  const core = new G1Core({ onLog: (l) => lines.push(l) });
  const anyCore = core as any;
  const fakeDev = () => ({
    writeCharacteristicWithResponseForService: jest.fn(async () => {}),
  });
  anyCore.devices = { L: fakeDev(), R: fakeDev() };
  anyCore.txChars = { L: {}, R: {} };
  anyCore.status.left.connected = true;  anyCore.status.left.txReady = true;
  anyCore.status.right.connected = true; anyCore.status.right.txReady = true;
  // Real reply shape from field logs: 2c 66 <pct> <volt_hi> <volt_lo> ...
  const batteryReply = (side: Side, pct: number) =>
    anyCore._onNotify(side, null, {
      value: toB64([0x2c, 0x66, pct, 0x2c, 0xd4, 0x86, 0x16, 0x01, 0x06, 0x06, 0x01, 0x06, 0x06]),
    });
  return { core, anyCore, lines, batteryReply };
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }

const lateLines = (lines: string[]) => lines.filter(l => /0x2c reply .*late/i.test(l));

describe('G1Core 0x2C battery poll observability', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('labels the 0x2C timeout byte as platform, not seq', async () => {
    const { anyCore, lines } = makeReadyCore();
    const p = anyCore._send('R', P.batteryRequest(P.PHONE_IOS));
    await flush();
    jest.advanceTimersByTime(DEFAULT_TIMEOUT_MS);
    await p.catch(() => {});
    const timeout = lines.find(l => l.includes('ACK timeout op=0x2c'));
    expect(timeout).toBeDefined();
    expect(timeout).toContain('platform=2');
    expect(timeout).not.toContain('seq=');
  });

  it('still labels an OP_TEXT timeout byte as seq', async () => {
    const { anyCore, lines } = makeReadyCore();
    anyCore._lastTextWriteAt = { L: Date.now(), R: Date.now() };
    const p = anyCore._send('L', new Uint8Array([P.OP_TEXT, 0x07]));
    await flush();
    jest.advanceTimersByTime(30_000);
    await p.catch(() => {});
    expect(lines.find(l => l.includes('ACK timeout op=0x4e'))).toContain('seq=7');
  });

  it('records a late 0x2C reply as battery level and reports it as late', async () => {
    const { anyCore, lines, batteryReply } = makeReadyCore();
    const p = anyCore._send('R', P.batteryRequest(P.PHONE_IOS));
    await flush();
    jest.advanceTimersByTime(DEFAULT_TIMEOUT_MS);
    await p.catch(() => {});

    jest.advanceTimersByTime(1_500); // reply lands 1.5s after the timeout
    batteryReply('R', 0x4b);

    expect(anyCore.status.right.batteryPct).toBe(0x4b);
    const late = lateLines(lines);
    expect(late).toHaveLength(1);
    expect(late[0]).toContain('[R]');
    expect(late[0]).toContain('1500ms after');
  });

  it('reports only the first reply after a timeout as late', async () => {
    const { anyCore, lines, batteryReply } = makeReadyCore();
    const p = anyCore._send('R', P.batteryRequest(P.PHONE_IOS));
    await flush();
    jest.advanceTimersByTime(DEFAULT_TIMEOUT_MS);
    await p.catch(() => {});
    batteryReply('R', 0x4b);
    batteryReply('R', 0x4b);
    expect(lateLines(lines)).toHaveLength(1);
  });

  it('does not report a reply that resolves a live waiter', async () => {
    const { anyCore, lines, batteryReply } = makeReadyCore();
    const p = anyCore._send('R', P.batteryRequest(P.PHONE_IOS));
    await flush();
    batteryReply('R', 0x4b);
    await p;
    expect(anyCore.status.right.batteryPct).toBe(0x4b);
    expect(lateLines(lines)).toHaveLength(0);
  });

  it('does not report a reply that follows no timeout', () => {
    const { anyCore, lines, batteryReply } = makeReadyCore();
    batteryReply('L', 0x40);
    expect(anyCore.status.left.batteryPct).toBe(0x40);
    expect(lateLines(lines)).toHaveLength(0);
  });

  it('a reply on a new connection is not reported late for a poll on the dead one', async () => {
    const { anyCore, lines, batteryReply } = makeReadyCore();
    const p = anyCore._send('R', P.batteryRequest(P.PHONE_IOS));
    await flush();
    jest.advanceTimersByTime(DEFAULT_TIMEOUT_MS);
    await p.catch(() => {});
    anyCore._onDisconnected('R');
    batteryReply('R', 0x4b);
    expect(lateLines(lines)).toHaveLength(0);
  });

  it('a timeout on one lens does not mark the other lens late', async () => {
    const { anyCore, lines, batteryReply } = makeReadyCore();
    const p = anyCore._send('R', P.batteryRequest(P.PHONE_IOS));
    await flush();
    jest.advanceTimersByTime(DEFAULT_TIMEOUT_MS);
    await p.catch(() => {});
    batteryReply('L', 0x40);
    expect(lateLines(lines)).toHaveLength(0);
  });
});
