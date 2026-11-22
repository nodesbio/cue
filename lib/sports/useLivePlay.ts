/**
 * useLivePlay — push LIVE play-by-play onto the lens, ambient & hands-free.
 *
 * The companion of useArticleStream, but for a LIVE source rather than a
 * pre-fetched queue:
 *   - useArticleStream: fetch-all → wrap → auto-advance a frozen queue on a
 *     clock. Sleep-safe, untethered, no mid-stream network.
 *   - useLivePlay:       poll a live game → whenever a NEW play lands, push it
 *     to the lens. The lens always shows "what just happened" — the newest
 *     play — not a scripted scroll. This is the glasses view of the live
 *     play-by-play the phone shows in the modal.
 *
 * Shares the #43 display-owner arbitration contract EXACTLY (its own OWNER
 * token, claimDisplay/releaseDisplay, tagged sendText, wrap through
 * lineWrapper, go-dark-on-stop). It differs only in cadence: event-driven on
 * new plays instead of a dwell clock.
 *
 * HONESTY (Zoracon): a fetch failure surfaces via `error`; it never freezes the
 * lens on a stale play while pretending the feed is live. We only re-push when
 * the newest play id actually changes, so the same frame isn't re-sent on every
 * poll (saves BLE traffic; coalescing would drop it anyway, but we don't even
 * enqueue it).
 *
 * Team/league-agnostic: it consumes a gameId + league. It knows nothing about OSU.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { G1Core } from '../g1/G1Core';
import { wrapScript, MAX_CHARS, getWindow } from '../teleprompter/lineWrapper';
import { fetchPlayByPlay, periodLabel } from './playByPlay';
import type { League, PlayLine } from './types';

// Distinct per-segment owner token (#43): the live-play lens view holds the
// lens under its OWN token, so an outgoing segment's releaseDisplay on unmount
// can't clear this segment's claim and vice-versa. The arbiter keys only on
// this string.
const OWNER = 'sports.liveplay';

/** How often to poll the live feed while streaming to the lens (ms). */
export const LIVE_POLL_MS = 15000;

/**
 * Format the lens frame for one play: a compact status line (period · clock ·
 * score) over the play text, wrapped to the lens width and clamped to the top
 * window. Pure + exported so the exact lens framing is unit-testable without a
 * device, and so the phone preview can render the identical frame.
 */
export function framePlay(play: PlayLine, league: League): string {
  const meta = [
    periodLabel(league, play.period),
    play.clock,
    play.score,
  ]
    .filter((s) => s.length > 0)
    .join('  ');
  const body = wrapScript(play.text, MAX_CHARS);
  const lines = meta ? [meta, ...body] : body;
  return getWindow(lines, 0).join('\n');
}

export interface UseLivePlay {
  /** The newest play currently on the lens (phone preview mirrors this). */
  current: PlayLine | null;
  /** The exact multi-line frame on the lens (phone preview === lens). */
  currentFrame: string;
  /** True while polling + pushing to the lens. */
  streaming: boolean;
  /** Last fetch error, surfaced — never silently swallowed. */
  error: string | null;
  /** Claim the lens and begin pushing the newest play as plays land. */
  start: () => void;
  /** Stop polling, blank the lens with an empty frame, release ownership. */
  stop: () => void;
}

/**
 * @param core        G1Core for lens I/O + display arbitration.
 * @param gameId      ESPN event id to follow.
 * @param league      league (selects the ESPN sport path).
 * @param isConnected lens link is usable (gates the actual push).
 * @param pollMs      live poll cadence (default LIVE_POLL_MS).
 */
export function useLivePlay(
  core: G1Core,
  gameId: string,
  league: League,
  isConnected: boolean,
  pollMs: number = LIVE_POLL_MS,
): UseLivePlay {
  const [current, setCurrent] = useState<PlayLine | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The play id last PUSHED to the lens — so we only re-push on a genuinely new
  // play, not on every poll that returns the same newest play.
  const pushedIdRef = useRef<string | null>(null);

  // Poll the live feed while streaming. Event-driven: push only when the newest
  // play id changes. Aborts in flight on stop/unmount; a fetch error surfaces
  // and leaves the last good play on the lens (we do NOT blank on a transient
  // network blip — but we DO surface it so the staleness is visible, not faked).
  useEffect(() => {
    if (!streaming) return;
    let cancelled = false;
    const ctrl = new AbortController();

    const poll = async () => {
      try {
        const plays = await fetchPlayByPlay(gameId, league, ctrl.signal);
        if (cancelled || ctrl.signal.aborted) return;
        setError(null);
        const newest = plays[0] ?? null; // extractPlayByPlay returns newest-first
        if (!newest) return;
        setCurrent(newest);
        if (newest.id !== pushedIdRef.current) {
          pushedIdRef.current = newest.id;
          if (isConnected && !core.status.poweredOff) {
            void core.sendText(framePlay(newest, league), 1, 1, true, undefined, OWNER);
          }
        }
      } catch (e) {
        if (!cancelled && !ctrl.signal.aborted) {
          setError(e instanceof Error ? e.message : 'Failed to load play-by-play');
        }
      }
    };

    void poll();
    const timer = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(timer);
    };
  }, [streaming, gameId, league, isConnected, pollMs, core]);

  const start = useCallback(() => {
    core.claimDisplay(OWNER);
    pushedIdRef.current = null; // force a push of the current newest play
    setStreaming(true);
  }, [core]);

  const stop = useCallback(() => {
    setStreaming(false);
    pushedIdRef.current = null;
    // Not clearDisplay(): that sends silent(true), the Power Off packet, and
    // nothing wakes the lens afterwards, so the next game and the top-game HUD
    // were drawn to a display that was asleep.
    core.yieldDisplay(OWNER);
  }, [core]);

  // Safety net: if this hook unmounts while still streaming (tab switch, nav
  // away), release the lens so we don't strand ownership (#43). Mirrors the
  // release-on-unmount guard in useArticleStream.
  // yieldDisplay is a no-op unless this hook holds the lens, so it needs no
  // streaming check (the old one read the first render's value, always false).
  useEffect(() => () => core.yieldDisplay(OWNER), [core]);

  const currentFrame = current ? framePlay(current, league) : '';
  return { current, currentFrame, streaming, error, start, stop };
}
