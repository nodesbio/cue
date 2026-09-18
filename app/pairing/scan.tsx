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
import { Device } from 'react-native-ble-plx';

type PairEntry = {
  serial: string;
  firmware: string;
  L?: Device;
  R?: Device;
};

export default function PairingScanScreen() {
  const router = useRouter();
  const { core } = useG1();
  const [pairs, setPairs] = useState<Record<string, PairEntry>>({});

  useEffect(() => {
    startScan();
    return () => {
      (core as any).manager.stopDeviceScan();
    };
  }, []);

  async function startScan() {
    setPairs({});
    try {
      await (core as any)._ensureBleReady();
      (core as any).manager.startDeviceScan(
        null,
        { allowDuplicates: true },
        (_err: any, device: Device | null) => {
          if (!device?.name?.includes('G1')) return;
          const parsed = (core as any)._parseManufacturerData(device);
          if (!parsed) return;
          const { side, serial, firmware } = parsed;
          setPairs(prev => {
            const entry = prev[serial] ?? { serial, firmware };
            return { ...prev, [serial]: { ...entry, [side]: device } };
          });
        },
      );
    } catch (e) {
      console.warn('[scan]', e);
    }
  }

  function rescan() {
    (core as any).manager.stopDeviceScan();
    startScan();
  }

  function selectPair(serial: string) {
    const entry = pairs[serial];
    if (!entry?.L || !entry?.R) return;
    (core as any).manager.stopDeviceScan();
    router.push({ pathname: '/pairing/connecting', params: { serial } });
  }

  const pairList = Object.values(pairs);

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
            return (
              <Pressable
                key={pair.serial}
                style={[s.pairCard, complete ? s.pairCardComplete : s.pairCardIncomplete]}
                onPress={() => selectPair(pair.serial)}
                disabled={!complete}
              >
                <View style={s.pairHeader}>
                  <Text style={s.pairSerial}>G1 · {pair.serial}</Text>
                  <Text style={s.pairFirmware}>fw {pair.firmware}</Text>
                </View>
                <View style={s.lensRow}>
                  <View style={[s.lensBadge, pair.L ? s.lensFound : s.lensMissing]}>
                    <Text style={s.lensText}>{pair.L ? '✓ Left' : '✗ Left'}</Text>
                    {pair.L && <Text style={s.rssiText}>{pair.L.rssi} dBm</Text>}
                  </View>
                  <View style={[s.lensBadge, pair.R ? s.lensFound : s.lensMissing]}>
                    <Text style={s.lensText}>{pair.R ? '✓ Right' : '✗ Right'}</Text>
                    {pair.R && <Text style={s.rssiText}>{pair.R.rssi} dBm</Text>}
                  </View>
                </View>
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
  rssiText:           { color: '#4ade80', fontSize: 11 },
  connectHint:        { color: '#4ade80', fontSize: 13, textAlign: 'center' },
  missingHint:        { color: '#666', fontSize: 13, textAlign: 'center' },
  backBtn:            { marginTop: 'auto', paddingVertical: 20 },
  backText:           { color: '#555', fontSize: 15 },
});
