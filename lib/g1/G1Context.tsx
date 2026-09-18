/**
 * G1Context — single shared G1Core instance for the whole app.
 *
 * Rules:
 *   - One BleManager, one connection, one source of truth for status.
 *   - The pairing flow calls connect(); the dashboard reads status.
 *   - Nobody else creates a G1Core.
 *   - On mount, auto-reconnects to the last paired serial (if any).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { G1Core, G1Status } from './G1Core';

export const PAIRED_SERIAL_KEY = 'g1_paired_serial';

interface G1ContextValue {
  /** The shared core — use for sendText, sendBmp, etc. */
  core: G1Core;
  status: G1Status | null;
  /** Connect to a specific serial (from pairing scan). */
  connect: (serial: string) => Promise<void>;
  disconnect: () => Promise<void>;
  /** The last successfully paired serial, if any. */
  pairedSerial: string | null;
}

const G1Context = createContext<G1ContextValue | null>(null);

export function G1Provider({ children }: { children: React.ReactNode }) {
  const coreRef = useRef<G1Core>(
    new G1Core({ onStatusChange: (s) => setStatus({ ...s }) }),
  );
  const [status, setStatus] = useState<G1Status | null>(null);
  const [pairedSerial, setPairedSerial] = useState<string | null>(null);

  useEffect(() => {
    // Auto-reconnect to the last paired serial
    AsyncStorage.getItem(PAIRED_SERIAL_KEY).then(serial => {
      if (!serial) return;
      setPairedSerial(serial);
      coreRef.current.connect(serial).catch((e) => {
        // Silent — dashboard will show "Connect" CTA if glasses aren't in range
        console.log('[G1Context] auto-reconnect failed:', e?.message ?? e);
      });
    }).catch(() => {});

    return () => {
      coreRef.current.destroy();
    };
  }, []);

  async function connect(serial: string) {
    await coreRef.current.connect(serial);
    // Persist serial so next launch auto-reconnects
    setPairedSerial(serial);
    await AsyncStorage.setItem(PAIRED_SERIAL_KEY, serial).catch(() => {});
  }

  async function disconnect() {
    await coreRef.current.disconnect();
    setPairedSerial(null);
    await AsyncStorage.removeItem(PAIRED_SERIAL_KEY).catch(() => {});
  }

  return (
    <G1Context.Provider value={{ core: coreRef.current, status, connect, disconnect, pairedSerial }}>
      {children}
    </G1Context.Provider>
  );
}

export function useG1(): G1ContextValue {
  const ctx = useContext(G1Context);
  if (!ctx) throw new Error('useG1 must be used inside <G1Provider>');
  return ctx;
}
