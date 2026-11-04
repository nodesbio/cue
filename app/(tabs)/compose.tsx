/**
 * Compose tab — the quick, ephemeral path to get words onto the glasses.
 *
 *  Script : paste/type, then Load → engine (Teleprompter tab drives playback).
 *  Live   : whatever you type mirrors to the glasses as you go. Bypasses the
 *           engine entirely; the engine is paused on entry so they don't fight.
 *
 * Nothing here persists. The Scripts tab owns the library (New / Import / Edit).
 */
import { useCallback, useEffect, useState } from 'react';
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
import { useRouter } from 'expo-router';
import * as Inbox from '@/lib/scripts/Inbox';
import { useG1 } from '@/lib/g1/G1Context';
import { getEngine } from '@/lib/teleprompter/engine';
import { useLiveMirror } from '@/lib/teleprompter/useLiveMirror';

type Mode = 'script' | 'live';

export default function ComposeScreen() {
  const router = useRouter();
  const { core, isConnected: connected } = useG1();
  const [mode, setMode] = useState<Mode>('script');
  const [scriptText, setScriptText] = useState('');
  const [liveText, setLiveText] = useState('');

  // ── Live ────────────────────────────────────────────────────────────────
  const sendLive = useCallback((frame: string) => core.sendText(frame), [core]);
  useLiveMirror(mode === 'live' && connected, liveText, sendLive);

  const switchMode = useCallback((m: Mode) => {
    if (m === 'live') getEngine().pause();
    setMode(m);
  }, []);

  // ── Script ──────────────────────────────────────────────────────────────
  const loadToEngine = useCallback((text: string) => {
    getEngine().loadScript(text);
    Keyboard.dismiss();
    router.navigate('/(tabs)');
  }, [router]);

  const handleLoad = useCallback(() => {
    if (scriptText.trim()) loadToEngine(scriptText);
  }, [scriptText, loadToEngine]);

  // Share-to-Cue: text deposited by app/_layout.tsx. Drain on mount (cold
  // start) and on every deposit (warm). Loads straight to the engine.
  useEffect(() => {
    const drain = () => {
      const text = Inbox.take();
      if (!text) return;
      setScriptText(text);
      setMode('script');
      getEngine().loadScript(text);
    };
    drain();
    return Inbox.subscribe(drain);
  }, []);

  const isLive = mode === 'live';

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <Text style={s.title}>Compose</Text>
        </View>

        <View style={s.segment}>
          <Pressable style={[s.segBtn, !isLive && s.segOn]} onPress={() => switchMode('script')}>
            <Text style={[s.segText, !isLive && s.segTextOn]}>Script</Text>
          </Pressable>
          <Pressable style={[s.segBtn, isLive && s.segLiveOn]} onPress={() => switchMode('live')}>
            <Text style={[s.segText, isLive && s.segTextOn]}>{isLive ? '● Live' : 'Live'}</Text>
          </Pressable>
        </View>

        <ScrollView
          style={s.flex}
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
        >
          {isLive ? (
            <>
              <Text style={s.hint}>
                {connected
                  ? 'Everything you type appears on the glasses as you go.'
                  : 'Connect glasses on the Teleprompter tab to go live.'}
              </Text>
              <TextInput
                style={s.input}
                multiline
                autoFocus
                value={liveText}
                onChangeText={setLiveText}
                placeholder="Start typing…"
                placeholderTextColor="#444"
                textAlignVertical="top"
              />
            </>
          ) : (
            <>
              <Text style={s.hint}>One-off script. To keep it, use + New in Scripts.</Text>
              <TextInput
                style={s.input}
                multiline
                value={scriptText}
                onChangeText={setScriptText}
                placeholder="Paste or type your script here…"
                placeholderTextColor="#444"
                textAlignVertical="top"
              />
              <Pressable
                style={[s.loadBtn, !scriptText.trim() && s.disabled]}
                onPress={handleLoad}
                disabled={!scriptText.trim()}
              >
                <Text style={s.loadBtnText}>Load to Teleprompter →</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </TouchableWithoutFeedback>
  );
}

const s = StyleSheet.create({
  root:          { flex: 1, backgroundColor: '#0a0a0a' },
  flex:          { flex: 1 },
  header:        { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  title:         { color: '#fff', fontSize: 28, fontWeight: '700' },

  segment:       { flexDirection: 'row', marginHorizontal: 20, marginBottom: 12, backgroundColor: '#141414',
                   borderRadius: 10, padding: 3 },
  segBtn:        { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segOn:         { backgroundColor: '#22c55e' },
  segLiveOn:     { backgroundColor: '#ef4444' },
  segText:       { color: '#888', fontSize: 14, fontWeight: '600' },
  segTextOn:     { color: '#000' },

  scroll:        { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
  hint:          { color: '#666', fontSize: 13 },
  input:         { backgroundColor: '#141414', borderRadius: 12, padding: 16, color: '#fff',
                   fontSize: 15, lineHeight: 22, minHeight: 280 },
  loadBtn:       { backgroundColor: '#22c55e', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  loadBtnText:   { color: '#000', fontSize: 16, fontWeight: '700' },
  disabled:      { opacity: 0.3 },
});
