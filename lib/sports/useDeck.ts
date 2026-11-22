/**
 * useDeck — load an audience's conversation deck and drive lens navigation (#46).
 *
 * Responsibilities (all UI-triggered, no remote in v1 per the backlog):
 *   - fetch every topic's cards in parallel (fetchTopicCards, #45),
 *   - assemble the ordered/capped deck (buildDeck, #46),
 *   - expose index + next/prev + current card,
 *   - push the current card to the lens when "playing", blank it on pause,
 *   - claim/release the 'sports' display owner so it coexists with the live HUD
 *     and the teleprompter (the #43 arbiter).
 *
 * The hook owns no clock: refresh is explicit (pull-to-refresh / interval wired
 * by the screen). It does NOT auto-advance — stepping is a deliberate user act so
 * the wearer controls the conversation.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { G1Core } from '../g1/G1Core';
import type { Audience } from './audience';
import { topicKey } from './audience';
import type { Card } from './cards';
import { fetchTopicCards } from './cards';
import { buildDeck } from './deck';

// Distinct per-segment owner token (#43): see useArticleStream for rationale.
// Shared 'sports' tokens let an unmounting segment release the incoming claim.
const OWNER = 'sports.deck';

export interface UseDeck {
  deck: Card[];
  index: number;
  current: Card | null;
  loading: boolean;
  error: string | null;
  /** True while the deck owns the lens (not paused). */
  playing: boolean;
  next: () => void;
  prev: () => void;
  /** Blank the lens and release ownership without losing deck position. */
  pause: () => void;
  /** Re-claim the lens and re-push the current card. */
  play: () => void;
  /** Re-fetch all topic cards and rebuild (keeps index in range). */
  refresh: () => void;
}

/**
 * @param core        G1Core for lens I/O + display arbitration.
 * @param audience    the audience to run, or null (empty deck).
 * @param liveTopicKeys topicKey()s with a live game right now (promoted first);
 *                    pass the set derived from the running SportsFeed, or empty.
 * @param isConnected lens link is usable (gates the actual push).
 */
export function useDeck(
  core: G1Core,
  audience: Audience | null,
  liveTopicKeys: ReadonlySet<string>,
  isConnected: boolean,
): UseDeck {
  const [deck, setDeck] = useState<Card[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  // Abort in-flight fetches when the audience changes or we unmount.
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    if (!audience || audience.topics.length === 0) {
      setDeck([]);
      setIndex(0);
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const entries = await Promise.all(
        audience.topics.map(async (t) => {
          const cards = await fetchTopicCards(t, ctrl.signal);
          return [topicKey(t), cards] as const;
        }),
      );
      if (ctrl.signal.aborted) return;
      const byTopic: Record<string, Card[]> = {};
      for (const [k, cards] of entries) byTopic[k] = cards;
      const built = buildDeck(audience, byTopic, { liveTopicKeys });
      setDeck(built);
      setIndex((i) => (built.length === 0 ? 0 : Math.min(i, built.length - 1)));
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
    // liveTopicKeys intentionally excluded: a live-set change should re-rank via
    // the dedicated effect below, not trigger a full network reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience]);

  // (Re)load when the audience changes. A live-set change re-ranks via refresh()
  // from the screen (buildDeck is pure) rather than refetching the network.
  useEffect(() => { void load(); return () => abortRef.current?.abort(); }, [load]);

  const current = deck.length > 0 ? deck[Math.min(index, deck.length - 1)] : null;

  // Push the current card whenever it changes while playing + connected.
  const currentText = current?.text ?? '';
  useEffect(() => {
    if (!playing || !currentText) return;
    if (isConnected && !core.status.poweredOff) {
      void core.sendText(currentText, 1, 1, true, undefined, OWNER);
    }
  }, [playing, currentText, isConnected, core]);

  const play = useCallback(() => {
    core.claimDisplay(OWNER);
    setPlaying(true);
    // The push happens in the effect above once `playing` flips true.
  }, [core]);

  const pause = useCallback(() => {
    setPlaying(false);
    // Blank the lens and hand ownership back.
    core.yieldDisplay(OWNER);
  }, [core]);

  const next = useCallback(() => {
    setIndex((i) => (deck.length === 0 ? 0 : Math.min(i + 1, deck.length - 1)));
  }, [deck.length]);

  const prev = useCallback(() => {
    setIndex((i) => Math.max(i - 1, 0));
  }, []);

  const refresh = useCallback(() => { void load(); }, [load]);

  // Release the lens on unmount if we still hold it.
  useEffect(() => () => {
    core.releaseDisplay(OWNER);
    abortRef.current?.abort();
  }, [core]);

  return { deck, index, current, loading, error, playing, next, prev, pause, play, refresh };
}
