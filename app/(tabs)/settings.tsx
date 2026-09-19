import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useG1, useG1Event, useLogs, PAIRED_SERIAL_KEY } from '@/lib/g1/G1Context';

export const GESTURE_KEY      = 'gesture_nav_enabled';
export const GESTURE_SWAP_KEY = 'gesture_nav_swapped';

export default function SettingsScreen() {
  const router = useRouter();
  const { core, status, isConnected: connected, disconnect, pairedSerial } = useG1();

  const [gesturesEnabled, setGesturesEnabled] = useState(false);
  const [gesturesSwapped, setGesturesSwapped] = useState(false);
  const [lastEvent, setLastEvent]             = useState<string | null>(null);
  const [debugDevices, setDebugDevices]       = useState<string[]>([]);
  const [scanning, setScanning]               = useState(false);
  const [showLogs, setShowLogs]               = useState(false);
  const logs = useLogs();

  useEffect(() => {
    AsyncStorage.multiGet([GESTURE_KEY, GESTURE_SWAP_KEY]).then(pairs => {
      if (pairs[0][1] === 'true') setGesturesEnabled(true);
      if (pairs[1][1] === 'true') setGesturesSwapped(true);
    }).catch(() => {});
  }, []);

  // Live event monitor — shows the last raw G1 gesture received
  useG1Event((e) => {
    if (e.name === 'head_up' || e.name === 'head_down') {
      setLastEvent(`${e.name}  (0x0${e.subcmd.toString(16)})  from ${e.side}`);
    }
  });

  function toggleGestures(val: boolean) {
    setGesturesEnabled(val);
    AsyncStorage.setItem(GESTURE_KEY, val ? 'true' : 'false').catch(() => {});
  }

  function toggleSwap(val: boolean) {
    setGesturesSwapped(val);
    AsyncStorage.setItem(GESTURE_SWAP_KEY, val ? 'true' : 'false').catch(() => {});
  }

  function handleConnectPress() {
    if (pairedSerial) {
      router.push({ pathname: '/pairing/connecting', params: { serial: pairedSerial, returnTo: '/(tabs)/settings' } });
    } else {
      router.push('/pairing/prep');
    }
  }

  async function handleDisconnect() {
    await disconnect();
  }

  async function runDebugScan() {
    setScanning(true);
    setDebugDevices([]);
    const devices = await core.scanDebug(8000);
    setDebugDevices(devices.length ? devices : ['No devices found']);
    setScanning(false);
  }

  const battL = status?.left.batteryPct;
  const battR = status?.right.batteryPct;
  const rssiL = status?.left.rssi;
  const rssiR = status?.right.rssi;

  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <Text style={s.title}>Settings</Text>

        {/* ── Connection ─────────────────────────────────────── */}
        <Text style={s.section}>Connection</Text>

        {connected ? (
          <>
            <View style={s.row}>
              <View style={s.rowText}>
                <Text style={s.label}>Status</Text>
                <Text style={s.sub}>{pairedSerial ?? 'Connected'}</Text>
              </View>
              <Text style={[s.value, s.green]}>● Connected</Text>
            </View>

            {(battL != null || battR != null) && (
              <View style={s.row}>
                <Text style={s.label}>Battery</Text>
                <Text style={s.value}>
                  {battL != null ? `L: ${battL}%` : ''}
                  {battL != null && battR != null ? '  ·  ' : ''}
                  {battR != null ? `R: ${battR}%` : ''}
                </Text>
              </View>
            )}

            {(rssiL != null || rssiR != null) && (
              <View style={s.row}>
                <Text style={s.label}>Signal (RSSI)</Text>
                <Text style={s.value}>
                  {rssiL != null ? `L: ${rssiL} dBm` : ''}
                  {rssiL != null && rssiR != null ? '  ·  ' : ''}
                  {rssiR != null ? `R: ${rssiR} dBm` : ''}
                </Text>
              </View>
            )}

            <Pressable style={[s.btn, s.btnDanger]} onPress={handleDisconnect}>
              <Text style={[s.btnText, { color: '#fff' }]}>Disconnect</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={s.row}>
              <Text style={s.label}>Status</Text>
              <Text style={s.value}>Not connected</Text>
            </View>

            <Pressable style={s.btn} onPress={handleConnectPress}>
              <Text style={s.btnText}>
                {pairedSerial ? `Reconnect · ${pairedSerial}` : 'Pair G1 Glasses'}
              </Text>
            </Pressable>

            {pairedSerial && (
              <Pressable style={[s.btn, s.btnSecondary]} onPress={() => router.push('/pairing/prep')}>
                <Text style={[s.btnText, { color: '#888' }]}>Pair a different G1</Text>
              </Pressable>
            )}
          </>
        )}

        {/* ── Head Gestures ──────────────────────────────────── */}
        <Text style={s.section}>Head Gestures</Text>

        <View style={s.row}>
          <View style={s.rowText}>
            <Text style={s.label}>Head gesture control</Text>
            <Text style={s.sub}>Nod up to advance, down to go back. Only active while playing.</Text>
          </View>
          <Switch
            value={gesturesEnabled}
            onValueChange={toggleGestures}
            trackColor={{ false: '#1a1a1a', true: '#00c47a' }}
            thumbColor="#fff"
          />
        </View>

        <View style={s.row}>
          <View style={s.rowText}>
            <Text style={s.label}>Swap up / down</Text>
            <Text style={s.sub}>If head-down advances and head-up goes back, enable this.</Text>
          </View>
          <Switch
            value={gesturesSwapped}
            onValueChange={toggleSwap}
            trackColor={{ false: '#1a1a1a', true: '#00c47a' }}
            thumbColor="#fff"
          />
        </View>

        <View style={s.row}>
          <View style={s.rowText}>
            <Text style={s.label}>Last gesture received</Text>
            <Text style={s.sub}>Tilt your head up or down to test detection.</Text>
          </View>
          <Text style={[s.value, lastEvent ? s.green : null]}>
            {lastEvent ?? '—'}
          </Text>
        </View>

        {/* ── Debug ──────────────────────────────────────────── */}
        <Text style={s.section}>Debug</Text>

        <Pressable style={[s.btn, s.btnSecondary]} onPress={runDebugScan} disabled={scanning}>
          <Text style={[s.btnText, { color: '#888' }]}>
            {scanning ? 'Scanning…' : '🔍 Scan All BLE Devices'}
          </Text>
        </Pressable>

        {debugDevices.map((d, i) => (
          <Text key={i} style={s.debugText}>{d}</Text>
        ))}

        {/* ── Raw Logs ───────────────────────────────────────── */}
        <Pressable style={s.logsToggleRow} onPress={() => setShowLogs(v => !v)}>
          <Text style={s.section}>Raw Logs</Text>
          <Text style={s.logsToggleChevron}>{showLogs ? '▲' : '▼'}</Text>
        </Pressable>

        {showLogs && (
          <ScrollView
            style={s.logsScroll}
            contentContainerStyle={s.logsContent}
            nestedScrollEnabled
          >
            {logs.length === 0
              ? <Text style={s.logLine}>— no logs yet —</Text>
              : [...logs].reverse().map((line, i) => (
                  <Text key={i} style={s.logLine} selectable>{line}</Text>
                ))
            }
          </ScrollView>
        )}

        {/* ── About ──────────────────────────────────────────── */}
        <Text style={s.section}>About</Text>
        <View style={s.row}><Text style={s.label}>Version</Text><Text style={s.value}>1.0.0</Text></View>
        <View style={s.row}><Text style={s.label}>Bundle</Text><Text style={s.value}>bio.nodes.cue</Text></View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#0a0a0a' },
  scroll:      { paddingHorizontal: 20, paddingBottom: 40 },
  title:       { color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 20, marginBottom: 8 },
  section:     { color: '#555', fontSize: 11, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', marginTop: 28, marginBottom: 8 },
  row:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1a1a1a' },
  rowText:     { flex: 1, marginRight: 16 },
  label:       { color: '#fff', fontSize: 15 },
  sub:         { color: '#555', fontSize: 12, marginTop: 3 },
  value:       { color: '#888', fontSize: 15 },
  green:       { color: '#00c47a' },
  btn:         { backgroundColor: '#fff', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  btnSecondary:{ backgroundColor: '#1a1a1a' },
  btnDanger:   { backgroundColor: '#2a1a1a' },
  btnText:     { fontSize: 15, fontWeight: '600', color: '#000' },
  debugText:        { color: '#555', fontSize: 11, marginTop: 6, fontFamily: 'monospace' },
  logsToggleRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 28, marginBottom: 0 },
  logsToggleChevron:{ color: '#555', fontSize: 12 },
  logsScroll:       { maxHeight: 300, backgroundColor: '#111', borderRadius: 8, marginTop: 8, marginBottom: 4 },
  logsContent:      { padding: 10 },
  logLine:          { color: '#4ade80', fontSize: 10, fontFamily: 'monospace', lineHeight: 16 },
});
