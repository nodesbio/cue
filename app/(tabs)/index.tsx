/**
 * Teleprompter — paste text, set speed, scroll to G1 HUD.
 * Temple tap (single_tap) → pause / resume.
 * Temple double-tap → exit to G1 dashboard.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { G1Core, G1Status } from '@/lib/g1/G1Core';
import { G1Event } from '@/lib/g1/packets';

// ── How many chars to push per "tick" ─────────────────────────────────────
const CHARS_PER_SEGMENT = 160; // fits one G1 screen comfortably

type Phase = 'idle' | 'connecting' | 'ready' | 'playing' | 'paused' | 'done';

export default function TeleprompterScreen() {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [scrollPct, setScrollPct] = useState(0);      // 0–100 progress
  const [wpm, setWpm] = useState(120);                 // approx reading speed
  const [status, setStatus] = useState<G1Status | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const g1 = useRef<G1Core | null>(null);
  const segmentIndex = useRef(0);
  const segments = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ms per segment based on WPM (avg 5 chars/word)
  const msPerSegment = useCallback(() => {
    const words = CHARS_PER_SEGMENT / 5;
    return Math.round((words / wpm) * 60_000);
  }, [wpm]);

  // ── G1 event handler ──────────────────────────────────────────────────────
  const handleEvent = useCallback((event: G1Event) => {
    if (event.name === 'single_tap') {
      setPhase(prev => {
        if (prev === 'playing') { _pause(); return 'paused'; }
        if (prev === 'paused')  { _resume(); return 'playing'; }
        return prev;
      });
    }
    if (event.name === 'double_tap') {
      _stop();
    }
  }, []);

  // ── Connect ───────────────────────────────────────────────────────────────
  async function connect() {
    setPhase('connecting');
    setErrorMsg(null);
    try {
      const core = new G1Core({
        onEvent: handleEvent,
        onStatusChange: (s) => setStatus({ ...s }),
      });
      await core.connect();
      g1.current = core;
      setPhase('ready');
    } catch (e: any) {
      setErrorMsg(e.message ?? 'Connection failed');
      setPhase('idle');
    }
  }

  // ── Scroll control ────────────────────────────────────────────────────────
  function buildSegments(raw: string): string[] {
    const segs: string[] = [];
    for (let i = 0; i < raw.length; i += CHARS_PER_SEGMENT) {
      segs.push(raw.slice(i, i + CHARS_PER_SEGMENT).trim());
    }
    return segs.filter(Boolean);
  }

  async function _pushNextSegment() {
    const core = g1.current;
    if (!core) return;
    const idx = segmentIndex.current;
    const segs = segments.current;
    if (idx >= segs.length) {
      setPhase('done');
      return;
    }
    await core.sendText(segs[idx]);
    segmentIndex.current = idx + 1;
    setScrollPct(Math.round(((idx + 1) / segs.length) * 100));
    timerRef.current = setTimeout(_pushNextSegment, msPerSegment());
  }

  function _pause() {
    if (timerRef.current) clearTimeout(timerRef.current);
  }

  function _resume() {
    _pushNextSegment();
  }

  function _stop() {
    _pause();
    segmentIndex.current = 0;
    setScrollPct(0);
    setPhase('ready');
    g1.current?.exitToDashboard();
  }

  async function startScroll() {
    if (!g1.current || !text.trim()) return;
    segments.current = buildSegments(text);
    segmentIndex.current = 0;
    setScrollPct(0);
    setPhase('playing');
    await _pushNextSegment();
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      _pause();
      g1.current?.destroy();
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  const connected = status?.left.connected && status?.right.connected;
  const battL = status?.left.batteryPct ?? 0;
  const battR = status?.right.batteryPct ?? 0;

  return (
    <SafeAreaView style={s.root}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header */}
        <View style={s.header}>
          <Text style={s.title}>Cue</Text>
          <View style={s.connRow}>
            {connected ? (
              <Text style={s.connOn}>● G1  L:{battL}%  R:{battR}%</Text>
            ) : (
              <Pressable onPress={connect} disabled={phase === 'connecting'}>
                <Text style={s.connOff}>
                  {phase === 'connecting' ? 'Connecting…' : '○ Connect G1'}
                </Text>
              </Pressable>
            )}
          </View>
        </View>

        {errorMsg && (
          <Text style={s.error}>{errorMsg}</Text>
        )}

        {/* Text input */}
        <TextInput
          style={s.input}
          multiline
          placeholder="Paste your text here…"
          placeholderTextColor="#444"
          value={text}
          onChangeText={setText}
          editable={phase !== 'playing'}
          scrollEnabled
        />

        {/* Speed + progress */}
        <View style={s.controls}>
          <View style={s.wpmRow}>
            <Pressable onPress={() => setWpm(w => Math.max(40, w - 20))} style={s.wpmBtn}>
              <Text style={s.wpmBtnText}>−</Text>
            </Pressable>
            <Text style={s.wpmLabel}>{wpm} WPM</Text>
            <Pressable onPress={() => setWpm(w => Math.min(400, w + 20))} style={s.wpmBtn}>
              <Text style={s.wpmBtnText}>+</Text>
            </Pressable>
          </View>

          {(phase === 'playing' || phase === 'paused' || phase === 'done') && (
            <View style={s.progressBar}>
              <View style={[s.progressFill, { width: `${scrollPct}%` }]} />
            </View>
          )}
        </View>

        {/* Action button */}
        <View style={s.actionRow}>
          {(phase === 'idle' || phase === 'ready') && (
            <Pressable
              style={[s.btn, (!connected || !text.trim()) && s.btnDisabled]}
              onPress={startScroll}
              disabled={!connected || !text.trim()}
            >
              <Text style={s.btnText}>▶  Start</Text>
            </Pressable>
          )}
          {phase === 'playing' && (
            <Pressable style={s.btn} onPress={() => { _pause(); setPhase('paused'); }}>
              <Text style={s.btnText}>⏸  Pause</Text>
            </Pressable>
          )}
          {phase === 'paused' && (
            <View style={s.btnGroup}>
              <Pressable style={s.btn} onPress={() => { _resume(); setPhase('playing'); }}>
                <Text style={s.btnText}>▶  Resume</Text>
              </Pressable>
              <Pressable style={[s.btn, s.btnSecondary]} onPress={_stop}>
                <Text style={s.btnText}>■  Stop</Text>
              </Pressable>
            </View>
          )}
          {phase === 'done' && (
            <Pressable style={[s.btn, s.btnSecondary]} onPress={_stop}>
              <Text style={s.btnText}>↺  Reset</Text>
            </Pressable>
          )}
        </View>

        <Text style={s.hint}>
          Temple tap — pause/resume  ·  Double tap — exit
        </Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#0a0a0a' },
  header:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  title:       { color: '#fff', fontSize: 22, fontWeight: '700', letterSpacing: 1 },
  connRow:     {},
  connOn:      { color: '#4ade80', fontSize: 12 },
  connOff:     { color: '#888', fontSize: 12 },
  error:       { color: '#f87171', fontSize: 13, marginHorizontal: 20, marginBottom: 8 },
  input:       { flex: 1, marginHorizontal: 16, padding: 14, backgroundColor: '#141414', borderRadius: 10, color: '#fff', fontSize: 16, lineHeight: 24, textAlignVertical: 'top' },
  controls:    { paddingHorizontal: 20, paddingVertical: 12 },
  wpmRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 },
  wpmBtn:      { width: 40, height: 40, borderRadius: 20, backgroundColor: '#1e1e1e', alignItems: 'center', justifyContent: 'center' },
  wpmBtnText:  { color: '#fff', fontSize: 20, fontWeight: '300' },
  wpmLabel:    { color: '#aaa', fontSize: 15, width: 90, textAlign: 'center' },
  progressBar: { height: 3, backgroundColor: '#222', borderRadius: 2, marginTop: 12 },
  progressFill:{ height: 3, backgroundColor: '#ffffff', borderRadius: 2 },
  actionRow:   { paddingHorizontal: 20, paddingBottom: 8 },
  btnGroup:    { flexDirection: 'row', gap: 12 },
  btn:         { flex: 1, backgroundColor: '#fff', borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  btnSecondary:{ backgroundColor: '#1e1e1e' },
  btnDisabled: { opacity: 0.3 },
  btnText:     { fontSize: 16, fontWeight: '600', color: '#000' },
  hint:        { textAlign: 'center', color: '#333', fontSize: 11, paddingBottom: 8 },
});
