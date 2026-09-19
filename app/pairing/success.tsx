/**
 * Pairing Success — serial already persisted by G1Context.connect().
 * Navigates home on dismiss.
 *
 * NOTE: iOS may still be showing Bluetooth pairing dialogs ("Pair?" / "Allow
 * notifications?") for the individual lenses at this point. Those are OS-level
 * prompts that fire after the app-level connection resolves and are required for
 * full functionality. We tell the user to expect them and tap Allow/Pair.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

export default function PairingSuccessScreen() {
  const router = useRouter();
  const { serial } = useLocalSearchParams<{ serial: string }>();

  return (
    <SafeAreaView style={s.root}>
      <View style={s.card}>
        <Text style={s.check}>✓</Text>
        <Text style={s.title}>Connected</Text>
        <Text style={s.subtitle}>G1 · {serial}</Text>
        <Text style={s.body}>
          If iOS shows "Pair?" or "Allow Notifications?" prompts for your lenses — tap{' '}
          <Text style={s.bold}>Pair</Text> and <Text style={s.bold}>Allow</Text> on each.
          That completes the one-time Bluetooth setup.
        </Text>
        <Text style={s.body2}>
          Once done, Cue will reconnect automatically next time.
        </Text>
      </View>

      <Pressable style={s.btn} onPress={() => router.replace('/')}>
        <Text style={s.btnText}>Start Using Cue →</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:     { flex: 1, backgroundColor: '#0a0a0a', paddingHorizontal: 24, justifyContent: 'center' },
  card:     { backgroundColor: '#0f2a1a', borderRadius: 20, padding: 32, gap: 12, alignItems: 'center', borderWidth: 1, borderColor: '#4ade80' },
  check:    { fontSize: 56 },
  title:    { color: '#fff', fontSize: 26, fontWeight: '700' },
  subtitle: { color: '#4ade80', fontSize: 14 },
  body:     { color: '#888', fontSize: 14, lineHeight: 22, textAlign: 'center', marginTop: 8 },
  body2:    { color: '#555', fontSize: 13, lineHeight: 20, textAlign: 'center' },
  bold:     { color: '#fff', fontWeight: '600' },
  btn:      { marginTop: 32, backgroundColor: '#fff', borderRadius: 14, paddingVertical: 18, alignItems: 'center' },
  btnText:  { color: '#000', fontSize: 16, fontWeight: '700' },
});
