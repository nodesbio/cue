/**
 * ble-debug.tsx — SmartRemote button sniffer.
 * Navigate to /ble-debug on the phone, press every button,
 * read the hex bytes, then delete this file.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, SafeAreaView, ActivityIndicator,
} from 'react-native';
import { BleManager, Device, Characteristic } from 'react-native-ble-plx';

const TARGET_NAME  = 'SmartRemote';
const SERVICE_UUID = 'AE40';
const NOTIFY_UUID  = 'AE42';

type Phase = 'checking' | 'idle' | 'scanning' | 'connected';

function b64ToHex(b64: string): string {
  const bin = atob(b64);
  return Array.from(bin).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
}

export default function BleDebug() {
  const [logs,    setLogs]    = useState<string[]>([]);
  const [phase,   setPhase]   = useState<Phase>('checking');
  const managerRef = useRef<BleManager | null>(null);
  const deviceRef  = useRef<Device | null>(null);
  const scrollRef  = useRef<ScrollView>(null);

  const log = (line: string) => {
    console.log(`[BleDebug] ${line}`);
    setLogs(prev => [...prev, `${new Date().toISOString().slice(11,23)}  ${line}`]);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
  };

  /** Enumerate all services+characteristics, then subscribe to every notifiable one. */
  const subscribeToDevice = async (d: Device) => {
    deviceRef.current = d;
    setPhase('connected');

    const services = await d.services();
    log(`Services (${services.length}):`);
    for (const svc of services) {
      log(`  SVC ${svc.uuid}`);
      const chars = await svc.characteristics();
      for (const ch of chars) {
        const flags = [
          ch.isReadable         && 'read',
          ch.isWritableWithResponse && 'write',
          ch.isNotifiable       && 'notify',
          ch.isIndicatable      && 'indicate',
        ].filter(Boolean).join('|');
        log(`    CHR ${ch.uuid}  [${flags}]`);

        // Try to read every readable char so we can see its value
        if (ch.isReadable) {
          try {
            const val = await ch.read();
            const hex = val.value ? b64ToHex(val.value) : '(empty)';
            log(`    READ ${ch.uuid.slice(4,8)}: ${hex}`);
          } catch (e: any) { log(`    READ err ${ch.uuid.slice(4,8)}: ${e.message}`); }
        }

        if (ch.isNotifiable) {
          log(`    → monitoring ${ch.uuid}`);
          ch.monitor((err2, char) => {
            if (err2) { log(`    Notify error (${ch.uuid.slice(4,8)}): ${err2.message}`); return; }
            if (!char?.value) return;
            const hex = b64ToHex(char.value);
            const bytes = Array.from(atob(char.value)).map(c => c.charCodeAt(0));
            log(`BUTTON [${ch.uuid.slice(4,8)}]: [${hex}]  dec=[${bytes.join(', ')}]`);
          });
        }

        // AE41 has no flags reported but may accept a write to arm AE42 notify.
        // Try writing 0x01 to it.
        if (ch.uuid.toLowerCase().includes('ae41')) {
          try {
            const arm = btoa(String.fromCharCode(0x01));
            await ch.writeWithResponse(arm);
            log(`    WROTE 01 to AE41 (arm attempt)`);
          } catch (e: any) {
            try {
              const arm = btoa(String.fromCharCode(0x01));
              await ch.writeWithoutResponse(arm);
              log(`    WROTE 01 to AE41 (no-response)`);
            } catch (e2: any) { log(`    AE41 write failed: ${e2.message}`); }
          }
        }
      }
    }
    log('Monitoring all notifiable characteristics — press buttons now');
  };

  /** Full flow: wait for BLE power, connect, discover, subscribe. */
  const connectFresh = async () => {
    const mgr = managerRef.current!;
    setPhase('scanning');
    log('Waiting for BLE to power on…');

    await new Promise<void>(resolve => {
      const sub = mgr.onStateChange(state => {
        log(`BLE state: ${state}`);
        if (state === 'PoweredOn') { sub.remove(); resolve(); }
      }, true);
    });

    log(`Scanning for "${TARGET_NAME}"…`);
    mgr.startDeviceScan(null, { allowDuplicates: false }, (err, device) => {
      if (err) { log(`Scan error: ${err.message}`); setPhase('idle'); return; }
      if (!device?.name?.includes(TARGET_NAME)) return;
      log(`Found: ${device.name} (${device.id}) rssi=${device.rssi}`);
      mgr.stopDeviceScan();

      device.connect()
        .then(d => { log('Connected'); return d.discoverAllServicesAndCharacteristics(); })
        .then(d => { log('Services discovered'); subscribeToDevice(d); })
        .catch((e: Error) => { log(`Error: ${e.message}`); setPhase('idle'); });
    });
  };

  const disconnect = () => {
    deviceRef.current?.cancelConnection().catch(() => {});
    managerRef.current?.stopDeviceScan();
    setPhase('idle');
    log('Disconnected');
  };

  /** On mount: initialise manager, wait for PoweredOn, check connected devices first. */
  useEffect(() => {
    const mgr = new BleManager();
    managerRef.current = mgr;

    const sub = mgr.onStateChange(async state => {
      if (state !== 'PoweredOn') return;
      sub.remove();
      log('BLE powered on — checking for already-connected SmartRemote…');

      try {
        const connected = await mgr.connectedDevices([SERVICE_UUID]);
        const already = connected.find(d => d.name?.includes(TARGET_NAME));

        if (already) {
          log(`Already connected: ${already.name} (${already.id}) — re-attaching…`);
          // connectedDevices() returns a thin reference; call connect() to get
          // a fully managed handle before discovering services.
          const reattached = await mgr.connectToDevice(already.id, { requestMTU: 512 });
          log('Re-attached — discovering services…');
          const discovered = await reattached.discoverAllServicesAndCharacteristics();
          subscribeToDevice(discovered);
        } else {
          log('SmartRemote not currently connected — tap Connect to scan');
          setPhase('idle');
        }
      } catch (e: any) {
        log(`Check error: ${e.message}`);
        setPhase('idle');
      }
    }, true);

    return () => {
      sub.remove();
      disconnect();
      mgr.destroy();
    };
  }, []);

  const connected = phase === 'connected';
  const checking  = phase === 'checking';
  const scanning  = phase === 'scanning';

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.title}>SmartRemote BLE Debug</Text>

      <View style={s.statusRow}>
        {checking || scanning ? (
          <ActivityIndicator color="#60a5fa" size="small" style={{ marginRight: 8 }} />
        ) : (
          <View style={[s.dot, { backgroundColor: connected ? '#4ade80' : '#6b7280' }]} />
        )}
        <Text style={s.statusText}>
          {checking  ? 'Checking connection…' :
           scanning  ? `Scanning for "${TARGET_NAME}"…` :
           connected ? 'Connected' : 'Not connected'}
        </Text>
      </View>

      {!connected && !checking && (
        <TouchableOpacity
          style={[s.btn, scanning && s.btnGray]}
          onPress={scanning ? undefined : connectFresh}
          disabled={scanning}
        >
          <Text style={s.btnText}>{scanning ? 'Scanning…' : 'Connect'}</Text>
        </TouchableOpacity>
      )}
      {connected && (
        <TouchableOpacity style={s.btnRed} onPress={disconnect}>
          <Text style={s.btnText}>Disconnect</Text>
        </TouchableOpacity>
      )}

      <ScrollView ref={scrollRef} style={s.scroll} contentContainerStyle={s.scrollContent}>
        {logs.map((l, i) => (
          <Text key={i} style={[s.logLine, l.includes('BUTTON') && s.buttonLine]}>{l}</Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: '#0a0a0a', padding: 16 },
  title:        { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 12 },
  statusRow:    { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  dot:          { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  statusText:   { color: '#9ca3af', fontSize: 13 },
  btn:          { backgroundColor: '#2563eb', borderRadius: 8, padding: 12, alignItems: 'center', marginBottom: 12 },
  btnRed:       { backgroundColor: '#dc2626', borderRadius: 8, padding: 12, alignItems: 'center', marginBottom: 12 },
  btnGray:      { backgroundColor: '#374151' },
  btnText:      { color: '#fff', fontWeight: '600', fontSize: 16 },
  scroll:       { flex: 1, backgroundColor: '#111', borderRadius: 8 },
  scrollContent:{ padding: 10 },
  logLine:      { color: '#9ca3af', fontSize: 11, fontFamily: 'monospace', marginBottom: 2 },
  buttonLine:   { color: '#4ade80', fontWeight: '700', fontSize: 12 },
});
