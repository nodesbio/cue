/**
 * files.tsx — Script library tab.
 *
 * Lists saved scripts. Tap to load into the teleprompter engine.
 * Swipe-to-delete via reveal. Import .txt files from device.
 * Inline rename by tapping the script name.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useFocusEffect } from 'expo-router';
import {
  listScripts,
  saveScript,
  deleteScript,
  updateScript,
  ScriptEntry,
} from '@/lib/scripts/ScriptStore';
import { TeleprompterEngine } from '@/lib/teleprompter/TeleprompterEngine';

// The engine singleton lives in the index module — we access the same global.
// This is intentional: Files tab just loads into the same running engine.
declare const global: { __cueEngine?: TeleprompterEngine };

// ── Row component ───────────────────────────────────────────────────────────

const SWIPE_THRESHOLD = 72;
const DELETE_WIDTH    = 80;

function ScriptRow({
  entry,
  onLoad,
  onDelete,
  onRename,
}: {
  entry: ScriptEntry;
  onLoad: (entry: ScriptEntry) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const tx          = useRef(new Animated.Value(0)).current;
  const revealed    = useRef(false);
  const startX      = useRef(0);
  const [renaming, setRenaming] = useState(false);
  const [nameVal,  setNameVal]  = useState(entry.name);

  function commitRename() {
    const trimmed = nameVal.trim();
    if (trimmed && trimmed !== entry.name) onRename(entry.id, trimmed);
    else setNameVal(entry.name);
    setRenaming(false);
  }

  function snapBack() {
    Animated.spring(tx, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
    revealed.current = false;
  }

  function snapOpen() {
    Animated.spring(tx, { toValue: -DELETE_WIDTH, useNativeDriver: true, bounciness: 0 }).start();
    revealed.current = true;
  }

  const date = new Date(entry.updatedAt).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const preview = entry.text.slice(0, 80).replace(/\n/g, ' ');

  return (
    <View style={r.rowWrap}>
      {/* Delete backing */}
      <View style={r.deleteBg}>
        <Pressable style={r.deleteBtn} onPress={() => onDelete(entry.id)}>
          <Text style={r.deleteTxt}>Delete</Text>
        </Pressable>
      </View>

      {/* Sliding foreground */}
      <Animated.View
        style={[r.row, { transform: [{ translateX: tx }] }]}
        onStartShouldSetResponder={() => true}
        onResponderGrant={e  => { startX.current = e.nativeEvent.pageX; }}
        onResponderMove={e   => {
          const dx = e.nativeEvent.pageX - startX.current;
          const base = revealed.current ? -DELETE_WIDTH : 0;
          const next = Math.min(0, Math.max(-DELETE_WIDTH, base + dx));
          tx.setValue(next);
        }}
        onResponderRelease={e => {
          const dx = e.nativeEvent.pageX - startX.current;
          if (!revealed.current && dx < -SWIPE_THRESHOLD) snapOpen();
          else if (revealed.current && dx > SWIPE_THRESHOLD / 2) snapBack();
          else if (!revealed.current && Math.abs(dx) < 6) {
            // Tap on revealed = snap back, tap on closed = load
            if (revealed.current) snapBack();
          } else if (revealed.current) snapOpen();
          else snapBack();
        }}
      >
        <Pressable style={r.rowContent} onPress={() => {
          if (revealed.current) { snapBack(); return; }
          onLoad(entry);
        }}>
          {renaming ? (
            <TextInput
              style={r.renameInput}
              value={nameVal}
              onChangeText={setNameVal}
              onBlur={commitRename}
              onSubmitEditing={commitRename}
              autoFocus
              selectTextOnFocus
            />
          ) : (
            <Pressable onLongPress={() => setRenaming(true)}>
              <Text style={r.name} numberOfLines={1}>{entry.name}</Text>
            </Pressable>
          )}
          <Text style={r.meta}>{date} · {entry.text.length.toLocaleString()} chars</Text>
          <Text style={r.preview} numberOfLines={1}>{preview}</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────

export default function FilesScreen() {
  const [scripts, setScripts]     = useState<ScriptEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [loadedId, setLoadedId]   = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    const list = await listScripts();
    setScripts(list);
    setLoading(false);
  }

  // Reload list every time this tab gains focus
  useFocusEffect(useCallback(() => { refresh(); }, []));

  async function handleImport() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['text/plain', 'text/*', 'public.plain-text'],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const text  = await FileSystem.readAsStringAsync(asset.uri);
    const name  = asset.name?.replace(/\.[^.]+$/, '') ?? 'Imported script';
    const entry = await saveScript(name, text);
    setScripts(prev => [entry, ...prev]);
  }

  function handleLoad(entry: ScriptEntry) {
    // Expose engine via global so files tab can load without importing the
    // singleton directly (avoids a circular module dep with index.tsx).
    const eng = (global as any).__cueEngine as TeleprompterEngine | undefined;
    if (!eng) {
      Alert.alert('Not ready', 'Open the Teleprompter tab first to initialise the engine.');
      return;
    }
    eng.loadScript(entry.text);
    setLoadedId(entry.id);
  }

  async function handleDelete(id: string) {
    Alert.alert('Delete script', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          await deleteScript(id);
          setScripts(prev => prev.filter(s => s.id !== id));
        },
      },
    ]);
  }

  async function handleRename(id: string, name: string) {
    await updateScript(id, { name });
    setScripts(prev => prev.map(s => s.id === id ? { ...s, name } : s));
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.title}>Scripts</Text>
        <Pressable style={s.importBtn} onPress={handleImport}>
          <Text style={s.importTxt}>+ Import</Text>
        </Pressable>
      </View>

      {loading ? (
        <Text style={s.empty}>Loading…</Text>
      ) : scripts.length === 0 ? (
        <View style={s.emptyState}>
          <Text style={s.emptyIcon}>📄</Text>
          <Text style={s.emptyHeading}>No saved scripts</Text>
          <Text style={s.emptySub}>Import a .txt file or save the current script from the Teleprompter tab.</Text>
        </View>
      ) : (
        <ScrollView style={s.list} contentContainerStyle={s.listContent}>
          {scripts.map(entry => (
            <ScriptRow
              key={entry.id}
              entry={entry}
              onLoad={handleLoad}
              onDelete={handleDelete}
              onRename={handleRename}
            />
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: '#0a0a0a' },
  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                  paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 },
  title:        { color: '#fff', fontSize: 28, fontWeight: '700' },
  importBtn:    { backgroundColor: '#1a1a1a', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 16 },
  importTxt:    { color: '#fff', fontSize: 14, fontWeight: '600' },
  empty:        { color: '#555', textAlign: 'center', marginTop: 60 },
  emptyState:   { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyIcon:    { fontSize: 48, marginBottom: 16 },
  emptyHeading: { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 8, textAlign: 'center' },
  emptySub:     { color: '#555', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  list:         { flex: 1 },
  listContent:  { paddingBottom: 32 },
});

const r = StyleSheet.create({
  rowWrap:      { overflow: 'hidden', borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  deleteBg:     { position: 'absolute', right: 0, top: 0, bottom: 0, width: DELETE_WIDTH,
                  backgroundColor: '#7f1d1d', justifyContent: 'center', alignItems: 'center' },
  deleteBtn:    { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  deleteTxt:    { color: '#fff', fontSize: 13, fontWeight: '600' },
  row:          { backgroundColor: '#0a0a0a' },
  rowContent:   { paddingHorizontal: 20, paddingVertical: 16 },
  name:         { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 3 },
  meta:         { color: '#555', fontSize: 11, marginBottom: 4 },
  preview:      { color: '#444', fontSize: 12 },
  renameInput:  { color: '#fff', fontSize: 16, fontWeight: '600', borderBottomWidth: 1,
                  borderBottomColor: '#555', paddingVertical: 2, marginBottom: 3 },
});
