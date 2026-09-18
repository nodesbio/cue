/**
 * Dashboard — pushes a rich status card to the G1 HUD every 60s.
 * Shows: time, next calendar event, battery.
 * (EventKit access via expo-calendar; add to app.config.ts when needed.)
 */

import { useEffect, useRef, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { G1Core, G1Status } from '@/lib/g1/G1Core';

const REFRESH_MS = 60_000;

function formatTime(): string {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatDate(): string {
  return new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function DashboardScreen() {
  const [status, setStatus] = useState<G1Status | null>(null);
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'live'>('idle');
  const [lastPush, setLastPush] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [debugDevices, setDebugDevices] = useState<string[]>([]);

  const g1 = useRef<G1Core | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function connect() {
    setPhase('connecting');
    setErrorMsg(null);
    try {
      const core = new G1Core({ onStatusChange: (s) => setStatus({ ...s }) });
      await core.connect();
      g1.current = core;
      setPhase('live');
      await pushDashboard();
      timerRef.current = setInterval(pushDashboard, REFRESH_MS);
    } catch (e: any) {
      setErrorMsg(e.message ?? 'Connection failed');
      setPhase('idle');
    }
  }

  async function pushDashboard() {
    const core = g1.current;
    if (!core) return;
    const time = formatTime();
    const date = formatDate();
    const battL = status?.left.batteryPct ?? '?';
    const battR = status?.right.batteryPct ?? '?';
    const line = `${time}  ${date}\nL:${battL}%  R:${battR}%`;
    await core.sendText(line);
    setLastPush(time);
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      g1.current?.destroy();
    };
  }, []);

  async function runDebugScan() {
    setDebugDevices(['Scanning…']);
    const core = new G1Core();
    const devices = await core.scanDebug(8000);
    core.destroy();
    setDebugDevices(devices.length ? devices : ['No devices found']);
  }

  const connected = status?.left.connected && status?.right.connected;

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.title}>Dashboard</Text>
      <Text style={s.subtitle}>Auto-pushes to G1 every minute</Text>

      {errorMsg && <Text style={s.error}>{errorMsg}</Text>}

      <View style={s.card}>
        <Text style={s.clockLabel}>{formatTime()}</Text>
        <Text style={s.dateLabel}>{formatDate()}</Text>
        {connected && (
          <Text style={s.battLabel}>
            L: {status?.left.batteryPct}%  ·  R: {status?.right.batteryPct}%
          </Text>
        )}
        {lastPush && <Text style={s.pushLabel}>Last push: {lastPush}</Text>}
      </View>

      <View style={s.btnRow}>
        {phase !== 'live' ? (
          <Pressable style={s.btn} onPress={connect} disabled={phase === 'connecting'}>
            <Text style={s.btnText}>
              {phase === 'connecting' ? 'Connecting…' : '● Start Dashboard'}
            </Text>
          </Pressable>
        ) : (
          <>
            <Pressable style={s.btn} onPress={pushDashboard}>
              <Text style={s.btnText}>↺  Refresh Now</Text>
            </Pressable>
            <Pressable
              style={[s.btn, s.btnSecondary]}
              onPress={() => {
                if (timerRef.current) clearInterval(timerRef.current);
                g1.current?.destroy();
                g1.current = null;
                setPhase('idle');
              }}
            >
              <Text style={[s.btnText, { color: '#fff' }]}>Disconnect</Text>
            </Pressable>
          </>
        )}
      </View>

      <Pressable style={[s.btn, { marginTop: 16, backgroundColor: '#1e1e1e' }]} onPress={runDebugScan}>
        <Text style={[s.btnText, { color: '#888' }]}>🔍 Debug: Scan All BLE</Text>
      </Pressable>
      {debugDevices.map((d, i) => (
        <Text key={i} style={{ color: '#666', fontSize: 11, marginTop: 4 }}>{d}</Text>
      ))}

      <Text style={s.hint}>
        Calendar integration coming in v1.1
      </Text>
    </SafeAreaView>
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
  hint:        { textAlign: 'center', color: '#2a2a2a', fontSize: 12, marginTop: 'auto', paddingBottom: 16 },
});
