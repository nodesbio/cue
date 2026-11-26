/**
 * live.tsx — Live Mirror (easter-egg / power-user mode, reached from Settings).
 *
 * Whatever you type mirrors to the glasses as you go. Bypasses the engine
 * entirely; the engine is paused on entry so they don't fight, and nothing
 * here persists. This used to be the "Live" half of the Compose tab — the
 * "Script" half was a duplicate of Scripts' + New / Load, so it was removed.
 */
import { useCallback, useEffect } from 'react';
import { useState } from 'react';
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
import { useG1 } from '@/lib/g1/G1Context';
import { getEngine } from '@/lib/teleprompter/engine';
import { useLiveMirror } from '@/lib/teleprompter/useLiveMirror';

export default function LiveMirrorScreen() {
  const router = useRouter();
  const { core, isConnected: connected } = useG1();
  const [liveText, setLiveText] = useState('');

  // Pause the engine on entry so the scroll path and the live mirror don't both
  // drive the lens. (Compose did this on mode switch; here it's unconditional.)
  useEffect(() => { getEngine().pause(); }, []);

  const sendLive = useCallback((frame: string) => core.sendText(frame), [core]);
  useLiveMirror(connected, liveText, sendLive);

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Text style={s.back}>‹ Back</Text>
          </Pressable>
          <Text style={s.title}>● Live Mirror</Text>
          <View style={s.backSpacer} />
        </View>

        <ScrollView
          style={s.flex}
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
        >
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
        </ScrollView>
      </SafeAreaView>
    </TouchableWithoutFeedback>
  );
}

const s = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#0a0a0a' },
  flex:        { flex: 1 },
  header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                 paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  back:        { color: '#ef4444', fontSize: 16, fontWeight: '600', width: 64 },
  backSpacer:  { width: 64 },
  title:       { color: '#fff', fontSize: 20, fontWeight: '700' },
  scroll:      { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
  hint:        { color: '#666', fontSize: 13 },
  input:       { backgroundColor: '#141414', borderRadius: 12, padding: 16, color: '#fff',
                 fontSize: 15, lineHeight: 22, minHeight: 280 },
});
