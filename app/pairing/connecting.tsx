/**
 * Pairing Connecting — animated loader while G1Core.connect(serial) runs.
 * Uses the shared G1Context — no local core instance.
 * On success → /pairing/success. On failure → shows error + retry.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { useG1 } from '@/lib/g1/G1Context';

const TIPS = [
  'Make sure both lenses are removed from the case and on your face.',
  'Keep your phone within 1–2 feet while connecting.',
  'If connection stalls, place lenses back in the case, close it, wait 5s, then reopen.',
  'The G1 app must be closed — it holds an exclusive BLE connection.',
  'Fold the left arm before placing lenses back in the case.',
  'Low battery on a lens can prevent connection — charge the case.',
];

export default function PairingConnectingScreen() {
  const router = useRouter();
  const { serial } = useLocalSearchParams<{ serial: string }>();
  const { connect, core } = useG1();
  const [tipIndex, setTipIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const tipInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    tipInterval.current = setInterval(() => {
      setTipIndex(i => (i + 1) % TIPS.length);
    }, 7000);
    attemptConnect();
    return () => {
      if (tipInterval.current) clearInterval(tipInterval.current);
    };
  }, []);

  function startProgressAnimation() {
    progressAnim.setValue(0);
    Animated.timing(progressAnim, {
      toValue: 85,
      duration: 30000,
      useNativeDriver: false,
      easing: Easing.out(Easing.exp),
    }).start();
  }

  async function attemptConnect() {
    setError(null);
    startProgressAnimation();
    try {
      await connect(serial);
      Animated.timing(progressAnim, {
        toValue: 100,
        duration: 400,
        useNativeDriver: false,
      }).start();
      setTimeout(() => {
        router.replace({ pathname: '/pairing/success', params: { serial } });
      }, 500);
    } catch (e: any) {
      progressAnim.stopAnimation();
      setError(e?.message ?? 'Connection failed');
    }
  }

  function retry() {
    attemptConnect();
  }

  function goBack() {
    // Stop any active scan before returning to the scan screen
    try { (core as any).manager.stopDeviceScan(); } catch {}
    router.replace('/pairing/scan');
  }

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  return (
    <SafeAreaView style={s.root}>
      <View style={s.card}>
        <Text style={s.title}>Connecting to G1</Text>
        <Text style={s.serial}>{serial}</Text>

        <View style={s.progressTrack}>
          <Animated.View style={[s.progressFill, { width: progressWidth }]} />
        </View>

        {error ? (
          <>
            <Text style={s.errorText}>⚠️ {error}</Text>
            <Pressable style={s.retryBtn} onPress={retry}>
              <Text style={s.retryText}>Try again</Text>
            </Pressable>
          </>
        ) : (
          <Text style={s.tip}>{TIPS[tipIndex]}</Text>
        )}
      </View>

      <Pressable style={s.cancelBtn} onPress={goBack}>
        <Text style={s.cancelText}>← Choose a different pair</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:          { flex: 1, backgroundColor: '#0a0a0a', paddingHorizontal: 24, justifyContent: 'center' },
  card:          { backgroundColor: '#141414', borderRadius: 20, padding: 28, gap: 16 },
  title:         { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  serial:        { color: '#555', fontSize: 13, textAlign: 'center' },
  progressTrack: { height: 10, backgroundColor: '#222', borderRadius: 5, overflow: 'hidden' },
  progressFill:  { height: '100%', backgroundColor: '#4ade80', borderRadius: 5 },
  tip:           { color: '#888', fontSize: 14, lineHeight: 20, textAlign: 'center', minHeight: 60 },
  errorText:     { color: '#f87171', fontSize: 14, textAlign: 'center' },
  retryBtn:      { backgroundColor: '#fff', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  retryText:     { color: '#000', fontWeight: '700', fontSize: 15 },
  cancelBtn:     { marginTop: 32, alignItems: 'center' },
  cancelText:    { color: '#444', fontSize: 14 },
});
