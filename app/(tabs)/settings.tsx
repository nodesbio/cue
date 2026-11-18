import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useG1, useG1Event, useLogs, getLogsText, clearLogBuffer, PAIRED_SERIAL_KEY } from '@/lib/g1/G1Context';
import { LensCard } from '@/components/LensCard';
import {
  RAMP_MS, STAGE_FRAMES, TOTAL_FRAMES, intervalForFrame,
  linkCeilingMs, renderCeilingMs, committedPaceMs,
} from '@/lib/g1/calibrate';
import {
  saveCalibration, loadCalibration, isCalibrationStale,
  type Calibration, type Side as CalSide,
} from '@/lib/g1/calibrationStore';

export const GESTURE_KEY      = 'gesture_nav_enabled';
export const GESTURE_SWAP_KEY = 'gesture_nav_swapped';

// Skew/lens-race harness buttons — internal diagnostics, hidden from the normal
// UI. Flip to true to re-expose them during link-layer debugging. (Already
// __DEV__-gated below, so they never ship to production regardless.)
const SHOW_DEV_HARNESS = false;

export default function SettingsScreen() {
  const router = useRouter();
  const { core, status, isConnected: connected, isPartiallyConnected, isAutoConnecting, disconnect, disconnectSide, reconnectSide, pairedSerial, brightness, setBrightness, sendTestDisplay } = useG1();

  const [gesturesEnabled, setGesturesEnabled] = useState(false);
  const [gesturesSwapped, setGesturesSwapped] = useState(false);
  const [lastEvent, setLastEvent]             = useState<string | null>(null);
  const [debugDevices, setDebugDevices]       = useState<string[]>([]);
  const [scanning, setScanning]               = useState(false);
  const [showAdvanced, setShowAdvanced]       = useState(false);
  const [showLogs, setShowLogs]               = useState(false);
  const [verboseLogs, setVerboseLogs]         = useState(false);
  const [harnessRunning, setHarnessRunning]   = useState(false);
  // Reading-eye auto-alternation (eye-health). Rotates which eye reads in mono
  // on a cadence so a single eye isn't loaded for a whole session.
  const [eyeAlternate, setEyeAlternate]       = useState(false);
  const logs = useLogs();

  // ── Calibration ───────────────────────────────────────────────────────────
  // User-facing "Calibrate" feature. Two phases, because the two lenses fail at
  // different layers (see calibrationStore.ts):
  //   Phase 1 LINK — auto. Ramp both lenses, read the 0x4e ACK ledger, find each
  //     side's drop-onset rate. No user action (R's radio ceiling).
  //   Phase 2 RENDER — human-in-loop. Show a big frame counter ON THE GLASSES
  //     and ramp the pace up; the user taps STOP the instant the numbers freeze.
  //     The firmware emits NO render-confirm frame, so a human watching is the
  //     ONLY valid render signal — this captures L's panel-commit ceiling.
  // Result = max(all ceilings) stored per serial; the live scroll path reads it.
  const [calPhase, setCalPhase]       = useState<'idle' | 'link' | 'render' | 'done'>('idle');
  const [calProgress, setCalProgress] = useState(0);        // 0..1 within a phase
  const [calResult, setCalResult]     = useState<Calibration | null>(null);
  const [savedCal, setSavedCal]       = useState<Calibration | null>(null);
  const calAbort = useState<{ stop: boolean; rendered: number | null }>({ stop: false, rendered: null })[0];

  // Load any stored calibration for this pair on mount / serial change.
  useEffect(() => {
    if (!pairedSerial) { setSavedCal(null); return; }
    void loadCalibration(pairedSerial).then(setSavedCal);
  }, [pairedSerial]);

  // STOP button during the render phase — records the frame on-glass right now.
  function calStopRender() {
    calAbort.rendered = calRenderFrame.current;
    calAbort.stop = true;
  }
  const calRenderFrame = useState<{ current: number }>({ current: 0 })[0];

  async function runCalibration() {
    if (calPhase !== 'idle' && calPhase !== 'done') { calAbort.stop = true; return; }
    if (!core || !pairedSerial) return;
    calAbort.stop = false;
    calAbort.rendered = null;
    setCalResult(null);

    const battAtCalib: Record<CalSide, number | null> = {
      L: status?.left.batteryPct ?? null,
      R: status?.right.batteryPct ?? null,
    };

    try {
      // ── Phase 1: LINK (automatic) ──────────────────────────────────────────
      // Ramp both lenses in parallel through RAMP_MS; the ACK ledger records
      // which seqs each firmware actually 0x4e-ACK'd. Gaps ⇒ link drop.
      setCalPhase('link');
      setCalProgress(0);
      const acked: Record<CalSide, Set<number>> = { L: new Set(), R: new Set() };
      const reached: Record<CalSide, number> = { L: 0, R: 0 };
      core.setTextAckObserver((side, seq) => { acked[side as CalSide].add(seq); });

      // Prime both lenses into TEXT-accept (frame 1 via the ACK-awaited path).
      const [pL, pR] = await Promise.all([
        core.racePrimeSide('L', `cal L 1/${TOTAL_FRAMES}`, 1).catch(() => false),
        core.racePrimeSide('R', `cal R 1/${TOTAL_FRAMES}`, 1).catch(() => false),
      ]);
      if (pL) { acked.L.add(1); reached.L = 1; }
      if (pR) { acked.R.add(1); reached.R = 1; }

      const rampSide = async (side: CalSide) => {
        for (let i = 2; i <= TOTAL_FRAMES; i++) {
          if (calAbort.stop) break;
          const frameMs = intervalForFrame(i);
          const t = Date.now();
          await core.raceSendTextToSide(side, `cal ${side} ${i}`, i & 0xff).catch(() => {});
          reached[side] = i;
          if (side === 'L') setCalProgress(i / TOTAL_FRAMES);
          const el = Date.now() - t;
          if (el < frameMs) await new Promise(r => setTimeout(r, frameMs - el));
        }
      };
      await Promise.all([rampSide('L'), rampSide('R')]);
      core.setTextAckObserver(null);

      const link: Record<CalSide, number> = {
        L: linkCeilingMs(acked.L, reached.L),
        R: linkCeilingMs(acked.R, reached.R),
      };
      core.note(`===== CALIBRATE LINK L=${link.L}ms R=${link.R}ms (acked L=${acked.L.size} R=${acked.R.size}) =====`);

      if (calAbort.stop) { setCalPhase('idle'); await core.exitToDashboard().catch(() => {}); return; }

      // ── Phase 2: RENDER (human-in-loop) ────────────────────────────────────
      // Ramp a visible counter up on BOTH glasses. The user watches and taps
      // STOP when the numbers freeze/stutter — that frame index is the render
      // edge. We send via sendText (the COMMIT path) so the panel actually
      // paints each page, unlike the raw race path. Only L typically freezes,
      // but we ramp both and take whichever froze (recorded in calAbort).
      setCalPhase('render');
      setCalProgress(0);
      calAbort.stop = false;
      calAbort.rendered = null;
      calRenderFrame.current = 0;
      for (let i = 1; i <= TOTAL_FRAMES; i++) {
        if (calAbort.stop) break;
        const frameMs = intervalForFrame(i);
        calRenderFrame.current = i;
        setCalProgress(i / TOTAL_FRAMES);
        const t = Date.now();
        // sendText drives both lenses through the commit path (page actually
        // renders). Big centered number so a freeze is obvious to the eye.
        await core.sendText(`${i}`).catch(() => {});
        const el = Date.now() - t;
        if (el < frameMs) await new Promise(r => setTimeout(r, frameMs - el));
      }
      // If the user tapped STOP, calAbort.rendered holds the frozen frame.
      // If the ramp finished clean (never tapped), render was never the limit.
      const stopFrame = calAbort.rendered;
      const render: Record<CalSide, number | null> = {
        // We can't attribute the freeze to a specific lens from the eye alone,
        // so we apply the observed render edge to BOTH as a conservative floor.
        L: renderCeilingMs(stopFrame),
        R: renderCeilingMs(stopFrame),
      };
      core.note(`===== CALIBRATE RENDER stopFrame=${stopFrame ?? 'none'} → L=${render.L}ms R=${render.R}ms =====`);

      const paceMs = committedPaceMs(link, render);
      const result: Calibration = {
        paceMs, linkCeilingMs: link, renderCeilingMs: render, battAtCalib, at: Date.now(),
      };
      await saveCalibration(pairedSerial, result);
      setSavedCal(result);
      setCalResult(result);
      setCalPhase('done');
      core.note(`===== CALIBRATE DONE paceMs=${paceMs} (${(1000 / paceMs).toFixed(1)} f/s) =====`);
    } catch (e: any) {
      core.note(`===== CALIBRATE ERROR ${e?.message ?? e} =====`);
      setCalPhase('idle');
    } finally {
      core.setTextAckObserver(null);
      await core.exitToDashboard().catch(() => {});
    }
  }

  const calBattStale = savedCal && isCalibrationStale(savedCal, {
    L: status?.left.batteryPct ?? null,
    R: status?.right.batteryPct ?? null,
  });

  // ── Skew harness (DEV-only) ───────────────────────────────────────────────
  // Drives the HUD with text frames at a FIXED cadence from a clean start so
  // the existing SKEW telemetry (w/a/Δ/max per side) plots a repeatable latency
  // curve instead of depending on hand-scroll. At a set frame count it fires a
  // clear() "resync" and keeps driving, so one run shows a-before vs a-after on
  // the same session — answering: (1) is the climb linear or stepped,
  // (2) does a resync recover `a`. `note()` stamps boundaries inline with SKEW.
  const harnessAbort = useState<{ stop: boolean }>({ stop: false })[0];
  async function runSkewHarness() {
    if (harnessRunning) { harnessAbort.stop = true; return; }
    if (!core) return;
    harnessAbort.stop = false;
    setHarnessRunning(true);
    const FRAMES = 160;        // past seq ~140 where a hit ~2s in the field
    const CADENCE_MS = 700;    // fixed inter-frame gap (field scroll was ~2.8s/frame; faster stresses the buffer)
    const RESYNC_AT = 0;       // 0 = disabled. Pure fixed-cadence climb test — no clear() mid-stream.
                               // (Run 2026-11-15 showed clear() mid-loop collides with the next
                               //  sendText and stalls the pipeline — a harness artifact, not the
                               //  field bug. Isolate the climb first; re-enable only once confirmed.)
    if (!verboseLogs) { core.setVerbose(true); setVerboseLogs(true); }  // SKEW lines need verbose
    core.note(`===== HARNESS START frames=${FRAMES} cadence=${CADENCE_MS}ms resyncAt=${RESYNC_AT} =====`);
    try {
      for (let i = 1; i <= FRAMES; i++) {
        if (harnessAbort.stop) { core.note(`===== HARNESS ABORTED at frame ${i} =====`); break; }
        if (RESYNC_AT > 0 && i === RESYNC_AT) {
          core.note(`===== HARNESS RESYNC (clear both) before frame ${i} ${core.syncSnapshot} =====`);
          await Promise.all([core.clearDisplay('L'), core.clearDisplay('R')]).catch(() => {});
        }
        // Monotonic payload so each frame is a distinct render, not a de-dupe.
        await core.sendText(`skew harness frame ${i} / ${FRAMES}`, 1, 1, true).catch(() => {});
        await new Promise(r => setTimeout(r, CADENCE_MS));
      }
      core.note(`===== HARNESS DONE ${core.syncSnapshot} =====`);
    } finally {
      setHarnessRunning(false);
    }
  }

  // ── Lens-race harness (DEV-only) ──────────────────────────────────────────
  // Drives L and R as two INDEPENDENT flat-out loops (no cadence, gated on BLE
  // write-acceptance, not firmware ACK — see G1Core.raceSendTextToSide for why
  // ACK-gating would rig R to lose). First lens to write seq=RACE_TO wins and
  // stops the other at whatever frame it reached. Output = per-lens sustained
  // write throughput (frames/sec) + the finishing margin, i.e. the link-layer
  // L/R asymmetry. Isolates BLE link throughput from firmware ACK timing:
  //   symmetric finish → skew lives in firmware (fixed 810ms R ACK), not the link.
  //   repeatable L-win-by-margin → R's link is the slower pipe; pace R behind L.
  // WILL desync the displays while running — auto-resyncs (exitToDashboard +
  // re-push via resync) on completion. Requires the engine idle (not scrolling).
  async function runLensRace() {
    if (harnessRunning) { harnessAbort.stop = true; return; }
    if (!core) return;
    harnessAbort.stop = false;
    setHarnessRunning(true);
    const RACE_TO = 160;
    if (!verboseLogs) { core.setVerbose(true); setVerboseLogs(true); }
    core.note(`===== LENS RACE START to=${RACE_TO} (write-acceptance, no cadence) =====`);
    // NO pre-race clear. Attempts to "blank to a clean baseline" (runs 18:22–18:28)
    // all backfired: exitToDashboard is MASTER-only (cleared R lens only), and
    // clearDisplay/silent(true) SUSPENDS the display thread on both lenses (see
    // G1Core line 1907/1453) — the race then wrote 276 frames that the suspended
    // firmware swallowed (R text-ACK=0, neither lens painted). The race drives
    // live text directly; the firmware overwrites prior content per frame, so no
    // pre-clear is needed. Resync via exitToDashboard happens AFTER the run.
    const reached: { L: number; R: number } = { L: 0, R: 0 };
    let winner: 'L' | 'R' | null = null;
    // Durable per-side ACK ledger for the BLE-skip metric. The tap fires on
    // every raw text-ACK before G1Core's skew-pairing prunes its internal map,
    // so this records seqs the firmware actually ACK'd (vs seqs we SENT).
    const ackSeen: { L: Set<number>; R: Set<number> } = { L: new Set(), R: new Set() };
    core.setTextAckObserver((side, seq) => { ackSeen[side].add(seq); });
    // READY/SET: prime EACH lens into the TEXT-accept state via the enqueued,
    // ACK-awaited path (racePrimeSide) BEFORE the flat-out loops. The raw
    // per-side _send in the race skips whatever _sendBoth/sendText does to make
    // the firmware COMMIT a 0x71 screen, so L buffered+ACK'd all frames but never
    // rendered + spat exit_to_dashboard (runs ≤18:30). Frame 1 (seq=1) goes
    // through the normal path to establish commit state; the race then owns
    // seq 2..RACE_TO. racePrimeSide returns false if the ACK never lands, so we
    // surface a lens that failed to reach SET instead of racing a dark panel.
    core.note('===== LENS RACE READY: priming L & R into TEXT-accept =====');
    const [primedL, primedR] = await Promise.all([
      core.racePrimeSide('L', `race L 1/${RACE_TO}`, 1).catch(() => false),
      core.racePrimeSide('R', `race R 1/${RACE_TO}`, 1).catch(() => false),
    ]);
    reached.L = primedL ? 1 : 0;
    reached.R = primedR ? 1 : 0;
    core.note(`===== LENS RACE SET: primedL=${primedL} primedR=${primedR} =====`);
    // Each side owns its OWN seq counter so each firmware gets a clean
    // contiguous stream (not interleaved on a shared counter — see
    // raceSendTextToSide). seq wraps within the 1-byte packet field. GO: race
    // seq 2..RACE_TO flat-out via the raw path (frame 1 was the prime).
    const t0 = Date.now();
    // STEP-RAMP CHARACTERIZATION. A single shared FRAME_MS forces a tie and hides
    // each lens's real ceiling (run 18:40: both pinned to 7.6 f/s → margin=0). We
    // now ramp EACH side independently through decreasing frame intervals and
    // record where each lens's PANEL stalls — that stall index is its commit
    // ceiling. Two FAILURE MODES, distinct per lens, measured separately:
    //   • render-skip (L): intake fine (contiguous ACKs) but panel drops pages
    //     when fed past its commit ceiling → detected as a stall index.
    //   • ble-skip   (R): frames never reach the buffer → missing ACK seqs.
    // Each side steps DOWN in interval every STEP_FRAMES frames; the ramp lets
    // one run map the whole throughput curve for both lenses at once.
    const RAMP_MS = [120, 90, 60, 40, 26, 16]; // ~8→60 f/s, per-lens
    const STEP_FRAMES = Math.max(1, Math.floor(RACE_TO / RAMP_MS.length));
    const stage = (i: number) => Math.min(RAMP_MS.length - 1, Math.floor((i - 1) / STEP_FRAMES));
    const runSide = async (side: 'L' | 'R') => {
      for (let i = 2; i <= RACE_TO; i++) {
        if (harnessAbort.stop) break;
        const frameMs = RAMP_MS[stage(i)];
        const frameStart = Date.now();
        await core.raceSendTextToSide(side, `race ${side} ${i}/${RACE_TO}`, i & 0xff).catch(() => {});
        reached[side] = i;
        // Log a per-stage boundary so the log maps frame-index → target f/s.
        if ((i - 2) % STEP_FRAMES === 0) {
          core.note(`[RAMP ${side}] frame=${i} stage=${stage(i)} target=${(1000 / frameMs).toFixed(1)}f/s interval=${frameMs}ms`);
        }
        if (i === RACE_TO && !winner) winner = side;
        const elapsed = Date.now() - frameStart;
        if (elapsed < frameMs) await new Promise(r => setTimeout(r, frameMs - elapsed));
      }
    };
    try {
      await Promise.all([runSide('L'), runSide('R')]);
      const dt = Date.now() - t0;
      const rate = (n: number) => (dt > 0 ? (n / (dt / 1000)).toFixed(1) : '0');
      // Per-lens BLE-skip report: which seqs we SENT but got no ACK for. (L's
      // render-skip ceiling is read from the RAMP boundary where its panel
      // visibly froze on-device — logged for correlation, confirmed by eye.)
      const bleSkips = (side: 'L' | 'R') => {
        const miss: number[] = [];
        for (let s = 1; s <= reached[side]; s++) if (!ackSeen[side].has(s)) miss.push(s);
        return miss;
      };
      const mL = bleSkips('L'), mR = bleSkips('R');
      core.note(`===== LENS RACE SKIPS L: ble-missed=${mL.length} [${mL.slice(0, 30).join(',')}${mL.length > 30 ? '…' : ''}] =====`);
      core.note(`===== LENS RACE SKIPS R: ble-missed=${mR.length} [${mR.slice(0, 30).join(',')}${mR.length > 30 ? '…' : ''}] =====`);
      const loser = winner === 'L' ? 'R' : 'L';
      const margin = winner ? reached[winner] - reached[loser] : 0;
      core.note(
        `===== LENS RACE DONE winner=${winner ?? 'none'} margin=${margin} frames ` +
        `dt=${dt}ms L=${reached.L}f(${rate(reached.L)}f/s) R=${reached.R}f(${rate(reached.R)}f/s) =====`,
      );
      // Auto-resync: the race deliberately desynced the displays. exitToDashboard
      // drives both lenses through the lockstep _sendBoth path to a single known
      // identical state — genuinely re-syncing them rather than masking the split.
      // (settings.tsx has no engine snapshot to re-push the live frame; the HUD
      // returns to dashboard and the next real scroll/load repaints both lenses.)
      await core.exitToDashboard().catch(() => {});
    } finally {
      core.setTextAckObserver(null); // detach the BLE-skip ledger tap
      setHarnessRunning(false);
    }
  }

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
          /* ── Connected / partially connected ───────────────── */
          <>
            {(['L', 'R'] as const).map(side => {
              const lensStatus = side === 'L' ? status?.left : status?.right;
              return (
                <LensCard
                  key={side}
                  side={side}
                  connected={!!lensStatus?.connected}
                  txReady={!!lensStatus?.txReady}
                  displayIdle={!!lensStatus?.displayIdle}
                  asleep={!!lensStatus?.asleep}
                  batteryPct={(side === 'L' ? battL : battR) ?? null}
                  rssi={(side === 'L' ? rssiL : rssiR) ?? null}
                  logs={logs}
                  onDisconnect={() => disconnectSide(side)}
                  onReconnect={() => reconnectSide(side)}
                />
              );
            })}
            {/* Test HUD — sends battery+signal to both lenses at once */}
            <Pressable
              style={[s.btn, s.btnTest, !(status?.left.txReady || status?.right.txReady) && s.btnDisabled]}
              disabled={!(status?.left.txReady || status?.right.txReady)}
              onPress={() => void sendTestDisplay()}
            >
              <Text style={[s.btnText, { color: '#ccc' }]}>Test HUD</Text>
            </Pressable>
            {pairedSerial && (
              <View style={s.row}>
                <Text style={s.label}>Serial</Text>
                <Text style={s.value}>{pairedSerial}</Text>
              </View>
            )}
            <Pressable style={[s.btn, s.btnDanger]} onPress={handleDisconnect}>
              <Text style={[s.btnText, { color: '#fff' }]}>Disconnect All</Text>
            </Pressable>
            {/* Silent mode toggle. The G1 has no true power-off; BLE stays connected, display thread suspends/resumes. */}
            <Pressable
              style={[s.btn, status?.poweredOff ? s.btnTest : s.btnDanger]}
              onPress={() => void (status?.poweredOff ? core.powerOn() : core.powerOff())}
            >
              <Text style={[s.btnText, { color: '#fff' }]}>
                {status?.poweredOff ? 'Power On Glasses' : 'Power Off Glasses'}
              </Text>
            </Pressable>
          </>
        ) : isAutoConnecting ? (
          /* ── Auto-reconnect in flight — don't flash the pair UI ── */
          <View style={s.row}>
            <Text style={s.label}>Status</Text>
            <Text style={s.value}>Connecting…</Text>
          </View>
        ) : (
          /* ── Genuinely disconnected ─────────────────────────── */
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

        {/* ── Single-lens mode ───────────────────────────────── */}
        <Text style={s.section}>Single-Lens Mode</Text>

        {/* Reading-eye auto-alternation (eye-health). In mono (single-lens)
            mode, rotates which eye shows content every few minutes so one eye
            isn't loaded for a whole session. Only acts while both lenses are
            healthy; a true-solo mono (one lens dead) has nowhere to swap and is
            left alone. Default 5 min cadence. */}
        <View style={s.row}>
          <View style={s.rowText}>
            <Text style={s.label}>Alternate reading eye</Text>
            <Text style={s.sub}>In single-lens mode, rotate which eye reads every 5 min to reduce single-eye fatigue.</Text>
          </View>
          <Switch
            value={eyeAlternate}
            onValueChange={(val) => {
              setEyeAlternate(val);
              core.setEyeAlternation(val);
            }}
            trackColor={{ false: '#1a1a1a', true: '#00c47a' }}
            thumbColor="#fff"
          />
        </View>

        {/* ── Advanced ───────────────────────────────────────
            Field diagnostics (BLE scan, verbose logging). Collapsed by
            default so everyday users are not shown developer tools. */}
        <Pressable onPress={() => setShowAdvanced(v => !v)} hitSlop={8} accessibilityRole="button">
          <Text style={s.section}>Advanced {showAdvanced ? '▾' : '▸'}</Text>
        </Pressable>

        {showAdvanced && (
          <>
            <Pressable style={[s.btn, s.btnSecondary]} onPress={runDebugScan} disabled={scanning}>
              <Text style={[s.btnText, { color: '#888' }]}>
                {scanning ? 'Scanning…' : '🔍 Scan All BLE Devices'}
              </Text>
            </Pressable>

            {debugDevices.map((d, i) => (
              <Text key={i} style={s.debugText}>{d}</Text>
            ))}

            {/* Verbose BLE logging — enriches the shared log with raw RX frames
                (incl. 0x4e ACK bytes) and per-frame write/ACK timing. Off by
                default: ~55% more log volume. Flip on before capturing a skew
                session, Share, then flip off. */}
            <View style={s.row}>
              <View style={s.rowText}>
                <Text style={s.label}>Verbose BLE logging</Text>
                <Text style={s.sub}>Logs raw frames + sync timing for skew diagnosis. Turn on before a capture.</Text>
              </View>
              <Switch
                value={verboseLogs}
                onValueChange={(val) => { setVerboseLogs(val); core.setVerbose(val); }}
                trackColor={{ false: '#1a1a1a', true: '#00c47a' }}
                thumbColor="#fff"
              />
            </View>
          </>
        )}

        {/* ── Calibrate ──────────────────────────────────────────
            Tunes the scroll pace to THIS pair at its current charge. Link
            phase is automatic; render phase asks the user to watch the glasses
            and tap STOP when the on-glass counter freezes. */}
        <Text style={s.section}>Calibration</Text>
        <View style={s.calCard}>
          {calPhase === 'idle' && (
            <>
              {savedCal ? (
                <>
                  <Text style={s.calStat}>
                    Scroll pace: <Text style={s.calStatVal}>{(1000 / savedCal.paceMs).toFixed(1)} f/s</Text>
                    <Text style={s.calStatDim}>  ({savedCal.paceMs}ms/frame)</Text>
                  </Text>
                  <Text style={s.calStatDim}>
                    Link L {savedCal.linkCeilingMs.L}ms · R {savedCal.linkCeilingMs.R}ms   Render{' '}
                    {savedCal.renderCeilingMs.L != null ? `${savedCal.renderCeilingMs.L}ms` : 'skipped'}
                  </Text>
                  <Text style={s.calStatDim}>
                    Calibrated at battery L {savedCal.battAtCalib.L ?? '–'}% · R {savedCal.battAtCalib.R ?? '–'}%
                  </Text>
                  {calBattStale && (
                    <Text style={s.calWarn}>⚠ Battery has drifted — recalibrate for best sync.</Text>
                  )}
                </>
              ) : (
                <Text style={s.calStatDim}>
                  Not calibrated. Run calibration to tune the scroll pace to your glasses.
                </Text>
              )}
            </>
          )}

          {calPhase === 'link' && (
            <>
              <Text style={s.calStat}>Measuring link… <Text style={s.calStatDim}>keep still</Text></Text>
              <View style={s.calBarTrack}><View style={[s.calBarFill, { width: `${Math.round(calProgress * 100)}%` }]} /></View>
            </>
          )}

          {calPhase === 'render' && (
            <>
              <Text style={s.calStat}>👓 Watch your glasses</Text>
              <Text style={s.calStatDim}>Tap STOP the instant the numbers freeze or stutter.</Text>
              <View style={s.calBarTrack}><View style={[s.calBarFill, { width: `${Math.round(calProgress * 100)}%` }]} /></View>
            </>
          )}

          {calPhase === 'done' && calResult && (
            <>
              <Text style={s.calStat}>✓ Calibrated</Text>
              <Text style={s.calStat}>
                Scroll pace: <Text style={s.calStatVal}>{(1000 / calResult.paceMs).toFixed(1)} f/s</Text>
                <Text style={s.calStatDim}>  ({calResult.paceMs}ms/frame)</Text>
              </Text>
              <Text style={s.calStatDim}>
                Limited by {calResult.paceMs === calResult.renderCeilingMs.L ? 'display render' : 'BLE link'}.
              </Text>
            </>
          )}

          {calPhase === 'render' ? (
            <Pressable style={[s.btn, s.btnDanger]} onPress={calStopRender}>
              <Text style={[s.btnText, { color: '#ff6b6b' }]}>■ STOP — numbers froze</Text>
            </Pressable>
          ) : (
            <Pressable
              style={[s.btn, (calPhase === 'link') ? s.btnDanger : s.btnSecondary, !connected && { opacity: 0.4 }]}
              onPress={() => void runCalibration()}
              disabled={!connected || calPhase === 'link'}
            >
              <Text style={[s.btnText, calPhase !== 'done' && calPhase !== 'idle' ? {} : { color: '#fff' }]}>
                {calPhase === 'link' ? 'Measuring…'
                  : savedCal || calPhase === 'done' ? '↻ Recalibrate'
                  : '▶ Calibrate glasses'}
              </Text>
            </Pressable>
          )}
        </View>

        {/* Skew harness — DEV only. Drives the HUD at a fixed cadence from a
            clean start and fires a mid-run resync, so the SKEW telemetry plots
            a repeatable latency curve. Reads out inline in the Raw Logs below. */}
        {__DEV__ && SHOW_DEV_HARNESS && (
          <Pressable
            style={[s.btn, harnessRunning ? s.btnDanger : s.btnSecondary, !connected && { opacity: 0.4 }]}
            onPress={() => void runSkewHarness()}
            disabled={!connected}
          >
            <Text style={[s.btnText, { color: '#ffffff' }]}>
              {harnessRunning ? '■ Stop skew harness' : '▶ Run skew harness (160 frames)'}
            </Text>
          </Pressable>
        )}

        {/* Lens race — DEV only. Drives L and R as two independent flat-out
            loops gated on BLE write-acceptance; first to seq=160 wins and stops
            the other. Reads out per-lens throughput + margin inline below, to
            isolate link-layer L/R asymmetry from firmware ACK timing. Desyncs
            the displays during the run, then auto-resyncs to dashboard. */}
        {__DEV__ && SHOW_DEV_HARNESS && (
          <Pressable
            style={[s.btn, harnessRunning ? s.btnDanger : s.btnSecondary, !connected && { opacity: 0.4 }]}
            onPress={() => void runLensRace()}
            disabled={!connected}
          >
            <Text style={[s.btnText, { color: '#ffffff' }]}>
              {harnessRunning ? '■ Stop' : '▶ Run lens race (L vs R, 160)'}
            </Text>
          </Pressable>
        )}

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

  btn:         { backgroundColor: '#fff', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  btnSecondary:{ backgroundColor: '#1a1a1a' },
  btnDanger:   { backgroundColor: '#2a1a1a' },
  btnTest:     { backgroundColor: '#1a1f2a' },
  btnDisabled: { opacity: 0.35 },
  btnText:     { fontSize: 15, fontWeight: '600', color: '#000' },
  calCard:     { backgroundColor: '#111', borderRadius: 12, padding: 16, gap: 6 },
  calStat:     { color: '#eee', fontSize: 14, fontWeight: '600' },
  calStatVal:  { color: '#00c47a', fontWeight: '700' },
  calStatDim:  { color: '#777', fontSize: 12, fontWeight: '400' },
  calWarn:     { color: '#ffb020', fontSize: 12, fontWeight: '600', marginTop: 2 },
  calBarTrack: { height: 6, borderRadius: 3, backgroundColor: '#1f1f1f', marginTop: 8, overflow: 'hidden' },
  calBarFill:  { height: 6, borderRadius: 3, backgroundColor: '#00c47a' },
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
