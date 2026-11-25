/**
 * useDeckLens.ts — mirror a review card to the G1 lens (SRS Phase 3, follow-up).
 *
 * The Sports deck mirrors its card to the glasses via useDeck, which is welded to
 * the sports network fetch + ranked-deck index. A manual deck has none of that:
 * useReviewSession already owns "the current card", so lens mirroring reduces to
 * the arbiter dance alone — claim on start, push the card text while on, blank +
 * yield on stop/blur/unmount. This hook is that dance and nothing else, so the
 * study path reuses the exact lens contract without dragging in sports plumbing.
 *
 * Owner token is 'deck.manual' — distinct from 'sports.deck'/'sports.live' so the
 * arbiter treats a study deck as its own display claimant (last claimer wins the
 * handoff; a stray sports push tagged with a different owner is rejected).
 *
 * Contract mirrors useDeck exactly (verified against lib/sports/useDeck.ts):
 *   - start():  claimDisplay(OWNER); the push effect fires once `on` flips true.
 *   - push:     only when on && connected && !poweredOff (guard avoids enqueuing
 *               frames the arbiter/tx would drop).
 *   - stop():   yieldDisplay(OWNER) — blanks via a space frame THEN releases, so
 *               we never strand a stale card on the lens (not clearDisplay, which
 *               isn't owner-gated and could blank another owner's frame).
 */

import { useCallback, useEffect, useState } from 'react';
import type { G1Core } from '@/lib/g1/G1Core';
import type { Card } from '@/lib/srs/card';

/** Distinct lens-owner token for manually-authored study decks. */
export const DECK_MANUAL_OWNER = 'deck.manual';

/**
 * Compose the lens frame for a review card. The lens tracks the on-screen reveal:
 * prompt alone while recalling, prompt + answer once revealed — so the wearer
 * reads hands-free exactly what they'd tap to see on the phone. Returns '' when
 * there is no card (session done / empty deck); callers must not push an empty
 * frame (the arbiter would drop it anyway, but '' also means "nothing to show").
 */
export function composeLensFrame(card: Card | null, revealed: boolean): string {
  if (!card) return '';
  return revealed ? `${card.prompt}\n\n${card.answer}` : card.prompt;
}

export interface UseDeckLens {
  /** True while the deck holds the lens. */
  on: boolean;
  /** Claim the lens and begin mirroring the current card. */
  start: () => void;
  /** Blank the lens and hand ownership back. */
  stop: () => void;
  /** Convenience toggle for a single Play/Pause control. */
  toggle: () => void;
}

/**
 * Mirror `text` to the lens while active.
 *
 * @param core        the shared G1 core
 * @param isConnected both lenses usable (the screen's isConnected AND)
 * @param text        the frame to show — caller composes it (e.g. prompt, or
 *                    prompt + revealed answer). Empty/whitespace is not pushed.
 * @param enabled     false disables start() entirely (e.g. deck not focused);
 *                    an already-active session is stopped when this goes false.
 */
export function useDeckLens(
  core: G1Core,
  isConnected: boolean,
  text: string,
  enabled = true,
): UseDeckLens {
  const [on, setOn] = useState(false);

  const start = useCallback(() => {
    if (!enabled) return;
    core.claimDisplay(DECK_MANUAL_OWNER);
    setOn(true);
    // The push happens in the effect below once `on` flips true.
  }, [core, enabled]);

  const stop = useCallback(() => {
    setOn(false);
    core.yieldDisplay(DECK_MANUAL_OWNER);
  }, [core]);

  const toggle = useCallback(() => {
    on ? stop() : start();
  }, [on, start, stop]);

  // Push to the lens whenever the mirrored text changes while on + connected.
  const frame = text.trim();
  useEffect(() => {
    if (!on || !frame) return;
    if (isConnected && !core.status.poweredOff) {
      void core.sendText(frame, 1, 1, true, undefined, DECK_MANUAL_OWNER);
    }
  }, [on, frame, isConnected, core]);

  // If the deck gets disabled (e.g. tab loses focus) while mirroring, hand the
  // lens back rather than stranding the last card on the glasses.
  useEffect(() => {
    if (!enabled && on) stop();
  }, [enabled, on, stop]);

  // Last line of defence: unmount must not leave a claimed, stale lens.
  useEffect(() => () => { core.yieldDisplay(DECK_MANUAL_OWNER); }, [core]);

  return { on, start, stop, toggle };
}
