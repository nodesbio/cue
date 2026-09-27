/**
 * LensCard — per-side lens status card with disconnect/reconnect controls
 * and a collapsible, shareable log panel filtered to this side's lines.
 *
 * The log panel filters the shared G1 log buffer client-side using the
 * [L] / [R] tags emitted by G1Core — no Core changes or per-side buffers needed.
 */

import { useState, useCallback } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export interface LensCardProps {
  side: 'L' | 'R';
  connected: boolean;   // BLE link up (includes stuck-in-init)
  txReady: boolean;     // fully initialised and ready to send
  batteryPct: number | null;
  rssi: number | null;
  /** Full shared log buffer — filtered here by [L] / [R] tag */
  logs: string[];
  onDisconnect: () => void;
  onReconnect: () => void;
}

/** Lines that belong to this side: tagged [L] / [R] or [G1 RX L] / [G1 RX R] */
function filterSideLogs(logs: string[], side: 'L' | 'R'): string[] {
  // Match: [L] [R] [G1 RX L] [G1 RX R] [G1] _foo [L] — anything with the side tag
  const re = new RegExp(`\\[${side}\\]|\\[G1 RX ${side}\\]`);
  return logs.filter(l => re.test(l));
}

async function shareSideLogs(side: 'L' | 'R', lines: string[]): Promise<void> {
  try {
    const text = lines.length ? lines.join('\n') : `(no ${side} lens logs)`;
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const file = new File(Paths.cache, `cue-lens-${side.toLowerCase()}-${ts}.txt`);
    file.write(text);
    const available = await Sharing.isAvailableAsync();
    if (!available) { alert('Sharing not available on this device'); return; }
    await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', dialogTitle: `Share ${side === 'L' ? 'Left' : 'Right'} Lens Logs` });
  } catch (e: any) {
    alert(`Share failed: ${e?.message ?? e}`);
  }
}

export function LensCard({ side, connected, txReady, batteryPct, rssi, logs, onDisconnect, onReconnect }: LensCardProps) {
  const [showLogs, setShowLogs] = useState(false);

  const label      = side === 'L' ? 'Left lens' : 'Right lens';
  const dot        = txReady ? '●' : connected ? '◐' : '○';
  const dotStyle   = txReady ? s.green : connected ? s.yellow : s.muted;
  const stateLabel = txReady ? 'Ready' : connected ? 'Connecting…' : 'Disconnected';

  // Both buttons always rendered; disabled state communicated via opacity only
  const canDisconnect = connected || txReady;
  const canReconnect  = !txReady;

  const sideLogs     = filterSideLogs(logs, side);
  const handleShare  = useCallback(() => shareSideLogs(side, sideLogs), [side, sideLogs]);

  return (
    <View style={s.card}>
      {/* Header row */}
      <View style={s.header}>
        <Text style={s.label}>{label}</Text>
        <Text style={[s.state, dotStyle]}>{dot} {stateLabel}</Text>
      </View>

      {/* Battery + RSSI chips */}
      <View style={s.meta}>
        {batteryPct != null && <Text style={s.chip}>🔋 {batteryPct}%</Text>}
        {rssi       != null && <Text style={s.chip}>📶 {rssi} dBm</Text>}
      </View>

      {/* Disconnect / Reconnect */}
      <View style={s.actions}>
        <Pressable
          style={[s.btn, s.btnDanger, !canDisconnect && s.btnDisabled]}
          onPress={onDisconnect}
          disabled={!canDisconnect}
        >
          <Text style={[s.btnText, !canDisconnect && s.btnTextDisabled]}>Disconnect</Text>
        </Pressable>
        <Pressable
          style={[s.btn, s.btnPrimary, !canReconnect && s.btnDisabled]}
          onPress={onReconnect}
          disabled={!canReconnect}
        >
          <Text style={[s.btnText, !canReconnect && s.btnTextDisabled]}>
            {connected && !txReady ? 'Force Reconnect' : 'Reconnect'}
          </Text>
        </Pressable>
      </View>

      {/* Per-lens log toggle row */}
      <View style={s.logToggleRow}>
        <Pressable onPress={() => setShowLogs(v => !v)} style={s.logToggleHit}>
          <Text style={s.logToggleLabel}>
            Logs{sideLogs.length ? ` (${sideLogs.length})` : ''}
          </Text>
          <Text style={s.logChevron}>{showLogs ? '▲' : '▼'}</Text>
        </Pressable>
        <Pressable onPress={handleShare} style={s.shareBtn}>
          <Text style={s.shareBtnText}>⬆ Share</Text>
        </Pressable>
      </View>

      {showLogs && (
        <ScrollView
          style={s.logScroll}
          contentContainerStyle={s.logContent}
          nestedScrollEnabled
        >
          {sideLogs.length === 0
            ? <Text style={s.logLine}>— no {label.toLowerCase()} logs yet —</Text>
            : [...sideLogs].reverse().map((line, i) => (
                <Text key={i} style={s.logLine} selectable>{line}</Text>
              ))
          }
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card:           { backgroundColor: '#111', borderRadius: 12, padding: 14, marginTop: 10 },
  header:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label:          { color: '#fff', fontSize: 15, fontWeight: '600' },
  state:          { fontSize: 13 },
  green:          { color: '#00c47a' },
  yellow:         { color: '#f5c542' },
  muted:          { color: '#555' },
  meta:           { flexDirection: 'row', gap: 10, marginTop: 6 },
  chip:           { color: '#888', fontSize: 12 },
  actions:        { flexDirection: 'row', gap: 8, marginTop: 10 },
  btn:            { flex: 1, borderRadius: 8, paddingVertical: 9, alignItems: 'center' },
  btnDanger:      { backgroundColor: '#2a1a1a' },
  btnPrimary:     { backgroundColor: '#1a2a1a' },
  btnDisabled:    { opacity: 0.35 },
  btnText:        { color: '#ccc', fontSize: 13, fontWeight: '600' },
  btnTextDisabled:{ color: '#555' },
  logToggleRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#1e1e1e' },
  logToggleHit:   { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  logToggleLabel: { color: '#555', fontSize: 11, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' },
  logChevron:     { color: '#555', fontSize: 11 },
  shareBtn:       { paddingHorizontal: 10, paddingVertical: 5, backgroundColor: '#1a1a1a', borderRadius: 7, borderWidth: 1, borderColor: '#2a2a2a' },
  shareBtnText:   { color: '#888', fontSize: 12 },
  logScroll:      { maxHeight: 220, backgroundColor: '#0d0d0d', borderRadius: 8, marginTop: 8 },
  logContent:     { padding: 10 },
  logLine:        { color: '#4ade80', fontSize: 10, fontFamily: 'monospace', lineHeight: 16 },
});
