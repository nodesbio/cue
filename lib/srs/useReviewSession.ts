/**
 * useReviewSession.ts — React binding for the review engine (SRS Phase 2).
 *
 * Wires the pure session state machine (review.ts) to:
 *   - persistence (store.ts): every grade is saved immediately, so earned
 *     intervals survive an app kill mid-session.
 *   - the G1 input surface (useG1Event): ONE subscription covers both glasses
 *     taps and the SmartRemote media buttons (see G1Context.useG1Event). Mapping:
 *         single_tap (▶▶)  → next   (navigation only)
 *         double_tap (◀◀)  → prev   (navigation only)
 *         triple_tap (⏯)   → markDone (reveal, then Grade.Good)
 *
 * Grades mutate the *persisted* deck (the full card list), not just the session
 * queue, so a card's new due-date is remembered next time the deck is opened.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useG1Event } from '../g1/G1Context';
import type { Grade } from './card';
import { type Card, type DeckId } from './card';
import { loadDeck, saveDeck } from './store';
import {
  startSession,
  currentCard,
  reveal as revealSession,
  next as nextSession,
  prev as prevSession,
  markDone as markDoneSession,
  grade as gradeSession,
  remaining as remainingCount,
  type ReviewSession,
} from './review';

export interface UseReviewSession {
  session: ReviewSession;
  current: Card | null;
  /** Whether the current card's answer is shown. */
  revealed: boolean;
  remaining: number;
  /** True once the deck has loaded from storage. */
  ready: boolean;
  /** Non-null when storage was corrupt — surface it, don't hide it. */
  error: Error | null;
  reveal: () => void;
  next: () => void;
  prev: () => void;
  /** Reveal-then-Good (the remote ⏯ / phone "mark done"). */
  markDone: () => void;
  /** Explicit 4-button grade (phone UI). */
  grade: (g: Grade) => void;
  /** Restart a fresh session over the currently-due cards. */
  restart: () => void;
}

const EMPTY: ReviewSession = { cards: [], index: -1, revealed: false };

/**
 * Drive a review session over a deck's cards. `cards` is the full, up-to-date
 * deck (already merged with fresh content by the caller); it is persisted under
 * `deckId` and used as the source of due cards. Pass `enabled=false` to ignore
 * remote input (e.g. when the Deck view isn't focused).
 */
export function useReviewSession(
  deckId: DeckId,
  cards: Card[],
  enabled: boolean = true,
): UseReviewSession {
  const [deck, setDeck] = useState<Card[]>(cards);
  const [session, setSession] = useState<ReviewSession>(EMPTY);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Load persisted scheduling once, then start a session over what's due.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const stored = await loadDeck(deckId);
        const effective = stored ?? cards;
        if (!alive) return;
        setDeck(effective);
        setSession(startSession(effective));
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e as Error); // corruption surfaced, not swallowed
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId]);

  /** Apply a graded card back into the persisted deck and save. */
  const commit = useCallback(
    (graded: Card | null) => {
      if (!graded) return;
      setDeck((prevDeck) => {
        const updated = prevDeck.map((c) => (c.id === graded.id ? graded : c));
        void saveDeck(deckId, updated);
        return updated;
      });
    },
    [deckId],
  );

  const reveal = useCallback(() => setSession((s) => revealSession(s)), []);
  const next = useCallback(() => setSession((s) => nextSession(s)), []);
  const prev = useCallback(() => setSession((s) => prevSession(s)), []);

  const markDone = useCallback(() => {
    setSession((s) => {
      const { session: ns, graded } = markDoneSession(s);
      commit(graded);
      return ns;
    });
  }, [commit]);

  const grade = useCallback(
    (g: Grade) => {
      setSession((s) => {
        const { session: ns, graded } = gradeSession(s, g);
        commit(graded);
        return ns;
      });
    },
    [commit],
  );

  const restart = useCallback(() => {
    setDeck((d) => { setSession(startSession(d)); return d; });
  }, []);

  // Unified glasses + SmartRemote input. Latest-closure via useG1Event's ref.
  const handlers = useRef({ next, prev, markDone, enabled });
  handlers.current = { next, prev, markDone, enabled };
  useG1Event((e) => {
    if (!handlers.current.enabled) return;
    switch (e.name) {
      case 'single_tap': handlers.current.next(); break;
      case 'double_tap': handlers.current.prev(); break;
      case 'triple_tap': handlers.current.markDone(); break;
    }
  });

  return {
    session,
    current: currentCard(session),
    revealed: session.revealed,
    remaining: remainingCount(session),
    ready,
    error,
    reveal,
    next,
    prev,
    markDone,
    grade,
    restart,
  };
}
