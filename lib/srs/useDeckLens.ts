/**
 * useDeckLens.ts — mirror a review card to the G1 lens (SRS Phase 3, follow-up).
 *
 * A manual study deck's lens needs are the plain arbiter dance: useReviewSession
 * already owns "the current card", so there's no network/index plumbing like the
 * sports deck. This is now a thin wrapper over useLensOwner (the shared primitive)
 * that fixes the owner token to 'deck.manual' and keeps the deck-specific frame
 * composition (composeLensFrame). All claim/push/yield/guard behaviour lives in
 * useLensOwner so every lens producer shares one implementation.
 */

import type { G1Core } from '@/lib/g1/G1Core';
import { useLensOwner, type UseLensOwner } from '@/lib/g1/useLensOwner';
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

export type UseDeckLens = UseLensOwner;

/**
 * Mirror `text` to the lens while active, under the 'deck.manual' owner.
 *
 * @param core        the shared G1 core
 * @param isConnected both lenses usable (the screen's isConnected)
 * @param text        the frame to show — caller composes it (see composeLensFrame)
 * @param enabled     false disables start() and stops an active session
 */
export function useDeckLens(
  core: G1Core,
  isConnected: boolean,
  text: string,
  enabled = true,
): UseDeckLens {
  return useLensOwner(core, isConnected, DECK_MANUAL_OWNER, text, { enabled });
}
