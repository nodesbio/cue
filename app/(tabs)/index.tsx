/**
 * teleprompter.tsx — Teleprompter mode screen.
 *
 * Wires TeleprompterEngine to the G1 glasses and shows a phone-side
 * preview of the rolling window with full playback controls.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Animated,
  Keyboard,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  useWindowDimensions,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Slider from '@react-native-community/slider';
import { useG1, useG1Event } from '@/lib/g1/G1Context';
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

// ── Module-level singleton ─────────────────────────────────────────────────
// One engine instance for the lifetime of this JS module.
// Fast Refresh replaces the module — module.hot.dispose kills the old engine's
// timers before the new module instance starts, preventing orphaned setIntervals.
let _engine: TeleprompterEngine | null = null;

if (typeof module !== 'undefined' && (module as NodeModule & { hot?: { dispose: (cb: () => void) => void } }).hot) {
  (module as NodeModule & { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
    _engine?.destroy();
    _engine = null;
  });
}

// ── Component ──────────────────────────────────────────────────────────────

export default function TeleprompterScreen() {
  const { core, status, isConnected: connected, isPartiallyConnected: partiallyConnected } = useG1();
  const { width: screenWidth } = useWindowDimensions();
  const screenWidthRef = useRef(screenWidth);
  useEffect(() => { screenWidthRef.current = screenWidth; }, [screenWidth]);

  // Engine lives in a ref — stable across renders, no remounting
  const engineRef = useRef<TeleprompterEngine | null>(null);

  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [scriptText, setScriptText] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [loop, setLoop] = useState(false);
  const [gesturesEnabled, setGesturesEnabled] = useState(false);
  const [gesturesSwapped, setGesturesSwapped] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  // 0 = split view (HUD + controls), 1 = HUD-only fullscreen
  const [hudPage, setHudPage] = useState(0);
  // true while the panel is fullscreen OR animating toward fullscreen
  // (leads hudPage so the flex:1 style applies before the panel lands)
  const [hudFullscreen, setHudFullscreen] = useState(false);
  const hudSlide = useRef(new Animated.Value(0)).current;
  const gesturesEnabledRef = useRef(false);
  const gesturesSwappedRef = useRef(false);

  const snapRef = useRef<EngineSnapshot | null>(null);
  const connectedRef = useRef(false);
  const manualPauseRef = useRef(false);


  // Keep refs in sync
  useEffect(() => { gesturesEnabledRef.current = gesturesEnabled; }, [gesturesEnabled]);
  useEffect(() => { gesturesSwappedRef.current = gesturesSwapped; }, [gesturesSwapped]);
  useEffect(() => { snapRef.current = snap; }, [snap]);
  useEffect(() => { connectedRef.current = connected; }, [connected]);

  // Load gesture preferences (re-read on focus so settings changes apply immediately)
  useEffect(() => {
    AsyncStorage.multiGet(['gesture_nav_enabled', 'gesture_nav_swapped']).then(pairs => {
      if (pairs[0][1] === 'true') setGesturesEnabled(true);
      if (pairs[1][1] === 'true') setGesturesSwapped(true);
    }).catch(() => {});
  }, []);

  // Gesture model (runs regardless of gesturesEnabled so nod always works):
  //   head_down              → start rewind immediately
  //   head_up (after down<NOD_WINDOW_MS) → stop rewind + toggle pause
  //   head_up (no prior down, or down timed out) → play / stopRewind / advance
  //
  // Media remote (G1 tap events — works regardless of gesturesEnabled):
  //   single_tap → next line
  //   double_tap → prev line
  //
  // Dedup: hardware fires each event 2-3x in a burst; suppress repeats within DEDUP_MS.
  const NOD_WINDOW_MS = 600;
  const DEDUP_MS = 300;

  const dedupRef   = useRef<{ name: string; until: number }>({ name: '', until: 0 });
  const handleToggleRef = useRef<() => void>(() => {});

  useG1Event((event) => {
    // G1 glasses emit from both arms — only handle the right side to avoid
    // doubles. SmartRemote events carry no side and pass through.
    if (event.side !== undefined && event.side !== 'R') return;

    const isUp      = event.name === 'head_up';
    const isDown    = event.name === 'head_down';
    const isTap     = event.name === 'single_tap';
    const isDblTap  = event.name === 'double_tap';
    const isTriTap  = event.name === 'triple_tap';

    if (!isUp && !isDown && !isTap && !isDblTap && !isTriTap) return;

    // ── Dedup ────────────────────────────────────────────────────────────
    const now = Date.now();
    if (event.name === dedupRef.current.name && now < dedupRef.current.until) return;
    dedupRef.current = { name: event.name, until: now + DEDUP_MS };

    // ── Media remote ─────────────────────────────────────────────────────
    // Tap events work independently of gesturesEnabled — the remote is always live.
    if (isTap) {
      engineRef.current?.next();
      return;
    }
    if (isDblTap) {
      engineRef.current?.prev();
      return;
    }
    // triple_tap = SmartRemote play/pause button. Route through handleToggle
    // so manualPauseRef stays in sync — a remote pause must also block head
    // gestures, exactly like a UI pause.
    if (isTriTap) {
      handleToggleRef.current();
      return;
    }

    // ── Head gestures ─────────────────────────────────────────────────────
    if (isDown) {
      if (manualPauseRef.current) return; // UI pause overrides gestures
      if (!engineRef.current?.isRewinding()) engineRef.current?.startRewind();
      return;
    }

    // ── head_up → advance one line (or resume if playing) ────────────────
    engineRef.current?.stopRewind();
    if (!gesturesEnabledRef.current) return;
    if (manualPauseRef.current) return;
    // Only resume play if already playing — never auto-start from idle/paused
    if (engineRef.current?.getSnapshot().state === 'playing') return;
    engineRef.current?.next();
  });

  // Initialise engine once per module lifetime.
  // StrictMode double-mounts reuse the same _engine; destroy() is NOT called on
  // unmount so the singleton survives the StrictMode cleanup/remount cycle.
  // Fast Refresh tears down the old module (and its _engine) via module.hot.dispose
  // before this runs, so there is never more than one live engine at a time.
  useEffect(() => {
    if (!_engine) {
      _engine = new TeleprompterEngine({ onFrame: () => {}, onStateChange: () => {} });
    }
    engineRef.current = _engine;

    // Re-wire every mount so closures (core, setSnap, connectedRef) are always
    // from the live component instance, not a stale StrictMode/Fast-Refresh copy.
    _engine.setCallbacks({
      onFrame: (frame, curLine, totalLines) => {
        if (connectedRef.current) {
          core.sendText(frame, curLine, totalLines).catch(() => undefined);
        }
      },
      onStateChange: (s) => {
        setSnap({ ...s });
      },
    });

    setSnap(_engine.getSnapshot());
    // No cleanup: singleton must outlive StrictMode unmount.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-send on reconnect (glasses may have restarted)
  useEffect(() => {
    if (!connected) return;
    const s = snapRef.current;
    if (s) {
      core.sendText(s.frame, s.topIndex + 1, s.totalLines).catch(() => undefined);
    }
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep battery levels in the engine status bar
  useEffect(() => {
    engineRef.current?.setBattery(
      status?.left.batteryPct ?? null,
      status?.right.batteryPct ?? null,
    );
  }, [status?.left.batteryPct, status?.right.batteryPct]);

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

  const handleToggle = useCallback(() => {
    const isPlaying = engineRef.current?.getSnapshot().state === 'playing';
    manualPauseRef.current = isPlaying;
    engineRef.current?.toggle();
  }, []);
  handleToggleRef.current = handleToggle;
  const handleNext   = useCallback(() => engineRef.current?.next(),   []);
  const handlePrev   = useCallback(() => engineRef.current?.prev(),   []);

  // Slider value = secondsPerLine (higher = slower). Min=SPEED_TURBO, Max=SPEED_SLOW.
  const handleSpeedChange = useCallback((value: number) => {
    engineRef.current?.setSpeed(value);
  }, []);

  const handleLoop = useCallback(() => {
    const next = !loop;
    setLoop(next);
    engineRef.current?.setLoop(next);
  }, [loop]);

  // ── Reconnect handler ─────────────────────────────────────────────────────
  const handleReconnect = useCallback(async () => {
    setReconnecting(true);
    try { await core.reconnectDropped(); } catch {}
    // Show spinner for at least 1 s so the tap feels responsive
    setTimeout(() => setReconnecting(false), 1000);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── HUD combined gesture handler ─────────────────────────────────────────
  // One PanResponder handles both axes to avoid responder contention:
  //   · Horizontal (|dx| > |dy|, |dx| > 50)  → page switch (fullscreen ↔ split)
  //   · Vertical   (|dy| > |dx|)              → scrub (18 px per line step)
  const SCRUB_STEP_PX   = 18;
  const HUD_SWIPE_THRESHOLD = 50;
  const scrubAccumRef = useRef(0);
  // true while the gesture is classified as horizontal
  const isHorizRef = useRef<boolean | null>(null);

  const scrubPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  () => true,
      onPanResponderGrant: () => {
        scrubAccumRef.current = 0;
        isHorizRef.current = null;
      },
      onPanResponderMove: (_, gs) => {
        // Classify on first meaningful movement
        if (isHorizRef.current === null && (Math.abs(gs.dx) > 6 || Math.abs(gs.dy) > 6)) {
          isHorizRef.current = Math.abs(gs.dx) > Math.abs(gs.dy);
        }

        if (isHorizRef.current) {
          hudSlide.setValue(gs.dx);
          return;
        }

        // Vertical scrub
        const steps = Math.trunc(-gs.dy / SCRUB_STEP_PX);
        const delta = steps - scrubAccumRef.current;
        if (delta === 0) return;
        scrubAccumRef.current = steps;
        if (delta > 0) {
          for (let i = 0; i < delta; i++) engineRef.current?.next();
        } else {
          for (let i = 0; i < -delta; i++) engineRef.current?.prev();
        }
      },
      onPanResponderRelease: (_, gs) => {
        scrubAccumRef.current = 0;
        if (isHorizRef.current) {
          if (gs.dx < -HUD_SWIPE_THRESHOLD) {
            // Swipe left → go to page 1 (fullscreen)
            // Apply fullscreen layout BEFORE animating so flex:1 is active during slide
            setHudFullscreen(true);
            Animated.timing(hudSlide, {
              toValue: -screenWidthRef.current,
              duration: 220,
              useNativeDriver: true,
            }).start(() => {
              hudSlide.setValue(0);
              setHudPage(1);
            });
          } else if (gs.dx > HUD_SWIPE_THRESHOLD) {
            // Swipe right → go to page 0 (split)
            // Keep fullscreen layout until after panel slides away
            Animated.timing(hudSlide, {
              toValue: screenWidthRef.current,
              duration: 220,
              useNativeDriver: true,
            }).start(() => {
              hudSlide.setValue(0);
              setHudPage(0);
              setHudFullscreen(false);
            });
          } else {
            // Snap back (didn't pass threshold)
            Animated.spring(hudSlide, { toValue: 0, useNativeDriver: true }).start();
          }
        }
        isHorizRef.current = null;
      },
    }),
  ).current;

  if (!snap) return null;

  const playing = snap.state === 'playing';
  const ended   = snap.state === 'ended';
  const hasScript = snap.totalLines > 0;

  // Render the current G1 frame as lines
  const hudLines = (engineRef.current?.getFrameAt(snap.topIndex) ?? '').split('\n');

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <SafeAreaView style={s.root}>

        {/* ── Header — hidden in fullscreen mode ─────────────────────── */}
        {!hudFullscreen && (
        <View style={s.headerBlock}>
          <Text style={s.title}>Teleprompter</Text>
          <Text style={[s.subtitle, connected ? { color: '#4ade80' } : {}]}>
            {connected ? '● Connected' : '○ Not connected — controls still work'}
          </Text>
        </View>
        )}

        {/* ── Half-connected reconnect banner ────────────────────────── */}
        {partiallyConnected && !hudFullscreen && (
          <View style={s.reconnectBanner}>
            <Text style={s.reconnectText}>◑ One lens dropped</Text>
            <Pressable
              style={[s.reconnectBtn, reconnecting && s.ctrlDisabled]}
              onPress={handleReconnect}
              disabled={reconnecting}
            >
              <Text style={s.reconnectBtnText}>
                {reconnecting ? 'Reconnecting…' : 'Reconnect'}
              </Text>
            </Pressable>
          </View>
        )}

        {/* ── G1 Display panel — swipe left/right to change view ─────── */}
        {/* Combines horizontal swipe (page change) + vertical scrub      */}
        <Animated.View
          style={[s.hudOuter, hudFullscreen && s.hudOuterFullscreen,
            { transform: [{ translateX: hudSlide }] }]}
          {...scrubPan.panHandlers}
        >
          <View style={s.hudLabelRow}>
            <Text style={s.hudLabel}>G1 DISPLAY</Text>
            <Text style={s.hudPageDots}>
              {hudFullscreen ? '○ ●' : '● ○'}
            </Text>
          </View>
          {hudLines.map((line, i) => (
            <Text
              key={i}
              style={[
                s.hudLine,
                i === 0 && s.hudStatus,
                i === 1 && s.hudActive,
                hudFullscreen && i > 0 && s.hudLineFullscreen,
              ]}
              numberOfLines={1}
            >
              {line || ' '}
            </Text>
          ))}
          <Text style={s.hudHint}>
            {hudFullscreen ? '↕ scrub  ·  → swipe right to exit' : '↕ scrub  ·  ← swipe left for fullscreen'}
          </Text>
        </Animated.View>

        {!hudFullscreen && <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

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
            <Slider
              style={s.speedSlider}
              minimumValue={-SPEED_SLOW}
              maximumValue={-SPEED_TURBO}
              value={-snap.secondsPerLine}
              step={SPEED_STEP}
              onValueChange={(v) => handleSpeedChange(-v)}
              minimumTrackTintColor="#333"
              maximumTrackTintColor="#fff"
              thumbTintColor="#fff"
            />
            <View style={s.speedEndLabels}>
              <Text style={s.speedEndLabel}>Slow</Text>
              <Text style={s.speedEndLabel}>Fast</Text>
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

        </ScrollView>}
      </SafeAreaView>
    </TouchableWithoutFeedback>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:             { flex: 1, backgroundColor: '#0a0a0a', overflow: 'hidden' },
  headerBlock:      { paddingHorizontal: 20 },
  scroll:           { paddingHorizontal: 20, paddingBottom: 40 },

  title:            { color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 20 },
  subtitle:         { color: '#555', fontSize: 13, marginTop: 4, marginBottom: 16 },

  // ── Reconnect banner ──────────────────────────────────────────────────────
  reconnectBanner:  { marginHorizontal: 20, marginBottom: 8, padding: 12,
                       backgroundColor: '#1a1200', borderRadius: 12,
                       borderWidth: 1, borderColor: '#3a2c00',
                       flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  reconnectText:    { color: '#f59e0b', fontSize: 13, fontWeight: '600' },
  reconnectBtn:     { backgroundColor: '#f59e0b', borderRadius: 8,
                       paddingVertical: 6, paddingHorizontal: 14 },
  reconnectBtnText: { color: '#000', fontSize: 13, fontWeight: '700' },

  // ── G1 Display panel ──────────────────────────────────────────────────────
  hudOuter:         { marginHorizontal: 16, marginBottom: 20,
                       backgroundColor: '#0d1a0d', borderRadius: 16,
                       paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20,
                       borderWidth: 1, borderColor: '#1a3a1a',
                       minHeight: 260 },
  // Fullscreen HUD mode — takes up as much vertical space as possible
  hudOuterFullscreen: { marginHorizontal: 0, borderRadius: 0, flex: 1,
                         borderWidth: 0, paddingHorizontal: 28, paddingTop: 36, paddingBottom: 28,
                         justifyContent: 'center' },
  hudLineFullscreen:  { fontSize: 36, lineHeight: 56 },
  hudLabelRow:      { flexDirection: 'row', justifyContent: 'space-between',
                       alignItems: 'center', marginBottom: 16 },
  hudLabel:         { color: '#2d6a2d', fontSize: 10, fontWeight: '700', letterSpacing: 2 },
  hudPageDots:      { color: '#2d6a2d', fontSize: 13 },
  // Display lines — sized to feel like actual glasses output
  hudLine:          { color: '#22c55e', fontFamily: 'monospace', fontSize: 24, lineHeight: 44 },
  hudStatus:        { color: '#4ade80', fontWeight: '600', fontSize: 16, lineHeight: 28 },
  hudActive:        { color: '#86efac', backgroundColor: '#0f2a0f', borderRadius: 4,
                       paddingHorizontal: 4 },
  hudHint:          { color: '#1a3a1a', fontSize: 11, textAlign: 'center', marginTop: 14 },

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
  speedSlider:      { width: '100%', height: 40, marginTop: 4 },
  speedEndLabels:   { flexDirection: 'row', justifyContent: 'space-between', marginTop: -4 },
  speedEndLabel:    { color: '#555', fontSize: 11 },

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
