/**
 * app/deck/index.tsx — the Decks library (SRS Phase 3 UI).
 *
 * Lists every deck in the registry (registry.listDecks) — the user-authored
 * study decks (Evan's psychology set) that have no live feed behind them. Tap a
 * deck to review it (/deck/[id]); "+ New deck" opens the editor (/deck/new).
 *
 * This is the user-facing payoff of Phase 3: the standalone flashcard product,
 * reachable without going through Sports. Revenue angle — this is the mode a
 * student keeps the glasses on for all day: glance-to-recall between classes.
 */

import { useCallback, useState } from 'react';
import { Alert, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { listDecks, registerDeck, unregisterDeck, type DeckMeta } from '@/lib/srs/registry';
import { deleteDeck, saveDeck } from '@/lib/srs/store';
import { parseDeckFile, importDeckFile, DeckFileError } from '@/lib/srs/deckio';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

const C = {
  bg: '#0a0a0a', card: '#141414', border: '#1f1f1f',
  text: '#ffffff', dim: '#777777', accent: '#39d353', hot: '#ff6b3d',
};

const SOURCE_BADGE: Record<DeckMeta['source'], string> = {
  manual: 'MADE BY YOU', sports: 'SPORTS', anki: 'ANKI',
};

export default function DecksScreen() {
  const [decks, setDecks] = useState<DeckMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    let alive = true;
    (async () => {
      try {
        const all = await listDecks();
        if (alive) { setDecks(all); setError(null); }
      } catch (e) {
        // Surfaced, not swallowed — a corrupt registry must not render as "no decks".
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, []);

  useFocusEffect(reload);

  // Import: pick a .cuedeck.json, validate it, and persist it as a BRAND-NEW deck
  // (fresh id + re-based card ids) so importing never overwrites an existing deck.
  // A re-import of the same file simply creates a second copy — expected and safe.
  const [importing, setImporting] = useState(false);
  const importDeck = useCallback(async () => {
    setImporting(true);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/json', 'public.json', '*/*'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const raw = await new FileSystem.File(res.assets[0].uri).text();
      const file = parseDeckFile(raw); // throws DeckFileError on anything malformed
      const { meta, cards } = importDeckFile(file);
      await saveDeck(meta.id, cards); // cards first — meta pointing at missing cards is worse
      await registerDeck(meta);
      reload();
      Alert.alert('Deck imported', `“${meta.name}” added with ${meta.cardCount} ${meta.cardCount === 1 ? 'card' : 'cards'}.`);
    } catch (e) {
      const msg = e instanceof DeckFileError ? e.message : (e as Error).message;
      Alert.alert('Import failed', msg);
    } finally {
      setImporting(false);
    }
  }, [reload]);

  const confirmDelete = useCallback((deck: DeckMeta) => {
    Alert.alert(
      `Delete “${deck.name}”?`,
      'This removes the deck and all your review progress for it. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            await unregisterDeck(deck.id); // registry first
            await deleteDeck(deck.id);     // then its cards
            reload();
          },
        },
      ],
    );
  }, [reload]);

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Text style={s.title}>Decks</Text>
        <View style={s.headerBtns}>
          <Pressable onPress={importDeck} disabled={importing} hitSlop={8} style={s.importBtn}>
            <Text style={s.importText}>{importing ? '…' : '↓ Import'}</Text>
          </Pressable>
          <Pressable onPress={() => router.push('/deck/new')} hitSlop={8} style={s.newBtn}>
            <Text style={s.newText}>+ New</Text>
          </Pressable>
        </View>
      </View>

      {error ? (
        <Text style={s.errorBox}>⚠ {error}</Text>
      ) : decks.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyTitle}>No decks yet</Text>
          <Text style={s.emptyBody}>
            Make a deck of flashcards — terms, definitions, anything you want to recall hands-free on the glasses.
          </Text>
          <Pressable onPress={() => router.push('/deck/new')} style={s.cta}>
            <Text style={s.ctaText}>Create your first deck</Text>
          </Pressable>
          <Pressable onPress={importDeck} disabled={importing} hitSlop={8} style={s.emptyImport}>
            <Text style={s.emptyImportText}>{importing ? 'Importing…' : 'or import a .cuedeck file'}</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4 }}>
          {decks.map((d) => (
            <Pressable
              key={d.id}
              style={s.row}
              onPress={() => router.push({ pathname: '/deck/[id]', params: { id: d.id } })}
              onLongPress={() => confirmDelete(d)}
            >
              <View style={{ flex: 1 }}>
                <Text style={s.rowName} numberOfLines={1}>{d.name}</Text>
                <Text style={s.rowSub}>{d.cardCount} {d.cardCount === 1 ? 'card' : 'cards'} · {SOURCE_BADGE[d.source]}</Text>
              </View>
              <Text style={s.chevron}>›</Text>
            </Pressable>
          ))}
          <Text style={s.hint}>Long-press a deck to delete it.</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  title: { color: C.text, fontSize: 28, fontWeight: '800' },
  headerBtns: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  newBtn: { borderColor: C.accent, borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 7 },
  newText: { color: C.accent, fontSize: 14, fontWeight: '700' },
  importBtn: { borderColor: C.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 },
  importText: { color: C.dim, fontSize: 14, fontWeight: '700' },
  emptyImport: { marginTop: 18, paddingVertical: 6 },
  emptyImportText: { color: C.dim, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },
  errorBox: { color: C.hot, fontSize: 14, margin: 20, lineHeight: 20 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { color: C.text, fontSize: 20, fontWeight: '700', marginBottom: 10 },
  emptyBody: { color: C.dim, fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 24 },
  cta: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 24 },
  ctaText: { color: '#06220f', fontSize: 15, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 10 },
  rowName: { color: C.text, fontSize: 17, fontWeight: '600' },
  rowSub: { color: C.dim, fontSize: 12, marginTop: 4, letterSpacing: 0.5 },
  chevron: { color: C.dim, fontSize: 22, marginLeft: 12 },
  hint: { color: C.dim, fontSize: 12, textAlign: 'center', marginTop: 8 },
});
