/**
 * Pairing Scan — continuous BLE scan for G1 pairs.
 * Uses the shared G1Context core so only one BleManager is ever scanning.
 * Shows live list of discovered pairs (keyed by serial from manufacturerData).
 * Tap a complete pair to connect; incomplete pairs show which lens is missing.
 */
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { useG1 } from '@/lib/g1/G1Context';
import { loadBattery, type BatterySnapshot } from '@/lib/g1/batteryStore';
import { Device } from 'react-native-ble-plx';

type PairEntry = {
  serial: string;
  firmware?: string;
  L?: Device;
  R?: Device;
};

export default function PairingScanScreen() {
  const router = useRouter();
  const { core } = useG1();
  const [pairs, setPairs] = useState<Record<string, PairEntry>>({});
  // Last-known battery per serial (from a previous connection). The G1
  // advertisement carries no battery byte, so this is the best we can do
  // before connecting. Loaded once per newly discovered serial.
  const [battery, setBattery] = useState<Record<string, BatterySnapshot | null>>({});
  // Live battery from a quick connect→0x2C→disconnect probe of each lens.
  // 'probing' while in flight, 'failed' if the lens refused, else per-side %.
  type Probe = { L?: number; R?: number; state: 'probing' | 'done' | 'failed' };
  const [live, setLive] = useState<Record<string, Probe>>({});
  const probeQueue = useRef<Promise<void>>(Promise.resolve());
  const probed = useRef(new Set<string>());

  useEffect(() => {
    startScan();
    return () => { core.stopStreamingScan(); };
  }, []);

  async function startScan() {
    setPairs({});
    try {
      await core.startStreamingScan(incoming => {
        // incoming keys are serial strings; values have optional L, R, firmware
        setPairs(incoming as Record<string, PairEntry>);
      });
    } catch (e) {
      console.warn('[scan]', e);
    }
  }

  function rescan() {
    core.stopStreamingScan();
    startScan();
  }

  function selectPair(serial: string) {
    const entry = pairs[serial];
    if (!entry?.L || !entry?.R) return;
    core.stopStreamingScan();
    router.push({ pathname: '/pairing/connecting', params: { serial } });
  }

  const pairList = Object.values(pairs);

  useEffect(() => {
    for (const serial of Object.keys(pairs)) {
      if (serial in battery) continue;
      setBattery(b => ({ ...b, [serial]: null }));
      loadBattery(serial).then(snap => { if (snap) setBattery(b => ({ ...b, [serial]: snap })); });
    }
  }, [pairs]);

  // Probe each complete pair once, strictly one lens at a time — two
  // concurrent connect() calls on CoreBluetooth race and one silently hangs.
  useEffect(() => {
    for (const pair of Object.values(pairs)) {
      if (!pair.L || !pair.R || probed.current.has(pair.serial)) continue;
      probed.current.add(pair.serial);
      const { serial, L, R } = pair;
      setLive(v => ({ ...v, [serial]: { state: 'probing' } }));
      probeQueue.current = probeQueue.current.then(async () => {
        let ok = false;
        for (const [side, dev] of [['L', L], ['R', R]] as const) {
          try {
            const { pct } = await core.probeBattery(dev);
            ok = true;
            setLive(v => ({ ...v, [serial]: { ...v[serial], [side]: pct, state: 'probing' } }));
          } catch {}
        }
        setLive(v => ({ ...v, [serial]: { ...v[serial], state: ok ? 'done' : 'failed' } }));
      });
    }
  }, [pairs]);

  function retryProbes() {
    probed.current.clear();
    setLive({});
    setPairs(p => ({ ...p })); // re-trigger the probe effect
  }

  function batText(pct: number | null | undefined): string | null {
    return pct == null ? null : `${pct}%`;
  }

  // The pair with the highest minimum lens level wins — a pair is only as
  // usable as its emptier lens.
  const pairMin = (p: Probe | undefined) =>
    p?.L != null && p?.R != null ? Math.min(p.L, p.R) : null;
  const bestSerial = (() => {
    let best: string | null = null, bestMin = -1;
    for (const [serial, p] of Object.entries(live)) {
      const m = pairMin(p);
      if (m != null && m > bestMin) { best = serial; bestMin = m; }
    }
    return Object.keys(live).length > 1 ? best : null;
  })();

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.title}>Scanning for G1</Text>
      <Text style={s.subtitle}>
        {pairList.length === 0 ? 'Looking for glasses…' : `Found ${pairList.length} pair(s)`}
      </Text>

      <View style={s.scanRow}>
        <ActivityIndicator color="#4ade80" size="small" />
        <Text style={s.scanText}>Live scan active</Text>
        <Pressable onPress={rescan} style={s.rescanBtn}>
          <Text style={s.rescanText}>↺ Rescan</Text>
        </Pressable>
      </View>

      {pairList.length === 0 ? (
        <View style={s.emptyCard}>
          <Text style={s.emptyTitle}>No G1 glasses found yet</Text>
          <Text style={s.emptyBody}>Make sure the case is plugged in and open. Both lenses should be inside.</Text>
        </View>
      ) : (
        <View style={s.list}>
          {pairList.map(pair => {
            const complete = !!(pair.L && pair.R);
            const bat = battery[pair.serial];
            const lv = live[pair.serial];
            // Live probe beats last-known; last-known beats nothing.
            const batL = batText(lv?.L ?? bat?.L);
            const batR = batText(lv?.R ?? bat?.R);
            const isLive = lv?.L != null || lv?.R != null;
            const isBest = bestSerial === pair.serial;
            return (
              <Pressable
                key={pair.serial}
                style={[s.pairCard, complete ? s.pairCardComplete : s.pairCardIncomplete, isBest && s.pairCardBest]}
                onPress={() => selectPair(pair.serial)}
                disabled={!complete}
              >
                <View style={s.pairHeader}>
                  <Text style={s.pairSerial}>G1 · {pair.serial}{isBest ? '  ★ fullest' : ''}</Text>
                  <Text style={s.pairFirmware}>fw {pair.firmware}</Text>
                </View>
                <View style={s.lensRow}>
                  <View style={[s.lensBadge, pair.L ? s.lensFound : s.lensMissing]}>
                    <Text style={s.lensText}>{pair.L ? '✓ Left' : '✗ Left'}</Text>
                    <View style={s.lensMeta}>
                      {batL && <Text style={s.batText}>🔋 {batL}</Text>}
                      {pair.L && <Text style={s.rssiText}>{pair.L.rssi} dBm</Text>}
                    </View>
                  </View>
                  <View style={[s.lensBadge, pair.R ? s.lensFound : s.lensMissing]}>
                    <Text style={s.lensText}>{pair.R ? '✓ Right' : '✗ Right'}</Text>
                    <View style={s.lensMeta}>
                      {batR && <Text style={s.batText}>🔋 {batR}</Text>}
                      {pair.R && <Text style={s.rssiText}>{pair.R.rssi} dBm</Text>}
                    </View>
                  </View>
                </View>
                {lv?.state === 'probing' && <Text style={s.batNote}>checking battery…</Text>}
                {lv?.state === 'failed' && !isLive && (
                  <Pressable onPress={retryProbes}><Text style={s.batNote}>battery check failed · tap to retry</Text></Pressable>
                )}
                {lv?.state === 'done' && isLive && <Text style={s.batNote}>live battery</Text>}
                {!isLive && bat && lv?.state !== 'probing' && <Text style={s.batNote}>battery as of last connection</Text>}
                {complete ? (
                  <Text style={s.connectHint}>Tap to connect →</Text>
                ) : (
                  <Text style={s.missingHint}>
                    Waiting for {!pair.L ? 'left' : 'right'} lens…
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      )}

      <Pressable style={s.backBtn} onPress={() => router.back()}>
        <Text style={s.backText}>← Back</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:               { flex: 1, backgroundColor: '#0a0a0a', paddingHorizontal: 20 },
  title:              { color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 24 },
  subtitle:           { color: '#555', fontSize: 14, marginTop: 4, marginBottom: 20 },
  scanRow:            { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 20 },
  scanText:           { color: '#4ade80', fontSize: 13, flex: 1 },
  rescanBtn:          { backgroundColor: '#1a1a1a', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  rescanText:         { color: '#aaa', fontSize: 13 },
  emptyCard:          { backgroundColor: '#141414', borderRadius: 16, padding: 24, gap: 8 },
  emptyTitle:         { color: '#fff', fontSize: 16, fontWeight: '600' },
  emptyBody:          { color: '#666', fontSize: 14, lineHeight: 20 },
  list:               { gap: 12 },
  pairCard:           { borderRadius: 16, padding: 18, gap: 12 },
  pairCardComplete:   { backgroundColor: '#0f2a1a', borderWidth: 1, borderColor: '#4ade80' },
  pairCardIncomplete: { backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#333' },
  pairHeader:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pairSerial:         { color: '#fff', fontSize: 16, fontWeight: '600' },
  pairFirmware:       { color: '#444', fontSize: 12 },
  lensRow:            { flexDirection: 'row', gap: 10 },
  lensBadge:          { flex: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  lensFound:          { backgroundColor: '#14532d' },
  lensMissing:        { backgroundColor: '#1c1c1c' },
  lensText:           { color: '#fff', fontSize: 13, fontWeight: '500' },
  lensMeta:           { alignItems: 'flex-end', gap: 2 },
  pairCardBest:       { borderColor: '#facc15', borderWidth: 2 },
  batText:            { color: '#fff', fontSize: 12, fontWeight: '600' },
  rssiText:           { color: '#4ade80', fontSize: 11 },
  batNote:            { color: '#555', fontSize: 11, textAlign: 'center', marginTop: -6 },
  connectHint:        { color: '#4ade80', fontSize: 13, textAlign: 'center' },
  missingHint:        { color: '#666', fontSize: 13, textAlign: 'center' },
  backBtn:            { marginTop: 'auto', paddingVertical: 20 },
  backText:           { color: '#555', fontSize: 15 },
});
