/**
 * useLensOwnership identity contract — regression for "Start 24/7 feed does
 * nothing" (sports.tsx).
 *
 * The hook's return OBJECT re-identifies when `on` flips; its start/stop/push
 * CALLBACKS do not. sports.tsx keyed its unmount cleanup on `[lens]`, so the
 * claim made by Start flipped `on`, re-fired the cleanup, and yielded the lens
 * (and stopped the feed) the tick after claiming it.
 *
 * The harness below mirrors that consumer shape. The `object` variant is the
 * old bug and must reproduce claim → yield; the `callbacks` variant is the fix
 * and must not. If someone "simplifies" the memo so callbacks churn, or a
 * consumer regresses to `[lens]`, these fail.
 */

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useEffect } from 'react';
import type { G1Core } from './G1Core';
import { useLensOwnership, type UseLensOwnership } from './useLensOwner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// react-test-renderer@19 logs a one-line deprecation on create(). Filter ONLY
// that exact message so every other console.error (real act()/render warnings)
// still surfaces. Swap to a maintained renderer if one is adopted repo-wide.
const realError = console.error;
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('react-test-renderer is deprecated')) return;
    realError(...args);
  });
});
afterAll(() => { (console.error as jest.Mock).mockRestore(); });

function fakeCore() {
  return {
    claimDisplay: jest.fn(),
    yieldDisplay: jest.fn(),
    sendText: jest.fn(async () => true),
    note: jest.fn(),
    status: { poweredOff: false },
  };
}

type DepStyle = 'object' | 'callbacks';

/** Mirrors sports.tsx: an unmount-intent cleanup that calls stop(). */
function Harness(props: {
  core: G1Core;
  depStyle: DepStyle;
  onLens: (l: UseLensOwnership) => void;
  onCleanup: () => void;
}) {
  const lens = useLensOwnership(props.core, true, 'test.owner');
  props.onLens(lens);
  const deps = props.depStyle === 'object' ? [lens] : [lens.stop];
  useEffect(() => () => { props.onCleanup(); lens.stop(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function mount(depStyle: DepStyle) {
  const core = fakeCore();
  const seen: UseLensOwnership[] = [];
  const onCleanup = jest.fn();
  let r!: ReactTestRenderer;
  act(() => {
    r = create(createElement(Harness, {
      core: core as unknown as G1Core,
      depStyle,
      onLens: (l) => seen.push(l),
      onCleanup,
    }));
  });
  return { core, seen, onCleanup, latest: () => seen[seen.length - 1], unmount: () => act(() => r.unmount()) };
}

describe('useLensOwnership identity', () => {
  it('start/stop/push keep their identity when `on` flips', () => {
    const h = mount('callbacks');
    const before = h.latest();
    act(() => before.start());
    const after = h.latest();
    expect(after.on).toBe(true);
    expect(after.start).toBe(before.start);
    expect(after.stop).toBe(before.stop);
    expect(after.push).toBe(before.push);
    expect(after.toggle).toBe(before.toggle);
    h.unmount();
  });

  it('the returned object DOES re-identify on `on` flip (why [lens] deps are a hazard)', () => {
    const h = mount('callbacks');
    const before = h.latest();
    act(() => before.start());
    expect(h.latest()).not.toBe(before);
    h.unmount();
  });

  it('fix: a cleanup keyed on stop does not fire on start — lens stays claimed', () => {
    const h = mount('callbacks');
    act(() => h.latest().start());
    expect(h.core.claimDisplay).toHaveBeenCalledTimes(1);
    expect(h.onCleanup).not.toHaveBeenCalled();
    expect(h.core.yieldDisplay).not.toHaveBeenCalled();
    expect(h.latest().on).toBe(true);
    expect(h.latest().push('frame')).toBe(true);
    h.unmount();
    expect(h.onCleanup).toHaveBeenCalledTimes(1);
  });

  it('old bug reproduced: a cleanup keyed on the lens object yields right after start', () => {
    const h = mount('object');
    act(() => h.latest().start());
    expect(h.core.claimDisplay).toHaveBeenCalledTimes(1);
    expect(h.onCleanup).toHaveBeenCalled();
    expect(h.core.yieldDisplay).toHaveBeenCalled();
    expect(h.latest().on).toBe(false);
    expect(h.latest().push('frame')).toBe(false); // the feed's frames are dropped
    h.unmount();
  });
});
