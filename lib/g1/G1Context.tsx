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
import Constants from 'expo-constants';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { G1Core, G1Status, EventHandler } from './G1Core';
import { smartRemoteManager } from './SmartRemoteManager';
import { startDevBridge } from './devBridge';
import { saveBattery } from './batteryStore';

// Detect whether the native BLE module is available (absent in Expo Go).
function isBleAvailable(): boolean {
  try {
    // react-native-ble-plx registers its native module as 'BlePlx'
    // (RCT_EXPORT_MODULE on the BlePlx class — see node_modules/react-native-ble-plx/
    // ios/BlePlx.m and src/BleModule.js: `NativeModules.BlePlx`).
    // If the native layer is missing (Expo Go), this is null/undefined.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NativeModules } = require('react-native');
    return !!NativeModules.BlePlx;
  } catch {
    return false;
  }
}

/** Minimal no-op stub used when BLE native module is unavailable (e.g. Expo Go). */
function makeStubCore(): G1Core {
  return {
    status: {
      left:  { device: null, connected: false, txReady: false, displayIdle: false, asleep: false, batteryPct: null, rssi: null },
      right: { device: null, connected: false, txReady: false, displayIdle: false, asleep: false, batteryPct: null, rssi: null },
      firmwareVersion: null,
      poweredOff: false,
    },
    // Connection
    connect:              async () => {},
    disconnect:           async () => {},
    powerOff:             async () => {},
    powerOn:              async () => {},
    disconnectSide:       async () => {},
    reconnectSide:        () => {},
    reconnectDropped:     async () => {},
    destroy:              () => {},
    // Status / events
    addEventHandler:      () => {},
    removeEventHandler:   () => {},
    setStatusCallback:    () => {},
    // Sending
    sendText:             async () => {},
    sendBmp:              async () => {},
    setBrightness:        async () => {},
    requestBattery:       async () => {},
    exitToDashboard:      async () => {},
    // Scanning
    scanPairs:            async () => ({}),
    scanDebug:            async () => ([]),
    startStreamingScan:   async () => {},
    stopStreamingScan:    () => {},
    // Computed props
    get isConnected()          { return false; },
    get isPartiallyConnected() { return false; },
    get isReconnecting()       { return false; },
  } as unknown as G1Core;
}

export const PAIRED_SERIAL_KEY = 'g1_paired_serial';
/** Per-serial CoreBluetooth peripheral ids: { L?: uuid, R?: uuid }. */
const PAIRED_IDS_KEY = (serial: string) => `g1_paired_ids_${serial}`;

// Module-level mirror of the persisted ids so the mount-time connect() can be
// seeded synchronously after the serial read resolves.
let _pairedIdsCache: { serial: string; ids: Partial<Record<'L' | 'R', string>> } | null = null;

function _loadPairedIds(serial: string): Partial<Record<'L' | 'R', string>> | undefined {
  return _pairedIdsCache?.serial === serial ? _pairedIdsCache.ids : undefined;
}

// ── Log buffer ─────────────────────────────────────────────────────────────
// Module-level ring buffer: survives Fast Refresh, max 200 lines.
const LOG_MAX = 1000;
const _logBuffer: string[] = [];
const _logListeners = new Set<() => void>();

function _addLog(line: string) {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.mmm
  const entry = `${ts}  ${line}`;
  _logBuffer.push(entry);
  if (_logBuffer.length > LOG_MAX) _logBuffer.shift();
  console.log('[G1]', entry);
  _logListeners.forEach(fn => fn());
}

// Build stamp — appVersionSource=remote means app.json's buildNumber is NOT
// what's in the binary; nativeBuildVersion is the real CFBundleVersion.
// Without this, a shared log can't be matched to an EAS build/commit (the
// 2026-10-25 logs were triaged against a fix that wasn't in that binary).
// runtimeVersion may be a policy object ({ policy: 'appVersion' }) rather than
// a string — rendered "[object Object]" in the 2026-11-04 log. Only print strings.
const _rtv = Constants.expoConfig?.runtimeVersion;
const BUILD_STAMP = `cue ${Constants.nativeAppVersion ?? '?'} (${Constants.nativeBuildVersion ?? '?'}) ${typeof _rtv === 'string' ? _rtv : ''}`.trim();
_addLog(`[BUILD] ${BUILD_STAMP}`);

/** Returns the full log buffer as a single newline-joined string (for sharing). */
export function getLogsText(): string {
  return [`[BUILD] ${BUILD_STAMP}`, ..._logBuffer].join('\n');
}

/** Clears the log buffer and notifies all listeners. */
export function clearLogBuffer(): void {
  _logBuffer.splice(0, _logBuffer.length);
  _logListeners.forEach(fn => fn());
}

/** Returns a stable snapshot of the log buffer that updates on every new line. */
export function useLogs(): string[] {
  const [, forceUpdate] = React.useState(0);
  useEffect(() => {
    const cb = () => forceUpdate(n => n + 1);
    _logListeners.add(cb);
    return () => { _logListeners.delete(cb); };
  }, []);
  return _logBuffer;
}

export const BRIGHTNESS_KEY     = 'g1_brightness';
export const BRIGHTNESS_DEFAULT = 21; // mid-range (0–42)

interface G1ContextValue {
  /** The shared core — use for sendText, sendBmp, etc. */
  core: G1Core;
  status: G1Status | null;
  /** Both lenses TX-ready and usable. */
  isConnected: boolean;
  /** At least one lens has completed handshake (txReady) but not both. */
  isPartiallyConnected: boolean;
  /**
   * True from mount until the AsyncStorage PAIRED_SERIAL_KEY check resolves
   * (initial auto-connect attempt), OR while G1Core has an active _connectLens
   * in flight via _scheduleReconnect. UI should show "Connecting…" in both
   * cases rather than the disconnected/pair flow.
   */
  isAutoConnecting: boolean;
  /** Connect to a specific serial (from pairing scan). */
  connect: (serial: string) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Disconnect a single lens and stop its reconnect timer. */
  disconnectSide: (side: 'L' | 'R') => Promise<void>;
  /** Reset backoff and immediately re-scan/reconnect a single lens. */
  reconnectSide: (side: 'L' | 'R') => void;
  /** The last successfully paired serial, if any. */
  pairedSerial: string | null;
  /** Display brightness (0–42). Persisted + pushed to hardware automatically. */
  brightness: number;
  setBrightness: (level: number) => Promise<void>;
  /** Send a one-line battery+signal test to both lens HUDs. */
  sendTestDisplay: () => Promise<void>;
  /** Clear the HUD on a single lens by re-asserting silent mode. */
  clearDisplay: (side: 'L' | 'R') => Promise<void>;
}

const G1Context = createContext<G1ContextValue | null>(null);

// Survive Fast Refresh — keep the live BLE connection across hot reloads.
declare const global: { __g1Core?: G1Core; __g1CoreVersion?: number };

// Bump this when the stub API changes. Forces old frozen instances to be replaced.
const STUB_VERSION = 4;
if (global.__g1CoreVersion !== STUB_VERSION) {
  global.__g1Core = undefined;
  global.__g1CoreVersion = STUB_VERSION;
}

// Stable ref that G1Core's callback writes into — avoids stale-closure problem
// where the Core is constructed before useState returns setStatus.
const statusCallbackRef: { current: ((s: G1Status) => void) | null } = { current: null };

export function G1Provider({ children }: { children: React.ReactNode }) {
  if (!global.__g1Core) {
    if (isBleAvailable()) {
      global.__g1Core = new G1Core({
        onStatusChange: (s) => statusCallbackRef.current?.({ ...s }),
        onLog: _addLog,
      });
    } else {
      _addLog('[G1Context] BLE native module unavailable (Expo Go?) — using stub.');
      console.warn('[G1Context] BLE native module unavailable (Expo Go?) — using stub.');
      global.__g1Core = makeStubCore();
    }
  }
  // Keep log callback current across Fast Refresh
  (global.__g1Core as G1Core).setLogCallback?.(_addLog);

  // Seed React state directly from the live core — handles Fast Refresh where
  // __g1Core already exists with txReady=true and connect() returns immediately
  // without calling onStatusChange (so the callback-only path misses it).
  const [status, setStatus] = useState<G1Status | null>(() => {
    const s = global.__g1Core!.status;
    const seedMsg = `[G1Context] seed L=connected:${s.left.connected} txReady:${s.left.txReady} R=connected:${s.right.connected} txReady:${s.right.txReady}`;
    console.log(seedMsg);
    _addLog(seedMsg);
    return { ...s };
  });

  // Wire the module-level ref to the current setStatus — always up to date.
  statusCallbackRef.current = (s) => setStatus(s);
  // Also keep the core's own slot current (used by pairing flow that bypasses context).
  global.__g1Core.setStatusCallback((s) => setStatus({ ...s }));

  const coreRef = useRef<G1Core>(global.__g1Core);
  const [pairedSerial, setPairedSerial] = useState<string | null>(null);
  const [brightness, setBrightnessState] = useState<number>(BRIGHTNESS_DEFAULT);
  // True until the AsyncStorage paired-serial check resolves on first mount.
  const [isAutoConnecting, setIsAutoConnecting] = useState<boolean>(() => {
    // If the core is already live (Fast Refresh), no waiting needed.
    const s = global.__g1Core!.status;
    return !(s.left.connected || s.right.connected || s.left.txReady || s.right.txReady);
  });

  // Remember last-known battery per serial so the scan screen can show it
  // before connecting (advertisement has no battery byte).
  const batL = status?.left.batteryPct ?? null;
  const batR = status?.right.batteryPct ?? null;
  useEffect(() => {
    if (!pairedSerial) return;
    saveBattery(pairedSerial, batL, batR).catch(() => {});
  }, [pairedSerial, batL, batR]);

  useEffect(() => {
    // Start SmartRemote listener once on mount.
    smartRemoteManager.start();
    startDevBridge({ core: coreRef.current, getLogs: () => _logBuffer, log: _addLog });
    return () => smartRemoteManager.stop();
  }, []);

  useEffect(() => {
    // Load persisted brightness on mount.
    AsyncStorage.getItem(BRIGHTNESS_KEY).then(v => {
      const b = parseInt(v ?? '', 10);
      if (!isNaN(b)) setBrightnessState(b);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    // Auto-reconnect to the last paired serial
    AsyncStorage.getItem(PAIRED_SERIAL_KEY).then(async serial => {
      if (!serial) {
        // No paired device — nothing to connect to, stop waiting.
        setIsAutoConnecting(false);
        return;
      }
      setPairedSerial(serial);
      const idsJson = await AsyncStorage.getItem(PAIRED_IDS_KEY(serial)).catch(() => null);
      if (idsJson) {
        try { _pairedIdsCache = { serial, ids: JSON.parse(idsJson) }; } catch { /* corrupt → re-learn from scan */ }
      }
      coreRef.current.connect(serial, _loadPairedIds(serial)).catch((e) => {
        // Silent — dashboard will show "Connect" CTA if glasses aren't in range
        const msg = `[G1Context] auto-reconnect failed: ${e?.message ?? e}`;
        console.log(msg);
        _addLog(msg);
      }).finally(() => {
        // Whether connect succeeded or failed, the auto-connect attempt is done.
        setIsAutoConnecting(false);
      });
    }).catch(() => { setIsAutoConnecting(false); });

    return () => {
      // Don't destroy on Fast Refresh unmount — the global instance stays alive.
      // destroy() is intentionally never called so the BLE connection survives reloads.
    };
  }, []);

  // Persist verified lens peripheral ids whenever the core learns one. Cold-start
  // resume on iOS has no mfr data, so these ids are the only pair verification.
  const pairedIdsJson = JSON.stringify(coreRef.current.pairedIds);
  useEffect(() => {
    if (!pairedSerial || pairedIdsJson === '{}') return;
    _pairedIdsCache = { serial: pairedSerial, ids: JSON.parse(pairedIdsJson) };
    AsyncStorage.setItem(PAIRED_IDS_KEY(pairedSerial), pairedIdsJson).catch(() => {});
  }, [pairedSerial, pairedIdsJson]);

  // Re-push stored brightness whenever glasses become connected/reconnect.
  const isConnectedForEffect = !!(status?.left.txReady || status?.right.txReady);
  useEffect(() => {
    if (isConnectedForEffect) {
      coreRef.current.setBrightness(brightness).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnectedForEffect]);

  async function sendTestDisplay() {
    await coreRef.current.sendTestDisplay().catch(() => {});
  }

  async function clearDisplay(side: 'L' | 'R') {
    await coreRef.current.clearDisplay(side).catch(() => {});
  }

  async function setBrightness(level: number): Promise<void> {
    const v = Math.max(0, Math.min(42, Math.round(level)));
    setBrightnessState(v);
    await AsyncStorage.setItem(BRIGHTNESS_KEY, String(v)).catch(() => {});
    if (isConnectedForEffect) {
      await coreRef.current.setBrightness(v).catch(() => {});
    }
  }

  async function connect(serial: string) {
    await coreRef.current.connect(serial);
    // Persist serial so next launch auto-reconnects
    setPairedSerial(serial);
    await AsyncStorage.setItem(PAIRED_SERIAL_KEY, serial).catch(() => {});
  }

  async function disconnect() {
    await coreRef.current.disconnect();
    // Do NOT clear pairedSerial — we want auto-reconnect to work next time
    // the app comes to foreground. Only an explicit "forget device" action
    // should remove the serial.
  }

  async function disconnectSide(side: 'L' | 'R') {
    await coreRef.current.disconnectSide(side);
  }

  function reconnectSide(side: 'L' | 'R') {
    coreRef.current.reconnectSide(side);
  }

  const core = coreRef.current;
  // "Connected" = BOTH lenses TX-ready. Using OR here caused split-brain: L
  // would complete handshake+silent and flip isConnected true while R was still
  // mid-_connectLens showing the firmware dashboard — the reconnect-send
  // useEffect would fire, sending text to R before R's silent(true) had run.
  const isConnected = !!(status?.left.txReady && status?.right.txReady);
  // "Partially connected" = at least one lens has completed handshake (txReady).
  // Deliberately excludes raw `connected` state — a lens that is BLE-bonded but
  // mid-silent-handshake (connected=true, txReady=false) is not usably connected
  // and should not flash the LensCard UI. See issue #20.
  const isPartiallyConnected = !isConnected && !!(
    status?.left.txReady || status?.right.txReady
  );
  // Covers both the initial mount attempt AND background _scheduleReconnect cycles.
  // Without the second term, isAutoConnecting goes permanently false after the first
  // connect() resolves, exposing the "Reconnect" button during active retries. See #19.
  const isAutoConnecting_ = isAutoConnecting || core.isReconnecting;

  return (
    <G1Context.Provider value={{ core, status, isConnected, isPartiallyConnected, isAutoConnecting: isAutoConnecting_, connect, disconnect, disconnectSide, reconnectSide, pairedSerial, brightness, setBrightness, sendTestDisplay, clearDisplay }}>
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
 * Subscribe to hardware events from both the G1 glasses AND the SmartRemote.
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
    smartRemoteManager.addEventHandler(h);
    return () => {
      core.removeEventHandler(h);
      smartRemoteManager.removeEventHandler(h);
    };
  }, [core]);
}
