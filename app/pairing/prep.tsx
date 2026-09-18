/**
 * Pairing Prep — G1-specific instructions before BLE scan.
 * Key insight from MentraOS: G1 requires case plugged in + left arm folded first.
 */
import { useRouter } from 'expo-router';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

const STEPS = [
  { emoji: '🔌', title: 'Plug in the case', body: 'Connect your G1 case to a charger before pairing.' },
  { emoji: '👓', title: 'Fold left arm first', body: 'Fold the LEFT arm before placing glasses in the case.' },
  { emoji: '📱', title: 'Stay close', body: 'Keep your phone within 1–2 feet of the case.' },
  { emoji: '🔵', title: 'No other apps open', body: 'Make sure the Even Realities app is closed and not connected.' },
];

export default function PairingPrepScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.title}>Before you scan</Text>
      <Text style={s.subtitle}>A few things to check first</Text>

      <View style={s.steps}>
        {STEPS.map((step, i) => (
          <View key={i} style={s.step}>
            <Text style={s.emoji}>{step.emoji}</Text>
            <View style={s.stepText}>
              <Text style={s.stepTitle}>{step.title}</Text>
              <Text style={s.stepBody}>{step.body}</Text>
            </View>
          </View>
        ))}
      </View>

      <View style={s.btnRow}>
        <Pressable style={s.btnPrimary} onPress={() => router.push('/pairing/scan')}>
          <Text style={s.btnPrimaryText}>I'm ready — Scan for G1 →</Text>
        </Pressable>
        <Pressable style={s.btnSecondary} onPress={() => router.back()}>
          <Text style={s.btnSecondaryText}>Cancel</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:            { flex: 1, backgroundColor: '#0a0a0a', paddingHorizontal: 24 },
  title:           { color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 24 },
  subtitle:        { color: '#555', fontSize: 14, marginTop: 4, marginBottom: 32 },
  steps:           { gap: 20, marginBottom: 40 },
  step:            { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  emoji:           { fontSize: 28, width: 40 },
  stepText:        { flex: 1 },
  stepTitle:       { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 2 },
  stepBody:        { color: '#888', fontSize: 14, lineHeight: 20 },
  btnRow:          { gap: 12 },
  btnPrimary:      { backgroundColor: '#fff', borderRadius: 14, paddingVertical: 18, alignItems: 'center' },
  btnPrimaryText:  { color: '#000', fontSize: 16, fontWeight: '700' },
  btnSecondary:    { backgroundColor: '#1a1a1a', borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  btnSecondaryText:{ color: '#555', fontSize: 15 },
});
