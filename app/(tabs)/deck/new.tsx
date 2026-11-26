/**
 * app/deck/new.tsx — create or edit a user-authored deck (SRS Phase 3 UI).
 *
 * One screen for both: no `id` param → create; with `id` → edit the existing
 * deck (rows pre-filled from its cards). Saving:
 *   1. manualToSrs() turns rows into SRS cards with content-stable ids.
 *   2. mergeDeck() reattaches earned scheduling for rows whose text is unchanged,
 *      so editing a deck never resets a student's progress on untouched cards.
 *   3. store.saveDeck persists cards; registry register/update records metadata.
 *
 * Order matters: cards are saved before registry metadata so a crash can never
 * leave a registered deck whose cards don't exist (a visible-but-broken deck).
 */

import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import {
  getDeckMeta, newDeckId, registerDeck, updateDeckMeta,
} from '@/lib/srs/registry';
import { loadDeck, saveDeck, mergeDeck } from '@/lib/srs/store';
import { manualToSrs, type ManualRow } from '@/lib/srs/sources/manual';

const C = { bg: '#0a0a0a', card: '#141414', border: '#1f1f1f', text: '#ffffff', dim: '#777777', accent: '#39d353', hot: '#ff6b3d' };

const BLANK: ManualRow = { prompt: '', answer: '' };

export default function DeckEditorScreen() {
  const { id: editId } = useLocalSearchParams<{ id?: string }>();
  const isEdit = !!editId;

  const [name, setName] = useState('');
  const [rows, setRows] = useState<ManualRow[]>([{ ...BLANK }, { ...BLANK }, { ...BLANK }]);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(!isEdit);

  // Edit mode: hydrate name + rows from the existing deck.
  useEffect(() => {
    if (!editId) return;
    let alive = true;
    (async () => {
      const [meta, cards] = await Promise.all([getDeckMeta(editId), loadDeck(editId)]);
      if (!alive) return;
      if (meta) setName(meta.name);
      if (cards && cards.length) {
        setRows(cards.map((c) => ({ prompt: c.prompt, answer: c.answer })).concat({ ...BLANK }));
      }
      setLoaded(true);
    })();
    return () => { alive = false; };
  }, [editId]);

  function setRow(i: number, patch: Partial<ManualRow>) {
    setRows((prev) => {
      const next = prev.map((r, j) => (j === i ? { ...r, ...patch } : r));
      // Keep one trailing blank row so there's always somewhere to type.
      const last = next[next.length - 1];
      if (last.prompt.trim() || last.answer.trim()) next.push({ ...BLANK });
      return next;
    });
  }

  function removeRow(i: number) {
    setRows((prev) => (prev.length <= 1 ? [{ ...BLANK }] : prev.filter((_, j) => j !== i)));
  }

  const validCount = rows.filter((r) => r.prompt.trim() && r.answer.trim()).length;
  const canSave = name.trim().length > 0 && validCount > 0 && !saving;

  async function onSave() {
    if (!canSave) return;
    setSaving(true);
    try {
      const deckId = editId ?? newDeckId();
      const fresh = manualToSrs(deckId, rows);

      // Preserve scheduling on edit: merge fresh cards over any existing ones.
      const existing = isEdit ? (await loadDeck(deckId)) ?? [] : [];
      const merged = mergeDeck(existing, fresh);

      await saveDeck(deckId, merged);            // cards first
      if (isEdit) {
        await updateDeckMeta(deckId, { name: name.trim(), cardCount: merged.length });
      } else {
        await registerDeck({
          id: deckId, name: name.trim(), source: 'manual',
          createdAt: Date.now(), updatedAt: Date.now(), cardCount: merged.length,
        });
      }
      router.back();
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={s.safe}>
      <Stack.Screen
        options={{
          title: isEdit ? 'Edit Deck' : 'New Deck',
          headerRight: () => (
            <Pressable onPress={onSave} disabled={!canSave} hitSlop={8}>
              <Text style={[s.save, !canSave && s.saveOff]}>Save</Text>
            </Pressable>
          ),
        }}
      />
      {!loaded ? null : (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
            <Text style={s.fieldLabel}>DECK NAME</Text>
            <TextInput
              style={s.nameInput}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Intro Psychology"
              placeholderTextColor="#444"
              autoFocus={!isEdit}
            />

            <Text style={[s.fieldLabel, { marginTop: 20 }]}>CARDS ({validCount})</Text>
            {rows.map((row, i) => (
              <View key={i} style={s.cardRow}>
                <View style={{ flex: 1 }}>
                  <TextInput
                    style={s.prompt}
                    value={row.prompt}
                    onChangeText={(t) => setRow(i, { prompt: t })}
                    placeholder="Prompt (front)"
                    placeholderTextColor="#444"
                    multiline
                  />
                  <TextInput
                    style={s.answer}
                    value={row.answer}
                    onChangeText={(t) => setRow(i, { answer: t })}
                    placeholder="Answer (back)"
                    placeholderTextColor="#444"
                    multiline
                  />
                </View>
                {(row.prompt.trim() || row.answer.trim()) && (
                  <Pressable onPress={() => removeRow(i)} hitSlop={8} style={s.del}>
                    <Text style={s.delText}>✕</Text>
                  </Pressable>
                )}
              </View>
            ))}

            <Text style={s.hint}>A new row appears as you fill the last one. Blank rows are ignored.</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  save: { color: C.accent, fontSize: 16, fontWeight: '700' },
  saveOff: { color: C.dim },
  fieldLabel: { color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  nameInput: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 10, color: C.text, fontSize: 17, paddingHorizontal: 14, paddingVertical: 12 },
  cardRow: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 10 },
  prompt: { color: C.text, fontSize: 16, fontWeight: '600', paddingVertical: 2 },
  answer: { color: C.accent, fontSize: 15, paddingVertical: 2, marginTop: 6 },
  del: { paddingHorizontal: 6, paddingVertical: 2, marginLeft: 8 },
  delText: { color: C.dim, fontSize: 16 },
  hint: { color: C.dim, fontSize: 12, marginTop: 8, lineHeight: 18 },
});
