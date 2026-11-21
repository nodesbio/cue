/**
 * AudienceBuilder — build & manage conversation-deck audiences (#44).
 *
 * The product is the user's own audiences: a named set of sports topics picked
 * ahead of a conversation. This screen is the list + editor. It does NOT run the
 * deck or touch the lens — that's #46. It only reads/writes AudienceStore.
 *
 * Palette + layout intentionally mirror sports.tsx so the Sports experience
 * feels like one surface. Topic picking is driven by the static catalog (#44);
 * live ESPN team lists are #45.
 *
 * Corruption handling: AudienceStore throws AudienceStoreError on bad data
 * rather than silently emptying the list. We catch it HERE and show a visible
 * banner — surfacing the signal to the user, not swallowing it (Zoracon #32).
 */

import { useCallback, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
// Note: the screen body is a plain View — the Sports tab shell (sports.tsx)
// owns the SafeAreaView. The editor Modal still uses its own SafeAreaView since
// it presents as a separate page sheet.
import { useFocusEffect } from 'expo-router';
import {
  AudienceStoreError,
  deleteAudience,
  listAudiences,
  saveAudience,
  seedTemplatesOnce,
  updateAudience,
} from '@/lib/sports/AudienceStore';
import {
  Audience,
  DEFAULT_MAX_CARDS,
  Stance,
  Topic,
  topicKey,
} from '@/lib/sports/audience';
import { CATALOG } from '@/lib/sports/catalog';

const C = {
  bg: '#0a0a0a',
  card: '#141414',
  border: '#1f1f1f',
  text: '#ffffff',
  dim: '#777777',
  accent: '#39d353',
  hot: '#ff6b3d',
  danger: '#ff5a5a',
};

// ── Editor draft ──────────────────────────────────────────────────────────────

/** An audience being edited; `id` absent means "new, not yet saved". */
interface Draft {
  id?: string;
  name: string;
  topics: Topic[];
  maxCards: number;
}

function emptyDraft(): Draft {
  return { name: '', topics: [], maxCards: DEFAULT_MAX_CARDS };
}

function draftFrom(a: Audience): Draft {
  return { id: a.id, name: a.name, topics: a.topics, maxCards: a.maxCards };
}

// ── Topic picker row ──────────────────────────────────────────────────────────

/**
 * One catalog league block: a league-level pick (when leaguePickable) plus its
 * teams. Each selected topic shows a know/learning stance toggle.
 */
function LeagueBlock({
  league,
  selected,
  onToggle,
  onStance,
}: {
  league: (typeof CATALOG)[number];
  selected: Map<string, Topic>;
  onToggle: (t: Topic) => void;
  onStance: (key: string, stance: Stance) => void;
}) {
  const rows: { key: string; topic: Topic; label: string }[] = [];
  if (league.leaguePickable) {
    const t: Topic = {
      kind: 'league',
      sport: league.sport,
      league: league.league,
      label: league.label,
      stance: 'learning',
    };
    rows.push({ key: topicKey(t), topic: t, label: `${league.label} (whole league)` });
  }
  for (const team of league.teams) {
    const t: Topic = {
      kind: 'team',
      sport: league.sport,
      league: league.league,
      teamId: team.teamId,
      label: team.label,
      stance: 'know',
    };
    rows.push({ key: topicKey(t), topic: t, label: team.label });
  }
  if (rows.length === 0) return null;

  return (
    <View style={s.block}>
      <Text style={s.blockTitle}>{league.label}</Text>
      {rows.map(({ key, topic, label }) => {
        const chosen = selected.get(key);
        return (
          <View key={key} style={s.pickRow}>
            <Pressable
              onPress={() => onToggle(topic)}
              style={s.pickHit}
              hitSlop={6}
            >
              <Text style={[s.check, chosen && s.checkOn]}>{chosen ? '◉' : '○'}</Text>
              <Text style={[s.pickLabel, chosen && s.pickLabelOn]} numberOfLines={1}>
                {label}
              </Text>
            </Pressable>
            {chosen && (
              <View style={s.stanceRow}>
                {(['know', 'learning'] as Stance[]).map((st) => (
                  <Pressable
                    key={st}
                    onPress={() => onStance(key, st)}
                    style={[s.stanceChip, chosen.stance === st && s.stanceChipOn]}
                    hitSlop={6}
                  >
                    <Text style={[s.stanceText, chosen.stance === st && s.stanceTextOn]}>
                      {st === 'know' ? 'I know' : 'Learning'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

// ── Editor modal ──────────────────────────────────────────────────────────────

function EditorModal({
  draft: initial,
  onSave,
  onDelete,
  onClose,
}: {
  draft: Draft;
  onSave: (d: Draft) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [maxCards, setMaxCards] = useState(initial.maxCards);
  // keyed map of selected topics for O(1) toggle + stance edits
  const [selected, setSelected] = useState<Map<string, Topic>>(
    () => new Map(initial.topics.map((t) => [topicKey(t), t])),
  );

  const toggle = useCallback((t: Topic) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const key = topicKey(t);
      if (next.has(key)) next.delete(key);
      else next.set(key, t);
      return next;
    });
  }, []);

  const setStance = useCallback((key: string, stance: Stance) => {
    setSelected((prev) => {
      const cur = prev.get(key);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(key, { ...cur, stance });
      return next;
    });
  }, []);

  const topics = Array.from(selected.values());
  const canSave = name.trim().length > 0 && topics.length > 0;

  const bumpCards = (delta: number) =>
    setMaxCards((n) => Math.max(1, Math.min(12, n + delta)));

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={s.modalRoot}>
        <View style={s.modalHeader}>
          <Pressable onPress={onClose} hitSlop={8}>
            <Text style={s.cancel}>Cancel</Text>
          </Pressable>
          <Text style={s.modalTitle}>{initial.id ? 'Edit audience' : 'New audience'}</Text>
          <Pressable
            onPress={() => canSave && onSave({ id: initial.id, name: name.trim(), topics, maxCards })}
            hitSlop={8}
            disabled={!canSave}
          >
            <Text style={[s.save, !canSave && s.saveDisabled]}>Save</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
          <Text style={s.fieldLabel}>NAME</Text>
          <TextInput
            style={s.nameInput}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Texas clients, Swim-meet parents…"
            placeholderTextColor="#444"
            autoFocus={!initial.id}
            selectTextOnFocus
          />

          <View style={s.cardsRow}>
            <Text style={s.fieldLabel}>CARDS IN THE DECK</Text>
            <View style={s.stepper}>
              <Pressable onPress={() => bumpCards(-1)} style={s.stepBtn} hitSlop={6}>
                <Text style={s.stepText}>−</Text>
              </Pressable>
              <Text style={s.stepVal}>{maxCards}</Text>
              <Pressable onPress={() => bumpCards(1)} style={s.stepBtn} hitSlop={6}>
                <Text style={s.stepText}>+</Text>
              </Pressable>
            </View>
          </View>

          <Text style={[s.fieldLabel, { marginTop: 18 }]}>
            TOPICS {topics.length > 0 ? `· ${topics.length} selected` : ''}
          </Text>
          <Text style={s.helper}>
            "I know" → the deck gives you something to share. "Learning" → it
            gives you a question to ask.
          </Text>
          {CATALOG.map((lg) => (
            <LeagueBlock
              key={`${lg.sport}/${lg.league}`}
              league={lg}
              selected={selected}
              onToggle={toggle}
              onStance={setStance}
            />
          ))}

          {onDelete && (
            <Pressable onPress={onDelete} style={s.deleteBtn}>
              <Text style={s.deleteText}>Delete audience</Text>
            </Pressable>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function AudienceBuilder() {
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      await seedTemplatesOnce(); // no-op after first run
      setAudiences(await listAudiences());
      setError(null);
    } catch (e) {
      // Surface corruption, don't render a deceptively empty list (Zoracon #32).
      setError(
        e instanceof AudienceStoreError
          ? "Couldn't load your audiences — the saved data looks corrupt."
          : e instanceof Error
            ? e.message
            : String(e),
      );
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const handleSave = useCallback(
    async (d: Draft) => {
      if (d.id) {
        await updateAudience(d.id, { name: d.name, topics: d.topics, maxCards: d.maxCards });
      } else {
        await saveAudience({ name: d.name, topics: d.topics, maxCards: d.maxCards });
      }
      setEditing(null);
      await reload();
    },
    [reload],
  );

  const handleDelete = useCallback(
    (d: Draft) => {
      if (!d.id) return;
      Alert.alert('Delete audience?', `"${d.name}" will be removed.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteAudience(d.id!);
            setEditing(null);
            await reload();
          },
        },
      ]);
    },
    [reload],
  );

  return (
    <View style={s.safe}>
      <View style={s.header}>
        <Text style={s.title}>Audiences</Text>
        <Pressable onPress={() => setEditing(emptyDraft())} style={s.newBtn} hitSlop={8}>
          <Text style={s.newText}>+ New</Text>
        </Pressable>
      </View>
      <Text style={s.subtitle}>Who are you about to talk to?</Text>

      {error && (
        <View style={s.errorBanner}>
          <Text style={s.errorText}>{error}</Text>
          <Pressable onPress={() => void reload()} hitSlop={8}>
            <Text style={s.retry}>Retry</Text>
          </Pressable>
        </View>
      )}

      <ScrollView style={s.list} contentContainerStyle={{ paddingBottom: 32 }}>
        {audiences.length === 0 && !error && (
          <Text style={s.empty}>No audiences yet. Tap “+ New” to build one.</Text>
        )}
        {audiences.map((a) => (
          <Pressable key={a.id} style={s.row} onPress={() => setEditing(draftFrom(a))}>
            <View style={{ flex: 1 }}>
              <Text style={s.rowName}>{a.name}</Text>
              <Text style={s.rowMeta} numberOfLines={1}>
                {a.topics.length} topic{a.topics.length === 1 ? '' : 's'} · {a.maxCards} cards
              </Text>
              <Text style={s.rowTopics} numberOfLines={1}>
                {a.topics.map((t) => t.label).join(' · ') || '—'}
              </Text>
            </View>
            <Text style={s.chevron}>›</Text>
          </Pressable>
        ))}
      </ScrollView>

      {editing && (
        <EditorModal
          draft={editing}
          onSave={handleSave}
          onDelete={editing.id ? () => handleDelete(editing) : undefined}
          onClose={() => setEditing(null)}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8 },
  title: { color: C.text, fontSize: 24, fontWeight: '700' },
  subtitle: { color: C.dim, fontSize: 13, marginTop: 2, marginBottom: 12 },
  newBtn: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1, borderColor: C.accent },
  newText: { color: C.accent, fontSize: 13, fontWeight: '700' },

  errorBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#2a1414', borderRadius: 10, borderWidth: 1, borderColor: C.danger, padding: 12, marginBottom: 12 },
  errorText: { color: C.danger, fontSize: 13, flex: 1, marginRight: 10 },
  retry: { color: C.text, fontSize: 13, fontWeight: '700' },

  list: { flex: 1 },
  empty: { color: C.dim, textAlign: 'center', marginTop: 48, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 10, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  rowName: { color: C.text, fontSize: 16, fontWeight: '600' },
  rowMeta: { color: C.dim, fontSize: 12, marginTop: 2 },
  rowTopics: { color: C.dim, fontSize: 12, marginTop: 4, opacity: 0.7 },
  chevron: { color: C.dim, fontSize: 24, marginLeft: 8 },

  // Modal
  modalRoot: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 16 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12 },
  modalTitle: { color: C.text, fontSize: 16, fontWeight: '700' },
  cancel: { color: C.dim, fontSize: 15 },
  save: { color: C.accent, fontSize: 15, fontWeight: '700' },
  saveDisabled: { color: C.dim, opacity: 0.4 },

  fieldLabel: { color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 8, marginBottom: 6 },
  helper: { color: C.dim, fontSize: 12, marginBottom: 8, opacity: 0.8 },
  nameInput: { backgroundColor: C.card, borderRadius: 10, borderWidth: 1, borderColor: C.border, color: C.text, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12 },

  cardsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stepBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center', backgroundColor: C.card },
  stepText: { color: C.text, fontSize: 20, fontWeight: '700' },
  stepVal: { color: C.text, fontSize: 18, fontWeight: '700', minWidth: 24, textAlign: 'center' },

  block: { marginTop: 14 },
  blockTitle: { color: C.text, fontSize: 13, fontWeight: '700', marginBottom: 6, opacity: 0.9 },
  pickRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  pickHit: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10 },
  check: { color: C.dim, fontSize: 18 },
  checkOn: { color: C.accent },
  pickLabel: { color: C.dim, fontSize: 15, flexShrink: 1 },
  pickLabelOn: { color: C.text },
  stanceRow: { flexDirection: 'row', gap: 6, marginLeft: 8 },
  stanceChip: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, borderColor: C.border },
  stanceChipOn: { borderColor: C.accent, backgroundColor: C.card },
  stanceText: { color: C.dim, fontSize: 12, fontWeight: '600' },
  stanceTextOn: { color: C.text },

  deleteBtn: { marginTop: 32, paddingVertical: 14, alignItems: 'center', borderRadius: 10, borderWidth: 1, borderColor: C.danger },
  deleteText: { color: C.danger, fontSize: 15, fontWeight: '700' },
});
