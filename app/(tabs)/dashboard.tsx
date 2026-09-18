/**
 * Dashboard — pushes a rich status card to the G1 HUD every 60s.
 * Reads connection state from G1Context (single source of truth).
 */
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, SafeAreaView, StyleSheet, Text, TouchableWithoutFeedback, View } from 'react-native';
import { useG1, PAIRED_SERIAL_KEY } from '@/lib/g1/G1Context';

function formatTime(): string {
  return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDate(): string {
  return new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function DashboardScreen() {
  const router = useRouter();
  const { core, status, isConnected: connected, disconnect, pairedSerial } = useG1();
  const [lastPush, setLastPush] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [debugDevices, setDebugDevices] = useState<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Push immediately on connect, then re-align to every minute boundary.
  // e.g. connect at :47 → push now, then again at :00, :01, :02, ...
  useEffect(() => {
    if (!connected) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }

    pushDashboard();

    // Wait until the next whole minute, then tick every 60s exactly.
    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    const alignTimeout = setTimeout(() => {
      pushDashboard();
      timerRef.current = setInterval(pushDashboard, 60_000);
    }, msUntilNextMinute);

    return () => {
      clearTimeout(alignTimeout);
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [connected]);

  async function pushDashboard() {
    const time = formatTime();
    const date = formatDate();
    const battL = status?.left.batteryPct ?? '--';
    const battR = status?.right.batteryPct ?? '--';
    await core.sendText(`${time}  ${date}\nL:${battL}%  R:${battR}%`);
    setLastPush(time);
  }

  function handleConnectPress() {
    if (pairedSerial) {
      // Reconnect goes through the same pairing connecting screen so the
      // shared core handles it — just navigate there with the known serial.
      router.push({ pathname: '/pairing/connecting', params: { serial: pairedSerial } });
    } else {
      router.push('/pairing/prep');
    }
  }

  async function handleDisconnect() {
    await disconnect();
    setLastPush(null);
  }

  async function runDebugScan() {
    setDebugDevices(['Scanning…']);
    const devices = await core.scanDebug(8000);
    setDebugDevices(devices.length ? devices : ['No devices found']);
  }

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <SafeAreaView style={s.root}>
        <Text style={s.title}>Dashboard</Text>
        <Text style={s.subtitle}>Auto-pushes to G1 every minute</Text>

        {errorMsg && <Text style={s.error}>{errorMsg}</Text>}

        <View style={s.card}>
          <Text style={s.clockLabel}>{formatTime()}</Text>
          <Text style={s.dateLabel}>{formatDate()}</Text>
          {connected && (
            <Text style={s.battLabel}>
              L: {status?.left.batteryPct ?? '--'}{status?.left.batteryPct != null ? '%' : ''}  ·  R: {status?.right.batteryPct ?? '--'}{status?.right.batteryPct != null ? '%' : ''}
            </Text>
          )}
          {connected && (status?.left.rssi != null || status?.right.rssi != null) && (
            <Text style={s.battLabel}>
              {status?.left.rssi != null ? `L: ${status.left.rssi} dBm` : ''}
              {status?.left.rssi != null && status?.right.rssi != null ? '  ·  ' : ''}
              {status?.right.rssi != null ? `R: ${status.right.rssi} dBm` : ''}
            </Text>
          )}
          {lastPush && <Text style={s.pushLabel}>Last push: {lastPush}</Text>}
        </View>

        <View style={s.btnRow}>
          {!connected && (
            <Pressable style={s.btn} onPress={handleConnectPress}>
              <Text style={s.btnText}>
                {pairedSerial ? `● Reconnect G1 · ${pairedSerial}` : '● Pair G1 Glasses'}
              </Text>
            </Pressable>
          )}
          {!connected && pairedSerial && (
            <Pressable
              style={[s.btn, s.btnSecondary]}
              onPress={() => router.push('/pairing/prep')}
            >
              <Text style={[s.btnText, { color: '#888' }]}>⊕ Pair a different G1</Text>
            </Pressable>
          )}
          {connected && (
            <>
              <Pressable style={s.btn} onPress={pushDashboard}>
                <Text style={s.btnText}>↺  Refresh Now</Text>
              </Pressable>
              <Pressable style={[s.btn, s.btnSecondary]} onPress={handleDisconnect}>
                <Text style={[s.btnText, { color: '#fff' }]}>Disconnect</Text>
              </Pressable>
            </>
          )}
        </View>

        <Pressable style={[s.btn, { marginTop: 16, backgroundColor: '#1e1e1e' }]} onPress={runDebugScan}>
          <Text style={[s.btnText, { color: '#888' }]}>🔍 Debug: Scan All BLE</Text>
        </Pressable>
        {debugDevices.map((d, i) => (
          <Text key={i} style={s.debugText}>{d}</Text>
        ))}

        <Text style={s.hint}>Calendar integration coming in v1.1</Text>
      </SafeAreaView>
    </TouchableWithoutFeedback>
  );
}

const s = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#0a0a0a', paddingHorizontal: 20 },
  title:       { color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 20 },
  subtitle:    { color: '#555', fontSize: 13, marginTop: 4, marginBottom: 24 },
  error:       { color: '#f87171', fontSize: 13, marginBottom: 12 },
  card:        { backgroundColor: '#141414', borderRadius: 16, padding: 24, gap: 8, marginBottom: 24 },
  clockLabel:  { color: '#ffffff', fontSize: 48, fontWeight: '200', letterSpacing: -1 },
  dateLabel:   { color: '#888', fontSize: 16 },
  battLabel:   { color: '#4ade80', fontSize: 13, marginTop: 8 },
  pushLabel:   { color: '#444', fontSize: 12 },
  btnRow:      { gap: 12 },
  btn:         { backgroundColor: '#fff', borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  btnSecondary:{ backgroundColor: '#1e1e1e' },
  btnText:     { fontSize: 16, fontWeight: '600', color: '#000' },
  debugText:   { color: '#666', fontSize: 11, marginTop: 4 },
  hint:        { textAlign: 'center', color: '#2a2a2a', fontSize: 12, marginTop: 'auto', paddingBottom: 16 },
});
