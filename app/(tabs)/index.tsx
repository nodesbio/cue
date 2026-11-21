/**
 * teleprompter.tsx — Teleprompter mode screen.
 *
 * Wires TeleprompterEngine to the G1 glasses and shows a phone-side
 * preview of the rolling window with full playback controls.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Animated,
  AppState,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Slider from '@react-native-community/slider';
import { useG1, useG1Event } from '@/lib/g1/G1Context';
import { loadCalibration } from '@/lib/g1/calibrationStore';
import {
  TeleprompterEngine,
  EngineSnapshot,
  SPEED_SLOW,
  SPEED_NORMAL,
  SPEED_FAST,
  SPEED_TURBO,
  SPEED_STEP,
} from '@/lib/teleprompter/TeleprompterEngine';
import { getEngine } from '@/lib/teleprompter/engine';
import { remainingSeconds, formatClock } from '@/lib/teleprompter/readTime';
import { getScript, setMarker, clearMarker, type ResumeMarker } from '@/lib/scripts/ScriptStore';

// ── Helpers ────────────────────────────────────────────────────────────────

function speedLabel(s: number): string {
  if (s >= SPEED_SLOW)   return 'Slow';
  if (s >= SPEED_NORMAL) return 'Normal';
  if (s >= SPEED_FAST)   return 'Fast';
  return 'Turbo';
}

// ── Component ──────────────────────────────────────────────────────────────

export default function TeleprompterScreen() {
  const { core, status, isConnected: connected, isPartiallyConnected: partiallyConnected, pairedSerial } = useG1();
  const { width: screenWidth } = useWindowDimensions();
  const screenWidthRef = useRef(screenWidth);
  useEffect(() => { screenWidthRef.current = screenWidth; }, [screenWidth]);

  // Engine lives in a ref — stable across renders, no remounting
  const engineRef = useRef<TeleprompterEngine | null>(null);

  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [loop, setLoop] = useState(false);
  const [gesturesEnabled, setGesturesEnabled] = useState(false);
  const [gesturesSwapped, setGesturesSwapped] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  // Resume marker for the currently loaded script. `marker` is the stored
  // bookmark (null = none set on this script, or ad-hoc text with no id).
  // `resumeDismissed` hides the resume chip once the operator acts on it so it
  // doesn't nag — re-shown only when a different script loads.
  const [marker, setMarkerState] = useState<ResumeMarker | null>(null);
  const [resumeDismissed, setResumeDismissed] = useState(false);
  // 0 = split view (HUD + controls), 1 = HUD-only fullscreen
  const [hudPage, setHudPage] = useState(0);
  // true while the panel is fullscreen OR animating toward fullscreen
  // (leads hudPage so the flex:1 style applies before the panel lands)
  const [hudFullscreen, setHudFullscreen] = useState(false);
  const hudSlide = useRef(new Animated.Value(0)).current;
  const gesturesEnabledRef = useRef(false);
  const gesturesSwappedRef = useRef(false);

  const snapRef = useRef<EngineSnapshot | null>(null);
  const connectedRef = useRef(false);
  const manualPauseRef = useRef(false);


  // Keep refs in sync
  useEffect(() => { gesturesEnabledRef.current = gesturesEnabled; }, [gesturesEnabled]);
  useEffect(() => { gesturesSwappedRef.current = gesturesSwapped; }, [gesturesSwapped]);
  useEffect(() => { snapRef.current = snap; }, [snap]);
  useEffect(() => { connectedRef.current = connected; }, [connected]);

  // ── Reconnect resync ──────────────────────────────────────────────────
  // While BLE is down the teleprompter keeps scrolling; every onFrame is
  // silently dropped (connectedRef=false) and the glasses stay frozen on
  // whatever line each lens last rendered before the drop — which can differ
  // between L and R, producing the lens desync (confirmed 2026-11: healthy
  // ACKs, divergent displays, "onFrame DROPPED" during the outage).
  //
  // `connected` (= isConnected = left.txReady && right.txReady) only goes
  // true once BOTH lenses have re-handshaked, so re-pushing here cannot be
  // dropped by a txReady=false guard. Force both lenses back onto the
  // engine's current frame — same re-push the display-takeover handler uses
  // (snapRef.current → sendText). This is the Zoracon-correct fix: it handles
  // the missing precondition (frames lost during the outage) instead of
  // silently tolerating it. Fires only on the false→true transition via the
  // prevConnectedRef edge-detect, so it won't re-fire on unrelated renders.
  const prevConnectedRef = useRef(false);
  useEffect(() => {
    if (connected && !prevConnectedRef.current) {
      const s = snapRef.current;
      if (s && !core.status.poweredOff) {
        core.note(`[index] reconnect resync → re-push line=${s.topIndex + 1}/${s.totalLines}`);
        // Tagged 'teleprompter' so a live sports HUD (which holds the display
        // owner) is NOT stomped by a background reconnect re-push. If nothing
        // holds the lens, this passes exactly as before.
        void core.sendText(s.frame, s.topIndex + 1, s.totalLines, s.topIndex + 1 >= s.totalLines, undefined, 'teleprompter');
      }
    }
    prevConnectedRef.current = connected;
  }, [connected, core]);

  // ── Foreground resync (lock-screen recovery) ─────────────────────────────
  // While the phone is locked/backgrounded iOS keeps the BLE connection up but
  // the glasses stop ACKing writes, so frames sent during the lock are lost and
  // the HUD freezes on the last line it rendered before lock. On return to the
  // foreground nothing re-pushed the current frame, so the HUD stayed frozen
  // FOREVER — even after unlock (field report 2026-11-16: locked at ~line 38,
  // HUD stuck at 41/381, never recovered across a 29-min lock + unlock).
  //
  // The AppState handler in G1Core was telemetry-only by design; recovery must
  // live here where we hold the engine snapshot. This is the same Zoracon-
  // correct re-push the reconnect path uses — it heals the missing precondition
  // (frames dropped while backgrounded) instead of tolerating a frozen HUD.
  // Edge-detect active-ness so it fires once on background/inactive → active,
  // not on every render. It does NOT try to keep scrolling while locked (iOS
  // won't deliver the writes); it guarantees the HUD catches up the instant the
  // operator unlocks.
  const prevActiveRef = useRef(true);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const nowActive = next === 'active';
      if (nowActive && !prevActiveRef.current) {
        const s = snapRef.current;
        if (s && connected && !core.status.poweredOff) {
          core.note(`[index] foreground resync → re-push line=${s.topIndex + 1}/${s.totalLines}`);
          // Tagged 'teleprompter' — defers to a live sports HUD on foreground.
          void core.sendText(s.frame, s.topIndex + 1, s.totalLines, s.topIndex + 1 >= s.totalLines, undefined, 'teleprompter');
        }
      }
      prevActiveRef.current = nowActive;
    });
    return () => sub.remove();
  }, [connected, core]);

  // ── Calibrated scroll pace ──────────────────────────────────────────────
  // Consume the per-pair calibration (Settings → Calibrate). The stored paceMs
  // is the slowest safe inter-frame interval across both lenses' failure layers
  // (L render ~8 f/s, R link ~16 f/s); G1Core enforces it as a minimum gap
  // between TEXT frames so bursts (loop restart, rapid next/prev, rewind,
  // reconnect re-push) can't outrun the slower lens and reopen the skew.
  // Re-applied on each connect since the ceiling drifts with battery. No stored
  // calibration ⇒ pace 0 (unthrottled, prior behaviour) — never worse than before.
  useEffect(() => {
    if (!connected || !pairedSerial) return;
    void loadCalibration(pairedSerial).then(cal => {
      core.setScrollPaceMs(cal?.paceMs ?? 0);
    });
  }, [connected, pairedSerial, core]);

  // ── Auto skew corrector ───────────────────────────────────────────────
  // G1Core detects sustained L/R ack-skew divergence (iOS background radio
  // throttling ratchets the lenses apart and they never recover on their own —
  // field log cue-logs-2026-11-15T19-16-51). On detection it calls back here
  // to re-anchor. Unlike the PLAY-BUTTON path this does NOT pause: the operator
  // didn't ask to stop, so we re-push the engine's CURRENT frame to both lenses
  // in place, snapping them back together while scrolling continues. The
  // re-push rides G1Core's pace gate, so it can't outrun the slow lens.
  useEffect(() => {
    core.setSkewResyncHandler((seq) => {
      const engine = engineRef.current;
      if (!engine || core.status.poweredOff) return;
      const s = engine.getSnapshot();
      core.note(`[index] AUTO-RESYNC (skew) trip@seq=${seq} → re-push line=${s.topIndex + 1}/${s.totalLines} ${core.syncSnapshot}`);
      void core.sendText(s.frame, s.topIndex + 1, s.totalLines, s.topIndex + 1 >= s.totalLines);
    });
    return () => core.setSkewResyncHandler(null);
  }, [core]);

  // ── Reading-eye auto-alternation re-push (eye-health) ────────────────────
  // When the core's alternation timer flips the mono reading eye, re-push the
  // current frame so the NEW reading eye lights immediately (the core holds the
  // decision, not the frame bytes — same contract as the skew-resync handler).
  useEffect(() => {
    core.setReadingEyeSwapHandler((side) => {
      const engine = engineRef.current;
      if (!engine || core.status.poweredOff) return;
      // Update the live-lens battery BEFORE snapshotting: the status bar builds
      // from monoBat, and the battery effect only runs on status ticks — so on
      // the mono flip (and each alternation) monoBat is stale until we set it
      // here. Without this the re-pushed frame still shows both lenses' batteries
      // (field: HUD read 'L74% R79% [S]' after L went dark). side===null ⇒ back
      // to stereo (shouldn't happen mid-session, but keeps the contract honest).
      engine.setBattery(
        core.status.left.batteryPct ?? null,
        core.status.right.batteryPct ?? null,
        side,
      );
      const s = engine.getSnapshot();
      core.note(`[index] MONO/EYE flip → reader=${side}, re-push line=${s.topIndex + 1}/${s.totalLines}`);
      void core.sendText(s.frame, s.topIndex + 1, s.totalLines, s.topIndex + 1 >= s.totalLines);
    });
    return () => core.setReadingEyeSwapHandler(null);
  }, [core]);

  // Load gesture preferences (re-read on focus so settings changes apply immediately)
  useEffect(() => {
    AsyncStorage.multiGet(['gesture_nav_enabled', 'gesture_nav_swapped']).then(pairs => {
      if (pairs[0][1] === 'true') setGesturesEnabled(true);
      if (pairs[1][1] === 'true') setGesturesSwapped(true);
    }).catch(() => {});
  }, []);

  // Gesture model (runs regardless of gesturesEnabled so nod always works):
  //   head_down              → start rewind immediately
  //   head_up (after down<NOD_WINDOW_MS) → stop rewind + toggle pause
  //   head_up (no prior down, or down timed out) → play / stopRewind / advance
  //
  // Media remote (works regardless of gesturesEnabled):
  //   single_tap → next line   (G1 touchbar or remote)
  //   double_tap → prev line   (SmartRemote ◀◀ only — the G1 never emits a
  //                             double-tap; F5 00 is 'exit_to_dashboard', a
  //                             firmware screen-rejection signal, and is
  //                             deliberately NOT mapped to any gesture)
  //
  // Dedup: hardware fires each event 2-3x in a burst; suppress repeats within DEDUP_MS.
  const NOD_WINDOW_MS = 600;
  const DEDUP_MS = 300;

  const dedupRef   = useRef<{ name: string; until: number }>({ name: '', until: 0 });
  const handlePlayButtonRef = useRef<() => void>(() => {});

  // ── Double-press-play → force resync ──────────────────────────────────
  // ── The play button is an EXCEPTION signal, not a navigation control ──
  // First principle: when the app is working, NO button is pressed. The
  // operator only presses because they want to STOP, or because L/R have
  // drifted (the rare R-ACK MISS path in G1Core._sendBoth leaves the lenses on
  // different lines with no signal we can auto-detect). Both intents collapse
  // to one action:
  //
  //   playing → resync(): pause-and-hold AND re-push the current frame to both
  //             lenses, atomically. Stopping and re-aligning are the same act —
  //             a press while playing can't mean anything else.
  //   paused  → resume play.
  //
  // This deletes the old double-press/RESYNC_WINDOW apparatus entirely: there
  // is no longer a timing window to disambiguate "pause" from "resync", so
  // there is nothing to mis-size. Resync is now free (it rides the pause the
  // operator was already making) and zero-latency. "Resync without stopping"
  // is intentionally gone — pressing the button already accepts the stop;
  // resuming is a second, untimed press.
  const handlePlayButton = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || core.status.poweredOff) return;
    const playing = engine.getSnapshot().state === 'playing';
    if (!playing) {
      manualPauseRef.current = false;
      engine.play();
      return;
    }
    // Playing → pause-and-resync. resync() stops the scroll timer AND flags
    // justSynced so the rebuilt frame carries the [S] glyph; we then re-push
    // that frame to BOTH lenses so any R-ACK MISS drift is corrected.
    manualPauseRef.current = true;
    engine.resync();
    const s = engine.getSnapshot();
    core.note(`[index] PLAY-BUTTON pause+resync → re-push line=${s.topIndex + 1}/${s.totalLines} ${core.syncSnapshot}`);
    void core.sendText(s.frame, s.topIndex + 1, s.totalLines, s.topIndex + 1 >= s.totalLines);
  }, [core]);

  useG1Event((event) => {
    // G1 glasses emit from both arms — only handle the right side to avoid
    // doubles. SmartRemote events carry no side and pass through.
    if (event.side !== undefined && event.side !== 'R') return;

    const isUp      = event.name === 'head_up';
    const isDown    = event.name === 'head_down';
    const isTap     = event.name === 'single_tap';
    const isDblTap  = event.name === 'double_tap';
    const isTriTap  = event.name === 'triple_tap';

    // Display takeover events — Even AI overlay or dashboard stole the HUD.
    // On any display-takeover event (dashboard open OR close, Even AI start),
    // re-push the current frame immediately. G1Core's _sendSilent is enqueued
    // first, so the content lands behind it in _sendQueue — no race, and the
    // dashboard never gets a chance to settle visibly.
    if (event.name === 'dashboard_open' || event.name === 'dashboard_close' || event.name === 'ai_start') {
      const s = snapRef.current;
      if (s && !core.status.poweredOff) {
        void core.sendText(s.frame, s.topIndex + 1, s.totalLines, s.topIndex + 1 >= s.totalLines);
      }
      return;
    }

    if (!isUp && !isDown && !isTap && !isDblTap && !isTriTap) return;

    // ── Dedup ────────────────────────────────────────────────────────────
    // triple_tap is EXCLUDED: it's already de-bursted at the source by
    // SmartRemoteManager.PRESS_DEDUP_MS (250ms, tuned below human double-press
    // cadence so deliberate rapid presses pass through). Re-deduping here with
    // SmartRemoteManager.PRESS_DEDUP_MS (250ms) is the primary echo guard; this
    // index-level window is a harmless second line. With the double-press
    // apparatus gone, triple_tap is now a single idempotent action (pause+resync
    // or resume) so it can be deduped like every other event — there is no
    // second press to protect.
    const now = Date.now();
    if (event.name === dedupRef.current.name && now < dedupRef.current.until) return;
    dedupRef.current = { name: event.name, until: now + DEDUP_MS };

    // ── Media remote ─────────────────────────────────────────────────────
    // Tap events work independently of gesturesEnabled — the remote is always live.
    // single_tap = SmartRemote Next (>>). Dual-purpose, gated on mono state so
    // the operator's thumb never leaves one key:
    //   • FIRST press (still stereo) → emergencyMono(): kill the doubled echo and
    //     session-latch stereo OFF. The on-stage safety action.
    //   • SUBSEQUENT presses (already mono) → next(): advance one line. Once the
    //     echo is gone the emergency can't re-fire (idempotent + latched), so the
    //     key is free to do its natural Next job. One thumb, save-then-drive.
    // Reassignable later via the Smart Remote Button Config pane (PR-C).
    if (isTap) {
      if (core.isMono) {
        engineRef.current?.next();
      } else {
        // Drop to mono. First STOP THE SCROLL: emergency-mono is a freeze-the-
        // world safety action — the HUD blanks a lens and holds the current
        // frame, so the app's G1 DISPLAY preview must freeze in lockstep. Without
        // this pause the scroll timer keeps firing onFrame, the preview races on
        // to the end while the HUD stays frozen, and app/HUD desync (field report
        // 2026-11-16: HUD stuck at 4/17, preview scrolled to 17/17).
        //
        // Reuse the PLAY-BUTTON pause idiom (manualPause + resync) so there's one
        // way to stop the deck. Then re-push the resync snapshot: emergencyMono()
        // only sets the decision; the lens drive (blank laggard + drive kept lens)
        // happens when a TEXT frame flows through _sendBoth's mono branch, honoring
        // the firmware R-first ESB sync (a hand-rolled lone blank left both on).
        manualPauseRef.current = true;
        engineRef.current?.resync();
        core
          .emergencyMono()
          .then(() => {
            const engine = engineRef.current;
            if (!engine) return;
            const s = engine.getSnapshot();
            return core.sendText(s.frame, s.topIndex + 1, s.totalLines, s.topIndex + 1 >= s.totalLines);
          })
          .catch((e) => console.warn('[G1] emergencyMono failed', e));
      }
      return;
    }
    // double_tap = SmartRemote Prev (<<) = rewind one line. Operator uses this.
    if (isDblTap) {
      engineRef.current?.prev();
      return;
    }
    // triple_tap = SmartRemote play/pause button. A single press is the whole
    // interface: playing → pause-and-resync, paused → resume. See
    // handlePlayButton for the first-principle rationale.
    if (isTriTap) {
      handlePlayButtonRef.current();
      return;
    }

    // ── Head gestures ─────────────────────────────────────────────────────
    // Guard first — setting is OFF means neither head_down nor head_up acts.
    if (!gesturesEnabledRef.current) return;

    if (isDown) {
      if (manualPauseRef.current) return; // UI pause overrides gestures
      if (!engineRef.current?.isRewinding()) engineRef.current?.startRewind();
      return;
    }

    // ── head_up → advance one line (or resume if playing) ────────────────
    engineRef.current?.stopRewind();
    if (manualPauseRef.current) return;
    // Only resume play if already playing — never auto-start from idle/paused
    if (engineRef.current?.getSnapshot().state === 'playing') return;
    engineRef.current?.next();
  });

  // Initialise engine once per module lifetime.
  // StrictMode double-mounts reuse the same _engine; destroy() is NOT called on
  // unmount so the singleton survives the StrictMode cleanup/remount cycle.
  // Fast Refresh tears down the old module (and its _engine) via module.hot.dispose
  // before this runs, so there is never more than one live engine at a time.
  useEffect(() => {
    const _engine = getEngine();
    engineRef.current = _engine;
    // DIAGNOSTIC: fires whenever the index tab mounts and re-wires callbacks.
    // If this logs right before a frame finally appears post-switch, the hang
    // is "index tab was unmounted; frame only sent on remount".
    core.note('[index] setCallbacks re-wired (index tab mounted)');

    // Re-wire every mount so closures (core, setSnap, connectedRef) are always
    // from the live component instance, not a stale StrictMode/Fast-Refresh copy.
    _engine.setCallbacks({
      onFrame: (frame, curLine, totalLines) => {
        // DIAGNOSTIC (2026-11-05): prove whether the first frame after a
        // cross-tab loadScript reaches sendText or is dropped here. If the
        // hang is the stale-closure/guard theory, we'll see "onFrame DROPPED"
        // at switch time; if it reaches sendText, the hang is elsewhere.
        if (connectedRef.current) {
          core.note(`[index] onFrame → sendText line=${curLine}/${totalLines}`);
          // _enqueue inside sendText handles errors and serialisation;
          // void is intentional — onFrame is a sync callback.
          void core.sendText(frame, curLine, totalLines, curLine >= totalLines);
        } else {
          core.note(`[index] onFrame DROPPED — connectedRef=false line=${curLine}/${totalLines} (stale closure or disconnected)`);
        }
      },
      onStateChange: (s) => {
        setSnap({ ...s });
      },
    });

    setSnap(_engine.getSnapshot());
    // No cleanup: singleton must outlive StrictMode unmount.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-send on reconnect (glasses may have restarted) and on Power On —
  // silent(false) resumes the display thread but shows nothing until we push.
  const poweredOff = status?.poweredOff ?? false;
  useEffect(() => {
    if (!connected || poweredOff) return;
    const s = snapRef.current;
    console.log(`[index] re-send effect connected=${connected} poweredOff=${poweredOff} hasSnap=${!!s}`);
    if (s) {
      // Power-On / reconnect re-push — tagged so a live sports HUD wins.
      void core.sendText(s.frame, s.topIndex + 1, s.totalLines, s.topIndex + 1 >= s.totalLines, undefined, 'teleprompter');
    }
  }, [connected, poweredOff]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep battery levels in the engine status bar. In mono fallback we pass the
  // live lens so the bar shows ONLY its battery (which also signals which lens
  // is active). `core.isMono` is read live; `status` ticks keep this in sync on
  // the flip frame since monoSide isn't part of the status snapshot.
  useEffect(() => {
    const mono = core?.isMono ? core.monoSide : null;
    engineRef.current?.setBattery(
      status?.left.batteryPct ?? null,
      status?.right.batteryPct ?? null,
      mono,
    );
  }, [status?.left.batteryPct, status?.right.batteryPct, status, core]);

  handlePlayButtonRef.current = handlePlayButton;
  const handleNext   = useCallback(() => engineRef.current?.next(),   []);
  const handlePrev   = useCallback(() => engineRef.current?.prev(),   []);

  // Slider value = secondsPerLine (higher = slower). Min=SPEED_TURBO, Max=SPEED_SLOW.
  const handleSpeedChange = useCallback((value: number) => {
    engineRef.current?.setSpeed(value);
  }, []);

  const handleLoop = useCallback(() => {
    const next = !loop;
    setLoop(next);
    engineRef.current?.setLoop(next);
  }, [loop]);

  // ── Resume markers ────────────────────────────────────────────────────────
  // Re-fetch the stored marker whenever the loaded script changes. The engine
  // owns the active id (set atomically with the text in loadScript), so this
  // can't point at the wrong script. A load clears the dismissed flag so a new
  // script's resume chip shows even if the previous one was dismissed.
  const activeId = engineRef.current?.activeScriptId() ?? null;
  const loadedTotal = snap?.totalLines ?? 0;
  useEffect(() => {
    let cancelled = false;
    setResumeDismissed(false);
    if (!activeId) { setMarkerState(null); return; }
    getScript(activeId).then(e => {
      if (!cancelled) setMarkerState(e?.marker ?? null);
    });
    return () => { cancelled = true; };
    // loadedTotal changes on every loadScript (wrap produces a new count),
    // giving us a reliable "a script was (re)loaded" signal alongside id.
  }, [activeId, loadedTotal]);

  const handleSetMarker = useCallback(async () => {
    const engine = engineRef.current;
    const id = engine?.activeScriptId();
    if (!engine || !id) return;
    const entry = await setMarker(id, engine.currentOffset(), engine.getSnapshot().topIndex);
    setMarkerState(entry?.marker ?? null);
    setResumeDismissed(true); // just set it — don't immediately offer to resume to it
  }, []);

  const handleClearMarker = useCallback(async () => {
    const id = engineRef.current?.activeScriptId();
    if (!id) return;
    await clearMarker(id);
    setMarkerState(null);
  }, []);

  const handleResume = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !marker) return;
    engine.jumpToOffset(marker.charOffset);
    setResumeDismissed(true);
  }, [marker]);

  // ── Reconnect handler ─────────────────────────────────────────────────────
  const handleReconnect = useCallback(async () => {
    setReconnecting(true);
    try { await core.reconnectDropped(); } catch {}
    // Show spinner for at least 1 s so the tap feels responsive
    setTimeout(() => setReconnecting(false), 1000);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── HUD combined gesture handler ─────────────────────────────────────────
  // One PanResponder handles both axes to avoid responder contention:
  //   · Horizontal (|dx| > |dy|, |dx| > 50)  → page switch (fullscreen ↔ split)
  //   · Vertical   (|dy| > |dx|)              → scrub (18 px per line step)
  const SCRUB_STEP_PX   = 18;
  const HUD_SWIPE_THRESHOLD = 50;
  const scrubAccumRef = useRef(0);
  // true while the gesture is classified as horizontal
  const isHorizRef = useRef<boolean | null>(null);

  const scrubPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  () => true,
      onPanResponderGrant: () => {
        scrubAccumRef.current = 0;
        isHorizRef.current = null;
      },
      onPanResponderMove: (_, gs) => {
        // Classify on first meaningful movement
        if (isHorizRef.current === null && (Math.abs(gs.dx) > 6 || Math.abs(gs.dy) > 6)) {
          isHorizRef.current = Math.abs(gs.dx) > Math.abs(gs.dy);
        }

        if (isHorizRef.current) {
          hudSlide.setValue(gs.dx);
          return;
        }

        // Vertical scrub
        const steps = Math.trunc(-gs.dy / SCRUB_STEP_PX);
        const delta = steps - scrubAccumRef.current;
        if (delta === 0) return;
        scrubAccumRef.current = steps;
        if (delta > 0) {
          for (let i = 0; i < delta; i++) engineRef.current?.next();
        } else {
          for (let i = 0; i < -delta; i++) engineRef.current?.prev();
        }
      },
      onPanResponderRelease: (_, gs) => {
        scrubAccumRef.current = 0;
        if (isHorizRef.current) {
          if (gs.dx < -HUD_SWIPE_THRESHOLD) {
            // Swipe left → go to page 1 (fullscreen)
            // Apply fullscreen layout BEFORE animating so flex:1 is active during slide
            setHudFullscreen(true);
            Animated.timing(hudSlide, {
              toValue: -screenWidthRef.current,
              duration: 220,
              useNativeDriver: true,
            }).start(() => {
              hudSlide.setValue(0);
              setHudPage(1);
            });
          } else if (gs.dx > HUD_SWIPE_THRESHOLD) {
            // Swipe right → go to page 0 (split)
            // Keep fullscreen layout until after panel slides away
            Animated.timing(hudSlide, {
              toValue: screenWidthRef.current,
              duration: 220,
              useNativeDriver: true,
            }).start(() => {
              hudSlide.setValue(0);
              setHudPage(0);
              setHudFullscreen(false);
            });
          } else {
            // Snap back (didn't pass threshold)
            Animated.spring(hudSlide, { toValue: 0, useNativeDriver: true }).start();
          }
        }
        isHorizRef.current = null;
      },
    }),
  ).current;

  if (!snap) return null;

  const playing = snap.state === 'playing';
  const ended   = snap.state === 'ended';
  const hasScript = snap.totalLines > 0;
  // null in manual mode (no timer); hidden once the script has ended.
  const timeLeft = ended ? null : remainingSeconds(snap.topIndex, snap.totalLines, snap.secondsPerLine);
  // Marker UI is only meaningful for a saved script (has an id to persist to).
  const canMark = hasScript && !!engineRef.current?.activeScriptId();
  // Line the marker currently maps to under THIS script's wrap — re-derived,
  // never trusted from the stale cache (survives edits / font changes).
  const markerLine = marker ? (engineRef.current?.lineForOffset(marker.charOffset) ?? 0) : 0;
  const atMarker = marker ? snap.topIndex === markerLine : false;
  const showResume = canMark && !!marker && !resumeDismissed && !atMarker;

  // Render the current G1 frame as lines
  const hudLines = (engineRef.current?.getFrameAt(snap.topIndex) ?? '').split('\n');

  return (
    <SafeAreaView style={s.root}>

        {/* ── Header — hidden in fullscreen mode ─────────────────────── */}
        {!hudFullscreen && (
        <View style={s.headerBlock}>
          <Text style={s.title}>Teleprompter</Text>
          <Text style={[s.subtitle, connected ? { color: '#4ade80' } : {}]}>
            {connected ? '● Connected' : '○ Not connected — controls still work'}
          </Text>
        </View>
        )}

        {/* ── Half-connected reconnect banner ────────────────────────── */}
        {partiallyConnected && !hudFullscreen && (
          <View style={s.reconnectBanner}>
            <Text style={s.reconnectText}>◑ One lens dropped</Text>
            <Pressable
              style={[s.reconnectBtn, reconnecting && s.ctrlDisabled]}
              onPress={handleReconnect}
              disabled={reconnecting}
            >
              <Text style={s.reconnectBtnText}>
                {reconnecting ? 'Reconnecting…' : 'Reconnect'}
              </Text>
            </Pressable>
          </View>
        )}

        {/* ── G1 Display panel — swipe left/right to change view ─────── */}
        {/* Combines horizontal swipe (page change) + vertical scrub      */}
        <Animated.View
          style={[s.hudOuter, hudFullscreen && s.hudOuterFullscreen,
            { transform: [{ translateX: hudSlide }] }]}
          {...scrubPan.panHandlers}
        >
          <View style={s.hudLabelRow}>
            <Text style={s.hudLabel}>G1 DISPLAY</Text>
            <Text style={s.hudPageDots}>
              {hudFullscreen ? '○ ●' : '● ○'}
            </Text>
          </View>
          {hudLines.map((line, i) => (
            <Text
              key={i}
              style={[
                s.hudLine,
                i === 0 && s.hudStatus,
                i === 1 && s.hudActive,
                hudFullscreen && i > 0 && s.hudLineFullscreen,
              ]}
              numberOfLines={1}
            >
              {line || ' '}
            </Text>
          ))}
          <Text style={s.hudHint}>
            {hudFullscreen ? '↕ scrub  ·  → swipe right to exit' : '↕ scrub  ·  ← swipe left for fullscreen'}
          </Text>
        </Animated.View>

        {!hudFullscreen && <ScrollView style={s.scrollView} contentContainerStyle={s.scroll}>

          {/* ── Progress ─────────────────────────────────────────────── */}
          {hasScript && (
            <View style={s.progressRow}>
              <View style={s.progressHeader}>
                <Text style={s.progressText}>
                  Line {snap.topIndex + 1} / {snap.totalLines}
                </Text>
                {timeLeft !== null && (
                  <Text style={s.progressTime}>{formatClock(timeLeft)} left</Text>
                )}
              </View>
              <View style={s.progressBar}>
                <View
                  style={[
                    s.progressFill,
                    { width: `${((snap.topIndex + 1) / snap.totalLines) * 100}%` },
                  ]}
                />
              </View>
            </View>
          )}

          {/* ── Resume chip — tap to jump to the stored marker ───────── */}
          {showResume && (
            <View style={s.resumeRow}>
              <Pressable style={s.resumeChip} onPress={handleResume}>
                <Text style={s.resumeIcon}>◆</Text>
                <Text style={s.resumeText} numberOfLines={1}>
                  Resume ▸ line {markerLine + 1}
                  {marker?.anchor ? `  “${marker.anchor}”` : ''}
                </Text>
              </Pressable>
              <Pressable
                style={s.resumeDismiss}
                hitSlop={10}
                onPress={() => setResumeDismissed(true)}
              >
                <Text style={s.resumeDismissText}>✕</Text>
              </Pressable>
            </View>
          )}

          {/* ── Playback Controls ─────────────────────────────────────── */}
          <View style={s.controlRow}>
            <Pressable style={[s.ctrlBtn, s.ctrlSecondary]} onPress={handlePrev} disabled={!hasScript}>
              <Text style={s.ctrlIcon}>←</Text>
            </Pressable>

            <Pressable
              style={[s.ctrlBtn, s.ctrlPrimary, !hasScript && s.ctrlDisabled]}
              onPress={handlePlayButton}
              disabled={!hasScript}
            >
              <Text style={s.ctrlPlayIcon}>{playing ? '⏸' : '▶'}</Text>
            </Pressable>

            <Pressable style={[s.ctrlBtn, s.ctrlSecondary]} onPress={handleNext} disabled={!hasScript}>
              <Text style={s.ctrlIcon}>→</Text>
            </Pressable>
          </View>

          {ended && (
            <Pressable style={s.restartBtn} onPress={() => engineRef.current?.restart()}>
              <Text style={s.restartText}>↺  Restart from top</Text>
            </Pressable>
          )}

          {/* ── Resume marker — set here / clear ──────────────────────── */}
          {canMark && (
            <View style={s.markerRow}>
              <Pressable
                style={[s.markerBtn, atMarker && s.markerBtnActive]}
                onPress={handleSetMarker}
              >
                <Text style={[s.markerBtnText, atMarker && s.markerBtnTextActive]}>
                  ◆  {atMarker ? 'Marked this line' : 'Set marker here'}
                </Text>
              </Pressable>
              {marker && (
                <Pressable style={s.markerClearBtn} hitSlop={8} onPress={handleClearMarker}>
                  <Text style={s.markerClearText}>Clear</Text>
                </Pressable>
              )}
            </View>
          )}

          {/* ── Speed Slider ─────────────────────────────────────────── */}
          <View style={s.speedCard}>
            <View style={s.speedHeader}>
              <Text style={s.speedLabel}>Speed</Text>
              <Text style={s.speedValue}>{speedLabel(snap.secondsPerLine)}</Text>
            </View>
            <Slider
              style={s.speedSlider}
              minimumValue={-SPEED_SLOW}
              maximumValue={-SPEED_TURBO}
              value={-snap.secondsPerLine}
              step={SPEED_STEP}
              onValueChange={(v) => handleSpeedChange(-v)}
              minimumTrackTintColor="#333"
              maximumTrackTintColor="#fff"
              thumbTintColor="#fff"
            />
            <View style={s.speedEndLabels}>
              <Text style={s.speedEndLabel}>Slow</Text>
              <Text style={s.speedEndLabel}>Fast</Text>
            </View>
          </View>

          {/* ── Loop Toggle ──────────────────────────────────────────── */}
          <Pressable style={s.loopRow} onPress={handleLoop}>
            <View style={[s.toggle, loop && s.toggleOn]}>
              <View style={[s.toggleThumb, loop && s.toggleThumbOn]} />
            </View>
            <Text style={s.loopLabel}>Repeat automatically</Text>
          </Pressable>

        </ScrollView>}
    </SafeAreaView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:             { flex: 1, backgroundColor: '#0a0a0a', overflow: 'hidden' },
  headerBlock:      { paddingHorizontal: 20 },
  scrollView:       { flex: 1 },
  scroll:           { paddingHorizontal: 20, paddingBottom: 40 },

  title:            { color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 20 },
  subtitle:         { color: '#555', fontSize: 13, marginTop: 4, marginBottom: 16 },

  // ── Reconnect banner ──────────────────────────────────────────────────────
  reconnectBanner:  { marginHorizontal: 20, marginBottom: 8, padding: 12,
                       backgroundColor: '#1a1200', borderRadius: 12,
                       borderWidth: 1, borderColor: '#3a2c00',
                       flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  reconnectText:    { color: '#f59e0b', fontSize: 13, fontWeight: '600' },
  reconnectBtn:     { backgroundColor: '#f59e0b', borderRadius: 8,
                       paddingVertical: 6, paddingHorizontal: 14 },
  reconnectBtnText: { color: '#000', fontSize: 13, fontWeight: '700' },

  // ── G1 Display panel ──────────────────────────────────────────────────────
  hudOuter:         { marginHorizontal: 16, marginBottom: 20,
                       backgroundColor: '#0d1a0d', borderRadius: 16,
                       paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20,
                       borderWidth: 1, borderColor: '#1a3a1a',
                       minHeight: 260 },
  // Fullscreen HUD mode — takes up as much vertical space as possible
  hudOuterFullscreen: { marginHorizontal: 0, borderRadius: 0, flex: 1,
                         borderWidth: 0, paddingHorizontal: 28, paddingTop: 36, paddingBottom: 28,
                         justifyContent: 'center' },
  hudLineFullscreen:  { fontSize: 36, lineHeight: 56 },
  hudLabelRow:      { flexDirection: 'row', justifyContent: 'space-between',
                       alignItems: 'center', marginBottom: 16 },
  hudLabel:         { color: '#2d6a2d', fontSize: 10, fontWeight: '700', letterSpacing: 2 },
  hudPageDots:      { color: '#2d6a2d', fontSize: 13 },
  // Display lines — sized to feel like actual glasses output
  hudLine:          { color: '#22c55e', fontFamily: 'monospace', fontSize: 24, lineHeight: 44 },
  hudStatus:        { color: '#4ade80', fontWeight: '600', fontSize: 16, lineHeight: 28 },
  hudActive:        { color: '#86efac', backgroundColor: '#0f2a0f', borderRadius: 4,
                       paddingHorizontal: 4 },
  hudHint:          { color: '#1a3a1a', fontSize: 11, textAlign: 'center', marginTop: 14 },

  // Progress
  progressRow:      { marginBottom: 20, gap: 8 },
  progressHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  progressText:     { color: '#555', fontSize: 12 },
  progressTime:     { color: '#aaa', fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  progressBar:      { height: 2, backgroundColor: '#1e1e1e', borderRadius: 1 },
  progressFill:     { height: 2, backgroundColor: '#22c55e', borderRadius: 1 },

  // Controls
  controlRow:       { flexDirection: 'row', gap: 12, marginBottom: 20, justifyContent: 'center' },
  ctrlBtn:          { borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  ctrlPrimary:      { backgroundColor: '#22c55e', width: 72, height: 72 },
  ctrlSecondary:    { backgroundColor: '#1e1e1e', width: 56, height: 56 },
  ctrlDisabled:     { opacity: 0.3 },
  ctrlPlayIcon:     { fontSize: 28 },
  ctrlIcon:         { fontSize: 22, color: '#fff' },

  restartBtn:       { alignSelf: 'center', marginBottom: 20, paddingVertical: 10, paddingHorizontal: 24,
                       backgroundColor: '#1e1e1e', borderRadius: 12 },
  restartText:      { color: '#888', fontSize: 14 },

  // Resume chip (shown above controls when a marker exists)
  resumeRow:        { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  resumeChip:       { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8,
                      paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12,
                      backgroundColor: 'rgba(74,222,128,0.12)',
                      borderWidth: 1, borderColor: 'rgba(74,222,128,0.4)' },
  resumeIcon:       { color: '#4ade80', fontSize: 13 },
  resumeText:       { color: '#4ade80', fontSize: 15, fontWeight: '600', flex: 1 },
  resumeDismiss:    { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  resumeDismissText:{ color: '#666', fontSize: 16 },

  // Resume marker set/clear (below controls)
  markerRow:        { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 20 },
  markerBtn:        { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 12,
                      backgroundColor: '#1e1e1e', borderWidth: 1, borderColor: '#2a2a2a' },
  markerBtnActive:  { backgroundColor: 'rgba(74,222,128,0.12)', borderColor: 'rgba(74,222,128,0.4)' },
  markerBtnText:    { color: '#ccc', fontSize: 14, fontWeight: '600' },
  markerBtnTextActive:{ color: '#4ade80' },
  markerClearBtn:   { paddingVertical: 12, paddingHorizontal: 16 },
  markerClearText:  { color: '#888', fontSize: 14 },

  // Speed
  speedCard:        { backgroundColor: '#141414', borderRadius: 16, padding: 20, marginBottom: 16 },
  speedHeader:      { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  speedLabel:       { color: '#888', fontSize: 13 },
  speedValue:       { color: '#fff', fontSize: 13, fontWeight: '600' },
  speedSlider:      { width: '100%', height: 40, marginTop: 4 },
  speedEndLabels:   { flexDirection: 'row', justifyContent: 'space-between', marginTop: -4 },
  speedEndLabel:    { color: '#555', fontSize: 11 },

  // Loop toggle
  loopRow:          { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 28 },
  toggle:           { width: 44, height: 26, borderRadius: 13, backgroundColor: '#1e1e1e',
                       justifyContent: 'center', paddingHorizontal: 3 },
  toggleOn:         { backgroundColor: '#22c55e' },
  toggleThumb:      { width: 20, height: 20, borderRadius: 10, backgroundColor: '#555' },
  toggleThumbOn:    { backgroundColor: '#fff', alignSelf: 'flex-end' },
  loopLabel:        { color: '#888', fontSize: 14 },

});
