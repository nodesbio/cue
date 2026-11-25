/**
 * app/deck/[id].tsx — review a single user deck (SRS Phase 3 UI).
 *
 * Loads the deck's cards from store.ts, runs them through useReviewSession (the
 * same SM-2 engine the Sports deck uses), and renders the shared ReviewCard. No
 * network, no live feed — a manual deck's cards are whatever the wearer typed.
 *
 * Lens: this screen does NOT yet push to the glasses — that's the Sports deck's
 * Play-to-lens path, which is coupled to the live feed. Mirroring a manual deck
 * to the lens is the natural next step (reuse ReviewCard's centerSlot), kept out
 * of this commit to avoid touching the killer-feature lens arbiter.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { getDeckMeta, type DeckMeta } from '@/lib/srs/registry';
import { loadDeck } from '@/lib/srs/store';
import { useReviewSession } from '@/lib/srs/useReviewSession';
import type { Card } from '@/lib/srs/card';
import { ReviewCard } from '@/components/ReviewCard';

const C = { bg: '#0a0a0a', text: '#ffffff', dim: '#777777', accent: '#39d353', hot: '#ff6b3d', border: '#1f1f1f' };

export default function DeckReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [meta, setMeta] = useState<DeckMeta | null>(null);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [m, c] = await Promise.all([getDeckMeta(id), loadDeck(id)]);
        if (!alive) return;
        setMeta(m);
        setCards(c ?? []);
      } catch (e) {
        if (alive) setLoadError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [id]);

  // Hook must run every render (rules-of-hooks); feed [] until cards resolve.
  const review = useReviewSession(id, cards ?? [], true);

  const editDeck = useCallback(() => {
    router.push({ pathname: '/deck/new', params: { id } });
  }, [id]);

  return (
    <SafeAreaView style={s.safe}>
      <Stack.Screen options={{ title: meta?.name ?? 'Deck', headerBackTitle: 'Decks' }} />

      {loadError ? (
        <Text style={s.error}>⚠ {loadError}</Text>
      ) : cards === null ? (
        <View style={s.center}><ActivityIndicator color={C.accent} /></View>
      ) : (
        <View style={s.body}>
          <View style={s.topRow}>
            <Text style={s.name} numberOfLines={1}>{meta?.name ?? 'Deck'}</Text>
            <Pressable onPress={editDeck} hitSlop={8}><Text style={s.edit}>Edit</Text></Pressable>
          </View>

          {cards.length === 0 ? (
            <View style={s.center}>
              <Text style={s.emptyBody}>This deck has no cards yet.</Text>
              <Pressable onPress={editDeck} style={s.cta}><Text style={s.ctaText}>Add cards</Text></Pressable>
            </View>
          ) : (
            <ReviewCard review={review} deckLabel={(meta?.name ?? 'DECK').toUpperCase()} />
          )}

          {cards.length > 0 && (
            <Pressable onPress={() => review.restart()} hitSlop={6} style={s.restart}>
              <Text style={s.restartText}>↻ Restart session</Text>
            </Pressable>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  body: { flex: 1, padding: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  name: { color: C.text, fontSize: 22, fontWeight: '700', flex: 1 },
  edit: { color: C.accent, fontSize: 15, fontWeight: '600', marginLeft: 12 },
  error: { color: C.hot, fontSize: 14, margin: 20, lineHeight: 20 },
  emptyBody: { color: C.dim, fontSize: 15, textAlign: 'center', marginBottom: 20 },
  cta: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 24 },
  ctaText: { color: '#06220f', fontSize: 15, fontWeight: '700' },
  restart: { alignItems: 'center', marginTop: 20 },
  restartText: { color: C.dim, fontSize: 13 },
});
