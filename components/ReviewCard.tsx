/**
 * ReviewCard.tsx — the shared review surface (card face + grade/nav rows).
 *
 * Extracted so the standalone Deck review screen (app/deck/[id]) and the Sports
 * tab's DeckView render ONE review UI, not two drifting copies (Portnoy, DRY).
 * It is purely presentational: it takes a UseReviewSession and renders the
 * recall/answer face plus the 4-button grade row (revealed) or the prev/next
 * nav row (not revealed). Lens-specific controls (Play-to-lens, pickers) stay in
 * the host screen — this component knows nothing about glasses or sources.
 *
 * NOTE: the Sports DeckView is NOT yet migrated onto this — that path drives the
 * killer-feature Play-to-lens demo and shouldn't be destabilised in the same
 * change that introduces user decks. Migrating it is a follow-up (one concern
 * per PR); the shared component exists now so the new screen doesn't fork a copy.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Grade } from '@/lib/srs/card';
import type { UseReviewSession } from '@/lib/srs/useReviewSession';

const C = {
  card: '#141414',
  border: '#1f1f1f',
  text: '#ffffff',
  dim: '#777777',
  accent: '#39d353',
  hot: '#ff6b3d',
};

export interface ReviewCardProps {
  review: UseReviewSession;
  /** Short label shown above the prompt (e.g. the deck name, uppercased). */
  deckLabel: string;
  /** Optional middle button when not revealed (e.g. Play-to-lens). Omitted → nav only. */
  centerSlot?: React.ReactNode;
}

export function ReviewCard({ review, deckLabel, centerSlot }: ReviewCardProps) {
  const current = review.current;
  const done = review.ready && !current;

  return (
    <View>
      <Pressable
        style={s.deckCard}
        onPress={() => review.reveal()}
        disabled={!current || review.revealed}
      >
        {!review.ready ? (
          <Text style={s.muted}>Loading…</Text>
        ) : review.error ? (
          <Text style={[s.muted, { color: C.hot }]}>⚠ Couldn’t load your progress.</Text>
        ) : done ? (
          <Text style={s.muted}>✓ All caught up. Nothing due right now.</Text>
        ) : current ? (
          <>
            <View style={s.meta}>
              <Text style={s.label}>{deckLabel}</Text>
              <View style={[s.badge, review.revealed ? s.badgeAnswer : s.badgeRecall]}>
                <Text style={s.badgeText}>{review.revealed ? 'ANSWER' : 'RECALL'}</Text>
              </View>
            </View>
            <Text style={s.prompt}>{current.prompt}</Text>
            {review.revealed ? (
              <Text style={[s.prompt, { marginTop: 14, color: C.accent }]}>{current.answer}</Text>
            ) : (
              <Text style={[s.muted, { marginTop: 14 }]}>Tap to reveal</Text>
            )}
            <Text style={s.count}>{review.remaining} due</Text>
          </>
        ) : (
          <Text style={s.muted}>No cards in this deck yet.</Text>
        )}
      </Pressable>

      {current && review.revealed && (
        <View style={s.nav}>
          <Pressable onPress={() => review.grade(Grade.Again)} style={[s.navBtn, { flex: 1, marginRight: 6, borderColor: C.hot }]} hitSlop={6}>
            <Text style={s.navText}>Again</Text>
          </Pressable>
          <Pressable onPress={() => review.grade(Grade.Hard)} style={[s.navBtn, { flex: 1, marginHorizontal: 6 }]} hitSlop={6}>
            <Text style={s.navText}>Hard</Text>
          </Pressable>
          <Pressable onPress={() => review.markDone()} style={[s.cta, { flex: 1, marginHorizontal: 6 }]} hitSlop={6}>
            <Text style={s.ctaText}>Good</Text>
          </Pressable>
          <Pressable onPress={() => review.grade(Grade.Easy)} style={[s.navBtn, { flex: 1, marginLeft: 6, borderColor: C.accent }]} hitSlop={6}>
            <Text style={s.navText}>Easy</Text>
          </Pressable>
        </View>
      )}

      {current && !review.revealed && (
        <View style={s.nav}>
          <Pressable onPress={() => review.prev()} style={s.navBtn} hitSlop={8}>
            <Text style={s.navText}>‹ Prev</Text>
          </Pressable>
          {centerSlot ?? <View style={{ flex: 1 }} />}
          <Pressable onPress={() => review.next()} style={s.navBtn} hitSlop={8}>
            <Text style={s.navText}>Next ›</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  deckCard: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 20, minHeight: 180, justifyContent: 'center' },
  muted: { color: C.dim, fontSize: 15, textAlign: 'center' },
  meta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  label: { color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeRecall: { backgroundColor: '#1f1f1f' },
  badgeAnswer: { backgroundColor: '#13351f' },
  badgeText: { color: C.text, fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  prompt: { color: C.text, fontSize: 20, lineHeight: 27, fontWeight: '600' },
  count: { color: C.dim, fontSize: 12, marginTop: 16 },
  nav: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  navBtn: { borderColor: C.border, borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16 },
  navText: { color: C.text, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  cta: { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  ctaText: { color: '#06220f', fontSize: 14, fontWeight: '700' },
});
