import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useG1, useG1Event, useLogs, getLogsText, clearLogBuffer, PAIRED_SERIAL_KEY } from '@/lib/g1/G1Context';

export const GESTURE_KEY      = 'gesture_nav_enabled';
export const GESTURE_SWAP_KEY = 'gesture_nav_swapped';

export default function SettingsScreen() {
  const router = useRouter();
  const { core, status, isConnected: connected, isPartiallyConnected, disconnect, disconnectSide, reconnectSide, pairedSerial, brightness, setBrightness } = useG1();

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
      const subcmdStr = 'subcmd' in e ? `  (0x0${(e as any).subcmd.toString(16)})` : '';
      const sideStr   = 'side'   in e ? `  from ${(e as any).side}` : '';
      setLastEvent(`${e.name}${subcmdStr}${sideStr}`);
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

  async function shareLogs() {
    try {
      const text = getLogsText() || '(no logs)';
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = new File(Paths.cache, `cue-logs-${ts}.txt`);
      file.write(text);
      const available = await Sharing.isAvailableAsync();
      if (!available) { alert('Sharing not available on this device'); return; }
      await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', dialogTitle: 'Share Cue Logs' });
    } catch (e: any) {
      alert(`Share failed: ${e?.message ?? e}`);
    }
  }

  function clearLogs() {
    clearLogBuffer();
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

        {(connected || isPartiallyConnected) ? (
          <>
            {/* ── Per-lens cards ──────────────────────────────── */}
            {(['L', 'R'] as const).map(side => {
              const lensStatus = side === 'L' ? status?.left : status?.right;
              const batt = side === 'L' ? battL : battR;
              const rssi = side === 'L' ? rssiL : rssiR;
              const label = side === 'L' ? 'Left lens' : 'Right lens';
              const isReady = !!lensStatus?.txReady;
              const isConn  = !!lensStatus?.connected;
              // Three states: ready (full), connecting (BLE up, init in flight), disconnected
              const dot        = isReady ? '●' : isConn ? '◐' : '○';
              const dotColor   = isReady ? s.green : isConn ? s.yellow : s.muted;
              const stateLabel = isReady ? 'Ready' : isConn ? 'Connecting…' : 'Disconnected';
              // Disconnect: available whenever BLE is up (connected or stuck in init)
              const canDisconnect = isConn || isReady;
              // Reconnect: available when not already ready; also force-available if stuck
              //   connecting (isConn=true, isReady=false) so user can break the loop
              const canReconnect = !isReady;
              return (
                <View key={side} style={s.lensCard}>
                  <View style={s.lensCardHeader}>
                    <Text style={s.label}>{label}</Text>
                    <Text style={[s.value, dotColor]}>{dot} {stateLabel}</Text>
                  </View>
                  <View style={s.lensMeta}>
                    {batt != null && <Text style={s.metaChip}>🔋 {batt}%</Text>}
                    {rssi != null && <Text style={s.metaChip}>📶 {rssi} dBm</Text>}
                  </View>
                  <View style={s.lensActions}>
                    <Pressable
                      style={[s.lensBtn, s.lensBtnDanger, !canDisconnect && s.lensBtnDisabled]}
                      onPress={() => disconnectSide(side)}
                      disabled={!canDisconnect}
                    >
                      <Text style={[s.lensBtnText, !canDisconnect && s.lensBtnTextDisabled]}>Disconnect</Text>
                    </Pressable>
                    <Pressable
                      style={[s.lensBtn, s.lensBtnPrimary, !canReconnect && s.lensBtnDisabled]}
                      onPress={() => reconnectSide(side)}
                      disabled={!canReconnect}
                    >
                      <Text style={[s.lensBtnText, !canReconnect && s.lensBtnTextDisabled]}>
                        {isConn && !isReady ? 'Force Reconnect' : 'Reconnect'}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}

            {/* Serial */}
            {pairedSerial && (
              <View style={s.row}>
                <Text style={s.label}>Serial</Text>
                <Text style={s.value}>{pairedSerial}</Text>
              </View>
            )}

            {/* Global disconnect */}
            <Pressable style={[s.btn, s.btnDanger]} onPress={handleDisconnect}>
              <Text style={[s.btnText, { color: '#fff' }]}>Disconnect All</Text>
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

        {/* ── Display ───────────────────────────────────────── */}
        <Text style={s.section}>Display</Text>

        <View style={s.sliderCard}>
          <View style={s.sliderHeader}>
            <Text style={s.label}>Brightness</Text>
            <Text style={s.sliderValue}>{Math.round((brightness / 42) * 100)}%</Text>
          </View>
          <Slider
            style={s.slider}
            minimumValue={0}
            maximumValue={42}
            value={brightness}
            step={1}
            onValueChange={(v) => setBrightness(v)}
            minimumTrackTintColor="#333"
            maximumTrackTintColor="#555"
            thumbTintColor="#fff"
            disabled={!connected}
          />
          {!connected && (
            <Text style={s.sliderDisabledHint}>Connect glasses to adjust brightness</Text>
          )}
        </View>

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
        <View style={s.logsToggleRow}>
          <Pressable onPress={() => setShowLogs(v => !v)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
            <Text style={s.section}>Raw Logs</Text>
            <Text style={s.logsToggleChevron}>{showLogs ? '▲' : '▼'}</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable onPress={clearLogs} style={s.shareLogsBtn}>
              <Text style={s.shareLogsBtnText}>🗑 Clear</Text>
            </Pressable>
            <Pressable onPress={shareLogs} style={s.shareLogsBtn}>
              <Text style={s.shareLogsBtnText}>⬆ Share</Text>
            </Pressable>
          </View>
        </View>

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

        {/* ── Dev Tools ─────────────────────────────────────── */}
        <Text style={s.section}>Dev Tools</Text>
        <Pressable style={[s.btn, s.btnSecondary]} onPress={() => router.push('/ble-debug')}>
          <Text style={s.btnText}>SmartRemote BLE Debug</Text>
        </Pressable>

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
  yellow:      { color: '#f5c542' },
  muted:       { color: '#555' },
  lensCard:    { backgroundColor: '#111', borderRadius: 12, padding: 14, marginTop: 10 },
  lensCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  lensMeta:    { flexDirection: 'row', gap: 10, marginTop: 6 },
  metaChip:    { color: '#888', fontSize: 12 },
  lensActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  lensBtn:     { flex: 1, borderRadius: 8, paddingVertical: 9, alignItems: 'center' },
  lensBtnDanger:        { backgroundColor: '#2a1a1a' },
  lensBtnPrimary:       { backgroundColor: '#1a2a1a' },
  lensBtnDisabled:      { opacity: 0.35 },
  lensBtnText:          { color: '#ccc', fontSize: 13, fontWeight: '600' },
  lensBtnTextDisabled:  { color: '#555' },
  btn:         { backgroundColor: '#fff', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  btnSecondary:{ backgroundColor: '#1a1a1a' },
  btnDanger:   { backgroundColor: '#2a1a1a' },
  btnText:     { fontSize: 15, fontWeight: '600', color: '#000' },
  debugText:        { color: '#555', fontSize: 11, marginTop: 6, fontFamily: 'monospace' },
  logsToggleRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 28, marginBottom: 0 },
  shareLogsBtn:     { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#1a1a1a', borderRadius: 8, borderWidth: 1, borderColor: '#333' },
  shareLogsBtnText: { color: '#888', fontSize: 13 },
  logsToggleChevron:{ color: '#555', fontSize: 12 },
  logsScroll:       { maxHeight: 300, backgroundColor: '#111', borderRadius: 8, marginTop: 8, marginBottom: 4 },
  logsContent:      { padding: 10 },
  logLine:          { color: '#4ade80', fontSize: 10, fontFamily: 'monospace', lineHeight: 16 },
  sliderCard:       { backgroundColor: '#141414', borderRadius: 16, padding: 20, marginBottom: 4 },
  sliderHeader:     { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  sliderValue:      { color: '#fff', fontSize: 13, fontWeight: '600' },
  slider:           { width: '100%', height: 40, marginTop: 4 },
  sliderDisabledHint: { color: '#444', fontSize: 11, marginTop: -4 },
});
