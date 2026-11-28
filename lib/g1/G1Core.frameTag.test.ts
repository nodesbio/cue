/**
 * Diagnostic frame-number tag (2026-11-28, "Bug B": one frame lands on one
 * lens only). ACKs are not render confirmations, so the operator reads the
 * tag on each eye and matches it to `sendText seq=N` in the log.
 *
 * Invariants:
 *  1. ON: both lenses receive text ending in ` #<seq>`, and <seq> equals the
 *     packet's seq byte (the number in the log).
 *  2. OFF (default): text is unchanged.
 *  3. The tag survives the 191-byte frame cut: long text is trimmed instead.
 *  3b. The tag never adds a line or pushes a line past MAX_CHARS: it goes on
 *      the first line with room (teleprompter: the status bar).
 *  4. A whitespace-only frame still counts as blank for the mono gate.
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
import { MAX_CHARS } from '../teleprompter/lineWrapper';
import { formatFrame } from '../teleprompter/lineWrapper';

function makeReadyCore() {
  const core = new G1Core({});
  const anyCore = core as any;
  anyCore._log = () => {}; anyCore._trace = () => {}; anyCore._warn = () => {};
  const written: Record<Side, Uint8Array[]> = { L: [], R: [] };
  const fakeDev = (side: Side) => ({
    writeCharacteristicWithResponseForService: jest.fn(async (_s: string, _c: string, b64: string) => {
      const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
      written[side].push(bytes);
      // Text ACK echoes seq in byte[2]; reply on the next tick.
      if (bytes[0] === P.OP_TEXT) {
        setTimeout(() => anyCore._onNotify(side, null, {
          value: Buffer.from([P.OP_TEXT, 0xc9, bytes[1]]).toString('base64'),
        }), 0);
      }
    }),
  });
  anyCore.devices = { L: fakeDev('L'), R: fakeDev('R') };
  anyCore.txChars = { L: {}, R: {} };
  anyCore.status.left.connected = true;  anyCore.status.left.txReady = true;
  anyCore.status.right.connected = true; anyCore.status.right.txReady = true;
  anyCore._lastTextWriteAt = { L: Date.now(), R: Date.now() };
  const textOf = (pkt: Uint8Array) => new TextDecoder().decode(pkt.slice(9));
  const lastText = (side: Side) => written[side].filter(p => p[0] === P.OP_TEXT).at(-1)!;
  return { core, anyCore, lastText, textOf };
}

async function send(core: G1Core, str: string) {
  const p = core.sendText(str);
  await jest.runAllTimersAsync();
  await p;
}

describe('frame-number tag on lenses', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('is off by default and leaves text unchanged', async () => {
    const { core, lastText, textOf } = makeReadyCore();
    expect(core.showFrameTag).toBe(false);
    await send(core, 'LAL 14 - SEA 7');
    expect(textOf(lastText('L'))).toBe('LAL 14 - SEA 7');
    expect(textOf(lastText('R'))).toBe('LAL 14 - SEA 7');
  });

  it('ON: both lenses end with " #<seq>" matching the wire seq', async () => {
    const { core, lastText, textOf } = makeReadyCore();
    core.setShowFrameTag(true);
    await send(core, 'first');
    await send(core, 'LAL 14 - SEA 7');
    for (const side of ['L', 'R'] as Side[]) {
      const pkt = lastText(side);
      expect(textOf(pkt)).toBe(`LAL 14 - SEA 7 #${pkt[1]}`);
    }
    expect(lastText('L')[1]).toBe(lastText('R')[1]);
  });

  it('keeps the tag when the text would exceed the 191-byte frame', () => {
    const long = 'x'.repeat(300);
    const out = G1Core._withFrameTag(long, 123);
    expect(out.endsWith(' #123')).toBe(true);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(P.TEXT_MAX_BYTES);
    // Multi-byte text is trimmed by character, never split mid-character.
    const emoji = '⚽'.repeat(100);
    const out2 = G1Core._withFrameTag(emoji, 7);
    expect(out2.endsWith(' #7')).toBe(true);
    expect(new TextEncoder().encode(out2).length).toBeLessThanOrEqual(P.TEXT_MAX_BYTES);
    expect(out2).not.toContain('�');
  });

  it('teleprompter frame: tag lands on the status bar, layout unchanged', () => {
    // Status bar + 3 full lines + a short one: within the 191-byte frame, with
    // the last content line full so a naive append would overflow MAX_CHARS.
    const full = 'a'.repeat(MAX_CHARS);
    const frame = ['9:41 L80% R79% ▶12/381', 'short', full, full, full].join('\n');
    expect(new TextEncoder().encode(frame).length + 5).toBeLessThanOrEqual(P.TEXT_MAX_BYTES);
    const out = G1Core._withFrameTag(frame, 212).split('\n');
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('9:41 L80% R79% ▶12/381 #212');
    expect(out.slice(1)).toEqual(['short', full, full, full]);
    for (const l of out) expect(Array.from(l).length).toBeLessThanOrEqual(MAX_CHARS);
  });

  it('real formatFrame output keeps every line within MAX_CHARS', () => {
    const lines = Array.from({ length: 10 }, (_, k) => `${k} ` + 'w'.repeat(MAX_CHARS - 2));
    const frame = formatFrame('9:41 ▶3/10', lines, 2);
    const before = frame.split('\n').length;
    const out = G1Core._withFrameTag(frame, 99).split('\n');
    expect(out).toHaveLength(before);
    expect(out.join('\n')).toContain(' #99');
    for (const l of out) expect(Array.from(l).length).toBeLessThanOrEqual(MAX_CHARS);
  });

  it('every line full: first line is shortened so the tag still shows', () => {
    const full = 'b'.repeat(MAX_CHARS);
    const out = G1Core._withFrameTag([full, full].join('\n'), 5).split('\n');
    expect(out).toHaveLength(2);
    expect(out[0].endsWith(' #5')).toBe(true);
    expect(Array.from(out[0]).length).toBe(MAX_CHARS);
    expect(out[1]).toBe(full);
  });

  it('a whitespace-only frame still counts as blank with the tag on', async () => {
    const { core, anyCore, lastText } = makeReadyCore();
    core.setShowFrameTag(true);
    const markSpy = jest.spyOn(anyCore, '_markTextSeq');
    await send(core, ' ');
    const seq = lastText('L')[1];
    expect(markSpy).toHaveBeenCalledWith(seq, ' ');
  });
});
