/**
 * teleprompter.tsx — Teleprompter mode screen.
 *
 * Wires TeleprompterEngine to the G1 glasses and shows a phone-side
 * preview of the rolling window with full playback controls.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Keyboard,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { useG1 } from '@/lib/g1/G1Context';
import {
  TeleprompterEngine,
  EngineSnapshot,
  SPEED_SLOW,
  SPEED_NORMAL,
  SPEED_FAST,
  SPEED_TURBO,
  SPEED_STEP,
} from '@/lib/teleprompter/TeleprompterEngine';

// ── Helpers ────────────────────────────────────────────────────────────────

function speedLabel(s: number): string {
  if (s >= SPEED_SLOW)         return 'Slow';
  if (s > SPEED_FAST)          return 'Normal';
  if (s > SPEED_TURBO + 0.25)  return 'Fast';
  return 'Turbo';
}

// ── Component ──────────────────────────────────────────────────────────────

export default function TeleprompterScreen() {
  const { core, isConnected: connected, isPartiallyConnected: partiallyConnected } = useG1();

  // Engine lives in a ref — stable across renders, no remounting
  const engineRef = useRef<TeleprompterEngine | null>(null);

  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [scriptText, setScriptText] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [loop, setLoop] = useState(false);

  // Initialise engine once
  useEffect(() => {
    const engine = new TeleprompterEngine({
      onFrame: (frame, curLine, totalLines) => {
        if (connected) {
          core.sendText(frame, curLine, totalLines).catch(() => {});
        }
      },
      onStateChange: (s) => setSnap({ ...s }),
    });
    engineRef.current = engine;
    setSnap(engine.getSnapshot());

    return () => engine.destroy();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-send on reconnect (glasses may have restarted)
  useEffect(() => {
    if (connected && snap) {
      core.sendText(snap.frame, snap.topIndex + 1, snap.totalLines).catch(() => {});
    }
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLoad = useCallback(() => {
    if (!scriptText.trim()) return;
    engineRef.current?.loadScript(scriptText);
    setEditMode(false);
    Keyboard.dismiss();
  }, [scriptText]);

  const handlePickFile = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['text/plain', 'text/*', 'public.plain-text'],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const text = await FileSystem.readAsStringAsync(result.assets[0].uri);
    setScriptText(text);
    engineRef.current?.loadScript(text);
    setEditMode(false);
  }, []);

  const handleToggle = useCallback(() => engineRef.current?.toggle(), []);
  const handleNext   = useCallback(() => engineRef.current?.next(),   []);
  const handlePrev   = useCallback(() => engineRef.current?.prev(),   []);

  const handleSpeedDec = useCallback(() => {
    const cur = engineRef.current?.getSnapshot().secondsPerLine ?? SPEED_NORMAL;
    engineRef.current?.setSpeed(Math.min(SPEED_SLOW, cur + SPEED_STEP));
  }, []);
  const handleSpeedInc = useCallback(() => {
    const cur = engineRef.current?.getSnapshot().secondsPerLine ?? SPEED_NORMAL;
    engineRef.current?.setSpeed(Math.max(SPEED_TURBO, cur - SPEED_STEP));
  }, []);

  const handleLoop = useCallback(() => {
    const next = !loop;
    setLoop(next);
    engineRef.current?.setLoop(next);
  }, [loop]);

  if (!snap) return null;

  const playing = snap.state === 'playing';
  const ended   = snap.state === 'ended';
  const hasScript = snap.totalLines > 0;

  // Phone-side preview: show the current 5-line frame
  const frameLines = snap.frame.split('\n');

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

          {/* ── Header ───────────────────────────────────────────────── */}
          <Text style={s.title}>Teleprompter</Text>
          <Text style={[s.subtitle,
            connected ? { color: '#4ade80' } :
            partiallyConnected ? { color: '#f59e0b' } : {}]}>
            {connected
              ? '● Connected'
              : partiallyConnected
              ? '◑ Half-connected — forget & re-pair in iOS Settings'
              : '○ Not connected — controls still work'}
          </Text>

          {/* ── HUD Preview ──────────────────────────────────────────── */}
          <View style={s.hudCard}>
            <Text style={s.hudLabel}>G1 DISPLAY</Text>
            {frameLines.map((line, i) => (
              <Text
                key={i}
                style={[
                  s.hudLine,
                  i === 0 && s.hudStatus,
                  i === 3 && s.hudActive, // line 4 = reading anchor
                ]}
                numberOfLines={1}
              >
                {line || ' '}
              </Text>
            ))}
          </View>

          {/* ── Progress ─────────────────────────────────────────────── */}
          {hasScript && (
            <View style={s.progressRow}>
              <Text style={s.progressText}>
                Line {snap.topIndex + 1} / {snap.totalLines}
              </Text>
              <View style={s.progressBar}>
                <View
                  style={[
                    s.progressFill,
                    { width: `${((snap.topIndex + 1) / snap.totalLines) * 100}%` },
                  ]}
                />
              </View>
            </View>
          )}

          {/* ── Playback Controls ─────────────────────────────────────── */}
          <View style={s.controlRow}>
            <Pressable style={[s.ctrlBtn, s.ctrlSecondary]} onPress={handlePrev} disabled={!hasScript}>
              <Text style={s.ctrlIcon}>←</Text>
            </Pressable>

            <Pressable
              style={[s.ctrlBtn, s.ctrlPrimary, !hasScript && s.ctrlDisabled]}
              onPress={handleToggle}
              disabled={!hasScript}
            >
              <Text style={s.ctrlPlayIcon}>{playing ? '⏸' : '▶'}</Text>
            </Pressable>

            <Pressable style={[s.ctrlBtn, s.ctrlSecondary]} onPress={handleNext} disabled={!hasScript}>
              <Text style={s.ctrlIcon}>→</Text>
            </Pressable>
          </View>

          {ended && (
            <Pressable style={s.restartBtn} onPress={() => engineRef.current?.restart()}>
              <Text style={s.restartText}>↺  Restart from top</Text>
            </Pressable>
          )}

          {/* ── Speed Slider ─────────────────────────────────────────── */}
          <View style={s.speedCard}>
            <View style={s.speedHeader}>
              <Text style={s.speedLabel}>Speed</Text>
              <Text style={s.speedValue}>{speedLabel(snap.secondsPerLine)}</Text>
            </View>
            <View style={s.speedButtons}>
              <Pressable style={s.speedBtn} onPress={handleSpeedDec}>
                <Text style={s.speedBtnText}>−</Text>
              </Pressable>
              <Pressable style={s.speedBtn} onPress={handleSpeedInc}>
                <Text style={s.speedBtnText}>+</Text>
              </Pressable>
            </View>
          </View>

          {/* ── Loop Toggle ──────────────────────────────────────────── */}
          <Pressable style={s.loopRow} onPress={handleLoop}>
            <View style={[s.toggle, loop && s.toggleOn]}>
              <View style={[s.toggleThumb, loop && s.toggleThumbOn]} />
            </View>
            <Text style={s.loopLabel}>Repeat automatically</Text>
          </Pressable>

          {/* ── Script Editor ─────────────────────────────────────────── */}
          <View style={s.scriptSection}>
            <View style={s.scriptHeader}>
              <Text style={s.sectionTitle}>Script</Text>
              <View style={s.scriptHeaderActions}>
                <Pressable onPress={handlePickFile}>
                  <Text style={s.editToggle}>📄 File</Text>
                </Pressable>
                <Pressable onPress={() => setEditMode(e => !e)}>
                  <Text style={s.editToggle}>{editMode ? 'Cancel' : 'Paste'}</Text>
                </Pressable>
              </View>
            </View>

            {editMode ? (
              <>
                <TextInput
                  style={s.scriptInput}
                  multiline
                  autoFocus
                  value={scriptText}
                  onChangeText={setScriptText}
                  placeholder="Paste or type your script here…"
                  placeholderTextColor="#444"
                  textAlignVertical="top"
                />
                <Pressable
                  style={[s.loadBtn, !scriptText.trim() && s.ctrlDisabled]}
                  onPress={handleLoad}
                  disabled={!scriptText.trim()}
                >
                  <Text style={s.loadBtnText}>Load Script →</Text>
                </Pressable>
              </>
            ) : (
              <Text style={s.scriptPreview} numberOfLines={4}>
                {scriptText || '(using default script — tap Edit to load your own)'}
              </Text>
            )}
          </View>

        </ScrollView>
      </SafeAreaView>
    </TouchableWithoutFeedback>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:             { flex: 1, backgroundColor: '#0a0a0a' },
  scroll:           { paddingHorizontal: 20, paddingBottom: 40 },

  title:            { color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 20 },
  subtitle:         { color: '#555', fontSize: 13, marginTop: 4, marginBottom: 24 },

  // HUD preview
  hudCard:          { backgroundColor: '#0d1a0d', borderRadius: 16, padding: 20, marginBottom: 20,
                       borderWidth: 1, borderColor: '#1a3a1a' },
  hudLabel:         { color: '#1a4a1a', fontSize: 10, fontWeight: '700', letterSpacing: 2,
                       marginBottom: 12 },
  hudLine:          { color: '#22c55e', fontFamily: 'monospace', fontSize: 13, lineHeight: 22 },
  hudStatus:        { color: '#4ade80', fontWeight: '600' },
  hudActive:        { color: '#86efac', backgroundColor: '#0f2a0f', borderRadius: 4,
                       paddingHorizontal: 4 },

  // Progress
  progressRow:      { marginBottom: 20, gap: 8 },
  progressText:     { color: '#555', fontSize: 12 },
  progressBar:      { height: 2, backgroundColor: '#1e1e1e', borderRadius: 1 },
  progressFill:     { height: 2, backgroundColor: '#22c55e', borderRadius: 1 },

  // Controls
  controlRow:       { flexDirection: 'row', gap: 12, marginBottom: 20, justifyContent: 'center' },
  ctrlBtn:          { borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  ctrlPrimary:      { backgroundColor: '#fff', width: 72, height: 72 },
  ctrlSecondary:    { backgroundColor: '#1e1e1e', width: 56, height: 56 },
  ctrlDisabled:     { opacity: 0.3 },
  ctrlPlayIcon:     { fontSize: 28 },
  ctrlIcon:         { fontSize: 22, color: '#fff' },

  restartBtn:       { alignSelf: 'center', marginBottom: 20, paddingVertical: 10, paddingHorizontal: 24,
                       backgroundColor: '#1e1e1e', borderRadius: 12 },
  restartText:      { color: '#888', fontSize: 14 },

  // Speed
  speedCard:        { backgroundColor: '#141414', borderRadius: 16, padding: 20, marginBottom: 16 },
  speedHeader:      { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  speedLabel:       { color: '#888', fontSize: 13 },
  speedValue:       { color: '#fff', fontSize: 13, fontWeight: '600' },
  speedButtons:     { flexDirection: 'row', gap: 12, marginTop: 8 },
  speedBtn:         { flex: 1, backgroundColor: '#1e1e1e', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  speedBtnText:     { color: '#fff', fontSize: 28, lineHeight: 32 },

  // Loop toggle
  loopRow:          { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 28 },
  toggle:           { width: 44, height: 26, borderRadius: 13, backgroundColor: '#1e1e1e',
                       justifyContent: 'center', paddingHorizontal: 3 },
  toggleOn:         { backgroundColor: '#22c55e' },
  toggleThumb:      { width: 20, height: 20, borderRadius: 10, backgroundColor: '#555' },
  toggleThumbOn:    { backgroundColor: '#fff', alignSelf: 'flex-end' },
  loopLabel:        { color: '#888', fontSize: 14 },

  // Script editor
  scriptSection:    { gap: 12 },
  scriptHeader:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  scriptHeaderActions: { flexDirection: 'row', gap: 16 },
  sectionTitle:     { color: '#fff', fontSize: 18, fontWeight: '600' },
  editToggle:       { color: '#22c55e', fontSize: 14 },
  scriptInput:      { backgroundColor: '#141414', borderRadius: 12, padding: 16, color: '#fff',
                       fontSize: 14, lineHeight: 22, minHeight: 180 },
  scriptPreview:    { color: '#444', fontSize: 13, lineHeight: 20 },
  loadBtn:          { backgroundColor: '#22c55e', borderRadius: 12, paddingVertical: 14,
                       alignItems: 'center', marginTop: 4 },
  loadBtnText:      { color: '#000', fontSize: 16, fontWeight: '700' },
});
