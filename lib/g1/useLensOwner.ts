/**
 * useLensOwner.ts — THE single lens-mirroring primitive.
 *
 * The G1 lens is one shared surface with many producers (sports deck/live/stream,
 * reader, teleprompter, study decks). Each one previously hand-wrote the same
 * arbiter dance — claimDisplay(OWNER) on start, a guarded sendText(..., OWNER)
 * while active, yieldDisplay(OWNER) on stop/blur/unmount — plus the same
 * `isConnected && !poweredOff` push guard. That was ~5 copies drifting apart.
 *
 * This hook is that dance, once. A producer gives it its owner token and the
 * frame to show; the hook owns claim/push/yield and the drop guard. The arbiter
 * in G1Core.sendText still has the final say (a frame tagged with a non-holder
 * owner is dropped), so this is a convenience layer over the contract, not a
 * second source of truth for it.
 *
 * Guard rationale (verified against the copies in useDeck / reader / index):
 *   - push only when active && frame && isConnected && !poweredOff — avoids
 *     enqueuing frames the tx/arbiter would drop anyway.
 *   - stop() yields via blank-then-release (yieldDisplay), never clearDisplay,
 *     so we never strand a stale frame on the lens or blank another owner's.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { G1Core } from './G1Core';
import type { NewScreenValue } from './packets';

export interface LensFrameOpts {
  /** 1-based current line for paged/teleprompter frames (default 1). */
  curLine?: number;
  /** Total lines for paged frames (default 1). */
  totalLines?: number;
  /** Whether this is the last page (default: curLine >= totalLines). */
  isLastPage?: boolean;
  /** Passed through to sendText for screen-status control. */
  newScreen?: NewScreenValue;
}

export interface UseLensOwnerOpts extends LensFrameOpts {
  /**
   * False disables start() and stops an active session (e.g. the producer's tab
   * lost focus). Default true.
   */
  enabled?: boolean;
}

/**
 * Push decision — the guard replicated at every lens producer, extracted so it
 * can be tested as a spec (the test IS the contract, cf. displayOwner.test.ts).
 * A frame is pushed only while active, non-empty, connected, and powered on;
 * anything else would be enqueued only for the tx/arbiter to drop.
 */
export function shouldPushFrame(args: {
  on: boolean;
  frame: string;
  isConnected: boolean;
  poweredOff: boolean;
}): boolean {
  return args.on && args.frame.trim().length > 0 && args.isConnected && !args.poweredOff;
}

/** Default last-page flag: a single-page frame is its own last page. */
export function resolveIsLastPage(curLine: number, totalLines: number, explicit?: boolean): boolean {
  return explicit ?? curLine >= totalLines;
}

/** A single guarded frame push. */
export interface LensPushArgs extends LensFrameOpts {}

export interface UseLensOwnership {
  /** True while this owner holds the lens. */
  on: boolean;
  /** Claim the lens. Safe to call repeatedly. */
  start: () => void;
  /** Blank the lens and hand ownership back. */
  stop: () => void;
  /** Convenience toggle for a single Play/Pause control. */
  toggle: () => void;
  /**
   * Take the lens back and replay the last pushed frame. For an imperative
   * producer that is still running after another producer claimed and then
   * yielded (which leaves the lens unclaimed — the teleprompter's untagged
   * frames would then interleave with ours). Stable identity.
   */
  reassert: () => void;
  /**
   * Push one frame NOW, guarded (active + non-empty + connected + powered on).
   * Returns true if the write was issued. Imperative producers (timer state
   * machines, gesture handlers) call this at their own sequencing points so
   * each logical frame maps to exactly one BLE write — sendText does NOT dedupe
   * identical strings, so "push only at logical events" is the caller's policy.
   */
  push: (frame: string, args?: LensPushArgs) => boolean;
}

/**
 * Lifecycle half of the lens arbiter: claim on start, yield on stop/disable/
 * unmount, plus a guarded imperative `push`. This is the single source of truth
 * for ownership; producers choose their own frame-invalidation policy (reactive
 * via useLensOwner, or imperative by calling push() directly). The arbiter in
 * G1Core.sendText still has the final say on a tagged frame.
 */
export function useLensOwnership(
  core: G1Core,
  isConnected: boolean,
  owner: string,
  opts: {
    enabled?: boolean;
    /**
     * Replay the last pushed frame when isConnected goes false→true while this
     * owner holds the lens. A frame pushed before both lenses are txReady is
     * dropped by the guard; without this, an imperative producer stays blank
     * until its next scheduled push. Opt-in: the teleprompter has its own
     * resync from the engine snapshot, and a replay of its last *focus* frame
     * would be stale.
     */
    resyncOnConnect?: boolean;
  } = {},
): UseLensOwnership {
  const { enabled = true, resyncOnConnect = false } = opts;
  const [on, setOn] = useState(false);

  // Synchronous ownership flag. `on` (React state) lags one render behind the
  // claim; an imperative producer that claims then push()es in the SAME tick
  // (e.g. reader's focus effect → tick() → push()) must not have that first
  // frame dropped. ownedRef tracks the claim synchronously so push() is correct
  // immediately, while `on` still drives rendering.
  const ownedRef = useRef(false);

  const start = useCallback(() => {
    if (!enabled) return;
    core.claimDisplay(owner);
    ownedRef.current = true;
    setOn(true);
  }, [core, owner, enabled]);

  // The last frame this owner asked to show, sent or not — what a resync or
  // reassert replays. Cleared on stop so a new session never replays old data.
  const lastRef = useRef<{ frame: string; args: LensPushArgs } | null>(null);

  const stop = useCallback(() => {
    ownedRef.current = false;
    lastRef.current = null;
    setOn(false);
    core.yieldDisplay(owner);
  }, [core, owner]);

  // toggle reads `on` via ownedRef so its identity is stable — otherwise it
  // would change every render that flips `on`, churning any consumer that holds
  // the hook's return in a dep array.
  const toggle = useCallback(() => {
    ownedRef.current ? stop() : start();
  }, [start, stop]);

  const connectedRef = useRef(isConnected);
  useEffect(() => { connectedRef.current = isConnected; }, [isConnected]);

  const push = useCallback((frame: string, args: LensPushArgs = {}): boolean => {
    const text = frame.trim();
    if (ownedRef.current && text.length > 0) lastRef.current = { frame: text, args };
    if (!shouldPushFrame({ on: ownedRef.current, frame: text, isConnected: connectedRef.current, poweredOff: core.status.poweredOff })) {
      return false;
    }
    const { curLine = 1, totalLines = 1, isLastPage, newScreen } = args;
    void core.sendText(text, curLine, totalLines, resolveIsLastPage(curLine, totalLines, isLastPage), newScreen, owner);
    return true;
  }, [core, owner]);

  /** Re-push the last frame (guarded like any push). */
  const replay = useCallback((why: string) => {
    const last = lastRef.current;
    if (!last) return;
    if (push(last.frame, last.args)) core.note(`[lens] ${owner} ${why} → re-push last frame`);
  }, [core, owner, push]);

  const reassert = useCallback(() => {
    if (!enabled) return;
    core.claimDisplay(owner);
    ownedRef.current = true;
    setOn(true);
    replay('reassert');
  }, [core, owner, enabled, replay]);

  // Connect-edge resync. Declared after the connectedRef effect so push()'s
  // guard already sees the new value (effects run in declaration order).
  const prevConnectedRef = useRef(isConnected);
  useEffect(() => {
    const was = prevConnectedRef.current;
    prevConnectedRef.current = isConnected;
    if (resyncOnConnect && isConnected && !was) replay('reconnect resync');
  }, [isConnected, resyncOnConnect, replay]);

  // If the producer gets disabled (e.g. tab blur) while mirroring, hand the lens
  // back rather than stranding the last frame on the glasses.
  useEffect(() => {
    if (!enabled && on) stop();
  }, [enabled, on, stop]);

  // Last line of defence: unmount must not leave a claimed, stale lens.
  useEffect(() => () => { core.yieldDisplay(owner); }, [core, owner]);

  // Memoized so the object only re-identifies when `on` changes — but it DOES
  // re-identify then. Consumers must put the (stable) start/stop/push callbacks
  // in dep arrays, never the object: a [lens]-keyed cleanup fires on the very
  // claim that flips `on`, calling stop() the tick after start() (this killed
  // the sports 24/7 feed).
  return useMemo(
    () => ({ on, start, stop, toggle, push, reassert }),
    [on, start, stop, toggle, push, reassert],
  );
}

export interface UseLensOwner {
  on: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

/**
 * Reactive-frame wrapper over useLensOwnership: mirror `frame` to the lens under
 * `owner`, re-pushing whenever the frame (or paging) changes while active. For
 * producers whose display IS a function of render state (study decks, simple
 * single-frame surfaces). Imperative producers should use useLensOwnership +
 * push() directly instead, to control exactly when writes happen.
 */
export function useLensOwner(
  core: G1Core,
  isConnected: boolean,
  owner: string,
  frame: string,
  opts: UseLensOwnerOpts = {},
): UseLensOwner {
  const { enabled = true, curLine = 1, totalLines = 1, isLastPage, newScreen } = opts;
  const lens = useLensOwnership(core, isConnected, owner, { enabled });

  const text = frame.trim();
  const lastPage = resolveIsLastPage(curLine, totalLines, isLastPage);
  // Re-push on any frame/paging change while active + connected.
  useEffect(() => {
    lens.push(text, { curLine, totalLines, isLastPage: lastPage, newScreen });
    // `lens.push` is stable; depend on the frame/paging inputs + active flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lens.on, text, isConnected, curLine, totalLines, lastPage, newScreen]);

  // Stable identity (same reasoning as useLensOwnership): consumers hold this in
  // dep arrays / focus-effect cleanups. A fresh object per render re-fires those
  // cleanups → stop() → the lens is released the tick after it's claimed.
  return useMemo(
    () => ({ on: lens.on, start: lens.start, stop: lens.stop, toggle: lens.toggle }),
    [lens.on, lens.start, lens.stop, lens.toggle],
  );
}
