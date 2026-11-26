/**
 * useLensOwnership re-assert contract — regressions for two blank/stolen-lens
 * bugs on the sports Live HUD (SportsFeed → lens.push every 20s poll):
 *
 *  1. Blank after connect: a frame pushed before both lenses are txReady is
 *     dropped by the push guard, and nothing re-pushed when isConnected went
 *     true — the lens stayed blank until the next poll (device log 2026-11-25:
 *     first frame at 30.677, lenses ready at 33.125). `resyncOnConnect` replays
 *     the owner's last frame on the false→true edge.
 *  2. Stolen lens: play-by-play "to lens" claims 'sports.liveplay'; its stop
 *     yields and leaves the lens UNCLAIMED while the HUD keeps pushing, so the
 *     teleprompter's untagged frames interleave with the scores. `reassert()`
 *     re-claims and replays the last frame.
 */

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { G1Core } from './G1Core';
import { useLensOwnership, type UseLensOwnership } from './useLensOwner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// react-test-renderer@19 logs a one-line deprecation on create(); filter only that.
const realError = console.error;
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('react-test-renderer is deprecated')) return;
    realError(...args);
  });
});
afterAll(() => { (console.error as jest.Mock).mockRestore(); });

const OWNER = 'test.hud';

function fakeCore() {
  return {
    claimDisplay: jest.fn(),
    yieldDisplay: jest.fn(),
    sendText: jest.fn(async (..._args: unknown[]) => true),
    note: jest.fn(),
    status: { poweredOff: false },
  };
}

function Harness(props: {
  core: G1Core;
  isConnected: boolean;
  resyncOnConnect?: boolean;
  onLens: (l: UseLensOwnership) => void;
}) {
  props.onLens(useLensOwnership(props.core, props.isConnected, OWNER, { resyncOnConnect: props.resyncOnConnect }));
  return null;
}

function mount(opts: { isConnected: boolean; resyncOnConnect?: boolean }) {
  const core = fakeCore();
  let lens!: UseLensOwnership;
  let r!: ReactTestRenderer;
  const el = (isConnected: boolean) => createElement(Harness, {
    core: core as unknown as G1Core,
    isConnected,
    resyncOnConnect: opts.resyncOnConnect,
    onLens: (l) => { lens = l; },
  });
  act(() => { r = create(el(opts.isConnected)); });
  return {
    core,
    lens: () => lens,
    setConnected: (c: boolean) => act(() => r.update(el(c))),
    unmount: () => act(() => r.unmount()),
  };
}

/** Frames actually written for OWNER (excludes nothing — the fake core has no arbiter). */
const sentFrames = (core: ReturnType<typeof fakeCore>) =>
  core.sendText.mock.calls.map((c) => c[0]);

describe('resyncOnConnect — blank lens after connect', () => {
  it('replays the frame that was dropped while disconnected, on the connect edge', () => {
    const h = mount({ isConnected: false, resyncOnConnect: true });
    act(() => h.lens().start());
    expect(h.lens().push('BOS 98\nLAL 96')).toBe(false); // dropped: not connected
    expect(h.core.sendText).not.toHaveBeenCalled();

    h.setConnected(true);
    expect(sentFrames(h.core)).toEqual(['BOS 98\nLAL 96']);
    expect(h.core.sendText.mock.calls[0][5]).toBe(OWNER); // owner-tagged
    h.unmount();
  });

  it('replays on every reconnect, with the latest frame', () => {
    const h = mount({ isConnected: true, resyncOnConnect: true });
    act(() => h.lens().start());
    h.lens().push('frame 1');
    h.setConnected(false);
    h.lens().push('frame 2'); // dropped while down
    h.setConnected(true);
    expect(sentFrames(h.core)).toEqual(['frame 1', 'frame 2']);
    h.unmount();
  });

  it('is opt-in: without it, nothing replays (teleprompter keeps its own resync)', () => {
    const h = mount({ isConnected: false });
    act(() => h.lens().start());
    h.lens().push('A');
    h.setConnected(true);
    expect(h.core.sendText).not.toHaveBeenCalled();
    h.unmount();
  });

  it('does not replay a frame from a stopped session', () => {
    const h = mount({ isConnected: false, resyncOnConnect: true });
    act(() => h.lens().start());
    h.lens().push('old scores');
    act(() => h.lens().stop());
    h.setConnected(true);
    expect(h.core.sendText).not.toHaveBeenCalled();
    h.unmount();
  });

  it('does not replay while powered off', () => {
    const h = mount({ isConnected: false, resyncOnConnect: true });
    act(() => h.lens().start());
    h.lens().push('A');
    h.core.status.poweredOff = true;
    h.setConnected(true);
    expect(h.core.sendText).not.toHaveBeenCalled();
    h.unmount();
  });
});

describe('reassert — take the lens back after another producer yielded', () => {
  it('re-claims and replays the last frame', () => {
    const h = mount({ isConnected: true });
    act(() => h.lens().start());
    h.lens().push('BOS 98');
    expect(h.core.claimDisplay).toHaveBeenCalledTimes(1);

    act(() => h.lens().reassert());
    expect(h.core.claimDisplay).toHaveBeenCalledTimes(2);
    expect(h.core.claimDisplay).toHaveBeenLastCalledWith(OWNER);
    expect(sentFrames(h.core)).toEqual(['BOS 98', 'BOS 98']);
    h.unmount();
  });

  it('with no frame yet, just re-claims', () => {
    const h = mount({ isConnected: true });
    act(() => h.lens().reassert());
    expect(h.core.claimDisplay).toHaveBeenCalledWith(OWNER);
    expect(h.core.sendText).not.toHaveBeenCalled();
    expect(h.lens().on).toBe(true);
    h.unmount();
  });

  it('keeps a stable identity across `on` flips', () => {
    const h = mount({ isConnected: true });
    const before = h.lens().reassert;
    act(() => h.lens().start());
    expect(h.lens().reassert).toBe(before);
    h.unmount();
  });
});
