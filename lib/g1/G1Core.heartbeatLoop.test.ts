/**
 * Regression: 0x25 heartbeat echo loop (2026-11).
 *
 * Since 5b01ec5 the app sends its own 0x25 every 8s and the lens echoes it.
 * The RX handler also echoed every 0x25, so each heartbeat ping-ponged
 * forever (verbose logs: 22–28 0x25 RX/s per lens vs ~0.125/s expected).
 *
 * Invariants:
 *  1. A received 0x25 is never written back to the lens.
 *  2. The app still sends its own 0x25 to both lenses every interval.
 *  3. The 0x25 RX rate is reported always-on (not trace) about once a minute,
 *     and is a warning when it exceeds 1/s on either lens.
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

const HB_INTERVAL_MS = 8_000; // HEARTBEAT_INTERVAL_MS (module-private)

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
  const writes = (side: Side): number[][] =>
    anyCore.devices[side].writeCharacteristicWithResponseForService.mock.calls
      .map((c: any[]) => Array.from(Buffer.from(c[2], 'base64')));
  const rxHeartbeat = (side: Side, seq: number) =>
    anyCore._onNotify(side, null, { value: toB64([0x25, 0x06, 0x00, seq, 0x04, seq]) });
  return { core, anyCore, lines, writes, rxHeartbeat };
}

async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

describe('G1Core 0x25 heartbeat', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('does not echo a received 0x25 back to the lens', async () => {
    const { writes, rxHeartbeat } = makeReadyCore();
    rxHeartbeat('L', 0x03);
    rxHeartbeat('R', 0x03);
    await flush();
    expect(writes('L')).toHaveLength(0);
    expect(writes('R')).toHaveLength(0);
  });

  it('still sends its own 0x25 to both lenses each interval', async () => {
    const { anyCore, writes } = makeReadyCore();
    anyCore._startHeartbeat();
    jest.advanceTimersByTime(HB_INTERVAL_MS);
    await flush();
    anyCore._stopHeartbeat();
    for (const side of ['L', 'R'] as Side[]) {
      expect(writes(side).filter(w => w[0] === 0x25)).toEqual([[0x25, 0x06, 0x00, 0x00, 0x04, 0x00]]);
    }
  });

  it('reports a normal 0x25 RX rate as a plain log line', async () => {
    const { anyCore, lines, rxHeartbeat } = makeReadyCore();
    anyCore._startHeartbeat();
    for (let tick = 1; tick <= 9; tick++) {
      rxHeartbeat('L', tick); rxHeartbeat('R', tick); // one echo per heartbeat
      jest.advanceTimersByTime(HB_INTERVAL_MS);
      await flush();
    }
    anyCore._stopHeartbeat();
    const rate = lines.filter(l => l.includes('0x25 RX rate'));
    expect(rate).toHaveLength(1);
    expect(rate[0]).toContain('L=9 (0.13/s)');
    expect(rate[0]).not.toContain('⚠️');
  });

  it('warns when the 0x25 RX rate exceeds 1/s', async () => {
    const { anyCore, lines, rxHeartbeat } = makeReadyCore();
    anyCore._startHeartbeat();
    for (let tick = 1; tick <= 9; tick++) {
      for (let i = 0; i < 200; i++) rxHeartbeat('R', i & 0xff); // 25/s — the loop
      jest.advanceTimersByTime(HB_INTERVAL_MS);
      await flush();
    }
    anyCore._stopHeartbeat();
    const rate = lines.filter(l => l.includes('0x25 RX rate'));
    expect(rate).toHaveLength(1);
    expect(rate[0]).toContain('⚠️');
    expect(rate[0]).toContain('possible 0x25 loop');
  });
});
