/**
 * Head-down re-push — mitigation for L/R content splits (2026-11-28).
 *
 * Three field splits (frame-number tag, build 83) each left L on an older
 * frame, and each missed frame arrived around the end of a head tilt (#95
 * during head-up, #73 +3.1s, #46 +7.9s after head_down). Both lenses ACK the
 * missed frame, so the app cannot see the split.
 *
 * Invariants:
 *  1. head_down → the newest frame is re-sent at +2s, +6s, +12s, same content
 *     and owner.
 *  2. head_up before a re-push fires cancels the pending ones.
 *  3. No re-push when nothing holds the display, a different owner holds it,
 *     or no frame was ever sent.
 *  4. Each re-push sends the NEWEST frame, not the one current at head_down.
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

function makeCore() {
  const core = new G1Core({});
  const anyCore = core as any;
  anyCore._log = () => {}; anyCore._trace = () => {}; anyCore._warn = () => {};
  anyCore.status.left.connected = true;  anyCore.status.left.txReady = true;
  anyCore.status.right.connected = true; anyCore.status.right.txReady = true;
  // Frames go nowhere: we assert on what sendText is asked to send.
  anyCore._enqueue = jest.fn(async () => {});
  const sent: Array<{ str: string; owner?: string }> = [];
  const real = core.sendText.bind(core);
  jest.spyOn(core, 'sendText').mockImplementation((str: string, a?: any, b?: any, c?: any, d?: any, owner?: string) => {
    sent.push({ str, owner });
    return real(str, a, b, c, d, owner);
  });
  const head = (name: 'head_up' | 'head_down') =>
    anyCore._onNotify('R', null, {
      value: Buffer.from([0xf5, name === 'head_up' ? 0x02 : 0x03]).toString('base64'),
    });
  return { core, anyCore, sent, head };
}

describe('head-down re-push', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('re-sends the current frame at +2s, +6s and +12s after head_down', () => {
    const { core, sent, head } = makeCore();
    core.claimDisplay('sports.liveplay');
    void core.sendText('BOS 98 LAL 96', 1, 1, true, undefined, 'sports.liveplay');
    sent.length = 0;
    head('head_down');
    jest.advanceTimersByTime(1_999); expect(sent).toHaveLength(0);
    jest.advanceTimersByTime(1);     expect(sent).toHaveLength(1);
    jest.advanceTimersByTime(4_000); expect(sent).toHaveLength(2);
    jest.advanceTimersByTime(6_000); expect(sent).toHaveLength(3);
    expect(sent.every(f => f.str === 'BOS 98 LAL 96' && f.owner === 'sports.liveplay')).toBe(true);
    jest.advanceTimersByTime(60_000); expect(sent).toHaveLength(3);
  });

  it('a new head_up cancels pending re-pushes', () => {
    const { core, sent, head } = makeCore();
    core.claimDisplay('sports.liveplay');
    void core.sendText('x', 1, 1, true, undefined, 'sports.liveplay');
    sent.length = 0;
    head('head_down');
    jest.advanceTimersByTime(2_500); expect(sent).toHaveLength(1);
    head('head_up');
    jest.advanceTimersByTime(20_000); expect(sent).toHaveLength(1);
  });

  it('does not re-push when nothing holds the display', () => {
    const { core, sent, head } = makeCore();
    void core.sendText('x', 1, 1, true, undefined, 'sports.live');
    sent.length = 0;
    head('head_down');
    jest.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(0);
  });

  it('does not re-push when a different owner now holds the display', () => {
    const { core, sent, head } = makeCore();
    core.claimDisplay('sports.liveplay');
    void core.sendText('play', 1, 1, true, undefined, 'sports.liveplay');
    core.claimDisplay('reader');
    sent.length = 0;
    head('head_down');
    jest.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(0);
  });

  it('does not re-push when no frame was ever sent', () => {
    const { core, sent, head } = makeCore();
    core.claimDisplay('sports.liveplay');
    head('head_down');
    jest.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(0);
  });

  it('each re-push sends the newest frame', () => {
    const { core, sent, head } = makeCore();
    core.claimDisplay('sports.liveplay');
    void core.sendText('old', 1, 1, true, undefined, 'sports.liveplay');
    head('head_down');
    jest.advanceTimersByTime(3_000);
    void core.sendText('new', 1, 1, true, undefined, 'sports.liveplay');
    sent.length = 0;
    jest.advanceTimersByTime(3_000);
    expect(sent.map(f => f.str)).toEqual(['new']);
  });
});
