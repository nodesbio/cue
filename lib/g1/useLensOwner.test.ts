/**
 * useLensOwner decision logic — the push guard and last-page default that every
 * lens producer shares. We test the extracted pure helpers (the test IS the spec,
 * cf. displayOwner.test.ts) rather than spinning up a renderer; the hook calls
 * these exact functions, so the contract and the runtime cannot drift.
 */

import { shouldPushFrame, resolveIsLastPage } from './useLensOwner';

describe('shouldPushFrame', () => {
  const base = { on: true, frame: 'hi', isConnected: true, poweredOff: false };

  it('pushes only when active, non-empty, connected, and powered on', () => {
    expect(shouldPushFrame(base)).toBe(true);
  });

  it('does not push while inactive', () => {
    expect(shouldPushFrame({ ...base, on: false })).toBe(false);
  });

  it('does not push an empty or whitespace-only frame', () => {
    expect(shouldPushFrame({ ...base, frame: '' })).toBe(false);
    expect(shouldPushFrame({ ...base, frame: '   \n  ' })).toBe(false);
  });

  it('does not push while disconnected', () => {
    expect(shouldPushFrame({ ...base, isConnected: false })).toBe(false);
  });

  it('does not push while the lens is powered off', () => {
    expect(shouldPushFrame({ ...base, poweredOff: true })).toBe(false);
  });
});

describe('resolveIsLastPage', () => {
  it('a single-page frame is its own last page', () => {
    expect(resolveIsLastPage(1, 1)).toBe(true);
  });

  it('a mid-document page is not the last page', () => {
    expect(resolveIsLastPage(3, 10)).toBe(false);
  });

  it('the final page of a document is the last page', () => {
    expect(resolveIsLastPage(10, 10)).toBe(true);
    expect(resolveIsLastPage(11, 10)).toBe(true); // clamp: past the end still last
  });

  it('honours an explicit override', () => {
    expect(resolveIsLastPage(3, 10, true)).toBe(true);
    expect(resolveIsLastPage(10, 10, false)).toBe(false);
  });
});
