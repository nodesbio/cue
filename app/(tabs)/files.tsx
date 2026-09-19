/**
 * files.tsx — Script library tab.
 *
 * Swipe architecture: the Animated.View slides LEFT, exposing the empty
 * space behind it. The action buttons are rendered AFTER (on top of) the
 * slider in the z-stack, absolutely pinned to the right edge, and only
 * receive touches when the row is in the revealed state (pointerEvents).
 */

import { useCallback, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
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

const ROW_HEIGHT       = 76;
const SWIPE_THRESHOLD  = 60;
const ACTION_WIDTH     = 160; // 2 × 80 px buttons
const DRAG_ACTIVATE_MS = 250;

// ── EditModal ────────────────────────────────────────────────────────────────

function EditModal({
  entry,
  onSave,
  onClose,
}: {
  entry: ScriptEntry;
  onSave: (id: string, name: string, text: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(entry.name);
  const [text, setText] = useState(entry.text);

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={m.root}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={m.header}>
            <Pressable onPress={onClose} style={m.headerBtn}>
              <Text style={m.cancelTxt}>Cancel</Text>
            </Pressable>
            <Text style={m.headerTitle} numberOfLines={1}>Edit Script</Text>
            <Pressable onPress={() => onSave(entry.id, name.trim() || 'Untitled', text)} style={m.headerBtn}>
              <Text style={m.saveTxt}>Save</Text>
            </Pressable>
          </View>
          <View style={m.nameWrap}>
            <Text style={m.label}>NAME</Text>
            <TextInput
              style={m.nameInput}
              value={name}
              onChangeText={setName}
              placeholder="Script name…"
              placeholderTextColor="#444"
              returnKeyType="next"
              selectTextOnFocus
            />
          </View>
          <Text style={[m.label, { paddingHorizontal: 20, paddingTop: 12 }]}>SCRIPT</Text>
          <TextInput
            style={m.bodyInput}
            value={text}
            onChangeText={setText}
            multiline
            textAlignVertical="top"
            placeholder="Script text…"
            placeholderTextColor="#444"
            autoCorrect={false}
            autoCapitalize="sentences"
            scrollEnabled
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ── NewModal ─────────────────────────────────────────────────────────────────

function NewModal({
  onSave,
  onClose,
}: {
  onSave: (name: string, text: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={m.root}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={m.header}>
            <Pressable onPress={onClose} style={m.headerBtn}>
              <Text style={m.cancelTxt}>Cancel</Text>
            </Pressable>
            <Text style={m.headerTitle}>New Script</Text>
            <Pressable onPress={() => onSave(name.trim() || 'Untitled', text)} style={m.headerBtn}>
              <Text style={m.saveTxt}>Save</Text>
            </Pressable>
          </View>
          <View style={m.nameWrap}>
            <Text style={m.label}>NAME</Text>
            <TextInput
              style={m.nameInput}
              value={name}
              onChangeText={setName}
              placeholder="Script name…"
              placeholderTextColor="#444"
              returnKeyType="next"
              autoFocus
              selectTextOnFocus
            />
          </View>
          <Text style={[m.label, { paddingHorizontal: 20, paddingTop: 12 }]}>SCRIPT</Text>
          <TextInput
            style={m.bodyInput}
            value={text}
            onChangeText={setText}
            multiline
            textAlignVertical="top"
            placeholder="Type your script here…"
            placeholderTextColor="#444"
            autoCorrect={false}
            autoCapitalize="sentences"
            scrollEnabled
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ── ScriptRow ────────────────────────────────────────────────────────────────

interface RowProps {
  entry:       ScriptEntry;
  isLoaded:    boolean;
  onLoad:      (entry: ScriptEntry) => void;
  onEdit:      (entry: ScriptEntry) => void;
  onDelete:    (id: string) => void;
  onRename:    (id: string, name: string) => void;
  onDragStart: (id: string, pageY: number) => void;
}

function ScriptRow({ entry, isLoaded, onLoad, onEdit, onDelete, onRename, onDragStart }: RowProps) {
  const tx        = useRef(new Animated.Value(0)).current;
  const revealed  = useRef(false);
  const [renaming, setRenaming] = useState(false);
  const [nameVal,  setNameVal]  = useState(entry.name);

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
    Animated.spring(tx, { toValue: -ACTION_WIDTH, useNativeDriver: true, bounciness: 0 }).start();
    revealed.current = true;
  }

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, gs) =>
        Math.abs(gs.dx) > 6 && Math.abs(gs.dx) > Math.abs(gs.dy),
      onPanResponderMove: (_e, gs) => {
        const base = revealed.current ? -ACTION_WIDTH : 0;
        tx.setValue(Math.min(0, Math.max(-ACTION_WIDTH, base + gs.dx)));
      },
      onPanResponderRelease: (_e, gs) => {
        if (!revealed.current && gs.dx < -SWIPE_THRESHOLD)        snapOpen();
        else if (revealed.current && gs.dx > SWIPE_THRESHOLD / 2) snapBack();
        else if (revealed.current)                                 snapOpen();
        else                                                        snapBack();
      },
      onPanResponderTerminate: () => {
        if (revealed.current) snapOpen(); else snapBack();
      },
    }),
  ).current;

  const openedLabel = entry.openedAt
    ? `Opened ${new Date(entry.openedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    : `Added ${new Date(entry.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  const preview = entry.text.slice(0, 90).replace(/\n/g, ' ');

  return (
    // clip to row height; no overflow:hidden so touches aren't eaten
    <View style={{ height: ROW_HEIGHT, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' }}>
      {/* Outer flex row: foreground fills width + ACTION_WIDTH extra, then translate left on swipe */}
      <Animated.View
        style={[r.slideTrack, { transform: [{ translateX: tx }] }]}
        {...pan.panHandlers}
      >
        {/* Foreground card — solid bg so it covers buttons while closed */}
        <View style={r.row}>
          <Pressable
            style={r.dragHandle}
            delayLongPress={DRAG_ACTIVATE_MS}
            onLongPress={e => onDragStart(entry.id, e.nativeEvent.pageY)}
          >
            <Text style={r.dragIcon}>≡</Text>
          </Pressable>

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
        </View>

        {/* Action buttons sit inline to the RIGHT of the foreground card */}
        <TouchableOpacity style={r.editBtn} activeOpacity={0.7} onPress={() => { snapBack(); onEdit(entry); }}>
          <Text style={r.editTxt}>Edit</Text>
        </TouchableOpacity>
        <TouchableOpacity style={r.deleteBtn} activeOpacity={0.7} onPress={() => { snapBack(); onDelete(entry.id); }}>
          <Text style={r.deleteTxt}>Delete</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

// ── FilesScreen ──────────────────────────────────────────────────────────────

export default function FilesScreen() {
  const [scripts,    setScripts]    = useState<ScriptEntry[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [loadedId,   setLoadedId]   = useState<string | null>(null);
  const [editEntry,  setEditEntry]  = useState<ScriptEntry | null>(null);
  const [showNew,    setShowNew]    = useState(false);

  const dragId       = useRef<string | null>(null);
  const dragFromIdx  = useRef(0);
  const dragToIdx    = useRef(0);
  const dragGhostY   = useRef(new Animated.Value(0)).current;
  const listTopY     = useRef(0);
  const [dragging,    setDragging]    = useState(false);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const scriptsRef   = useRef<ScriptEntry[]>([]);

  function setList(next: ScriptEntry[]) {
    scriptsRef.current = next;
    setScripts(next);
  }

  function refresh() {
    setLoading(true);
    listScripts().then(list => { setList(list); setLoading(false); });
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
    touchScript(entry.id).then(() => {
      setList([
        { ...scriptsRef.current.find(s => s.id === entry.id)!, openedAt: Date.now() },
        ...scriptsRef.current.filter(s => s.id !== entry.id),
      ]);
    });
  }

  // ── New ─────────────────────────────────────────────────────────────────
  async function handleNewSave(name: string, text: string) {
    const entry = await saveScript(name, text);
    setList([entry, ...scriptsRef.current]);
    setShowNew(false);
  }

  // ── Edit ────────────────────────────────────────────────────────────────
  async function handleEditSave(id: string, name: string, text: string) {
    const updated = await updateScript(id, { name, text });
    if (!updated) return;
    setList(scriptsRef.current.map(s => s.id === id ? updated : s));
    setEditEntry(null);
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
    setList([entry, ...scriptsRef.current]);
  }

  // ── Delete ──────────────────────────────────────────────────────────────
  function handleDelete(id: string) {
    Alert.alert('Delete script', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          await deleteScript(id);
          setList(scriptsRef.current.filter(s => s.id !== id));
          if (loadedId === id) setLoadedId(null);
        },
      },
    ]);
  }

  // ── Rename ──────────────────────────────────────────────────────────────
  async function handleRename(id: string, name: string) {
    await updateScript(id, { name });
    setList(scriptsRef.current.map(s => s.id === id ? { ...s, name } : s));
  }

  // ── Drag ────────────────────────────────────────────────────────────────
  function handleDragStart(id: string, pageY: number) {
    const idx = scriptsRef.current.findIndex(s => s.id === id);
    if (idx === -1) return;
    dragId.current      = id;
    dragFromIdx.current = idx;
    dragToIdx.current   = idx;
    dragGhostY.setValue(pageY - listTopY.current - ROW_HEIGHT / 2);
    setDragging(true);
    setDragOverIdx(idx);
  }

  const overlayHandlers = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder:  () => true,
    onResponderMove: (e: any) => {
      const relY = e.nativeEvent.pageY - listTopY.current;
      dragGhostY.setValue(relY - ROW_HEIGHT / 2);
      const idx = Math.max(0, Math.min(scriptsRef.current.length - 1, Math.floor(relY / ROW_HEIGHT)));
      dragToIdx.current = idx;
      setDragOverIdx(idx);
    },
    onResponderRelease: () => {
      const from = dragFromIdx.current;
      const to   = dragToIdx.current;
      setDragging(false);
      setDragOverIdx(null);
      dragId.current = null;
      if (from === to) return;
      const next = [...scriptsRef.current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setList(next);
      reorderScripts(next.map(s => s.id));
    },
  };

  const draggedEntry = dragging ? scriptsRef.current.find(s => s.id === dragId.current) : null;

  return (
    <SafeAreaView style={s.root}>
      {editEntry && (
        <EditModal entry={editEntry} onSave={handleEditSave} onClose={() => setEditEntry(null)} />
      )}
      {showNew && (
        <NewModal onSave={handleNewSave} onClose={() => setShowNew(false)} />
      )}

      <View style={s.header}>
        <Text style={s.title}>Scripts</Text>
        <View style={s.headerActions}>
          <Pressable style={s.headerBtn} onPress={() => setShowNew(true)}>
            <Text style={s.headerBtnTxt}>+ New</Text>
          </Pressable>
          <Pressable style={s.headerBtn} onPress={handleImport}>
            <Text style={s.headerBtnTxt}>+ Import</Text>
          </Pressable>
        </View>
      </View>

      {loading ? (
        <Text style={s.empty}>Loading…</Text>
      ) : scripts.length === 0 ? (
        <View style={s.emptyState}>
          <Text style={s.emptyIcon}>📄</Text>
          <Text style={s.emptyHeading}>No saved scripts</Text>
          <Text style={s.emptySub}>
            Create a new script, import a .txt file, or save from the Teleprompter tab.
          </Text>
        </View>
      ) : (
        <View
          style={s.listWrapper}
          onLayout={(e: LayoutChangeEvent) => {
            e.target.measure((_x, _y, _w, _h, _px, py) => { listTopY.current = py; });
          }}
        >
          <ScrollView style={s.list} contentContainerStyle={s.listContent} scrollEnabled={!dragging}>
            {scripts.map((entry, idx) => (
              <View key={entry.id}>
                {dragging && dragOverIdx === idx && dragFromIdx.current !== idx && (
                  <View style={s.dropIndicator} />
                )}
                <View style={dragging && dragId.current === entry.id ? s.rowDragging : undefined}>
                  <ScriptRow
                    entry={entry}
                    isLoaded={entry.id === loadedId}
                    onLoad={handleLoad}
                    onEdit={setEditEntry}
                    onDelete={handleDelete}
                    onRename={handleRename}
                    onDragStart={handleDragStart}
                  />
                </View>
              </View>
            ))}
            {dragging && dragOverIdx === scripts.length - 1 && dragFromIdx.current !== scripts.length - 1 && (
              <View style={s.dropIndicator} />
            )}
          </ScrollView>

          {dragging && (
            <View style={StyleSheet.absoluteFill} {...overlayHandlers}>
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
  headerActions: { flexDirection: 'row', gap: 8 },
  headerBtn:     { backgroundColor: '#1a1a1a', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14 },
  headerBtnTxt:  { color: '#fff', fontSize: 14, fontWeight: '600' },
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
  // Animated track: flex row wider than the screen by ACTION_WIDTH,
  // starts translated 0 (buttons hidden off-right), slides to -ACTION_WIDTH to reveal
  slideTrack:   { flexDirection: 'row', width: '100%', flex: 1 },
  // Foreground card fills the screen width, solid bg hides buttons behind it
  row:          { flex: 1, backgroundColor: '#0a0a0a', flexDirection: 'row', alignItems: 'center' },
  dragHandle:   { paddingHorizontal: 14, paddingVertical: 20, justifyContent: 'center', alignItems: 'center' },
  dragIcon:     { color: '#444', fontSize: 20 },
  rowContent:   { flex: 1, paddingRight: 20, paddingVertical: 14, justifyContent: 'center' },
  nameRow:      { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 },
  namePressable:{ flex: 1 },
  name:         { color: '#fff', fontSize: 15, fontWeight: '600' },
  loadedBadge:  { color: '#4ade80', fontSize: 11, fontWeight: '600', flexShrink: 0 },
  meta:         { color: '#555', fontSize: 11, marginBottom: 3 },
  preview:      { color: '#444', fontSize: 12 },
  renameInput:  { color: '#fff', fontSize: 15, fontWeight: '600', borderBottomWidth: 1,
                  borderBottomColor: '#555', paddingVertical: 2, flex: 1 },
  // Buttons sit inline after the foreground card in the flex row
  editBtn:      { width: 80, height: ROW_HEIGHT, backgroundColor: '#1d4ed8',
                  justifyContent: 'center', alignItems: 'center' },
  editTxt:      { color: '#fff', fontSize: 13, fontWeight: '600' },
  deleteBtn:    { width: 80, height: ROW_HEIGHT, backgroundColor: '#7f1d1d',
                  justifyContent: 'center', alignItems: 'center' },
  deleteTxt:    { color: '#fff', fontSize: 13, fontWeight: '600' },
});

const m = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#0a0a0a' },
  header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                 paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12,
                 borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  headerBtn:   { minWidth: 60 },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '600', flex: 1, textAlign: 'center' },
  cancelTxt:   { color: '#888', fontSize: 16 },
  saveTxt:     { color: '#4ade80', fontSize: 16, fontWeight: '600', textAlign: 'right' },
  nameWrap:    { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 4 },
  label:       { color: '#555', fontSize: 11, fontWeight: '600', letterSpacing: 0.8, marginBottom: 6 },
  nameInput:   { color: '#fff', fontSize: 18, fontWeight: '600', borderBottomWidth: 1,
                 borderBottomColor: '#2a2a2a', paddingVertical: 6, paddingHorizontal: 0 },
  bodyInput:   { flex: 1, color: '#ddd', fontSize: 15, lineHeight: 22,
                 paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20 },
});
