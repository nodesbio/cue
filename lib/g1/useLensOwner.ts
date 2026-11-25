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

import { useCallback, useEffect, useState } from 'react';
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

export interface UseLensOwner {
  /** True while this owner holds the lens. */
  on: boolean;
  /** Claim the lens and begin mirroring `frame`. */
  start: () => void;
  /** Blank the lens and hand ownership back. */
  stop: () => void;
  /** Convenience toggle for a single Play/Pause control. */
  toggle: () => void;
}

/**
 * Mirror `frame` to the lens under `owner` while active.
 *
 * @param core        the shared G1 core
 * @param isConnected both lenses usable (the screen's connection state)
 * @param owner       the producer's distinct arbiter token (e.g. 'reader')
 * @param frame       the text to show — caller composes it; empty is not pushed
 * @param opts        enabled + paging options
 */
export function useLensOwner(
  core: G1Core,
  isConnected: boolean,
  owner: string,
  frame: string,
  opts: UseLensOwnerOpts = {},
): UseLensOwner {
  const { enabled = true, curLine = 1, totalLines = 1, isLastPage, newScreen } = opts;
  const [on, setOn] = useState(false);

  const start = useCallback(() => {
    if (!enabled) return;
    core.claimDisplay(owner);
    setOn(true);
    // The push happens in the effect below once `on` flips true.
  }, [core, owner, enabled]);

  const stop = useCallback(() => {
    setOn(false);
    core.yieldDisplay(owner);
  }, [core, owner]);

  const toggle = useCallback(() => {
    on ? stop() : start();
  }, [on, start, stop]);

  // Push whenever the mirrored frame (or paging) changes while on + connected.
  const text = frame.trim();
  const lastPage = resolveIsLastPage(curLine, totalLines, isLastPage);
  useEffect(() => {
    if (shouldPushFrame({ on, frame: text, isConnected, poweredOff: core.status.poweredOff })) {
      void core.sendText(text, curLine, totalLines, lastPage, newScreen, owner);
    }
  }, [on, text, isConnected, core, owner, curLine, totalLines, lastPage, newScreen]);

  // If the producer gets disabled (e.g. tab blur) while mirroring, hand the lens
  // back rather than stranding the last frame on the glasses.
  useEffect(() => {
    if (!enabled && on) stop();
  }, [enabled, on, stop]);

  // Last line of defence: unmount must not leave a claimed, stale lens.
  useEffect(() => () => { core.yieldDisplay(owner); }, [core, owner]);

  return { on, start, stop, toggle };
}
