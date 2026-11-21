/**
 * useArticleStream — ambient, auto-advancing prose stream for the lens (#49).
 *
 * The sibling of useDeck: same display-owner arbitration and push gating (the
 * #43 arbiter), but instead of stepping through cards on user taps, it streams
 * the FULL prose of selected articles past your eyes on a clock — hands-free,
 * phone-in-pocket. "Pick articles on the phone, stream the prose on the lens."
 *
 * UNTETHERED DESIGN (this is built for TestFlight on a real device):
 *   - Prose is fetched + wrapped into a FLAT line list BEFORE streaming starts.
 *     Once playing, advancing is pure local state — no network mid-stream, so a
 *     backgrounded app / pocketed phone doesn't stall the feed.
 *   - Fetch failures are surfaced per-article (video / empty-body / network),
 *     never silently skipped into a blank stretch (Zoracon). Unstreamable
 *     articles are reported in `skipped`, not hidden.
 *   - Play-through-then-dark: at the end it blanks the lens and releases the
 *     owner — no infinite glow at 3am (sleep-safe).
 *
 * Team/league-agnostic: it consumes article ids. It knows nothing about OSU.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { G1Core } from '../g1/G1Core';
import { wrapScript, MAX_CHARS, WINDOW_SIZE, getWindow } from '../teleprompter/lineWrapper';
import {
  fetchArticleBody,
  ArticleUnavailableError,
  type ArticleProse,
  type ArticleRejectReason,
} from './articleStream';
import { markSeen } from './SeenStore';
import {
  saveStreamQueue,
  saveResumeIndex,
  clearStreamQueue,
  loadStreamQueue,
} from './StreamQueueStore';

// Distinct per-segment owner token (#43/#49): LiveSportsView, DeckView and
// StreamView each hold the lens under their OWN token so an outgoing segment's
// releaseDisplay on unmount cannot clear the incoming segment's fresh claim.
// The arbiter keys only on this string — shared tokens are indistinguishable.
const OWNER = 'sports.stream';

/** Default dwell per lens window while auto-advancing (ms). Reading pace. */
export const DEFAULT_DWELL_MS = 5500;

/** One article that could not be streamed, with a surfaced reason. */
export interface SkippedArticle {
  articleId: string;
  reason: ArticleRejectReason | 'network';
  detail: string;
}

/** A streamed line with the article it belongs to (for phone-side progress). */
export interface StreamLine {
  articleId: string;
  /** True on the first line of an article (headline boundary / "new story"). */
  isHead: boolean;
  text: string;
}

/** Result of assembling a queue of article ids into a flat lens line list. */
export interface AssembledStream {
  lines: StreamLine[];
  skipped: SkippedArticle[];
}

/**
 * Pure stream assembly — fetch each article id in order, wrap its prose into
 * ≤45-col lens lines, and flatten into one list. Unstreamable articles (video,
 * empty body, network) are collected into `skipped` with a surfaced reason,
 * never silently dropped into a blank stretch (Zoracon).
 *
 * Team/league-agnostic and network-injectable so it's unit-testable without a
 * device or live ESPN. The hook is a thin React wrapper over this.
 *
 * @param fetchBody  injected fetcher (production: fetchArticleBody).
 * @param articleIds queue order == read order.
 */
export async function assembleStream(
  fetchBody: (id: string, signal?: AbortSignal) => Promise<ArticleProse>,
  articleIds: readonly string[],
  signal?: AbortSignal,
): Promise<AssembledStream> {
  const lines: StreamLine[] = [];
  const skipped: SkippedArticle[] = [];

  for (const id of articleIds) {
    if (signal?.aborted) break;
    let prose: ArticleProse;
    try {
      prose = await fetchBody(id, signal);
    } catch (e) {
      if (signal?.aborted) break;
      if (e instanceof ArticleUnavailableError) {
        skipped.push({ articleId: id, reason: e.reason, detail: e.message });
      } else {
        // Real network/HTTP failure — surface it, don't bury it (Zoracon).
        skipped.push({ articleId: id, reason: 'network', detail: (e as Error).message });
      }
      continue;
    }
    // The fetch may have resolved concurrently with an abort (phone locked
    // mid-request). Re-check before committing this article's lines, so an
    // aborted stream never grows after the fact (untethered correctness).
    if (signal?.aborted) break;
    const head = wrapScript(prose.headline, MAX_CHARS);
    head.forEach((t, i) => lines.push({ articleId: id, isHead: i === 0, text: t }));
    for (const t of wrapScript(prose.body, MAX_CHARS)) {
      lines.push({ articleId: id, isHead: false, text: t });
    }
  }
  return { lines, skipped };
}

/**
 * Pure: the ids of articles fully streamed past by the time the lens window sits
 * at `index` (its top line). An article counts as read once its LAST line is
 * above the window top (index > that line) — i.e. it has scrolled off the top of
 * the lens. On the final window we also count articles whose last line is within
 * the visible window, since play-through-end shows that window then goes dark.
 *
 * Returned in first-seen order, deduped. This is the signal SeenStore records —
 * only articles you actually read to the end, never ones still on/ahead of the
 * lens. Extracted pure so the "mark seen" rule is unit-testable without a device.
 */
export function articlesReadBy(lines: readonly StreamLine[], index: number): string[] {
  if (lines.length === 0) return [];
  const atEnd = index >= lines.length - WINDOW_SIZE;
  // Last line index per article (lines are contiguous per article).
  const lastLineOf = new Map<string, number>();
  lines.forEach((l, i) => lastLineOf.set(l.articleId, i));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [id, last] of lastLineOf) {
    const read = atEnd ? last <= index + WINDOW_SIZE - 1 : last < index;
    if (read && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

export interface UseArticleStream {
  /** Flat, wrapped, ≤45-col lines across all streamable queued articles. */
  lines: StreamLine[];
  /** Index of the current line (top of the lens window). */
  index: number;
  /** The headline of the article currently on the lens, for the phone UI. */
  currentHeadline: string;
  /** Exact multi-line frame currently on the lens (phone preview === lens). */
  currentFrame: string;
  loading: boolean;
  /** Fatal load error (couldn't fetch anything). Per-article issues → skipped. */
  error: string | null;
  /** Articles that couldn't be streamed, each with a surfaced reason. */
  skipped: SkippedArticle[];
  playing: boolean;
  /** True once the stream has played to the end (and gone dark). */
  done: boolean;
  /** Load + wrap the given article ids (does not start playing). */
  load: (articleIds: string[]) => Promise<void>;
  /**
   * Restore a stream frozen by a prior session (cold-kill mid-stream) offline,
   * no re-fetch, and START PLAYING it immediately (claims the lens). Resolves
   * true if a stream was restored + started, false if nothing resumable. Do NOT
   * call play() after — this self-starts. Corrupt snapshots surface via `error`.
   */
  resume: () => Promise<boolean>;
  /** Claim the lens and begin auto-advancing. */
  play: () => void;
  /** Stop advancing, blank the lens, release ownership. Keeps position. */
  pause: () => void;
  /** Jump forward/back one window (manual override of the clock). */
  next: () => void;
  prev: () => void;
  /**
   * The last reachable top index. The clock + next()/prev() step by one window
   * and clamp here, so UIs should derive "at end" from `index >= lastTop`, NOT
   * `lines.length - 1` (which is unreachable). Single source of truth for the
   * stepping bound so callers don't re-import lineWrapper internals.
   */
  lastTop: number;
}

/**
 * @param core        G1Core for lens I/O + display arbitration.
 * @param isConnected lens link is usable (gates the actual push).
 * @param dwellMs     per-window dwell while auto-advancing (default reading pace).
 */
export function useArticleStream(
  core: G1Core,
  isConnected: boolean,
  dwellMs: number = DEFAULT_DWELL_MS,
): UseArticleStream {
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<SkippedArticle[]>([]);
  const [playing, setPlaying] = useState(false);
  const [done, setDone] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ids already persisted to SeenStore this load — avoids re-writing on every
  // window tick. Reset in load() when a new queue comes in.
  const markedRef = useRef<Set<string>>(new Set());

  const load = useCallback(async (articleIds: string[]) => {
    abortRef.current?.abort();
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setPlaying(false);
    setDone(false);
    setIndex(0);
    setSkipped([]);
    setError(null);
    markedRef.current = new Set();

    // A fresh pick supersedes any prior resume snapshot. Clear it now so a
    // cold-kill BEFORE the new stream plays can't resume into last pick's prose.
    clearStreamQueue().catch((e) => {
      console.warn('[useArticleStream] clearStreamQueue (load) failed:', (e as Error).message);
    });

    if (articleIds.length === 0) { setLines([]); return; }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);

    const { lines: out, skipped: skips } = await assembleStream(
      fetchArticleBody,
      articleIds,
      ctrl.signal,
    );

    if (ctrl.signal.aborted) return;
    setLines(out);
    setSkipped(skips);
    if (out.length === 0) {
      setError(
        skips.length > 0
          ? 'None of the selected articles had readable prose.'
          : 'Nothing to stream.',
      );
    }
    setLoading(false);
  }, []);

  const current = lines.length > 0 ? lines[Math.min(index, lines.length - 1)] : null;
  // The exact text pushed to the lens — same getWindow() call as the push effect,
  // so the phone preview shows what the wearer sees, not a divergent single line.
  const currentFrame =
    lines.length > 0 ? getWindow(lines.map((l) => l.text), index).join('\n') : '';
  const currentHeadlineRef = useRef('');
  if (current) {
    // headline = the nearest preceding head line's text
    for (let i = Math.min(index, lines.length - 1); i >= 0; i--) {
      if (lines[i].isHead) { currentHeadlineRef.current = lines[i].text; break; }
    }
  }

  // Push the current window whenever index changes while playing + connected.
  useEffect(() => {
    if (!playing || lines.length === 0) return;
    if (isConnected && !core.status.poweredOff) {
      const frame = getWindow(lines.map((l) => l.text), index).join('\n');
      void core.sendText(frame, 1, 1, true, undefined, OWNER);
    }
  }, [playing, index, lines, isConnected, core]);

  // Record articles streamed past as the window advances (#49 dedup). Only ids
  // not yet persisted this load are written, so a nightly listener won't re-see
  // them. A write failure is surfaced (console), never silenced — a lost "seen"
  // mark just means the article may reappear, which is safe, but we don't want
  // to hide a storage fault (Zoracon). Marking is gated on `playing` so merely
  // scrubbing with next/prev while paused doesn't burn through the backlog.
  useEffect(() => {
    if (!playing || lines.length === 0) return;
    const readNow = articlesReadBy(lines, index).filter((id) => !markedRef.current.has(id));
    if (readNow.length === 0) return;
    for (const id of readNow) markedRef.current.add(id);
    markSeen(readNow).catch((e) => {
      console.warn('[useArticleStream] markSeen failed:', (e as Error).message);
    });
  }, [playing, index, lines]);

  // Track the resume point as the window advances (#49 resilience). Cheap
  // index-only write (doesn't re-serialize the prose each tick) so a cold-kill
  // mid-stream resumes at the right line offline. A write failure is surfaced,
  // never silenced — a stale resume point is safe, but we won't hide a fault.
  useEffect(() => {
    if (!playing || lines.length === 0) return;
    saveResumeIndex(index).catch((e) => {
      console.warn('[useArticleStream] saveResumeIndex failed:', (e as Error).message);
    });
  }, [playing, index, lines.length]);

  // The clock: advance one window per dwell while playing. Local-only (no
  // network), so it keeps ticking with the phone in a pocket.
  useEffect(() => {
    if (!playing || lines.length === 0) return;
    if (index >= lines.length - WINDOW_SIZE) {
      // Reached the end — go dark and release (sleep-safe, no infinite glow).
      timerRef.current = setTimeout(() => {
        setPlaying(false);
        setDone(true);
        void core.clearDisplay('L');
        void core.clearDisplay('R');
        core.releaseDisplay(OWNER);
        // Played to the end — nothing left to resume into, so drop the snapshot
        // (a finished stream resuming into darkness would be the masked-empty
        // bug this store exists to avoid).
        clearStreamQueue().catch((e) => {
          console.warn('[useArticleStream] clearStreamQueue failed:', (e as Error).message);
        });
      }, dwellMs);
      return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    }
    timerRef.current = setTimeout(() => {
      setIndex((i) => Math.min(i + WINDOW_SIZE, Math.max(0, lines.length - WINDOW_SIZE)));
    }, dwellMs);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [playing, index, lines.length, dwellMs, core]);

  const play = useCallback(() => {
    if (lines.length === 0) return;
    core.claimDisplay(OWNER);
    setDone(false);
    setPlaying(true);
    // Freeze the assembled stream so a lock / background / cold-kill resumes it
    // offline from here (#49). Written whole once at play; the per-tick effect
    // then only updates the index. Surfaced, not silenced, on failure.
    saveStreamQueue(lines, skipped, index).catch((e) => {
      console.warn('[useArticleStream] saveStreamQueue failed:', (e as Error).message);
    });
  }, [core, lines, skipped, index]);

  const pause = useCallback(() => {
    setPlaying(false);
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    void core.clearDisplay('L');
    void core.clearDisplay('R');
    core.releaseDisplay(OWNER);
  }, [core]);

  // Restore a snapshot frozen by a prior session (cold-kill / force-quit mid-
  // stream) WITHOUT re-fetching — the prose was frozen at pick time and the
  // network can't be assumed at 3am (#49). Returns true if a stream was
  // restored (caller should then call play()); false if there was nothing
  // resumable. A corrupt snapshot SURFACES via setError, not a silent no-op.
  const resume = useCallback(async (): Promise<boolean> => {
    let snap;
    try {
      snap = await loadStreamQueue();
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
    if (!snap || snap.lines.length === 0) return false;
    abortRef.current?.abort();
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    markedRef.current = new Set();
    setSkipped(snap.skipped);
    setLines(snap.lines);
    setIndex(snap.index);
    setError(null);
    setDone(false);
    // Claim + play HERE off the just-loaded snapshot, not via play(): play()'s
    // guard reads render-time `lines`, which is still stale ([]) in this same
    // tick right after setLines — so it would early-return and never claim the
    // lens. We own the snapshot locally, so start it directly. The window-push
    // effect (gated on isConnected) pushes once state commits + glasses attach.
    core.claimDisplay(OWNER);
    setPlaying(true);
    return true;
  }, [core]);

  const next = useCallback(() => {
    setIndex((i) => Math.min(i + WINDOW_SIZE, Math.max(0, lines.length - WINDOW_SIZE)));
  }, [lines.length]);

  const prev = useCallback(() => {
    setIndex((i) => Math.max(i - WINDOW_SIZE, 0));
  }, []);

  // Release the lens + abort fetches on unmount.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    core.releaseDisplay(OWNER);
    abortRef.current?.abort();
  }, [core]);

  return {
    lines,
    index,
    currentHeadline: currentHeadlineRef.current,
    currentFrame,
    loading,
    error,
    skipped,
    playing,
    done,
    load,
    resume,
    play,
    pause,
    next,
    prev,
    lastTop: Math.max(0, lines.length - WINDOW_SIZE),
  };
}
