/**
 * Pairing Success — serial already persisted by G1Context.connect().
 * Just confirms success and navigates home.
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
        <Text style={s.title}>Connected!</Text>
        <Text style={s.subtitle}>G1 · {serial}</Text>
        <Text style={s.body}>Your glasses are paired and ready. Next time, Cue will reconnect automatically.</Text>
      </View>

      <Pressable style={s.btn} onPress={() => router.replace('/(tabs)/dashboard')}>
        <Text style={s.btnText}>Open Dashboard →</Text>
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
  body:     { color: '#888', fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 8 },
  btn:      { marginTop: 32, backgroundColor: '#fff', borderRadius: 14, paddingVertical: 18, alignItems: 'center' },
  btnText:  { color: '#000', fontSize: 16, fontWeight: '700' },
});
