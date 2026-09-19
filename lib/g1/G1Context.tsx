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
import { G1Core, G1Status, EventHandler } from './G1Core';

export const PAIRED_SERIAL_KEY = 'g1_paired_serial';

interface G1ContextValue {
  /** The shared core — use for sendText, sendBmp, etc. */
  core: G1Core;
  status: G1Status | null;
  /** Both lenses TX-ready and usable. */
  isConnected: boolean;
  /** OS reports connected but UART not yet ready (half-bonded). */
  isPartiallyConnected: boolean;
  /** Connect to a specific serial (from pairing scan). */
  connect: (serial: string) => Promise<void>;
  disconnect: () => Promise<void>;
  /** The last successfully paired serial, if any. */
  pairedSerial: string | null;
}

const G1Context = createContext<G1ContextValue | null>(null);

// Survive Fast Refresh — keep the live BLE connection across hot reloads.
declare const global: { __g1Core?: G1Core };

// Stable ref that G1Core's callback writes into — avoids stale-closure problem
// where the Core is constructed before useState returns setStatus.
const statusCallbackRef: { current: ((s: G1Status) => void) | null } = { current: null };

export function G1Provider({ children }: { children: React.ReactNode }) {
  if (!global.__g1Core) {
    global.__g1Core = new G1Core({
      onStatusChange: (s) => statusCallbackRef.current?.({ ...s }),
    });
  }

  // Seed React state directly from the live core — handles Fast Refresh where
  // __g1Core already exists with txReady=true and connect() returns immediately
  // without calling onStatusChange (so the callback-only path misses it).
  const [status, setStatus] = useState<G1Status | null>(() => {
    const s = global.__g1Core!.status;
    console.log(`[G1Context] seed L=connected:${s.left.connected} txReady:${s.left.txReady} R=connected:${s.right.connected} txReady:${s.right.txReady}`);
    return { ...s };
  });

  // Wire the module-level ref to the current setStatus — always up to date.
  statusCallbackRef.current = (s) => setStatus(s);
  // Also keep the core's own slot current (used by pairing flow that bypasses context).
  global.__g1Core.setStatusCallback((s) => setStatus({ ...s }));

  const coreRef = useRef<G1Core>(global.__g1Core);
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
      // Don't destroy on Fast Refresh unmount — the global instance stays alive.
      // destroy() is intentionally never called so the BLE connection survives reloads.
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

  const core = coreRef.current;
  // "Connected" = at least one lens is TX-ready (the other may be mid-reconnect).
  // "Both ready" = both txReady (used for full-feature sends).
  const isConnected = !!(status?.left.txReady || status?.right.txReady);
  const isPartiallyConnected = !isConnected && !!(
    (status?.left.connected || status?.right.connected)
  );

  return (
    <G1Context.Provider value={{ core, status, isConnected, isPartiallyConnected, connect, disconnect, pairedSerial }}>
      {children}
    </G1Context.Provider>
  );
}

export function useG1(): G1ContextValue {
  const ctx = useContext(G1Context);
  if (!ctx) throw new Error('useG1 must be used inside <G1Provider>');
  return ctx;
}

/**
 * Subscribe to raw G1 hardware events (head_up, head_down, etc.).
 * Handler is registered/deregistered automatically with the component lifecycle.
 * Does NOT cause any re-renders — purely side-effectful.
 */
export function useG1Event(handler: EventHandler): void {
  const { core } = useG1();
  const handlerRef = useRef(handler);
  handlerRef.current = handler; // always call latest closure, no re-subscribe needed

  useEffect(() => {
    const h: EventHandler = (e) => handlerRef.current(e);
    core.addEventHandler(h);
    return () => core.removeEventHandler(h);
  }, [core]);
}
