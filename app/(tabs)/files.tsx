/**
 * files.tsx — Script library tab.
 *
 * • Sorted by explicit index order — last-opened always floats to top.
 * • Long-press drag handle (≡) to reorder.
 * • Swipe left to reveal Delete.
 * • Long-press name to rename inline.
 * • Tap row to load into the teleprompter engine.
 * • + Import picks a .txt file from the device.
 */

import { useCallback, useRef, useState } from 'react';
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
  type LayoutChangeEvent,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useFocusEffect } from 'expo-router';
import {
  listScripts,
  saveScript,
  deleteScript,
  updateScript,
  touchScript,
  reorderScripts,
  type ScriptEntry,
} from '@/lib/scripts/ScriptStore';
import { type TeleprompterEngine } from '@/lib/teleprompter/TeleprompterEngine';

// ── Constants ────────────────────────────────────────────────────────────────

const ROW_HEIGHT      = 76;   // px — must match r.rowContent minHeight
const SWIPE_THRESHOLD = 68;
const DELETE_WIDTH    = 80;
const DRAG_ACTIVATE_MS = 250; // long-press duration before drag starts

// ── ScriptRow ────────────────────────────────────────────────────────────────

interface RowProps {
  entry:     ScriptEntry;
  isLoaded:  boolean;
  onLoad:    (entry: ScriptEntry) => void;
  onDelete:  (id: string) => void;
  onRename:  (id: string, name: string) => void;
  /** Called when the drag handle is pressed — parent takes over gesture */
  onDragStart: (id: string, pageY: number) => void;
}

function ScriptRow({ entry, isLoaded, onLoad, onDelete, onRename, onDragStart }: RowProps) {
  const tx       = useRef(new Animated.Value(0)).current;
  const revealed = useRef(false);
  const startX   = useRef(0);
  const [renaming, setRenaming] = useState(false);
  const [nameVal,  setNameVal]  = useState(entry.name);

  // Keep nameVal in sync if parent renames externally
  const prevName = useRef(entry.name);
  if (entry.name !== prevName.current) {
    prevName.current = entry.name;
    setNameVal(entry.name);
  }

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

  const openedLabel = entry.openedAt
    ? `Opened ${new Date(entry.openedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    : `Added ${new Date(entry.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  const preview = entry.text.slice(0, 90).replace(/\n/g, ' ');

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
          tx.setValue(Math.min(0, Math.max(-DELETE_WIDTH, base + dx)));
        }}
        onResponderRelease={e => {
          const dx = e.nativeEvent.pageX - startX.current;
          if (!revealed.current && dx < -SWIPE_THRESHOLD)       snapOpen();
          else if (revealed.current && dx > SWIPE_THRESHOLD / 2) snapBack();
          else if (revealed.current)                             snapOpen();
          else                                                    snapBack();
        }}
      >
        {/* Drag handle — left side */}
        <Pressable
          style={r.dragHandle}
          delayLongPress={DRAG_ACTIVATE_MS}
          onLongPress={e => onDragStart(entry.id, e.nativeEvent.pageY)}
        >
          <Text style={r.dragIcon}>≡</Text>
        </Pressable>

        {/* Main content */}
        <Pressable
          style={r.rowContent}
          onPress={() => {
            if (revealed.current) { snapBack(); return; }
            onLoad(entry);
          }}
        >
          <View style={r.nameRow}>
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
              <Pressable onLongPress={() => setRenaming(true)} style={r.namePressable}>
                <Text style={r.name} numberOfLines={1}>{entry.name}</Text>
              </Pressable>
            )}
            {isLoaded && <Text style={r.loadedBadge}>● loaded</Text>}
          </View>
          <Text style={r.meta}>{openedLabel} · {entry.text.length.toLocaleString()} chars</Text>
          <Text style={r.preview} numberOfLines={1}>{preview}</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

// ── FilesScreen ──────────────────────────────────────────────────────────────

export default function FilesScreen() {
  const [scripts,  setScripts]  = useState<ScriptEntry[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [loadedId, setLoadedId] = useState<string | null>(null);

  // ── Drag state ──────────────────────────────────────────────────────────
  const dragId       = useRef<string | null>(null);
  const dragFromIdx  = useRef(0);
  const dragToIdx    = useRef(0);
  const dragStartY   = useRef(0);
  const dragGhostY   = useRef(new Animated.Value(0)).current;
  const listTopY     = useRef(0);       // pageY of the ScrollView top edge
  const [dragging,   setDragging]   = useState(false);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const scriptsRef   = useRef<ScriptEntry[]>([]);

  function refresh() {
    setLoading(true);
    listScripts().then(list => {
      setScripts(list);
      scriptsRef.current = list;
      setLoading(false);
    });
  }

  useFocusEffect(useCallback(() => { refresh(); }, []));

  // ── Load ────────────────────────────────────────────────────────────────
  function handleLoad(entry: ScriptEntry) {
    const eng = (globalThis as any).__cueEngine as TeleprompterEngine | undefined;
    if (!eng) {
      Alert.alert('Not ready', 'Open the Teleprompter tab first to initialise the engine.');
      return;
    }
    eng.loadScript(entry.text);
    setLoadedId(entry.id);
    // Promote to top — fire-and-forget; then bump in local state
    touchScript(entry.id).then(() => {
      setScripts(prev => {
        const next = [
          { ...prev.find(s => s.id === entry.id)!, openedAt: Date.now() },
          ...prev.filter(s => s.id !== entry.id),
        ];
        scriptsRef.current = next;
        return next;
      });
    });
  }

  // ── Import ──────────────────────────────────────────────────────────────
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
    setScripts(prev => { const n = [entry, ...prev]; scriptsRef.current = n; return n; });
  }

  // ── Delete ──────────────────────────────────────────────────────────────
  function handleDelete(id: string) {
    Alert.alert('Delete script', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          await deleteScript(id);
          setScripts(prev => { const n = prev.filter(s => s.id !== id); scriptsRef.current = n; return n; });
          if (loadedId === id) setLoadedId(null);
        },
      },
    ]);
  }

  // ── Rename ──────────────────────────────────────────────────────────────
  async function handleRename(id: string, name: string) {
    await updateScript(id, { name });
    setScripts(prev => { const n = prev.map(s => s.id === id ? { ...s, name } : s); scriptsRef.current = n; return n; });
  }

  // ── Drag-to-reorder ──────────────────────────────────────────────────────
  // Architecture: no external DnD library — we use a plain PanResponder on a
  // transparent overlay that covers the whole list while dragging.
  // The ghost (clone of the dragged row) follows the finger via Animated.
  // We compute the hovered index from pageY and show a drop-target indicator.

  function handleDragStart(id: string, pageY: number) {
    const list = scriptsRef.current;
    const idx  = list.findIndex(s => s.id === id);
    if (idx === -1) return;
    dragId.current      = id;
    dragFromIdx.current = idx;
    dragToIdx.current   = idx;
    dragStartY.current  = pageY;
    dragGhostY.setValue(pageY - listTopY.current - ROW_HEIGHT / 2);
    setDragging(true);
    setDragOverIdx(idx);
  }

  const overlayPan = useRef(
    (() => {
      // We can't use PanResponder.create here (needs stable ref), so we build
      // the handlers manually and attach to a View via onStartShouldSetResponder.
      return {
        onStartShouldSetResponder: () => dragging,
        onMoveShouldSetResponder:  () => dragging,
        onResponderGrant: () => {},
        onResponderMove: (e: any) => {
          if (!dragging) return;
          const py   = e.nativeEvent.pageY;
          const relY = py - listTopY.current;
          dragGhostY.setValue(relY - ROW_HEIGHT / 2);
          const idx  = Math.max(0, Math.min(
            scriptsRef.current.length - 1,
            Math.floor(relY / ROW_HEIGHT),
          ));
          dragToIdx.current = idx;
          setDragOverIdx(idx);
        },
        onResponderRelease: () => {
          if (!dragging) return;
          const from = dragFromIdx.current;
          const to   = dragToIdx.current;
          setDragging(false);
          setDragOverIdx(null);
          dragId.current = null;
          if (from === to) return;
          // Apply reorder
          const next = [...scriptsRef.current];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          scriptsRef.current = next;
          setScripts(next);
          reorderScripts(next.map(s => s.id));
        },
      };
    })(),
  ).current;

  // Ghost label for the dragged item
  const draggedEntry = dragging ? scriptsRef.current.find(s => s.id === dragId.current) : null;

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
          <Text style={s.emptySub}>
            Import a .txt file or save the current script from the Teleprompter tab.
          </Text>
        </View>
      ) : (
        <View
          style={s.listWrapper}
          onLayout={(e: LayoutChangeEvent) => {
            // Capture the pageY of the list top for ghost positioning
            e.target.measure((_x, _y, _w, _h, _px, py) => { listTopY.current = py; });
          }}
        >
          <ScrollView
            style={s.list}
            contentContainerStyle={s.listContent}
            scrollEnabled={!dragging}
          >
            {scripts.map((entry, idx) => (
              <View key={entry.id}>
                {/* Drop indicator above this row */}
                {dragOverIdx === idx && dragging && dragFromIdx.current !== idx && (
                  <View style={s.dropIndicator} />
                )}
                <View style={dragging && dragId.current === entry.id ? s.rowDragging : undefined}>
                  <ScriptRow
                    entry={entry}
                    isLoaded={entry.id === loadedId}
                    onLoad={handleLoad}
                    onDelete={handleDelete}
                    onRename={handleRename}
                    onDragStart={handleDragStart}
                  />
                </View>
              </View>
            ))}
            {/* Drop indicator at the very bottom */}
            {dragging && dragOverIdx === scripts.length - 1 && dragFromIdx.current !== scripts.length - 1 && (
              <View style={s.dropIndicator} />
            )}
          </ScrollView>

          {/* Drag overlay — captures all touch events while dragging */}
          {dragging && (
            <View
              style={StyleSheet.absoluteFill}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderMove={overlayPan.onResponderMove}
              onResponderRelease={overlayPan.onResponderRelease}
            >
              {/* Floating ghost row */}
              {draggedEntry && (
                <Animated.View
                  style={[s.ghost, { transform: [{ translateY: dragGhostY }] }]}
                  pointerEvents="none"
                >
                  <Text style={s.ghostDragIcon}>≡</Text>
                  <View style={s.ghostContent}>
                    <Text style={s.ghostName} numberOfLines={1}>{draggedEntry.name}</Text>
                    <Text style={s.ghostMeta}>{draggedEntry.text.length.toLocaleString()} chars</Text>
                  </View>
                </Animated.View>
              )}
            </View>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:          { flex: 1, backgroundColor: '#0a0a0a' },
  header:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                   paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 },
  title:         { color: '#fff', fontSize: 28, fontWeight: '700' },
  importBtn:     { backgroundColor: '#1a1a1a', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 16 },
  importTxt:     { color: '#fff', fontSize: 14, fontWeight: '600' },
  empty:         { color: '#555', textAlign: 'center', marginTop: 60 },
  emptyState:    { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyIcon:     { fontSize: 48, marginBottom: 16 },
  emptyHeading:  { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 8, textAlign: 'center' },
  emptySub:      { color: '#555', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  listWrapper:   { flex: 1, position: 'relative' },
  list:          { flex: 1 },
  listContent:   { paddingBottom: 32 },
  rowDragging:   { opacity: 0.3 },
  dropIndicator: { height: 2, backgroundColor: '#4ade80', marginHorizontal: 16, borderRadius: 1 },
  ghost:         { position: 'absolute', left: 0, right: 0, height: ROW_HEIGHT,
                   backgroundColor: '#1c1c1c', borderRadius: 10, marginHorizontal: 8,
                   flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
                   shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 12, elevation: 12 },
  ghostDragIcon: { color: '#555', fontSize: 20, marginRight: 12, width: 24, textAlign: 'center' },
  ghostContent:  { flex: 1 },
  ghostName:     { color: '#fff', fontSize: 15, fontWeight: '600' },
  ghostMeta:     { color: '#555', fontSize: 11, marginTop: 2 },
});

const r = StyleSheet.create({
  rowWrap:      { overflow: 'hidden', borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  deleteBg:     { position: 'absolute', right: 0, top: 0, bottom: 0, width: DELETE_WIDTH,
                  backgroundColor: '#7f1d1d', justifyContent: 'center', alignItems: 'center' },
  deleteBtn:    { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  deleteTxt:    { color: '#fff', fontSize: 13, fontWeight: '600' },
  row:          { backgroundColor: '#0a0a0a', flexDirection: 'row', alignItems: 'center' },
  dragHandle:   { paddingHorizontal: 14, paddingVertical: 20, justifyContent: 'center', alignItems: 'center' },
  dragIcon:     { color: '#444', fontSize: 20 },
  rowContent:   { flex: 1, paddingRight: 20, paddingVertical: 14, minHeight: ROW_HEIGHT,
                  justifyContent: 'center' },
  nameRow:      { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 },
  namePressable:{ flex: 1 },
  name:         { color: '#fff', fontSize: 15, fontWeight: '600' },
  loadedBadge:  { color: '#4ade80', fontSize: 11, fontWeight: '600', flexShrink: 0 },
  meta:         { color: '#555', fontSize: 11, marginBottom: 3 },
  preview:      { color: '#444', fontSize: 12 },
  renameInput:  { color: '#fff', fontSize: 15, fontWeight: '600', borderBottomWidth: 1,
                  borderBottomColor: '#555', paddingVertical: 2, flex: 1 },
});
