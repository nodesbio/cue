/**
 * G1Core.ts — BLE connection manager for Even Realities G1 glasses.
 * Manages both lenses (L + R), heartbeat, ACK sequencing, and event callbacks.
 * Port of g1core/core.py (EvenBridge).
 */

import { BleManager, Device, State, Characteristic, Subscription, BleError, BleErrorCode } from 'react-native-ble-plx';
import { encode as btoa } from 'base-64';
import * as P from './packets';
import { Platform, AppState, AppStateStatus } from 'react-native';

/** Platform byte for 0x2C — see P.batteryRequest. */
const PHONE = Platform.OS === 'ios' ? P.PHONE_IOS : P.PHONE_ANDROID;

// ── Types ──────────────────────────────────────────────────────────────────

export type Side = 'L' | 'R';
/** Listener for the shared BLE scan (see `_subscribeScan`). */
type ScanListener = (error: BleError | null, device: Device | null) => void;

export interface LensState {
  device: Device | null;
  connected: boolean;
  /** TX characteristic was discovered — lens is actually usable, not just OS-connected */
  txReady: boolean;
  /**
   * Link is up and the firmware answers control opcodes, but the last OP_TEXT
   * went un-ACKed. The master lens defers the 0x4e ACK to its display thread
   * (ble_process_req_dispatch.c:316 → display_dispatch_thread.c:703), so this
   * means "display pipeline not rendering" (glasses in case / asleep) — NOT a
   * BLE fault. Cleared on the next text ACK or on (re)connect. See #26.
   */
  displayIdle: boolean;
  /**
   * BLE link is up but the firmware is not responding at all (no 0x03 ACK, no
   * events). Glasses are in the case / powered down. We hold the connection
   * and wait for the first unsolicited frame instead of reconnect-looping. #27
   */
  asleep: boolean;
  batteryPct: number | null;
  rssi: number | null;
}

export interface G1Status {
  left: LensState;
  right: LensState;
  firmwareVersion: string | null;
  /**
   * User tapped Power Off: silent mode ON on both arms. The BLE link stays up
   * (the G1 has no real off state) — the display thread is just suspended.
   * Cleared by powerOn() (silent OFF). Reset on disconnect.
   */
  poweredOff: boolean;
}

export type EventHandler = (event: P.G1Event) => void;
export type StatusHandler = (status: G1Status) => void;

// ── Constants ──────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 8_000;
// Skip the periodic battery poll if a text frame was sent within this window —
// the poll shares the send queue and desyncs L/R mid-scroll (see heartbeat).
const BATTERY_POLL_QUIET_MS = 10_000;
const SCAN_TIMEOUT_MS = 12_000;
// Faster cap — 30 s is too long during a live session. Keeps retrying at 10 s.
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

function uint8ToBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ── G1Core ─────────────────────────────────────────────────────────────────

export class G1Core {
  private manager: BleManager;
  /** Last time `[G1 MFR RAW]` was logged per `${serial}${side}` (scan research throttle). */
  private _mfrLogAt: Record<string, number> = {};
  private devices: Partial<Record<Side, Device>> = {};
  private txChars: Partial<Record<Side, Characteristic>> = {};
  private rxSubs: Partial<Record<Side, Subscription>> = {};
  private seq = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Count of routine 0x25 heartbeat RX frames since the last non-heartbeat
   *  frame, per side. Dumped (then reset) when a real frame arrives, so the
   *  heartbeat rate stays visible without spamming the HUD ring buffer. */
  private _hbRxCount: Record<Side, number> = { L: 0, R: 0 };
  private reconnectAttempts: Partial<Record<Side, number>> = { L: 0, R: 0 };
  private destroyed = false;
  /** Mutex: if a connect/scan is already in flight, callers share the same promise. */
  private _connectingPromise: Promise<void> | null = null;
  /**
   * Single-slot send queue for user-visible sends (sendText, sendBmp).
   * If a new frame arrives while a previous one is still in-flight, we
   * discard the in-flight and send only the latest — same behaviour as the
   * official app's "cancel stale" pattern. This prevents the queue from
   * growing unboundedly during rapid scrolling while still ensuring every
   * frame eventually reaches the glasses (the last one always wins).
   *
   * Implemented as a tail-swap: _nextSend holds the most recent pending
   * frame; _sendQueue is the in-flight chain. Callers await _sendQueue
   * being free then execute.
   */
  private _sendQueue: Promise<void> = Promise.resolve();
  /**
   * Minimum gap (ms) enforced between consecutive TEXT frame commits — the
   * per-pair calibrated scroll pace (see calibrationStore.ts). The two lenses
   * fail at different layers above this rate (L render-freezes ~8 f/s, R link-
   * drops ~16 f/s), so bursts faster than the slower lens can commit cause the
   * skew the Calibrate feature exists to kill. Enforced in _enqueue for text
   * ops only; 0 = uncalibrated / no throttle (connect & battery packets never
   * gated). Set via setScrollPaceMs from the stored calibration at HUD start.
   */
  private _scrollPaceMs = 0;
  /** Wall-clock of the last gated text frame, for the inter-frame gap. */
  private _lastPacedSendAt = 0;
  /**
   * Monotonic token for sendText coalescing. Each sendText captures the
   * current value at enqueue time; when its turn on _sendQueue arrives, it
   * only sends if no newer sendText has been enqueued since. Field report
   * 2026-11-04: glasses were 28 min / ~380 lines behind the app because the
   * queue was an unbounded FIFO and each text frame waits up to 25 s for an
   * R-side ACK — every scroll tick was faithfully replayed in order.
   */
  private _textGen = 0;
  /**
   * Per-side connect queues. Each side serialises its own _connectLens calls
   * independently. A shared queue meant R's reconnect blocked on L's (and
   * vice-versa), producing paired reconnect storms. iOS BLE does not require
   * that L and R connects be serialised against each other — only that we
   * don't issue two connects to the *same* peripheral concurrently.
   */
  private _connectQueue: Record<Side, Promise<void>> = { L: Promise.resolve(), R: Promise.resolve() };
  /**
   * True while a _connectLens call is actively executing for that side.
   * Used to gate _scheduleReconnect / reconnectSide so a burst of reconnect
   * requests doesn't pile up a queue of redundant attempts behind an in-flight
   * connection.
   */
  private _connectingOnSide: Record<Side, boolean> = { L: false, R: false };

  /** True while any _connectLens call is actively executing. Surfaced to G1Context. */
  get isReconnecting(): boolean {
    return this._connectingOnSide.L || this._connectingOnSide.R;
  }
  /** Timestamp of the last reconnectSide() call per side — used to debounce UI taps. */
  private _lastReconnectSideAt: Record<Side, number> = { L: 0, R: 0 };
  private static readonly RECONNECT_SIDE_DEBOUNCE_MS = 1500;
  /**
   * Generation counter per side. Incremented each time _connectLens runs.
   * The onDisconnected closure captures its generation at creation time and
   * no-ops if a newer connection has since replaced it — prevents stale
   * disconnect handlers from corrupting a healthy reconnected session.
   */
  private _connGen: Record<Side, number> = { L: 0, R: 0 };
  /** Pending reconnect timeout handles — cancelled on disconnect/destroy. */
  private _reconnectTimers: Partial<Record<Side, ReturnType<typeof setTimeout>>> = {};
  /**
   * The pair we are bound to. `_pairedSerial` is the mfr-data serial
   * ("H290036"); `_pairedIds` are the CoreBluetooth peripheral UUIDs learned
   * the first time each side connects with mfr data verifying the serial.
   * iOS connectedDevices() and some resume paths return devices WITHOUT mfr
   * data, so the ids are the only way to tell G1_30 from G1_5 there. Every
   * device-selection path (scan, resume, targeted reconnect scan) must go
   * through _matchesPair — with two pairs in range, an unfiltered path
   * connects one lens from each set.
   */
  private _pairedSerial: string | null = null;
  private _pairedIds: Partial<Record<Side, string>> = {};
  /** Lens peripheral ids verified against the paired serial. Persist these. */
  get pairedIds(): Partial<Record<Side, string>> { return { ...this._pairedIds }; }
  /**
   * Timestamp (ms) of the last silent(true) send per side, used to rate-limit
   * connection_error re-silences and avoid a re-silence storm.
   */
  private _lastSilentAt: Record<Side, number> = { L: 0, R: 0 };
  /**
   * Per-side wall-clock of the last OP_TEXT (0x4e) write issued in the CURRENT
   * connection cycle. Zeroed on _onDisconnected. Used to reject ghost text ACKs:
   * iOS replays a 0x4e notification buffered from the previous session on the
   * fresh RX subscription, and because the text ACK waiter is keyed `${side}4e`
   * (no seq), that stale frame would otherwise resolve the seq=0 waiter in ~3ms.
   * The real render never lands and the lens shows stale content (blank, or a
   * leftover Even-AI HUD). Confirmed on-device 2026-11: seq=0 L-ack was +3ms
   * (ghost) while the next live frame seq=1 L-acked at +1592ms (real display
   * thread) and rendered. A genuine 0x4e ACK can only follow a write we issued,
   * so any ACK arriving while this is 0 — or predating the write — is a ghost.
   * Same defence as the OP_SILENT `_lastSilentAt !== 0` gate (Bug #10).
   */
  private _lastTextWriteAt: Record<Side, number> = { L: 0, R: 0 };
  /**
   * Timestamp (ms) of the last received OP_SILENT (0x03) ACK from the glass,
   * per side. If a successful ACK arrived within the last SILENT_ACK_REUSE_MS,
   * _connectLens skips the 12-second _sendForResult wait (the glass already
   * accepted silent mode and won't send another 0x03 ACK for the same power-on).
   */
  private _lastSilentAckAt: Record<Side, number> = { L: 0, R: 0 };
  private static readonly SILENT_ACK_REUSE_MS = 60_000;
  /**
   * Consecutive OP_TEXT NACK counter per side — telemetry only. Reset to 0 on
   * any successful text ACK or on connect.
   *
   * #24: this used to force _onDisconnected at threshold=1. That flapped R
   * every 27 s (38×/session), dropped 2 queued lines per cycle, and recovered
   * 0 times — because an un-ACKed 0x4e is a display-thread state, not a link
   * fault (see LensState.displayIdle). We now surface it instead.
   */
  private _textNackCount: Record<Side, number> = { L: 0, R: 0 };
  /**
   * Telemetry (lens-sync skew triage). For each OP_TEXT seq we record the
   * arrival time of each side's ACK; when both have arrived we log the signed
   * skew = (L ack time − R ack time). Positive ⇒ R acked first ⇒ R leads.
   *
   * This replaces the earlier "master-detection" EMA, which was disproven by a
   * tethered run (2026-11-xx): both sides ack within ~30ms at ~1000ms, no
   * seconds-deferred master exists in this firmware, and the inferred-master
   * flag flapped every frame on sub-2% EMA noise. The real symptom is a
   * STRUCTURAL one-line lead (field obs: R=148, L=147 w/ 🔼 on L) caused by the
   * R-first write + L-only barrier. This skew tracker quantifies that lead per
   * frame so a barrier fix can be proven, not guessed.
   *
   * ⚠ CAVEAT (2026-11, proven): this metric does NOT measure true L-vs-R
   * DISPLAY-RENDER skew. R's 0x4e text ACK fires on a FIXED ~810ms firmware
   * timer (observed dead-constant 806–822ms across all frames, independent of
   * content/timing — it is a cadence, not a render-confirm). So the skew here
   * is L's variable render-ack paired against R's fixed metronome — an
   * aliasing artifact, bidirectional and ~zero-mean (±40ms typ, ±80ms tail).
   * The G1 firmware exposes NO render-confirm frame for either lens (R emits
   * only 0x25 keepalive + the 810ms-timer 0x4e), so true render skew is
   * UNOBSERVABLE in software and cannot be barriered on. The visible
   * line-transition blip is intrinsic two-radio display jitter, not a bug.
   * Do NOT "fix the skew" by tuning against this number — it's a proxy proven
   * disconnected from the target. Keep only as a coarse liveness signal.
   */
  private _textAckAt: Record<Side, Map<number, number>> = { L: new Map(), R: new Map() };
  /** Root-cause triage (telemetry-only): per-(side,seq) timing breakdown so the
   *  SKEW line can attribute lag to its SOURCE. writeMs = time the radio took to
   *  ACCEPT the write (CoreBluetooth queue drain — high ⇒ iOS BLE radio
   *  starvation / power-save, the standalone-vs-tethered suspect). ackLatMs =
   *  write-accepted → firmware text-ACK (high ⇒ firmware render / ESB
   *  master→slave sync lag, independent of iOS). Splitting these two is what
   *  distinguishes "R radio throttled" from "R firmware slow". */
  private _textAckTiming: Record<Side, Map<number, { writeMs: number; ackLatMs: number }>> = {
    L: new Map(),
    R: new Map(),
  };
  /** Current foreground/background/inactive state, tracked live so every SKEW
   *  and ACK-MISS line is stamped with it. The standalone "falls apart in the
   *  wild" report predicts skew spikes should correlate with 'background' /
   *  'inactive' (screen dim, pocketed); if skew is flat across states the root
   *  is NOT iOS power-save. Telemetry-only — never gates send behavior. */
  private _appState: AppStateStatus = AppState?.currentState ?? 'active';
  /** PROBE (Bug B triage): seqs R has text-acked, pruned by the R-ACK-MISS
   *  probe in _sendBoth. Separate from _textAckAt so skew-pairing deletes don't
   *  create false "R never acked" readings. Telemetry-only. */
  private _rAckedSeqs: Set<number> = new Set();
  /** Bug B directionality probe (telemetry-only): L text-ACKs, mirror of
   *  _rAckedSeqs. The barrier awaits L's ack so an L miss "can't" happen per
   *  the _sendBoth comment — but a field [S]-split that goes L-stale would
   *  disprove that. Track both sides so the probe reports WHICH lens dropped. */
  private _lAckedSeqs: Set<number> = new Set();
  /** Optional harness tap, fired on every raw text-ACK (side, seq) before the
   *  skew-pairing delete. Registered by the lens-race BLE-skip ledger. */
  private _onTextAckRaw: ((side: Side, seq: number) => void) | null = null;
  /** Register/clear the raw text-ACK tap. Pass null to unregister. Harness-only
   *  — does not affect send/render behaviour. */
  setTextAckObserver(fn: ((side: Side, seq: number) => void) | null): void {
    this._onTextAckRaw = fn;
  }
  // Windowed mean of signed (L−R) ack skew. A LIFETIME mean (the original
  // impl) was useless for triage: in the 2026-11-15T19-37 log it read -190ms
  // for 100+ frames while the INSTANTANEOUS skew was oscillating -9ms↔-288ms
  // and recovering between spikes — the ancient samples dominated and hid
  // current health. A rolling window reflects the lens state *now*, which is
  // what a human reading a mid-session capture needs. Telemetry-only; the
  // corrector itself keys off instantaneous |skew|, never the mean.
  private static readonly SKEW_MEAN_WINDOW = 20;
  private _skewWindow: number[] = [];

  // ── Mono-fallback: legible-mono beats garbled-stereo ──────────────────────
  // Two eyes cannot FUSE a text image that is temporally offset beyond
  // ~150-250ms — the viewer sees doubled/ghosted text and must physically
  // close one eye to read (field report, 2026-11-16T03-58 log). On a degraded
  // link skew spent most of that session >400ms and spiked to ~8000ms, and the
  // skew CORRECTOR made it worse (re-push adds frames to a choked link: skew
  // GREW +187→+1478ms after each resync). So when skew is sustained beyond what
  // re-push can fix, the humane move is NOT to keep fighting for stereo sync —
  // it is to blank the LAGGARD lens and drive the healthier one MONO, giving
  // one clean readable image. This is what the operator was doing by hand
  // (closing an eye); we do it for them, and undo it when the link recovers.
  //
  // Operator verdict (2026-11-16): "the doubling is bad at ANY offset — 1 lens
  // clean is much better than any offset." So clean-mono is HOME BASE, not a
  // last resort. We enter mono on any PERCEPTIBLE sustained skew and resume
  // stereo only when the link proves it can hold skew imperceptibly tight.
  //
  // ENTER FAST: 40ms is "perceptible offset" — low enough to kill visible
  // doubling, high enough to ride out the sub-perceptual 10-30ms jitter that's
  // always present on a healthy foreground link (else mono would strobe). 3
  // frames so a single spike can't trip it. These are tunable from field logs.
  private static readonly SKEW_MONO_THRESHOLD_MS = 40;
  private static readonly SKEW_MONO_BREACH_COUNT = 3;
  // LEAVE SLOW: resume stereo only after a long run under a TIGHTER bar (25ms,
  // below the 40ms entry — a deliberate hysteresis gap so a link flapping near
  // 40ms stays in clean-mono instead of strobing). 15 frames ≈ several seconds
  // of proven-clean link before we spend the second lens again.
  private static readonly SKEW_MONO_RECOVER_MS = 25;
  private static readonly SKEW_MONO_RECOVER_COUNT = 15;
  /** Active mono side: the lens we drive alone, or null for stereo. */
  private _monoSide: Side | null = null;
  private _monoBreachStreak = 0;  // consecutive perceptible-skew paired frames
  private _monoRecoverStreak = 0; // consecutive clean frames while in mono

  // ── Background ACK-MISS mono trigger ──────────────────────────────────────
  // The skew detector (_evaluateSkew) only ticks when paired ACKs come back, so
  // it goes DORMANT when iOS throttles the BLE radio on lockscreen/background —
  // emergency-mono never fired while locked (field: cue-logs-2026-11-17T03-39,
  // 82 consecutive R ACK MISSes over ~5 min backgrounded, mono fired only once
  // the app returned to active). The per-frame ACK-MISS probe DOES run in
  // background, so a sustained one-sided miss streak is the only live signal
  // for a dead lens while locked. A run of N same-side misses trips mono,
  // keeping the lens that is still acking.
  private _ackMissSide: Side | null = null; // side of the current miss streak
  private _ackMissStreak = 0;               // consecutive same-side ACK misses
  // 3 missed frames ≈ the same evidence bar as SKEW_MONO_BREACH_COUNT: enough to
  // rule out a lone dropped ACK, fast enough to catch a dead lens within ~6-9s.
  private static readonly ACK_MISS_MONO_COUNT = 3;

  /** Operator's preferred reading eye (UI toggle). null = Auto (link decides).
   *  Honored in mono ONLY when the preferred lens's link is healthy; a dead
   *  preferred lens is overridden to the lens that actually works. Since the
   *  2026-11 keep-both-live finding (see _sendBoth mono branch) EITHER lens can
   *  be the reader, so this is now freely honored — no forced keep-R. */
  private _preferredEye: Side | null = null;

  /** Session-latch: once the operator (or an emergency drop) forces mono, the
   *  engine STAYS mono for the rest of the session — no automatic stereo
   *  re-entry. Cleared only by resetLensSession() (a deliberate restart /
   *  pre-show re-enable). This is the stage-safety invariant: the glasses must
   *  never flicker the echo back on their own mid-presentation. */
  private _stereoLatchedOff = false;

  /** Force an immediate, session-latched drop to a single clean lens. Wired to
   *  the SmartRemote emergency key (Next >>). Picks the coherent lens via the
   *  same priority as auto mono-fallback, blanks the other, and latches stereo
   *  OFF so nothing auto-resumes it. Idempotent: repeated presses are safe. */
  /** True once the engine has dropped to a single clean lens (emergency or
   *  auto fallback). Lets the UI reuse the emergency key for a second purpose
   *  (manual line-advance) without re-triggering the drop. */
  get isMono(): boolean {
    return this._monoSide !== null;
  }

  /** The lens currently driven in mono ('L'|'R'), or null while stereo. The UI
   *  shows only this lens's battery in mono — the single reading showing which
   *  lens is live (see TeleprompterEngine._buildStatusBar). */
  get monoSide(): Side | null {
    return this._monoSide;
  }

  async emergencyMono(): Promise<void> {
    // Operator pressed the emergency key. Keep the coherent lens via the same
    // priority the auto path uses. _tripMono is idempotent, so a second press
    // while already mono is a safe no-op (no re-log, no re-notify).
    this._tripMono(this._monoSide ?? this._pickMonoSide(this._skewMeanMs), 'emergency key');
    // ACTUATION NOTE: this only sets the mono DECISION. The actual lens drive —
    // blank the laggard + drive the kept lens — happens when a TEXT frame flows
    // through _sendBoth (the mono branch there). The emergency key is pressed
    // during a PAUSE, when no frame is in flight, so the CALLER must re-push the
    // current frame immediately after this returns (see index.tsx tap handler).
    // Earlier a raw _send(drop, blank) was hand-rolled here; it bypassed the
    // firmware-aware R-first ESB sync in _sendBoth and left BOTH lenses lit when
    // keeping R (the ESB slave rejected the lone out-of-sync seq). Driving the
    // real frame through _sendBoth reuses the proven auto-fallback path instead.
  }

  /** Shared mono-drop body. Every path that forces mono (operator emergency
   *  key, auto skew-fallback, and the background ACK-MISS detector) funnels
   *  through here so the latch, streak resets, logging and HUD notify are
   *  identical. Idempotent: a no-op if already mono on the same side.
   *
   *  `keep` is the lens to DRIVE (the reader). The caller decides which lens
   *  survives: the skew path uses _pickMonoSide(mean); the ACK-MISS path keeps
   *  the lens that is still acking (the opposite of the missing side).
   *
   *  Does NOT itself push a frame — the mono decision actuates on the next
   *  TEXT frame through _sendBoth's mono branch. _onReadingEyeSwap re-pushes
   *  the current frame so a PAUSED/foregrounded operator heals immediately. */
  private _tripMono(keep: Side, reason: string): void {
    this._stereoLatchedOff = true;
    if (this._monoSide === keep) return; // already there — don't re-log/re-notify
    this._monoSide = keep;
    this._monoBreachStreak = 0;
    this._monoRecoverStreak = 0;
    this._log(
      `[G1] MONO-DROP (${reason}) → reading eye ${keep}, ` +
      `blank-live on ${keep === 'R' ? 'L' : 'R'} (pref=${this._preferredEye ?? 'Auto'}); ` +
      `stereo latched off for session`,
    );
    this._onReadingEyeSwap?.(keep);
  }

  /** Re-enable stereo for a NEW session (deliberate operator action only — e.g.
   *  restarting the prompter or a pre-show re-enable). Clears the session latch
   *  and the mono state so the auto-controller can earn stereo again. NOT called
   *  by any live on-stage gesture. */
  resetLensSession(): void {
    this._stereoLatchedOff = false;
    this._monoSide = null;
    this._monoBreachStreak = 0;
    this._monoRecoverStreak = 0;
    this._log(`[G1] lens session reset → stereo re-enabled (will be re-earned)`);
  }

  /** Set the preferred reading eye for mono-fallback. 'L' | 'R' | null (Auto).
   *  Takes effect at the next mono-entry decision; does not force a switch
   *  mid-mono (that would blank a working lens the viewer is already reading). */
  setPreferredEye(side: Side | null): void {
    this._preferredEye = side;
    this._log(`[G1] preferred eye = ${side ?? 'Auto'}`);
  }

  /** A lens is usable iff its TX characteristic is discovered AND it's connected.
   *  txReady is the real "lens is usable, not just OS-connected" signal
   *  (see LensState.txReady). Used to override eye preference onto a dead lens. */
  private _lensHealthy(side: Side): boolean {
    const st = side === 'L' ? this.status.left : this.status.right;
    return st.connected && st.txReady;
  }

  /** Choose which lens to keep as the CONTENT (reading) eye in mono.
   *
   *  DOCTRINE RETRACTED (2026-11-16). The former rule — "ALWAYS KEEP R, L master
   *  freezes solo" — was WRONG. The earlier keep-L freezes (field logs 2026-11,
   *  41/381 and 51/381) all shared a confound: the non-content lens was BLANKED
   *  (one-shot) and then never written again. L didn't freeze because it ran
   *  solo; it froze because R, the ESB slave, went silent and starved the
   *  master's sync. Verified by the eye-flip test (log 2026-11-16T20:51): with R
   *  driven a fresh blank frame every tick (keep-both-live), L kept ACKing for
   *  55s straight (a360→a676ms, no climb, survived backgrounding) and never
   *  stalled. EITHER lens can be the reader as long as the other is kept
   *  sync-alive. The keep-both-live drive in _sendBoth is now the only mono
   *  path, so this picker is free to honor the operator's choice.
   *
   *  Priority: (1) the operator's preferred eye if that lens is healthy;
   *  (2) the only healthy lens if just one is up; (3) R as a neutral Auto
   *  tiebreak when both are healthy and no preference is set (R is the ESB
   *  slave — a slightly cheaper default, not a safety mandate). meanMs is
   *  unused — kept in the signature for call sites and telemetry. */
  private _pickMonoSide(_meanMs: number): Side {
    const lOk = this._lensHealthy('L');
    const rOk = this._lensHealthy('R');

    // (1) Honor the operator's preferred reading eye when its link is healthy.
    if (this._preferredEye && this._lensHealthy(this._preferredEye)) {
      return this._preferredEye;
    }
    // (2) Only one lens up → keep it (either is a valid solo reader now).
    if (lOk && !rOk) {
      this._log('[G1] _pickMonoSide: only L healthy → keeping L as reader (R driven live is impossible; mono degrades to true-solo).');
      return 'L';
    }
    if (rOk && !lOk) return 'R';
    // (3) Both healthy, no preference → neutral Auto default.
    return 'R';
  }
  private get _skewMeanMs(): number {
    const w = this._skewWindow;
    if (w.length === 0) return 0;
    return w.reduce((a, b) => a + b, 0) / w.length;
  }
  private get _skewSamples(): number {
    return this._skewWindow.length;
  }
  // Climb-vs-jitter telemetry: rolling max ackLatency per side (does the
  // baseline rise over a session ⇒ firmware degradation?) and the previous
  // frame's ackLatency per side (frame-to-frame Δa ⇒ transient jitter spike).
  // Both telemetry-only; persist for the core's lifetime like _skewMeanMs
  // (never reset mid-session — a capture spans one connection).
  private _ackLatMax: Record<Side, number> = { L: 0, R: 0 };
  private _ackLatPrev: Record<Side, number | undefined> = { L: undefined, R: undefined };

  // ── Closed-loop skew corrector ──────────────────────────────────────────
  // Field logs show L/R ack latency diverging under iOS background radio
  // throttling. The 2026-11-15T19-37 capture (first with this corrector live)
  // refined the model: instantaneous skew OSCILLATES hard in background
  // (-9ms↔-320ms) rather than ratcheting monotonically — it spikes past
  // threshold and recovers between spikes. The corrector fired 28× there,
  // caught the sustained excursions, and the operator reported stability
  // "really good". So this is correction of a transient-but-frequent
  // divergence, not a one-way ratchet. We detect a SUSTAINED breach (not a
  // single spike) and re-anchor both lenses (same effect as the manual
  // PLAY-BUTTON pause+resync). Keyed off instantaneous |skew|, not the mean.
  private static readonly SKEW_RESYNC_THRESHOLD_MS = 150;
  private static readonly SKEW_RESYNC_BREACH_COUNT = 3;
  /** Consecutive paired frames whose |skew| exceeded the threshold. Reset on
   *  any in-bounds frame OR after a resync fires, so the detector re-arms. */
  private _skewBreachStreak = 0;
  /** Invoked with the triggering seq when sustained divergence is detected.
   *  The HUD wires this to the same re-anchor the play button performs. */
  private _onSkewResync: ((seq: number) => void) | null = null;
  setSkewResyncHandler(fn: ((seq: number) => void) | null): void {
    this._onSkewResync = fn;
  }

  // ── Reading-eye auto-alternation (eye-health) ───────────────────────────
  // Unlocked by the 2026-11-16 keep-both-live finding: since EITHER lens can be
  // the reader, we periodically swap which eye shows content to avoid loading a
  // single eye for a whole session. Default cadence 5 min (binocular-display
  // comfort guidance; tune via setEyeAlternationMinutes). OFF by default — it's
  // a comfort feature, not a safety one, and must never surprise a live operator.
  //
  // Swap mechanics reuse the proven "core decides, HUD re-pushes" pattern (see
  // _onSkewResync): the timer flips _monoSide and fires _onReadingEyeSwap so the
  // HUD re-pushes the current frame, lighting the new reading eye immediately.
  // Guarded: only swaps while in mono with BOTH lenses healthy (can't move the
  // reader onto a dead lens), and never clears the stereo latch.
  private _eyeAlternateEnabled = false;
  private _eyeAlternateMs = 5 * 60_000;
  private _eyeAlternateTimer: ReturnType<typeof setInterval> | null = null;
  private _onReadingEyeSwap: ((side: Side) => void) | null = null;

  /** HUD wires this to re-push the current frame after an auto-swap flips the
   *  reading eye, exactly like setSkewResyncHandler. */
  setReadingEyeSwapHandler(fn: ((side: Side) => void) | null): void {
    this._onReadingEyeSwap = fn;
  }

  setEyeAlternationMinutes(min: number): void {
    this._eyeAlternateMs = Math.max(1, min) * 60_000;
    this._log(`[G1] eye-alternation cadence = ${min} min`);
    if (this._eyeAlternateEnabled) this.setEyeAlternation(true); // restart timer at new cadence
  }

  setEyeAlternation(on: boolean): void {
    this._eyeAlternateEnabled = on;
    if (this._eyeAlternateTimer) { clearInterval(this._eyeAlternateTimer); this._eyeAlternateTimer = null; }
    if (on) {
      this._eyeAlternateTimer = setInterval(() => this._tryAlternateEye(), this._eyeAlternateMs);
    }
    this._log(`[G1] eye-alternation ${on ? `ON (every ${this._eyeAlternateMs / 60_000} min)` : 'OFF'}`);
  }

  /** Timer tick: swap the reading eye iff it's safe. No-op outside mono or when
   *  either lens is unhealthy — we never move the reader onto a lens that can't
   *  render, and a true-solo mono (one lens dead) has nowhere to swap. */
  private _tryAlternateEye(): void {
    if (!this._eyeAlternateEnabled || this._monoSide === null) return;
    if (!this._lensHealthy('L') || !this._lensHealthy('R')) {
      this._log('[G1] eye-alternation skip: both lenses must be healthy to swap the reader.');
      return;
    }
    const next: Side = this._monoSide === 'L' ? 'R' : 'L';
    this._monoSide = next;
    this._log(`[G1] eye-alternation → reading eye now ${next} (health rotation)`);
    this._onReadingEyeSwap?.(next);
  }
  /** Last OP_TEXT frame handed to _sendBoth — read by the USER MARK handler so
   *  a human-observed desync is stamped with the exact in-flight line/seq. */
  private _lastSent: { seq: number; line: number; total: number; at: number } | null = null;

  /**
   * One-line sync snapshot for the devBridge USER MARK handler. Pairs a
   * human-observed desync with the machine state at that instant: the frame in
   * flight, the current ack-skew mean, and per-side NACK counts (a NACK on one
   * side only = the dropped-frame asymmetry that would cause a real ±1 line
   * counter divergence). Both lenses always receive the SAME line/seq, so any
   * genuine divergence must come from a one-sided drop — this surfaces it.
   */
  get syncSnapshot(): string {
    const s = this._lastSent;
    const age = s ? Date.now() - s.at : -1;
    return (
      `lastFrame=${s ? `seq=${s.seq} line=${s.line}/${s.total} (${age}ms ago)` : 'none'} ` +
      `skewMean=${this._skewMeanMs >= 0 ? '+' : ''}${this._skewMeanMs.toFixed(0)}ms(n=${this._skewSamples}) ` +
      `nack{L:${this._textNackCount.L},R:${this._textNackCount.R}} app=${this._appState}`
    );
  }
  /**
   * #27: resolver for "first RX frame from this side", armed while a lens is
   * asleep during init. Resolved by _onNotify (wake) or _onDisconnected (abort).
   */
  private _wakeWaiters: Record<Side, (() => void) | undefined> = { L: undefined, R: undefined };
  /**
   * Pending ACK resolvers. Key = "<side><opcode_hex>" (e.g. "L4e", "R15").
   * The firmware echoes the command opcode in data[0] and puts the status in
   * data[1] (0xC9 or 0xCB = ok). The key must include the opcode so concurrent
   * sends on different opcodes (e.g. heartbeat and battery) don't clobber each
   * other's resolvers. We register BEFORE the write to avoid a race on fast ACK.
   */
  // FIFO queue of in-flight ACK waiters per key ("<side><opHex>"). BLE
  // notifications arrive in-order per characteristic, so the oldest waiter
  // is resolved first. A queue (not a single slot) lets two TEXT sends on
  // the same side be in-flight concurrently without one evicting the other.
  private _pendingAck: Map<string, Array<{
    resolve: (ok: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
    seq: number;
  }>> = new Map();

  public status: G1Status = {
    left:  { device: null, connected: false, txReady: false, displayIdle: false, asleep: false, batteryPct: null, rssi: null },
    right: { device: null, connected: false, txReady: false, displayIdle: false, asleep: false, batteryPct: null, rssi: null },
    firmwareVersion: null,
    poweredOff: false,
  };

  private eventHandlers = new Set<EventHandler>();
  private onStatusChange?: StatusHandler;
  private onLog?: (line: string) => void;

  /** Master trace toggle. When false (default), `_trace()` lines are dropped:
   *  raw RX frames, per-seq text write/ACK timing, routine heartbeat events,
   *  and raw battery/MFR byte dumps — ~55% of log volume. Keeping them off by
   *  default stops lifecycle events from being pushed out of the HUD ring
   *  buffer before they can be read. `_log`/`_warn` are always emitted.
   *  Flip on (via `setVerbose(true)`) when triaging a specific frame-level bug. */
  public verbose = false;

  /** Toggle verbose trace logging at runtime (e.g. from a dev-menu switch). */
  setVerbose(on: boolean): void {
    this.verbose = on;
    this._log(`[G1] verbose logging ${on ? 'ON' : 'OFF'}`);
  }

  constructor(opts?: { onEvent?: EventHandler; onStatusChange?: StatusHandler; onLog?: (line: string) => void }) {
    this.manager = new BleManager();
    if (opts?.onEvent) this.eventHandlers.add(opts.onEvent);
    this.onStatusChange = opts?.onStatusChange;
    this.onLog = opts?.onLog;
    // Root-cause triage (telemetry-only): track fg/bg/inactive so SKEW lines
    // are stamped with it. Logged on transition so the moment the OS throttles
    // the radio is visible in the timeline next to the skew it (dis)proves.
    AppState?.addEventListener?.('change', (next) => {
      if (next !== this._appState) {
        this._log(`[G1] APPSTATE ${this._appState} → ${next}`);
        const leavingActive = this._appState === 'active' && next !== 'active';
        this._appState = next;
        // PRE-EMPTIVE MONO ON LOCK/BACKGROUND. Verified limitation (2026-11-17,
        // confirmed against Apple CoreBluetooth background docs): on lockscreen
        // iOS suspends the RN JS runloop, so NO setTimeout/BLE-ACK callback
        // fires and the skew + ACK-MISS detectors go dark — a lens that dies
        // mid-lock would silently ghost the reader with no way to catch it
        // (bluetooth-central only wakes NATIVE CB delegates, not the JS bridge).
        // So we cannot DETECT a dead lens while locked; we DEFEND against it:
        // the instant we leave 'active' (this handler still runs — JS is alive
        // for the transition), drop to a single clean lens. Operating contract:
        // screen on = tinker in stereo, screen locked = committed to mono.
        // Stereo re-earns on resume via the normal skew path (latch is cleared
        // by _tripMono? no — it LATCHES off; resume path calls resetLensSession
        // on a deliberate restart). We only arm this when actually presenting:
        // connected + not already mono, else an idle backgrounded app would
        // needlessly latch mono before the operator ever starts.
        if (leavingActive && this.isConnected && this._monoSide === null) {
          const keep = this._pickMonoSide(this._skewMeanMs);
          this._tripMono(keep, `app left active (${next}) — can't detect dead lens while locked`);
        }
      }
    });
  }

  addEventHandler(h: EventHandler): void    { this.eventHandlers.add(h); }
  removeEventHandler(h: EventHandler): void { this.eventHandlers.delete(h); }
  setStatusCallback(cb: StatusHandler): void { this.onStatusChange = cb; }
  setLogCallback(cb: (line: string) => void): void { this.onLog = cb; }

  /** Public log passthrough so app-layer code (screens) can emit into the same
   *  HUD log ring as core BLE logs. Routes through _log → onLog sink. */
  note(line: string): void { this._log(line); }

  private _fmt(args: unknown[]): string {
    return args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  }

  /** Always emitted: lifecycle, connect/disconnect, user-initiated actions. */
  private _log(...args: unknown[]): void {
    const line = this._fmt(args);
    console.log(line);
    this.onLog?.(line);
  }

  /** Verbose-only: per-frame RX dumps, per-seq timing, raw battery/MFR bytes.
   *  Gated behind `verbose` — these account for ~55% of log volume and push
   *  lifecycle events out of the HUD ring buffer before they can be read.
   *  No-ops (and skips string building) when verbose is off. */
  private _trace(...args: unknown[]): void {
    if (!this.verbose) return;
    const line = this._fmt(args);
    console.log(line);
    this.onLog?.(line);
  }

  /** Always emitted, tagged so warnings stand out in a quiet (non-verbose) log. */
  private _warn(...args: unknown[]): void {
    const line = `⚠️ ${this._fmt(args)}`;
    console.warn(line);
    this.onLog?.(line);
  }

  // ── Shared scan owner ─────────────────────────────────────────────────────
  //
  // `BleManager.startDeviceScan` / `stopDeviceScan` are global: a second
  // startDeviceScan replaces the first callback, and any stopDeviceScan kills
  // whoever is scanning. Four independent scanners (streaming scan screen,
  // connect()'s _scan, the reconnect-timer scan, scanDebug) used to each own
  // the radio, so the reconnect loop routinely clobbered the scan screen and
  // vice-versa (#scan-sync). Now exactly one startDeviceScan runs while ≥1
  // listener is subscribed; listeners never touch the radio directly.

  private _scanListeners = new Set<ScanListener>();

  /**
   * Subscribe to the shared BLE scan. The radio starts on the first subscriber
   * and stops when the last one unsubscribes. Returns an idempotent unsubscribe.
   * On a scan error every listener is notified once and the set is cleared so
   * the next subscriber restarts the radio.
   */
  private async _subscribeScan(listener: ScanListener): Promise<() => void> {
    await this._ensureBleReady();
    this._scanListeners.add(listener);
    if (this._scanListeners.size === 1) {
      this._log(`[G1] scan radio ON`);
      this.manager.startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
        if (error) {
          this._warn(`[G1] scan error: ${error.message} — notifying ${this._scanListeners.size} listener(s)`);
          const ls = [...this._scanListeners];
          this._scanListeners.clear();
          for (const l of ls) l(error, null);
          return;
        }
        if (!device) return;
        for (const l of [...this._scanListeners]) l(null, device);
      });
    }
    return () => {
      if (!this._scanListeners.delete(listener)) return;
      if (this._scanListeners.size === 0) {
        this._log(`[G1] scan radio OFF`);
        this.manager.stopDeviceScan();
      }
    };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  private _streamingUnsub?: () => void;

  /**
   * Start a continuous BLE scan for G1 pairs, calling `onUpdate` each time a
   * new lens is discovered. Call `stopStreamingScan()` to stop.
   * Safe to call when BLE is not yet ready — waits internally.
   */
  async startStreamingScan(
    onUpdate: (pairs: Record<string, Partial<Record<Side, Device>> & { serial?: string; firmware?: string }>) => void,
  ): Promise<void> {
    this.stopStreamingScan();
    const pairs: Record<string, Partial<Record<Side, Device>> & { serial?: string; firmware?: string }> = {};
    this._streamingUnsub = await this._subscribeScan((_err, device) => {
      if (!device?.name?.includes('G1')) return;
      const parsed = this._parseManufacturerData(device);
      if (!parsed) return;
      const { side, serial, firmware } = parsed;
      if (!pairs[serial]) pairs[serial] = { serial, firmware };
      pairs[serial][side] = device;
      onUpdate({ ...pairs });
    });
  }

  /** Stop a streaming scan started with `startStreamingScan`. */
  stopStreamingScan(): void {
    this._streamingUnsub?.();
    this._streamingUnsub = undefined;
  }

  /**
   * Briefly connect to an advertising R lens, read battery, and disconnect.
   * Used by the scan screen to pick the fuller of two pairs BEFORE pairing —
   * the advertisement carries no battery byte (firmware ble_ancs.c:856-864),
   * so this is the only way to get a live number without fully connecting.
   *
   * Protocol (firmware ble_cmd.h:50 BLE_CMD_DEVICE_INFO_GET, ble_proto.c:3238):
   *   TX  2C 01
   *   RX  2C 66 [pct] [pct2] [voltage] [current] [temp] [fw ver ×14]
   * data[2] is what the existing connected path uses as the lens's own level,
   * so that's what we return. data[3] is logged for research — on the master
   * it is probably the slave's level via ESB, but that's unverified.
   *
   * Deliberately bypasses _connectLensInner: no init handshake, no status
   * mutation, no onDisconnected → no reconnect loop. Refuses to run while a
   * real connect is in flight so it can't race the per-side queue for the
   * same peripheral.
   */
  async probeBattery(device: Device, timeoutMs = 8000): Promise<{ pct: number; raw: number[] }> {
    if (this.isReconnecting) throw new Error('probeBattery: connect in flight');
    const tag = `[G1] probeBattery ${device.name ?? device.id}`;
    let sub: Subscription | undefined;
    let connected: Device | undefined;
    try {
      connected = await device.connect({ autoConnect: false, timeout: timeoutMs });
      const disc = await connected.discoverAllServicesAndCharacteristics();
      const raw = await new Promise<Uint8Array>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('probeBattery: no 0x2C reply')), timeoutMs);
        sub = disc.monitorCharacteristicForService(P.UART_SVC, P.UART_RX, (err, ch) => {
          if (err || !ch?.value) return;
          const data = base64ToUint8(ch.value);
          if (data[0] !== P.OP_BATTERY) return;
          clearTimeout(t);
          resolve(data);
        });
        disc.writeCharacteristicWithResponseForService(P.UART_SVC, P.UART_TX, uint8ToBase64(P.batteryRequest(PHONE)))
          .catch(e => { clearTimeout(t); reject(e); });
      });
      const hex = Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join(' ');
      this._trace(`${tag} ok pct=${raw[2]} data[3]=${raw[3]} raw: ${hex}`);
      return { pct: raw[2], raw: Array.from(raw) };
    } catch (e: any) {
      this._warn(`${tag} failed: ${e?.message ?? e}`);
      throw e;
    } finally {
      sub?.remove();
      if (connected) {
        try { await connected.cancelConnection(); } catch {}
      }
    }
  }

  /** Scan and return all discovered pairs (channel → {L,R} device). */
  async scanPairs(durationMs = 8000): Promise<Record<string, Partial<Record<Side, Device>>>> {
    const pairs: Record<string, Partial<Record<Side, Device>>> = {};
    return new Promise(async (resolve) => {
      const finish = () => { clearTimeout(timeout); unsub(); resolve(pairs); };
      const timeout = setTimeout(finish, durationMs);
      const unsub = await this._subscribeScan((error, device) => {
        if (error) { finish(); return; }
        if (!device?.name) return;
        const side = this._parseSide(device);
        if (!side) return;
        const ch = this._parseChannel(device);
        if (!ch) return;
        if (!pairs[ch]) pairs[ch] = {};
        pairs[ch][side] = device;
        // Resolve early if we have 2+ complete pairs
        const complete = Object.values(pairs).filter(p => p.L && p.R).length;
        if (complete >= 2) finish();
      });
    });
  }

  async connect(channel?: string, knownIds?: Partial<Record<Side, string>>): Promise<void> {
    // Bind to the requested pair before any device selection runs.
    if (channel && channel !== this._pairedSerial) {
      this._pairedSerial = channel;
      this._pairedIds = {};
    }
    if (knownIds) this._pairedIds = { ...this._pairedIds, ...knownIds };
    // If already connected, nothing to do.
    if (this.isConnected) return;

    // If a connection attempt is already in flight, share it instead of
    // starting a second scan (which would cancel the first and throw
    // "Operation was cancelled").
    if (this._connectingPromise) {
      return this._connectingPromise;
    }

    this._connectingPromise = (async () => {
      try {
        await this._ensureBleReady();
        const resumed = await this._resumeAlreadyConnected(channel);
        if (!resumed) await this._scan(channel);
      } finally {
        this._connectingPromise = null;
      }
    })();

    return this._connectingPromise;
  }

  /**
   * Immediately attempt to reconnect any dropped lens without waiting for the
   * next backoff tick. Resets the backoff counter so the next auto-attempt also
   * starts from the short end. Safe to call when already fully connected.
   */
  async reconnectDropped(): Promise<void> {
    if (this.destroyed) return;
    for (const side of ['L', 'R'] as Side[]) {
      if (this.status[side === 'L' ? 'left' : 'right'].connected) continue;
      const dev = this.devices[side];
      if (!dev) continue;
      this.reconnectAttempts[side] = 0; // reset backoff
      this._enqueueConnect(side, dev);
    }
  }

  async disconnect(): Promise<void> {
    this.status.poweredOff = false;
    this._connectingPromise = null;
    this._connectQueue = { L: Promise.resolve(), R: Promise.resolve() };
    this._stopHeartbeat();
    clearTimeout(this._reconnectTimers.L); this._reconnectTimers.L = undefined;
    clearTimeout(this._reconnectTimers.R); this._reconnectTimers.R = undefined;
    for (const side of ['L', 'R'] as Side[]) {
      // Invalidate the onDisconnected handler BEFORE cancelConnection. iOS
      // fires it during the cancel, and without this it would call
      // _scheduleReconnect after we've already cleared the timers above —
      // so every user-initiated disconnect reconnected itself ~1s later.
      this._connGen[side]++;
      this.rxSubs[side]?.remove();
      this.rxSubs[side] = undefined;
      const dev = this.devices[side];
      if (dev) {
        try { await dev.cancelConnection(); } catch {}
      }
      this.devices[side] = undefined;
      this.txChars[side] = undefined;
      this.reconnectAttempts[side] = 0;
      this._lastSilentAckAt[side] = 0;
      this._setConnected(side, false);
    }
  }

  /**
   * "Power off" — the G1 has no off state (firmware decomp has no power-down
   * path in the BLE dispatcher; only the case stops it). Silent mode ON
   * (03 0C) suspends the display thread and drops to standby, which is the
   * closest thing. Send to both arms, then disconnect so we don't immediately
   * wake them back up with a reconnect-init silent(false).
   */
  async powerOff(): Promise<void> {
    await this._setPowered(false);
  }

  /** Counterpart to powerOff(): silent mode OFF resumes the display thread. */
  async powerOn(): Promise<void> {
    await this._setPowered(true);
  }

  private async _setPowered(on: boolean): Promise<void> {
    const sides = (['L', 'R'] as Side[]).filter(s => this.txChars[s]);
    if (!sides.length) { this._log(`[G1] _setPowered(${on}) — no lens txReady, ignored`); return; }
    this._log(`[G1] _setPowered(${on}) sending silent(${!on}) to ${sides.join(',')}`);
    const acks = await Promise.all(sides.map(s => this._sendForResult(s, P.silent(!on), 5000)));
    this._log(`[G1] _setPowered(${on}) ACKs ${sides.map((s, i) => `${s}=${acks[i]}`).join(' ')}`);
    if (on) {
      // exit_silent_mode shows the firmware's "Activated" splash. Text written
      // while it's up is wiped when the splash clears, so hold the poweredOff
      // flip (which triggers index.tsx's frame re-send) until it's gone.
      await new Promise(r => setTimeout(r, G1Core.ACTIVATED_SPLASH_MS));
      // display_dispatch_thread.c:523 — the firmware memcmp()s the incoming
      // frame against its last-rendered cache and skips the draw if identical.
      // enter_silent_mode blanks the panel without invalidating that cache, so
      // re-sending the same frame after Power On renders nothing. Dirty the
      // cache with a blank frame; the caller's real frame queues behind it.
      await this._enqueue(() => this._sendBoth(P.text(' ', this._nextSeq(), 1, 1, P.NewScreen.TEXT)));
    }
    this.status.poweredOff = !on;
    this._log(`[G1] _setPowered(${on}) done — poweredOff=${!on}`);
    this._emitStatus();
  }
  /** Duration of the firmware "Activated" splash after exit_silent_mode. Unmeasured — tune on device. */
  private static readonly ACTIVATED_SPLASH_MS = 1500;

  /**
   * Disconnect a single lens and stop any pending reconnect timer for it.
   * The other lens is left untouched. Does NOT reset pairedSerial — a
   * subsequent reconnectSide() call will re-scan and reconnect just that side.
   */
  async disconnectSide(side: Side): Promise<void> {
    this._log(`[G1] disconnectSide [${side}] — user-initiated`);
    clearTimeout(this._reconnectTimers[side]);
    this._reconnectTimers[side] = undefined;
    this._connectQueue[side] = Promise.resolve(); // flush any queued attempts
    this._connGen[side]++; // stale-out onDisconnected so cancelConnection doesn't reschedule (see disconnect())
    this.rxSubs[side]?.remove();
    this.rxSubs[side] = undefined;
    const dev = this.devices[side];
    if (dev) {
      try { await dev.cancelConnection(); } catch {}
    }
    this.devices[side] = undefined;
    this.txChars[side] = undefined;
    this.reconnectAttempts[side] = 0;
    this._lastSilentAckAt[side] = 0; // force full silent handshake on next connect
    this._setConnected(side, false);
  }

  /**
   * Reconnect a single lens. Resets backoff and immediately schedules a
   * _connectLens attempt for this side only. The other lens is unaffected.
   * Requires a prior connect() call to have set the paired serial so the
   * reconnect scan knows what device to look for.
   */
  reconnectSide(side: Side): void {
    // Debounce: ignore taps within RECONNECT_SIDE_DEBOUNCE_MS of the last call.
    const now = Date.now();
    if (now - this._lastReconnectSideAt[side] < G1Core.RECONNECT_SIDE_DEBOUNCE_MS) {
      this._log(`[G1] reconnectSide [${side}] — debounced (too soon)`);
      return;
    }
    this._lastReconnectSideAt[side] = now;

    // In-flight guard: if _connectLens is already executing for this side,
    // there's nothing to add — the running attempt will either succeed or
    // call _scheduleReconnect itself on failure.
    if (this._connectingOnSide[side]) {
      this._log(`[G1] reconnectSide [${side}] — already connecting, ignored`);
      return;
    }

    this._log(`[G1] reconnectSide [${side}] — user-initiated`);
    clearTimeout(this._reconnectTimers[side]);
    this._reconnectTimers[side] = undefined;
    this.reconnectAttempts[side] = 0; // reset backoff so it tries immediately
    this._scheduleReconnect(side);
  }

  /** Both lenses OS-connected AND UART TX characteristic discovered (actually usable). */
  get isConnected(): boolean {
    return !!(this.status.left.txReady && this.status.right.txReady);
  }

  /** OS reports connected but TX not ready — partial/half-bonded state. */
  get isPartiallyConnected(): boolean {
    const l = this.status.left; const r = this.status.right;
    return (l.connected || r.connected) && !this.isConnected;
  }

  /**
   * Enqueue a user-visible send (sendText / sendBmp).
   *
   * Uses a "latest wins" strategy: if a send is already in-flight and a new
   * one arrives, we don't cancel the in-flight (BLE can't abort mid-write)
   * but we do discard any queued-but-not-yet-started work and replace it
   * with the new task. This keeps the glasses showing the most recent frame
   * without letting the queue grow unboundedly during rapid scrolling.
   */
  /**
   * Apply the per-pair calibrated scroll pace (ms/frame). Call once at HUD
   * start with the stored calibration's paceMs (or 0 to disable throttling).
   * Enforced as a minimum gap between consecutive TEXT frames in _enqueue.
   */
  setScrollPaceMs(ms: number): void {
    this._scrollPaceMs = Math.max(0, ms | 0);
    this._log(`[G1] scroll pace set to ${this._scrollPaceMs}ms/frame (${this._scrollPaceMs ? (1000 / this._scrollPaceMs).toFixed(1) + ' f/s' : 'disabled'})`);
  }

  private _enqueue(fn: () => Promise<void>, paced = false): Promise<void> {
    const run = this._sendQueue.then(async () => {
      // Pace gate: for TEXT frames, hold until at least _scrollPaceMs has
      // elapsed since the previous paced frame. This throttles bursts (loop
      // restart, rapid next()/prev(), rewind) to the rate the SLOWER lens can
      // commit — without it, the coalescer still fires frames back-to-back and
      // L freezes / R drops. Non-paced ops (connect, battery) are never gated.
      if (paced && this._scrollPaceMs > 0) {
        const since = Date.now() - this._lastPacedSendAt;
        if (since < this._scrollPaceMs) {
          await new Promise(r => setTimeout(r, this._scrollPaceMs - since));
        }
        this._lastPacedSendAt = Date.now();
      }
      return fn();
    }).catch((e) => {
      // Log real errors; swallow only disconnect noise.
      const code = (e as BleError)?.errorCode;
      if (code !== BleErrorCode.DeviceDisconnected && code !== BleErrorCode.OperationCancelled) {
        this._warn('[G1] send error:', e?.message ?? e);
      }
    });
    this._sendQueue = run;
    return run;
  }

  /**
   * Send a text string to both lenses.
   * curLine / totalLines populate the status bar counter (e.g. "▶ 2/14").
   *
   * Screen byte defaults to NewScreen.MANUAL (0x51) — see note in the body.
   * Pass newScreen explicitly to override.
   */
  async sendText(
    str: string,
    curLine = 1,
    totalLines = 1,
    isLastPage = false,
    newScreen?: P.NewScreenValue,
  ): Promise<void> {
    // Default TEXT (0x71) — the byte the official text_service.dart uses.
    // 0x41/0x51 are Even AI session bytes; without an open AI session the
    // firmware stores the frame but never switches to it, then emits F5 00
    // ("exit to dashboard") once a second — which we were decoding as
    // double-tap and rewinding the script. See NewScreen in packets.ts.
    // isLastPage is kept for callers but no longer selects the screen byte.
    void isLastPage;
    const ns = newScreen ?? P.NewScreen.TEXT;
    const myGen = ++this._textGen;
    return this._enqueue(async () => {
      if (myGen !== this._textGen) {
        this._trace(`[G1] sendText line=${curLine} superseded (gen ${myGen} < ${this._textGen}) — skipped`);
        return;
      }
      const packet = P.text(str, this._nextSeq(), curLine, totalLines, ns);
      this._lastSent = { seq: packet[1], line: curLine, total: totalLines, at: Date.now() };
      this._trace(`[G1] sendText seq=${packet[1]} ns=0x${ns.toString(16)} line=${curLine}/${totalLines} len=${str.length} poweredOff=${this.status.poweredOff}`);
      await this._sendBoth(packet);
    }, /* paced */ true);
  }

  /**
   * HARNESS-ONLY: send one text frame to ONE lens and resolve on BLE
   * write-acceptance (OS writeWithResponse completed), NOT on firmware ACK.
   *
   * Bypasses the _sendBoth R-first ESB-sync barrier on purpose: the lens-race
   * harness drives L and R as two independent, flat-out loops to measure each
   * link's sustained write throughput and the L/R delta. Gating on the firmware
   * text ACK would be invalid here — R's 0x4e ACK is a FIXED ~810ms firmware
   * timer (see field notes near _rAckedSeqs), so an ACK-gated race would rig R
   * to lose by construction regardless of real link speed. Write-acceptance is
   * the honest per-lens throughput signal and is the layer the field desync
   * ("R's CoreBluetooth write queue grew one frame per tick") actually lives in.
   *
   * This WILL desync the two displays while running — it is a throughput probe,
   * not a correctness path. Callers must resync (exitToDashboard + re-push)
   * after the run. Do NOT use outside the harness.
   */
  /**
   * READY phase for the lens race: prime ONE lens into the TEXT-accept display
   * state before the flat-out raw-_send loops. The normal sendText/_sendBoth
   * path works on both lenses, but the race's raw per-side _send (below) skips
   * whatever that enqueued path does to make the firmware COMMIT a 0x71 TEXT
   * screen. Symptom (runs through 2026-11-15T18:30): L buffers+ACKs all frames
   * (status 0x01) but never commits a page and emits exit_to_dashboard (0xf5)
   * ~1/s — the documented "firmware rejects the current screen" state (see
   * packets.ts NewScreen doc) — so L shows nothing while R renders.
   *
   * This sends a single TEXT frame through the ENQUEUED, ACK-AWAITED path for
   * just this side (same mechanics as sendText) and resolves once the lens text-
   * ACKs it, i.e. once that lens is in TEXT-accept. Returns true if ACK landed
   * within the window (SET confirmed), false if it timed out (still not ready).
   */
  async racePrimeSide(side: Side, str: string, seq: number): Promise<boolean> {
    const packet = P.text(str, seq, 1, 1, P.NewScreen.TEXT);
    const ack = await this._sendForResult(side, packet, 3000)
      .catch(() => false);
    this._trace(`[G1] racePrimeSide [${side}] seq=${seq} primed=${!!ack}`);
    return !!ack;
  }

  async raceSendTextToSide(side: Side, str: string, seq: number): Promise<void> {
    // Explicit per-side seq — the caller owns a SEPARATE counter per lens so
    // each firmware receives a clean contiguous 1..N stream. Using the shared
    // _nextSeq() here (prior bug, run 2026-11-15T18:17) interleaved the two
    // loops onto one counter (L got even, R got odd), so neither lens received
    // a coherent sequence and L buffered+ACK'd every frame but never committed a
    // page to the display — "L shows nothing". seq is masked to the 1-byte
    // packet field by P.text; the harness keeps it in 0..255.
    const packet = P.text(str, seq, 1, 1, P.NewScreen.TEXT);
    let written!: () => void;
    const writtenP = new Promise<void>((r) => { written = r; });
    // awaitAck=false → no ACK wait; onWritten fires in _send's finally on
    // write-acceptance (or WRITE_TIMEOUT_MS if the radio stalls — a result too).
    const p = this._send(side, packet, false, written);
    p.catch((e) => this._warn(`[G1] raceSendTextToSide [${side}] send error: ${e?.message ?? e}`));
    await writtenP;
  }

  /**
   * Send a pre-rendered 1-bit BMP frame to both lenses.
   *
   * Matches EvenDemoApp's requestList behaviour (verified from source):
   *   - L and R receive each packet IN PARALLEL (not sequential) — the
   *     firmware handles each side independently; sequential L→R doubles
   *     the BMP transfer time with no correctness benefit.
   *   - Intermediate data chunks: fire-and-forget (awaitAck=false) to
   *     keep throughput high.
   *   - Final packet (bmpEnd): awaits ACK on both sides so callers know
   *     the frame is committed before sending the next one.
   *   - writeCharacteristicWithResponse on every packet still provides
   *     OS-level flow control even without the protocol ACK wait.
   */
  async sendBmp(frame: Uint8Array): Promise<void> {
    return this._enqueue(async () => this._sendBmpRaw(frame));
  }

  private async _sendBmpRaw(frame: Uint8Array): Promise<void> {
    const chunks = P.bmpDataChunks(frame);

    // Send all data chunks to L and R in parallel, no ACK wait
    for (const chunk of chunks) {
      await Promise.all([
        this._send('L', chunk, false),
        this._send('R', chunk, false),
      ]);
    }

    // CRC packet — parallel, no ACK
    await Promise.all([
      this._send('L', P.bmpCrc(frame), false),
      this._send('R', P.bmpCrc(frame), false),
    ]);

    // End packet — parallel, AWAIT ACK on both sides
    await Promise.all([
      this._send('L', P.bmpEnd(), true),
      this._send('R', P.bmpEnd(), true),
    ]);
  }

  async setBrightness(level: number, auto = false): Promise<void> {
    await this._sendBoth(P.brightness(level, auto));
  }

  async requestBattery(): Promise<void> {
    await this._sendBoth(P.batteryRequest(PHONE));
  }

  async exitToDashboard(): Promise<void> {
    await this._sendBoth(P.exitToDashboard());
  }

  /**
   * Send a single-line test message to ONE lens only, showing its battery and
   * RSSI so the user can verify the HUD is alive and the telemetry is correct.
   * Uses the existing send queue so it doesn't race active teleprompter sends.
   */
  async sendTestDisplay(): Promise<void> {
    const fmt = (st: typeof this.status.left, label: string) => {
      const bat  = st.batteryPct != null ? `${st.batteryPct}%` : '--';
      const rssi = st.rssi       != null ? `${st.rssi}dBm`     : '--';
      return `${label} 🔋${bat} 📶${rssi}`;
    };
    const line = `${fmt(this.status.left, 'L:')}  ${fmt(this.status.right, 'R:')}`;
    this._log(`[G1] sendTestDisplay txReady L=${this.status.left.txReady} R=${this.status.right.txReady}`);
    return this._enqueue(async () => {
      // No silent(false) before the text write. The lens already left silent
      // mode in _connectLensInner (that ACK is what gates txReady), and the
      // firmware ACKs 0x03 once per boot, so a second one is unverifiable
      // noise. Per firmware decomp (even-g1-companion docs), 03 0a =
      // exit_silent_mode rewrites the live screen id and resumes the master
      // display thread — not something to fire 0 ms before a 0x4E. The
      // 2026-11-04 "Even AI listening" flash was AUTO_LAST (0x41) handing the
      // surface back to the firmware's Even AI task — TEXT (0x71) is the
      // only byte the firmware renders without an open AI session.
      const packet = P.text(line, this._nextSeq(), 1, 1, P.NewScreen.TEXT);
      await this._sendBoth(packet);
    });
  }

  /**
   * Clear the HUD on ONE lens by sending silent(true) to re-assert Cue ownership,
   * which causes the firmware to blank the display.
   */
  async clearDisplay(side: Side): Promise<void> {
    return this._enqueue(async () => {
      await this._send(side, P.silent(true));
    });
  }

  destroy(): void {
    this.destroyed = true;
    this._stopHeartbeat();
    if (this._eyeAlternateTimer) { clearInterval(this._eyeAlternateTimer); this._eyeAlternateTimer = null; }
    this._resolveWake('L'); this._resolveWake('R'); // #27: don't leave _connectLensInner parked forever
    clearTimeout(this._reconnectTimers.L); this._reconnectTimers.L = undefined;
    clearTimeout(this._reconnectTimers.R); this._reconnectTimers.R = undefined;
    this.rxSubs.L?.remove();
    this.rxSubs.R?.remove();
    this.manager.destroy();
  }

  // ── Scanning ──────────────────────────────────────────────────────────────

  private async _ensureBleReady(): Promise<void> {
    // iOS prompts for BLE permission automatically on first scan (via Info.plist entries).
    // We just need to wait for the manager to reach PoweredOn state (up to 5s).
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      // sub may be assigned AFTER the callback fires if BLE is already PoweredOn
      // (emitCurrentValue=true fires synchronously). Use a holder so the closure
      // always has a reference regardless of assignment order.
      const holder: { sub?: { remove(): void } } = {};
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        holder.sub?.remove();
        reject(new Error('Bluetooth not powered on — check device settings'));
      }, 5000);
      holder.sub = this.manager.onStateChange((state) => {
        if (state === State.PoweredOn && !settled) {
          settled = true;
          clearTimeout(t);
          holder.sub?.remove();
          resolve();
        }
      }, true);
    });
  }

  /** Scan all BLE devices and return rich debug info per device. */
  async scanDebug(durationMs = 8000): Promise<string[]> {
    const found: string[] = [];
    const seen = new Set<string>();
    return new Promise(async (resolve) => {
      const t = setTimeout(() => { unsub(); resolve(found); }, durationMs);
      const unsub = await this._subscribeScan((_err, device) => {
        if (!device?.name) return;
        if (seen.has(device.id)) return;
        seen.add(device.id);

        const isG1 = device.name.includes('G1');
        const parsed = isG1 ? this._parseManufacturerData(device) : null;
        const info = isG1
          ? {
              name: device.name,
              id: device.id,
              rssi: device.rssi,
              isConnectable: device.isConnectable,
              txPower: device.txPowerLevel,
              serviceUUIDs: device.serviceUUIDs,
              manufacturerData: device.manufacturerData,
              localName: device.localName,
              mtu: device.mtu,
              decoded: parsed,
            }
          : { name: device.name, id: device.id };

        if (isG1) {
          // Also log raw manufacturer bytes for in-case detection research
          if (device.manufacturerData) {
            const buf = base64ToUint8(device.manufacturerData);
            const hex = Array.from(buf).map(b => b.toString(16).padStart(2,'0')).join(' ');
            this._log(`[G1 MFR RAW] ${device.name} bytes[${buf.length}]: ${hex}`);
          }
          this._log('[G1 DEBUG]', JSON.stringify(info, null, 2));
        }
        else       this._log('[BLE DEBUG]', device.name, `[${device.id}]`);

        const entry = isG1
          ? `${device.name} rssi=${device.rssi} connectable=${device.isConnectable}`
          : `${device.name} [${device.id}]`;
        found.push(entry);
      });
    });
  }

  /**
   * Fast-path: if iOS already has both lenses connected at the OS level,
   * skip scanning and go straight to _connectLens (service discovery + handshake).
   * Returns true if both lenses were resumed, false if we need to scan.
   */
  private async _resumeAlreadyConnected(channel?: string): Promise<boolean> {
    try {
      // iOS registers UART service on bonded peripherals asynchronously — one lens
      // may not appear in connectedDevices([UART_SVC]) for several seconds after
      // the other. Logs show R taking >6s; poll up to ~10s (5 × 2s) before giving up.
      const POLL_INTERVAL_MS = 2000;
      const POLL_ATTEMPTS    = 5;

      const parseBatch = (devices: Device[]): { found: Partial<Record<Side, Device>>; unidentified: Device[] } => {
        const found: Partial<Record<Side, Device>> = {};
        const unidentified: Device[] = [];
        for (const device of devices) {
          const side = this._parseSide(device);
          if (!side) {
            if (device.name?.includes('G1') || device.name == null) unidentified.push(device);
            continue;
          }
          // connectedDevices() on iOS carries no mfr data. With two pairs in
          // range (G1_30 + G1_5) the old rule "no mfr data → trust it" is how
          // we ended up with one lens from each set. Only accept a peripheral
          // whose id we've previously verified against the paired serial.
          if (!this._matchesPair(device, side)) {
            this._trace(`[G1] _resumeAlreadyConnected: ${device.name ?? device.id} [${side}] is not the paired ${this._pairedSerial} — skipped`);
            continue;
          }
          found[side] = device;
        }
        // Unidentified (nameless) peripherals: only accept by known id.
        for (const s of ['L', 'R'] as Side[]) {
          if (found[s]) continue;
          const idx = unidentified.findIndex(d => d.id === this._pairedIds[s]);
          if (idx >= 0) found[s] = unidentified.splice(idx, 1)[0];
        }
        return { found, unidentified };
      };

      let found: Partial<Record<Side, Device>> = {};
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        const connected = await this.manager.connectedDevices([P.UART_SVC]);
        this._trace(`[G1] connectedDevices attempt ${attempt + 1}/${POLL_ATTEMPTS} returned ${connected.length}: ${connected.map(d => `${d.name ?? 'noname'}[${d.id}] mfr=${d.manufacturerData ?? 'null'}`).join(', ')}`);
        const batch = parseBatch(connected);
        // Merge — keep any side already found in a prior attempt.
        found = { ...batch.found, ...found };
        if (found.L && found.R) break;
        this._trace(`[G1] _resumeAlreadyConnected attempt ${attempt + 1}: found L=${!!found.L} R=${!!found.R} — ${found.L && found.R ? 'done' : 'waiting'}`);
      }

      if (found.L && found.R) {
        this._log('[G1] Both lenses already connected — skipping scan');
        // _connectFound resolves if ≥1 lens comes up and schedules the other's
        // reconnect itself. A total failure throws → fall through to scan.
        try {
          await this._connectFound(found);
          return true;
        } catch (e: any) {
          this._warn(`[G1] _resumeAlreadyConnected failed: ${e?.message ?? e} — falling through to scan`);
          return false;
        }
      }
      if (found.L || found.R) {
        // 2026-11-04 log: R sat in connectedDevices for all 5 polls (10s) while
        // L was absent — we then threw it away and ran a full 12s scan that
        // re-found R and had to redo discovery. Resume the side we have NOW and
        // let _scheduleReconnect's targeted scan pick up the missing side.
        this._log(`[G1] One lens already connected (${found.L ? 'L' : 'R'}) — resuming it, scanning for the other`);
        try {
          await this._connectFound(found);
          return true;
        } catch (e: any) {
          this._warn(`[G1] _resumeAlreadyConnected single-side failed: ${e?.message ?? e} — falling through to scan`);
          return false;
        }
      }
    } catch (e: any) {
      this._warn('[G1] _resumeAlreadyConnected failed:', e?.message ?? e);
    }
    return false;
  }

  private async _scan(channel?: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
      let settled = false;
      const done = (fn: () => void | Promise<void>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsub();
        fn();
      };
      const found: Partial<Record<Side, Device>> = {};
      const timeout = setTimeout(() => {
        done(() => reject(new Error('G1 glasses not found. Make sure they are on and in range.')));
      }, SCAN_TIMEOUT_MS);

      const unsub = await this._subscribeScan((error, device) => {
        if (error) { done(() => reject(error)); return; }
        if (!device?.name) return;

        const side = this._parseSide(device);
        if (!side) return;
        if (found[side]) return;
        if (!this._matchesPair(device, side)) return;
        this._learnPairedId(device, side);

        found[side] = device;

        if (found.L && found.R) {
          // Both lenses found — connect in parallel via per-side queues.
          done(() => this._connectFound(found).then(resolve, reject));
        } else {
          // One lens found — give the other a short window to advertise before
          // resolving with one. _connectFound schedules the missing side.
          setTimeout(() => {
            done(() => this._connectFound(found).then(resolve, reject));
          }, 1500);
        }
      });
    });
  }

  /**
   * Decode G1 manufacturer advertisement data.
   * Format: [side(1)] [S] [firmware(6)] [serial(7)] [padding(5)]
   *   side: 0x01 = Right, 0x02 = Left
   *   serial: e.g. "H290028" or "H290036" — unique per physical pair
   *
   * Falls back to name parsing if manufacturerData is absent.
   */
  private _parseManufacturerData(device: Device): { side: Side; serial: string; firmware: string } | null {
    if (device.manufacturerData) {
      try {
        const buf = base64ToUint8(device.manufacturerData);
        // Side byte: 0x01 = R, 0x02 = L (confirmed from EvenBridge source).
        // Log unknown values so we can diagnose without silently masking them.
        let side: Side;
        if (buf[0] === 0x02) side = 'L';
        else if (buf[0] === 0x01) side = 'R';
        else {
          // Only log the unknown-byte warning for devices that look like G1 glasses
          // (name contains "G1"). Samsung TVs, Quest headsets, etc. all have mfr
          // data — logging every one pollutes the log and buries real signal.
          if (device.name?.includes('G1')) {
            this._warn(`[G1] _parseManufacturerData: unknown side byte 0x${buf[0].toString(16).padStart(2,'0')} for "${device.name}" — falling through to name parse`);
          }
          // Fall through to name-based parsing below rather than guessing.
          throw new Error('unknown side byte');
        }
        const firmware = String.fromCharCode(...buf.slice(2, 8)).replace(/\0/g, '');
        const serial   = String.fromCharCode(...buf.slice(8, 15)).replace(/\0/g, '');
        if (serial.length > 0) return { side, serial, firmware };
      } catch {}
    }
    // Fallback: parse from name.
    // Normalize "Even G1_..." → "G1_..." so the regex matches regardless of prefix.
    // Channel segment may contain letters as well as digits (e.g. "5L" in "G1_5L_L_810D29"),
    // so use [A-Za-z0-9]+ rather than \d+.
    const name = (device.name ?? '').replace(/^Even G1/, 'G1');
    const m = name.match(/G1_([A-Za-z0-9]+)_([LR])_([0-9A-Fa-f]+)/);
    if (m) {
      // Strip any trailing side letter from the channel token so "5L" and "5" both
      // normalise to "5" — keeping L and R in the same logical pair.
      const ch = m[1].replace(/[LR]$/i, '');
      return { side: m[2] as Side, serial: `name-ch${ch}`, firmware: 'unknown' };
    }
    return null;
  }

  /** Extract channel/pair key from device. Uses serial from manufacturerData (preferred) or hex suffix from name. */
  private _parseChannel(device: Device): string | null {
    const parsed = this._parseManufacturerData(device);
    if (parsed) return parsed.serial;
    // Name format: "Even G1_5_L_810D29" or "G1_5L_R_D55156"
    // The hex suffix (e.g. "810D29") is the same serial stored during pairing when
    // manufacturerData was available. Extract it as the canonical channel key so
    // reconnect channel-filter matching works even when mfr=null (iOS connectedDevices).
    const name = (device.name ?? '').replace(/^Even G1/, 'G1');
    const mHex = name.match(/G1_[A-Za-z0-9]+_[LR]_([0-9A-Fa-f]+)/);
    if (mHex) return mHex[1];
    // last-resort: channel number only (loses hex, but allows unfiltered reconnect)
    const mCh = name.match(/G1_([A-Za-z0-9]+)_[LR]/);
    return mCh ? mCh[1].replace(/[LR]$/i, '') : null;
  }

  /**
   * Is this peripheral the `side` lens of the pair we're bound to?
   *   1. No paired serial yet (first pairing) → accept.
   *   2. We've learned this side's peripheral id → exact id match only.
   *   3. Otherwise require mfr-data serial === paired serial.
   *   4. No mfr data and no known id → reject. The name hex suffix is NOT the
   *      serial and connectedDevices() on iOS never carries mfr data, so there
   *      is nothing to verify against; the scan path (which has mfr data) will
   *      find it and record the id.
   */
  private _matchesPair(device: Device, side: Side): boolean {
    if (!this._pairedSerial) return true;
    const knownId = this._pairedIds[side];
    if (knownId) return device.id === knownId;
    const parsed = this._parseManufacturerData(device);
    return !!parsed && parsed.serial === this._pairedSerial;
  }

  /** Record a verified peripheral id for `side` once mfr data confirms the serial. */
  private _learnPairedId(device: Device, side: Side): void {
    const parsed = this._parseManufacturerData(device);
    if (!parsed || parsed.serial.startsWith('name-ch')) return;
    if (!this._pairedSerial) this._pairedSerial = parsed.serial;
    if (parsed.serial !== this._pairedSerial) return;
    if (this._pairedIds[side] !== device.id) {
      this._pairedIds[side] = device.id;
      this._log(`[G1] _learnPairedId [${side}] ${parsed.serial} → ${device.id}`);
      this._emitStatus();
    }
  }

  /** Parse Side from device. Uses manufacturerData byte (preferred) or name. */
  private _parseSide(device: Device): Side | null {
    const parsed = this._parseManufacturerData(device);
    if (parsed) return parsed.side;
    // last-resort: name-based
    const name = (device.name ?? '').replace('Even G1', 'G1');
    if (!name.startsWith('G1_')) return null;
    for (const part of name.split('_')) {
      if (part === 'L') return 'L';
      if (part === 'R') return 'R';
    }
    return null;
  }

  // ── Connection ────────────────────────────────────────────────────────────

  /**
   * Canonical enqueue point for all _connectLens calls.
   *
   * Guards:
   *   - destroyed: class is torn down
   *   - txChars[side]: already connected — no-op
   *   - _connectingOnSide[side]: a _connectLens is mid-execution — no-op
   *
   * Previously this pattern was copy-pasted four times (_reconnectDropped,
   * _scheduleReconnect×2, _resumeAlreadyConnected). Each copy had subtly
   * different guards, which caused the Bug #10 scan storm (txChars guard
   * missing from two sites). Centralising here ensures every code path is
   * consistent.
   */
  private _enqueueConnect(side: Side, device: Device): void {
    // "Already up" only counts if the lens we hold IS the one being requested.
    // Holding a different peripheral (other pair's lens) must not block the
    // correct one — _connectLensInner evicts the stranger.
    const holdingThis = () => !!this.txChars[side] && this.devices[side]?.id === device.id;
    if (this.destroyed || holdingThis() || this._connectingOnSide[side]) {
      this._log(`[G1] _enqueueConnect [${side}] skipped — destroyed=${this.destroyed} txChars=${!!this.txChars[side]} connecting=${this._connectingOnSide[side]}`);
      return;
    }
    void this._runOnQueue(side, async () => {
      if (this.destroyed || holdingThis()) return; // re-check: may have connected while queued
      try { await this._connectLens(side, device); }
      catch { this._scheduleReconnect(side); }
    });
  }

  /**
   * Serialise `fn` on the per-side connect queue. The queue itself NEVER holds
   * a rejected promise — the 2026-11-04 log showed L's queue poisoned by a
   * single connect() timeout at 14:34:55, after which every later
   * _enqueueConnect('L') chained `.then()` onto a rejected promise and silently
   * never ran. User "Reconnect L" taps found the lens via scan and did nothing.
   * Callers still see the rejection via the returned promise.
   */
  private _runOnQueue<T>(side: Side, fn: () => Promise<T>): Promise<T> {
    const p = this._connectQueue[side].then(fn);
    this._connectQueue[side] = p.then(() => undefined, () => undefined);
    return p;
  }

  /**
   * Connect whichever lenses are in `found` (one or both). Resolves if at
   * least one lens reaches txReady; rejects only if every attempted lens
   * failed. Any side that is missing or failed gets its device cached (so the
   * reconnect path can skip scanning) and a _scheduleReconnect — previously a
   * failed side in a pair-connect was orphaned: no timer, no cached device.
   * Used by _scan (both paths) and _resumeAlreadyConnected.
   */
  private async _connectFound(found: Partial<Record<Side, Device>>): Promise<void> {
    const sides = (['L', 'R'] as Side[]).filter(s => found[s]);
    for (const s of sides) {
      // Cache before connecting so a connect() failure still leaves
      // _scheduleReconnect with a device to retry (no re-scan needed).
      // Do NOT overwrite a cached different peripheral here — _connectLensInner
      // uses devices[s].id !== found.id to detect and evict a wrong-pair lens.
      if (!this.devices[s]) this.devices[s] = found[s]!;
    }
    const results = await Promise.allSettled(
      sides.map(s => this._runOnQueue(s, () => this._connectLens(s, found[s]!))),
    );
    const okSides = sides.filter((_, i) => results[i].status === 'fulfilled');
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    for (const s of ['L', 'R'] as Side[]) {
      if (!okSides.includes(s)) {
        this._log(`[G1] _connectFound [${s}] ${found[s] ? 'failed' : 'not found'} — scheduling reconnect`);
        this.reconnectAttempts[s] = 0;
        this._scheduleReconnect(s);
      }
    }

    if (okSides.length === 0) throw failures[0]?.reason ?? new Error('G1 glasses not found. Make sure they are on and in range.');
    this._startHeartbeat();
  }

  private async _connectLens(side: Side, device: Device): Promise<void> {
    this._connectingOnSide[side] = true;
    try {
      await this._connectLensInner(side, device);
    } finally {
      this._connectingOnSide[side] = false;
    }
  }

  private async _connectLensInner(side: Side, device: Device): Promise<void> {
    // #23: iOS BLE fires onDeviceConnected repeatedly for an already-connected
    // peripheral. The fast silent-ACK-reuse path resolves in ~100ms, making
    // _connectingOnSide briefly false — letting subsequent callbacks in.
    // Gate here on rxSubs (live notification subscription) as the definitive
    // "already initialised" signal, independent of timing.
    //
    // Zoracon: don't silently bail if the lens is in a broken half-init state
    // (rxSubs live but txReady false — e.g. a prior silent-ACK timeout left the
    // sub wired but aborted before _setConnected). Tear down and re-enter so the
    // reconnect path actually recovers instead of looping on a dead state.
    if (this.rxSubs[side]) {
      const held = this.devices[side];
      const txReady = side === 'L' ? this.status.left.txReady : this.status.right.txReady;
      if (held && held.id !== device.id) {
        // 2026-11-04 log: rxSubs[R] was live for G1_30_R (the other pair's
        // lens, grabbed before the pair filter existed) when the reconnect
        // scan found the real H290028 R. The old guard saw "an R is up" and
        // skipped — so we held the stranger forever and every 0x4e text
        // timed out. The live sub is for the WRONG peripheral: drop it.
        this._warn(`[G1] _connectLensInner [${side}] held ${held.name ?? held.id} ≠ target ${device.name ?? device.id} — dropping wrong lens`);
        this.rxSubs[side]!.remove();
        this.rxSubs[side] = undefined;
        this.txChars[side] = undefined;
        this.devices[side] = undefined;
        this._lastSilentAckAt[side] = 0;
        this._setConnected(side, false);
        try { await held.cancelConnection(); } catch (e: any) {
          this._warn(`[G1] _connectLensInner [${side}] cancelConnection on wrong lens failed: ${e?.message ?? e}`);
        }
      } else if (txReady) {
        this._log(`[G1] _connectLensInner [${side}] skipped — RX subscription already live and txReady`);
        return;
      } else {
        this._log(`[G1] _connectLensInner [${side}] stale rxSub (txReady=false) — tearing down and re-entering`);
        this.rxSubs[side]!.remove();
        this.rxSubs[side] = undefined;
      }
    }
    this._log(`[G1] _connectLensInner [${side}] enter — device=${device.name ?? device.id}`);
    let connected: Device;
    try {
      // Explicit timeout prevents CoreBluetooth from hanging indefinitely when
      // the lens is out of range or held by another central. Without it,
      // connect() never rejects → _connectingOnSide stays true → the per-side
      // queue blocks → L never retries even after R has been running for hours.
      connected = await device.connect({ autoConnect: false, timeout: 15000 });
    } catch (e: any) {
      // DeviceConnectionFailed (200) is iOS didFailToConnect — the CoreBluetooth
      // code is the only thing that distinguishes "stale bond, Forget in
      // Settings" (CBError 14) from "held by another central" (6/7). Log it and
      // put it in the message so a screenshot of the pairing screen is enough.
      const be = e as BleError;
      this._log(
        `[G1] _connectLensInner [${side}] connect() failed name=${device.name} ` +
        `code=${be?.errorCode ?? '?'} ios=${be?.iosErrorCode ?? '?'} att=${be?.attErrorCode ?? '?'} reason=${be?.reason ?? '—'}`,
      );
      if (be?.errorCode === BleErrorCode.DeviceConnectionFailed) {
        // CBError.peerRemovedPairingInformation = 14; ble-plx's BleIOSErrorCode
        // enum stops at 12 so compare as a plain number.
        const hint = (be.iosErrorCode as number | null) === 14
          ? 'Pairing is stale — Settings → Bluetooth → Forget both lenses, then retry.'
          : 'Make sure the Even app (and any other phone) is fully closed.';
        throw new Error(`${side} lens connection failed (iOS ${be.iosErrorCode ?? '?'}). ${hint}`);
      }
      throw e;
    }
    const discovered = await connected.discoverAllServicesAndCharacteristics();
    this.devices[side] = discovered;
    // Capture RSSI at connect time
    if (side === 'L') this.status.left.rssi = device.rssi ?? null;
    if (side === 'R') this.status.right.rssi = device.rssi ?? null;

    // Find TX characteristic (write)
    const services = await discovered.services();
    for (const svc of services) {
      if (svc.uuid.toLowerCase() !== P.UART_SVC) continue;
      const chars = await svc.characteristics();
      for (const ch of chars) {
        if (ch.uuid.toLowerCase() === P.UART_TX) {
          this.txChars[side] = ch;
          // txReady is set after both TX and RX are wired — see _setConnected call below.
        }
        if (ch.uuid.toLowerCase() === P.UART_RX) {
          this._log(`[G1] RX found [${side}] notifiable=${ch.isNotifiable}`);
          this.rxSubs[side]?.remove();
          try {
            this.rxSubs[side] = discovered.monitorCharacteristicForService(
              svc.uuid, P.UART_RX,
              (err, char) => this._onNotify(side, err, char),
            );
          } catch (monErr: any) {
            console.warn(`[G1] monitor setup failed [${side}]:`, monErr?.message ?? monErr);
          }
        }
      }
    }

    // NOTE: txReady is intentionally set AFTER handshake + silent complete below.
    // Setting it here would flip isConnected immediately and trigger React effects
    // (e.g. the reconnect-send useEffect in index.tsx) before the glass is ready,
    // causing 0x4e ACK timeouts and a connection_error loop.

    // Handshake — firmware does not ACK 0xF4, fire-and-forget.
    await this._send(side, P.handshake(), false);
    // Suppress firmware notification overlays (e.g. "Even AI unable to connect")
    // so they don't clobber our teleprompter display.
    // Use _sendForResult so we verify the ACK before marking txReady — a
    // fire-and-forget silent that times out must not silently promote the lens
    // to ready state (reproduces as one lens blank on startup, L vs R race).
    this._lastSilentAt[side] = Date.now();
    // If the glass already ACK'd OP_SILENT during this power-on cycle (e.g. the
    // ACK arrived while a prior _connectLens attempt was still waiting, or after
    // it timed out and gave up), skip the 12s wait entirely — the glass will NOT
    // send a second 0x03 ACK for the same boot cycle and we'd always time out.
    const silentAlreadyAckd = (Date.now() - this._lastSilentAckAt[side]) < G1Core.SILENT_ACK_REUSE_MS;
    if (silentAlreadyAckd) {
      this._log(`[G1] _connectLens [${side}] reusing recent silent ACK — skipping 12s wait`);
    } else {
      // Firmware ACK for OP_SILENT (0x03) arrives 5–8s after BLE connection in
      // observed logs — well outside the default 2s window. Use a generous 12s
      // timeout here so we don't reconnect-loop while the firmware is still
      // initialising. The 2s default is still appropriate for mid-session sends.
      // silent(false) = EXIT silent mode (03 0a). Firmware decomp
      // (display_dispatch_thread.c) shows silent mode SUSPENDS the master
      // lens's display thread — which both blanks the HUD and defers the
      // 0x4e text ACK indefinitely (ble_process_req_dispatch.c case 0x4e:
      // master defers ACK to the display thread via DAT_20019a69).
      // We previously sent silent(true) here believing it asserted display
      // ownership; it actually turned the display OFF. Same opcode, same
      // ACK path, so txReady gating is unchanged.
      let silentOk = await this._sendForResult(side, P.silent(false), 12000);
      // #27: no 0x03 ACK means the firmware is asleep (in case / powered down),
      // not that the link is bad — in the 2026-10-25 log both lenses were
      // BLE-connected for 2.5 min with zero RX of any kind, then R emitted a
      // 0xf5 event and ACK'd 0x03 100 ms later. Tearing down + rediscovering
      // 12× per side bought nothing. Hold the link, wait for the first
      // unsolicited frame, and retry the silent command.
      while (!silentOk) {
        if (this.destroyed || !this.rxSubs[side]) return; // _onDisconnected owns cleanup + reconnect
        this._setAsleep(side, true);
        this._log(`[G1] _connectLens [${side}] no silent ACK — firmware asleep, holding link until first RX`);
        await this._waitForWake(side);
        if (this.destroyed) return;
        if (!this.rxSubs[side]) { this._scheduleReconnect(side); return; } // link dropped while asleep
        this._log(`[G1] _connectLens [${side}] woke — re-sending silent(false)`);
        this._lastSilentAt[side] = Date.now();
        silentOk = await this._sendForResult(side, P.silent(false), 12000);
      }
      this._setAsleep(side, false);
    }

    // Mark TX as ready only after init sequence is complete — the RX monitor
    // is already live (set up in the loop above) so ACKs are handled correctly.
    this._textNackCount[side] = 0; // fresh link — restart telemetry streak
    if (side === 'L') this.status.left.txReady = true;
    if (side === 'R') this.status.right.txReady = true;
    this._log(`[G1] _connectLensInner [${side}] txReady — init complete`);
    this._setConnected(side, true);
    this.reconnectAttempts[side] = 0;

    // Request battery level after connect
    setTimeout(() => this._send(side, P.batteryRequest(PHONE)), 500);

    // Watch for disconnection.
    // Capture the generation counter at registration time. If _connectLens
    // runs again (reconnect) before this fires, the generation increments and
    // this stale handler becomes a no-op — preventing it from corrupting the
    // new healthy connection.
    const gen = ++this._connGen[side];
    discovered.onDisconnected((err) => {
      if (this._connGen[side] !== gen) return; // stale — a newer connection replaced this one
      this._onDisconnected(side, err ?? undefined);
    });
  }

  private _onDisconnected(side: Side, err?: Error): void {
    const be = err as BleError | undefined;
    this._log(
      `[G1] onDisconnected [${side}]` +
      (be ? ` code=${be.errorCode ?? '?'} ios=${be.iosErrorCode ?? '?'} reason=${be.reason ?? '—'}` : ' (no error)'),
    );
    // One BLE drop surfaces here up to 3× within ~5ms: the RX monitor error
    // (no code), the OS onDisconnected (201), then OperationCancelled (2) from
    // the monitor being torn down. Each call used to bump reconnectAttempts,
    // so the FIRST retry after a single drop waited 4s instead of 1s and the
    // backoff hit its 10s ceiling after two drops. Only the first call tears
    // down + schedules; the rest are duplicates of a drop already handled.
    if (!this.rxSubs[side] && !this.txChars[side] && this._reconnectTimers[side]) {
      this._log(`[G1] onDisconnected [${side}] — duplicate, reconnect already scheduled`);
      return;
    }
    // Cancel all pending ACK waiters — a disconnected lens will never respond.
    // This prevents stale waiters from timing out sequentially and producing
    // a cascade of false-alarm log lines after reconnect.
    this._drainAckWaiters(side);
    this._setConnected(side, false);
    this.txChars[side] = undefined;
    // #27: rxSubs is nulled below, so the asleep-wait loop in
    // _connectLensInner sees the drop and exits after we resolve it.
    // Tear down the RX subscription so _connectLensInner's rxSubs guard
    // doesn't mistake a stale subscription for "already initialised" and
    // silently skip the reconnect attempt. This is the same invariant as the
    // silent-ACK abort path — any exit from a connect lifecycle must leave
    // rxSubs null so the next _enqueueConnect enters _connectLensInner cleanly.
    this.rxSubs[side]?.remove();
    this.rxSubs[side] = undefined;
    this._resolveWake(side);
    // Invalidate the silent-ACK reuse timestamp.  _onDisconnected is called
    // either on a genuine BLE disconnect or when we force-disconnect after
    // consecutive text NACKs (display-dead).  In both cases the firmware may
    // have rebooted and will send a fresh 0x03 ACK on the next connect — the
    // old timestamp is no longer valid, and reusing it would skip the 12s
    // _sendForResult wait and promote a still-initialising firmware to txReady.
    this._lastSilentAckAt[side] = 0;
    // Also zero the send-timestamp so the no-waiter OP_SILENT ACK handler
    // (see _onNotify) cannot stamp _lastSilentAckAt from a ghost buffered ACK
    // that iOS delivers on the new RX subscription before we've actually sent
    // the silent command in the new connection cycle.  The handler gates on
    // _lastSilentAt[side] !== 0, which is only true after _connectLensInner
    // (or _sendSilent) has written the command.
    this._lastSilentAt[side] = 0;
    // Disarm the OP_TEXT ghost-ACK gate too: any 0x4e delivered on the next
    // connection before we re-write text is a stale buffered frame and must be
    // rejected (see _lastTextWriteAt). Without this reset the gate would stay
    // armed from the dead connection and admit the very ghost we guard against.
    this._lastTextWriteAt[side] = 0;
    this._scheduleReconnect(side);
  }

  private _scheduleReconnect(side: Side): void {
    if (this.destroyed) return;
    // Cancel any existing timer for this side before scheduling a new one.
    clearTimeout(this._reconnectTimers[side]);
    const attempts = this.reconnectAttempts[side] ?? 0;
    const delay = RECONNECT_BACKOFF_MS[Math.min(attempts, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempts[side] = attempts + 1;
    this._log(`[G1] _scheduleReconnect [${side}] attempt=${attempts + 1} delay=${delay}ms`);
    this._reconnectTimers[side] = setTimeout(async () => {
      this._reconnectTimers[side] = undefined;
      if (this.destroyed) return;
      let dev = this.devices[side];
      if (dev && !this._matchesPair(dev, side)) {
        // Cached device predates the pair binding (or belongs to the other
        // set). Reconnecting it would re-grab the wrong lens — drop and scan.
        this._log(`[G1] _scheduleReconnect [${side}] cached ${dev.name ?? dev.id} is not the paired ${this._pairedSerial} — discarding`);
        this.devices[side] = undefined;
        dev = undefined;
      }

      if (!dev) {
        // This side was never found during the initial scan (e.g. L didn't
        // advertise in time). Run a short targeted scan to find it now.
        if (this._connectingOnSide[side]) {
          this._log(`[G1] _scheduleReconnect [${side}] scan already in progress — skipped`);
          return;
        }
        this._log(`[G1] _scheduleReconnect [${side}] no cached device — scanning`);
        // Mark in-flight for the scan's duration so reconnectSide()/_enqueueConnect
        // treat it like an active connect and don't start a competing scan.
        this._connectingOnSide[side] = true;
        try {
          const found = await new Promise<Device | null>(async (resolve) => {
            const finish = (d: Device | null) => { clearTimeout(t); unsub(); resolve(d); };
            const t = setTimeout(() => finish(null), 5000);
            const unsub = await this._subscribeScan((error, device) => {
              if (error) { finish(null); return; }
              if (!device?.name) return;
              // Same pair filter as the main scan — this unfiltered path was
              // the one that grabbed the other set's lens during reconnect.
              if (this._parseSide(device) === side && this._matchesPair(device, side)) {
                this._learnPairedId(device, side);
                finish(device);
              }
            });
          });
          this._connectingOnSide[side] = false;
          if (found) {
            this._enqueueConnect(side, found);
          } else {
            this._scheduleReconnect(side); // scan timed out, try again
          }
        } catch {
          this._connectingOnSide[side] = false;
          this._scheduleReconnect(side);
        }
        return;
      }

      // _enqueueConnect handles the _connectingOnSide / destroyed / txChars guards.
      this._enqueueConnect(side, dev);
    }, delay);
  }

  // ── ACK waiter queue (FIFO per ackKey) ──────────────────────────────────
  // Appends a waiter to the tail of its key's queue, creating the queue lazily.
  private _enqueueAckWaiter(
    ackKey: string,
    waiter: { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout>; seq: number },
  ): void {
    const q = this._pendingAck.get(ackKey);
    if (q) q.push(waiter);
    else this._pendingAck.set(ackKey, [waiter]);
  }

  // Finds the waiter in a key's queue whose seq matches `seq`. Used only for
  // OP_TEXT, whose firmware ACK echoes the originating seq at payload byte[2]
  // (verified against device frames: `4e <result> <seq> <chunk> …`, and the
  // decomp FUN_0007f41e(seq→field[4], result→field[6])). FIFO-head resolution
  // was wrong for TEXT: with R not gating the send queue (#25), multiple R
  // TEXT frames sit in-flight, so an ACK for seq=N could resolve seq=N-k's
  // waiter and absorb that frame's queue-wait into its reported ackLatency —
  // inflating `a` by queue depth, not true firmware render time. Seq-matching
  // makes `a` a true per-frame latency. Returns undefined if no waiter matches
  // (ACK for an already-timed-out frame) — caller then drops it, not the head.
  private _findAckWaiterBySeq(
    ackKey: string,
    seq: number,
  ): { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout>; seq: number } | undefined {
    const q = this._pendingAck.get(ackKey);
    if (!q) return undefined;
    return q.find((w) => w.seq === seq);
  }

  // Removes a specific waiter from its queue (by identity, not position — the
  // timeout/write-error paths must evict their own waiter, which may not be the
  // head). Deletes the map entry once the queue drains so `has()`/size stay honest.
  private _dequeueAckWaiter(
    ackKey: string,
    waiter: { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout>; seq: number },
  ): void {
    const q = this._pendingAck.get(ackKey);
    if (!q) return;
    const i = q.indexOf(waiter);
    if (i !== -1) q.splice(i, 1);
    if (q.length === 0) this._pendingAck.delete(ackKey);
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  private _onNotify(side: Side, error: Error | null, char: Characteristic | null): void {
    if (error) {
      const bleErr = error as BleError;
      const isDisconnect =
        bleErr.errorCode === BleErrorCode.DeviceDisconnected ||
        bleErr.errorCode === BleErrorCode.OperationCancelled;
      if (isDisconnect) {
        // Monitor subscription is dead — drive _onDisconnected directly so
        // cleanup + reconnect scheduling happen immediately rather than waiting
        // for the OS-level onDisconnected callback (which may arrive later or
        // not at all if the notify fires first on this iOS version).
        this._onDisconnected(side, error);
        return;
      }
      console.warn(
        `[G1] notify error [${side}] code=${bleErr.errorCode} reason=${bleErr.reason ?? '—'}:`,
        bleErr.message,
      );
      return;
    }
    if (!char?.value) return;
    const data = base64ToUint8(char.value);
    if (!data.length) return;
    this._resolveWake(side); // #27: any frame from a sleeping lens means it woke

    const op = data[0];
    // Harness-scoped raw text-ACK tap. Placed at the RX DECODE site (not in
    // _recordTextAckSeq) because the lens-race uses raceSendTextToSide →
    // _send(awaitAck=false): no ACK waiter is registered, so the waiter-match
    // block below is skipped and _recordTextAckSeq never runs. This sees EVERY
    // 0x4e ACK on the radio regardless of waiter state. data[2] = echoed seq.
    // No-op unless the harness registered an observer.
    if (op === P.OP_TEXT && this._onTextAckRaw) this._onTextAckRaw(side, data[2]);
    // Routine 0x25 heartbeat RX carries no per-frame diagnostic value and
    // arrives ~continuously from both lenses — ~98% of all RX volume. Logging
    // each one floods the 1000-line HUD ring and evicts SKEW/ACK lines before
    // they can be read (skew capture 2026-11-15: 987/1000 lines were 0x25,
    // every SKEW line lost). Count them instead; dump the count on any
    // non-heartbeat frame so the rate is still visible when triaging.
    if (op === P.OP_HEARTBEAT) {
      this._hbRxCount[side]++;
    } else {
      if (this._hbRxCount.L || this._hbRxCount.R) {
        this._trace(`[G1 RX] 0x25 heartbeats since last frame: L=${this._hbRxCount.L} R=${this._hbRxCount.R}`);
        this._hbRxCount.L = 0; this._hbRxCount.R = 0;
      }
      this._trace(`[G1 RX ${side}] op=0x${op.toString(16).padStart(2,'0')} len=${data.length} raw=${Array.from(data).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);
    }

    // ── Protocol-level ACK ────────────────────────────────────────────────
    // The firmware echoes the command opcode in data[0] and puts the result
    // in data[1]: 0xC9 or 0xCB = ok, anything else = nack.
    // Look up the pending waiter by side+opcode key (e.g. "L4e").
    //
    // Exception: OP_BATTERY (0x2C) responses use a different status format —
    // data[1]=0x66 is a battery-specific status byte, not a protocol ACK.
    // Always route battery packets directly to the OP_BATTERY handler below.
    const ackKey = `${side}${op.toString(16).padStart(2, '0')}`;
    // FIFO: the oldest in-flight waiter for this key is the one this ACK
    // belongs to (BLE notifications are in-order per characteristic). Peek
    // without removing yet — the ghost-ACK gate below may drop this packet.
    const queue = this._pendingAck.get(ackKey);
    const pending = queue && queue.length > 0 ? queue[0] : undefined;
    // Ghost-ACK gate (OP_TEXT only): the text ACK waiter is keyed `${side}4e`
    // with no seq, so a 0x4e buffered by iOS from the previous connection and
    // replayed on the fresh RX subscription would resolve the seq=0 waiter in
    // ~3ms — before the firmware has actually rendered — leaving the lens on
    // stale content. A real 0x4e can only follow a write we issued this cycle.
    // If _lastTextWriteAt is 0 we have not written text yet, so this ACK is a
    // ghost: drop it WITHOUT resolving the waiter, so the real ACK (which the
    // display thread sends ~1.5s later) still lands. Same shape as the
    // OP_SILENT `_lastSilentAt !== 0` gate below (Bug #10, 2026-09-27).
    if (pending && op === P.OP_TEXT && this._lastTextWriteAt[side] === 0) {
      this._warn(`[G1] OP_TEXT ghost ACK [${side}] dropped — no text write armed this cycle (stale iOS buffer)`);
      return;
    }
    // OP_TEXT resolves by echoed seq (byte[2]), NOT FIFO head — see
    // _findAckWaiterBySeq. The ghost gate above already peeked the head; a
    // real ACK past that gate carries a seq we can match exactly. An ACK whose
    // seq matches no in-flight waiter is for a frame that already timed out —
    // drop it (do NOT fall through and resolve some other seq's waiter).
    if (op === P.OP_TEXT && pending) {
      const ackSeq = data[2];
      const target = this._findAckWaiterBySeq(ackKey, ackSeq);
      if (!target) {
        this._warn(`[G1] OP_TEXT ACK [${side}] seq=${ackSeq} has no in-flight waiter — dropped (late/timed-out)`);
        return;
      }
      clearTimeout(target.timer);
      this._dequeueAckWaiter(ackKey, target);
      const status = data[1];
      const ok = status === P.R_STATUS_OK || status === P.R_STATUS_OK2;
      target.resolve(ok);
      return;
    }
    if (pending && op !== P.OP_BATTERY) {
      clearTimeout(pending.timer);
      this._dequeueAckWaiter(ackKey, pending);
      const status = data[1];
      const ok = status === P.R_STATUS_OK || status === P.R_STATUS_OK2;
      // Track silent ACK receipt so _connectLens can skip the 12s wait on
      // reconnect if the glass already ACK'd during this power-on cycle.
      if (op === P.OP_SILENT && ok) this._lastSilentAckAt[side] = Date.now();
      pending.resolve(ok);
      return;
    }
    // OP_SILENT ACK arrived with no pending waiter (e.g. arrived after a prior
    // _connectLens already gave up and rescheduled). Record the timestamp so the
    // next _connectLens attempt can skip its 12s wait — BUT only if we have
    // actually sent a silent in this connection cycle (_lastSilentAt[side] !== 0).
    // If _lastSilentAt is 0 the ACK is a ghost: a buffered iOS notification from
    // the previous connection, delivered on the new RX subscription before we have
    // written anything.  Accepting it would incorrectly enable the fast-path and
    // let _connectLensInner skip the full firmware-init wait, leaving R in a state
    // where it never ACKs 0x4e.  (Bug #10 resurfacing — fixed 2026-09-27.)
    if (op === P.OP_SILENT && this._lastSilentAt[side] !== 0) {
      const status = data[1];
      if (status === P.R_STATUS_OK || status === P.R_STATUS_OK2) {
        this._lastSilentAckAt[side] = Date.now();
        this._trace(`[G1] OP_SILENT late ACK [${side}] — recorded for next _connectLens`);
      }
    }
    // Clean up any battery ACK waiter — it resolves successfully since we got a response.
    if (op === P.OP_BATTERY && pending) {
      clearTimeout(pending.timer);
      this._dequeueAckWaiter(ackKey, pending);
      pending.resolve(true);
    }

    // ── Heartbeat (firmware-initiated) ───────────────────────────────────
    // The glasses send 0x25 to us; we echo it straight back. We do NOT send
    // unsolicited heartbeats — the firmware owns the heartbeat clock.
    if (op === P.OP_HEARTBEAT) {
      this._send(side, data, false).catch(() => {});
      return;
    }

    if (op === P.OP_EVENT) {
      const event = P.parseEvent(data, side);
      if (event) {
        // Routine housekeeping events fire every ~47s (status_ping, battery,
        // charging). Trace-only — they account for ~45% of ring-buffer lines
        // and push lifecycle events out before capture. Non-routine events
        // (e.g. display takeover, taps) are always logged.
        const isRoutine = event.name === 'status_ping' || event.name === 'battery' || event.name === 'charging';
        const line = `[G1 EVENT ${side}] subcmd=0x${event.subcmd.toString(16).padStart(2,'0')} name="${event.name}"`;
        if (isRoutine) this._trace(line);
        else this._log(line);
        // op=0x11 ('status_ping') — fires after every battery poll response
        // (0x2c) as a routine firmware heartbeat. Confirmed from log correlation:
        // f5 11 always arrives within ~300ms of a 0x2c battery packet on R.
        // It is NOT a display-takeover signal. Genuine reconnects are handled
        // by _connectLens (which calls _sendSilent before setting txReady).
        // Intentionally ignored here. See issue #18 for full diagnosis.

        // Even AI / dashboard overlays steal the display. When the firmware
        // signals that a foreign overlay has opened or closed, re-assert Cue's
        // silent-mode ownership so we can push content again.
        // dashboard_open  (0x1e): overlay appeared — silence immediately so we
        //   don't fight the firmware mid-animation.
        // dashboard_close (0x1f): overlay dismissed — re-silence to reclaim.
        // ai_start        (0x17): triple-tap fired Even AI — same treatment.
        //
        // NOTE: opcode semantics for 0x1e/0x1f/0x17 are also community-sourced,
        // not verified from firmware. Treat as working assumptions (see issue #18).
        if (
          event.name === 'dashboard_open' ||
          event.name === 'dashboard_close' ||
          event.name === 'ai_start'
        ) {
          this._log(`[G1] display takeover event "${event.name}" [${side}] — re-asserting silent`);
          // Do NOT drain ACK waiters here. Draining kills in-flight OP_TEXT
          // sends whose ACK simply hasn't arrived yet (R delays 15-19s when
          // audio is streaming). Draining causes those sends to NACK, the
          // _enqueue swallows the error, and the HUD goes blank even though
          // the firmware successfully received the text.
          //
          // _drainAckWaiters is appropriate before a full reconnect
          // (_onDisconnected path) but NOT for display-takeover events.
          //
          // _sendSilent goes through _enqueue, so any sendText enqueued by
          // index.tsx's event handler will sequence behind it in _sendQueue —
          // no timing race between the silent and the content re-push.
          // For dashboard_open, silence immediately.
          // For close/ai_start, defer 300ms to let the overlay animation finish.
          if (event.name === 'dashboard_open') {
            this._sendSilent(side);
          } else {
            setTimeout(() => this._sendSilent(side), 300);
          }
        }

        this.eventHandlers.forEach(h => h(event));
      }
      return;
    }

    if (op === P.OP_BATTERY) {
      this._trace(`[G1] BATTERY raw [${side}]:`, Array.from(data).map(b => b.toString(16).padStart(2,'0')).join(' '));
      // resp[2] = battery % (confirmed from raw log). Each glass reports its own.
      const level = data[2] ?? 0;
      if (side === 'L') this.status.left.batteryPct = level;
      if (side === 'R') this.status.right.batteryPct = level;
      this._emitStatus();
      return;
    }
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  /**
   * Write one packet to one lens and (optionally) await the protocol-level ACK.
   *
   * ACK protocol (verified against official EvenDemoApp source):
   *   - Firmware echoes the command opcode in data[0]
   *   - Status is in data[1]: 0xC9 or 0xCB = ok, anything else = nack
   *   - Resolver is keyed by "<side><opcode_hex>" (e.g. "L4e") so concurrent
   *     sends on different opcodes don't clobber each other
   *   - We register the resolver BEFORE the write to avoid a race on fast ACK
   *
   * Uses writeCharacteristicWithResponse so iOS BLE won't silently drop
   * packets when the TX queue is full.
   *
   * Timeout: 2 s per packet. On timeout or NACK we log a warning but do not
   * throw — the caller's sequence continues. This matches the official app.
   */
  /**
   * Send silent(true) and record the timestamp so callers can rate-limit
   * subsequent re-silences (e.g. connection_error storms).
   */
  private _sendSilent(side: Side): void {
    // Do NOT send while the init sequence is in flight — txReady is only set
    // after the init silent ACK is received. An event-triggered silent here
    // would register a second R03/L03 waiter that evicts the init waiter,
    // resolving it false and triggering an unnecessary reconnect. (Bug #10.)
    const st = side === 'L' ? this.status.left : this.status.right;
    if (!st.txReady) {
      this._trace(`[G1] _sendSilent [${side}] suppressed — init in progress (txReady=false)`);
      return;
    }
    if (this.status.poweredOff) {
      this._trace(`[G1] _sendSilent [${side}] suppressed — user powered off`);
      return;
    }
    this._lastSilentAt[side] = Date.now();
    // Route through _enqueue so this silent is ordered in the same queue as
    // any subsequent sendText call. A bare _send here would race a sendText
    // enqueued by index.tsx's event handler — the silent could arrive on the
    // glasses AFTER the text, leaving "Silent" as the last visible frame.
    // silent(false): EXIT silent mode. silent(true) here would SUSPEND the
    // master lens's display thread (firmware decomp) — the opposite of
    // reclaiming the display after an overlay.
    this._enqueue(() => this._send(side, P.silent(false))).catch(() => {});
  }

  /**
   * Cancel and remove all pending ACK waiters for a given side.
   * Call before re-silencing after a connection_error so stale waiters don't
   * time out sequentially and produce a cascade of false-alarm log lines.
   */
  private _drainAckWaiters(side: Side): void {
    for (const [key, queue] of this._pendingAck.entries()) {
      if (key.startsWith(side)) {
        for (const waiter of queue) {
          clearTimeout(waiter.timer);
          waiter.resolve(false);
        }
        this._pendingAck.delete(key);
        this._trace(`[G1] _drainAckWaiters: cancelled ${queue.length} stale waiter(s) key=${key}`);
      }
    }
  }

  /**
   * Like _send but returns true on ACK ok, false on NACK/timeout/write-error.
   * Used by the heartbeat monitor to detect zombied lenses.
   */
  private async _sendForResult(side: Side, data: Uint8Array, timeoutMs = 2000): Promise<boolean> {
    const ch = this.txChars[side];
    const dev = this.devices[side];
    if (!ch || !dev) return false;

    const opHex = data[0].toString(16).padStart(2, '0');
    const ackKey = `${side}${opHex}`;
    const b64 = uint8ToBase64(data);

    let waiterRef: { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout>; seq: number } | undefined;
    const ackPromise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (waiterRef) this._dequeueAckWaiter(ackKey, waiterRef);
        this._warn(`[G1] _sendForResult [${side}] ACK timeout op=0x${opHex} after ${timeoutMs}ms`);
        resolve(false);
      }, timeoutMs);
      waiterRef = { resolve, timer, seq: -1 };
      this._enqueueAckWaiter(ackKey, waiterRef);
    });

    try {
      await Promise.race([
        dev.writeCharacteristicWithResponseForService(P.UART_SVC, P.UART_TX, b64),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('write timeout')), 3000)),
      ]);
    } catch (e: any) {
      if (waiterRef) { clearTimeout(waiterRef.timer); this._dequeueAckWaiter(ackKey, waiterRef); }
      const be = e as BleError;
      this._log(
        `[G1] _sendForResult [${side}] WRITE failed op=0x${opHex} ` +
        `code=${be?.errorCode ?? '?'} reason=${be?.reason ?? '—'} msg=${e?.message ?? e}`,
      );
      return false;
    }

    return ackPromise;
  }

  // OP_TEXT ACKs can arrive up to ~20s late on the right lens when audio is
  // streaming (0xf1 frames from the mic pipeline saturate firmware processing).
  // Give text sends a generous timeout so we don't NACK and blank the HUD.
  private static readonly ACK_TIMEOUT_TEXT_MS = 25_000;
  private static readonly ACK_TIMEOUT_DEFAULT_MS = 2_000;

  /**
   * @param onWritten fires once the write phase has finished — accepted by the
   *   lens, dropped, or failed — regardless of ACK. _sendBoth uses it as a
   *   barrier so the send queue can't run ahead of a slow lens's write.
   */
  private async _send(side: Side, data: Uint8Array, awaitAck = true, onWritten?: () => void): Promise<void> {
    try {
      await this._sendInner(side, data, awaitAck, onWritten);
    } finally {
      onWritten?.(); // idempotent: resolving a settled promise is a no-op
    }
  }

  private async _sendInner(side: Side, data: Uint8Array, awaitAck: boolean, onWritten?: () => void): Promise<void> {
    const ch = this.txChars[side];
    const dev = this.devices[side];
    if (!ch || !dev) {
      const opHex = data[0].toString(16).padStart(2, '0');
      this._warn(`[G1] _send [${side}] DROP op=0x${opHex} — txChars=${!!ch} dev=${!!dev} txReady=${side === 'L' ? this.status.left.txReady : this.status.right.txReady}`);
      return;
    }

    const opHex = data[0].toString(16).padStart(2, '0');
    const ackKey = `${side}${opHex}`;
    const b64 = uint8ToBase64(data);

    // Arm the OP_TEXT ghost-ACK gate at the SAME point the waiter is registered
    // (before the write) — not after. The waiter is registered pre-write to
    // catch a legitimate fast ACK; arming the gate here means a real ACK racing
    // the write is admitted, while a ghost ACK (delivered before we ever reach
    // this send) is still rejected because _lastTextWriteAt is 0 until now.
    if (awaitAck && data[0] === P.OP_TEXT) this._lastTextWriteAt[side] = Date.now();
    // Register ACK waiter BEFORE the write to prevent the fast-ACK race.
    let ackPromise: Promise<boolean> | null = null;
    let ackWaiter: { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout>; seq: number } | undefined;
    if (awaitAck) {
      // FIFO enqueue (no eviction): two TEXT sends on the same side can be
      // in-flight concurrently. The previous bug evicted seq=N's waiter when
      // seq=N+1 registered, so N+1 stole N's ACK and N reported ACK MISS.
      // Queueing lets each send await its own ACK, resolved oldest-first.
      ackPromise = new Promise<boolean>((resolve) => {
        const ackTimeout = data[0] === P.OP_TEXT
          ? G1Core.ACK_TIMEOUT_TEXT_MS
          : G1Core.ACK_TIMEOUT_DEFAULT_MS;
        const timer = setTimeout(() => {
          if (ackWaiter) this._dequeueAckWaiter(ackKey, ackWaiter);
          this._warn(`[G1] _send [${side}] ACK timeout op=0x${opHex} seq=${data[1]} after ${ackTimeout}ms`);
          resolve(false);
        }, ackTimeout);
        ackWaiter = { resolve, timer, seq: data[1] };
        this._enqueueAckWaiter(ackKey, ackWaiter);
      });
    }

    // Race the BLE write against a hard timeout — firmware can stall the radio
    // and writeCharacteristicWithResponse has no built-in deadline, which would
    // block _sendQueue indefinitely and freeze all subsequent sends.
    const WRITE_TIMEOUT_MS = 3000;
    // Sync telemetry (OP_TEXT only): write duration and ACK latency per side,
    // keyed by seq so L/R lines for the same frame can be paired in a log.
    const isText = data[0] === P.OP_TEXT;
    const seq = data[1];
    const t0 = Date.now();
    try {
      await Promise.race([
        dev.writeCharacteristicWithResponseForService(P.UART_SVC, P.UART_TX, b64),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('write timeout')), WRITE_TIMEOUT_MS)),
      ]);
    } catch (e: any) {
      // Clean up the specific ACK waiter we registered above (not the oldest
      // in the FIFO — another in-flight send may own that one).
      if (awaitAck && ackWaiter) {
        clearTimeout(ackWaiter.timer);
        this._dequeueAckWaiter(ackKey, ackWaiter);
      }
      const code = (e as BleError)?.errorCode;
      if (code === BleErrorCode.DeviceDisconnected || code === BleErrorCode.OperationCancelled) return;
      if (e?.message === 'write timeout') {
        this._warn(`[G1] _send [${side}] write stalled >3s op=0x${opHex} — dropping`);
        return;
      }
      this._warn(
        `[G1] _send [${side}] write failed code=${code ?? '?'} reason=${(e as BleError)?.reason ?? '—'}: ${e?.message ?? e}`,
      );
      return;
    }

    const tWritten = Date.now();
    if (isText) this._trace(`[G1] text seq=${seq} [${side}] written +${tWritten - t0}ms`);
    onWritten?.();
    if (!awaitAck || !ackPromise) return;

    const ok = await ackPromise;
    const tAck = Date.now();
    const ackLatency = tAck - tWritten;
    if (isText) this._trace(`[G1] text seq=${seq} [${side}] ${ok ? 'ack' : 'nack'} +${ackLatency}ms after write`);
    if (isText && ok) this._recordTextAckSeq(side, seq, tAck, tWritten - t0, ackLatency);
    if (!ok) {
      this._warn(`[G1] _send [${side}] NACK op=0x${opHex}`);
      if (data[0] === P.OP_TEXT) {
        this._textNackCount[side]++;
        this._warn(`[G1] _send [${side}] consecutive text NACKs=${this._textNackCount[side]}`);
        this._setDisplayIdle(side, true);
      }
    } else if (data[0] === P.OP_TEXT) {
      this._textNackCount[side] = 0;
      this._setDisplayIdle(side, false);
    }
  }

  /**
   * Lens-sync skew triage (OP_TEXT only). Record this side's ACK arrival time
   * keyed by seq. When BOTH sides have acked the same seq, log the signed skew
   *   skew = (L ack time − R ack time)
   * Positive ⇒ R acked first ⇒ R is ahead; negative ⇒ L ahead. Also tracks a
   * running mean so a sustained structural lead is obvious at a glance.
   * Telemetry only — does not alter send behavior.
   */
  private _recordTextAckSeq(
    side: Side,
    seq: number,
    ackAt: number,
    writeMs: number,
    ackLatMs: number,
  ): void {
    // PROBE (Bug B triage): record R text-ACKs in a set the skew pairing never
    // deletes, so the R-ACK-MISS probe in _sendBoth can distinguish "R never
    // acked" from "both acked and the skew pairing already cleaned up". The
    // probe prunes this set itself. Telemetry-only.
    if (side === 'R') this._rAckedSeqs.add(seq);
    if (side === 'L') this._lAckedSeqs.add(seq);
    this._textAckAt[side].set(seq, ackAt);
    this._textAckTiming[side].set(seq, { writeMs, ackLatMs });
    const other: Side = side === 'L' ? 'R' : 'L';
    const otherAt = this._textAckAt[other].get(seq);
    if (otherAt === undefined) return; // wait for the pair

    const lAt = side === 'L' ? ackAt : otherAt;
    const rAt = side === 'R' ? ackAt : otherAt;
    const skew = lAt - rAt; // >0 ⇒ R acked first ⇒ R leads

    // Backgrounded ACK timing is NOT link health. When iOS suspends the app it
    // stops granting CPU, so writes queue and ACKs are only processed when the
    // OS next schedules us — the field 2026-11-17 log showed ack-latency climb
    // to 16.5s with app=background, which the skew/mono detectors read as a
    // catastrophic link fault and would act on. That latency measures OS
    // throttling, not the glasses. Zoracon: drop the junk sample at its source
    // rather than widen thresholds to tolerate it. We DON'T seed the window
    // either — a suspended sample would poison the mean on resume. Both detectors
    // (resync + mono) are skipped; streaks are untouched so a real pre-suspend
    // streak survives the gap and resumes cleanly when active returns.
    if (this._appState !== 'active') {
      this._textAckAt[side].delete(seq);
      this._textAckAt[other].delete(seq);
      this._textAckTiming[side].delete(seq);
      this._textAckTiming[other].delete(seq);
      this._trace(`[G1] skew sample dropped — app ${this._appState} (ack timing is OS-throttled, not link)`);
      return;
    }

    this._skewWindow.push(skew);
    if (this._skewWindow.length > G1Core.SKEW_MEAN_WINDOW) this._skewWindow.shift();

    // Closed-loop corrector: count consecutive frames over the divergence
    // threshold; a transient one-frame spike resets the streak, sustained
    // divergence trips a resync. Reset the streak after firing so it re-arms.
    if (Math.abs(skew) >= G1Core.SKEW_RESYNC_THRESHOLD_MS) {
      this._skewBreachStreak++;
      if (this._skewBreachStreak >= G1Core.SKEW_RESYNC_BREACH_COUNT) {
        this._skewBreachStreak = 0;
        this._log(
          `[G1] SKEW-RESYNC seq=${seq} |skew|=${Math.abs(skew)}ms ≥ ` +
          `${G1Core.SKEW_RESYNC_THRESHOLD_MS}ms for ` +
          `${G1Core.SKEW_RESYNC_BREACH_COUNT} frames → re-anchoring lenses`,
        );
        this._onSkewResync?.(seq);
      }
    } else {
      this._skewBreachStreak = 0;
    }

    // Mono-fallback escalation: when skew is sustained BEYOND the fusion limit
    // the corrector can't win (the 2026-11-16 log: re-push made skew grow), so
    // we stop fighting for stereo and drive the healthy lens alone. Keyed off
    // the WINDOWED MEAN, not one frame — a single-sample sign is noise, and the
    // mean's sign reliably names the structural laggard. mean>0 ⇒ R leads ⇒ L
    // lags ⇒ keep R, blank L. Hysteresis: slow to enter, slower to leave.
    const meanAbs = Math.abs(this._skewMeanMs);
    if (this._monoSide === null) {
      // Entry gates on PER-FRAME skew ONLY, for a sustained streak. The windowed
      // MEAN must NOT gate magnitude: the 2026-11-15 log showed the per-frame
      // L-R oscillating across zero (+50, -24, -39, -85) while the mean stayed
      // ~27ms — the swings cancel in the mean, so a mean gate is BLIND to exactly
      // the sign-flipping doubling the user reports. The eye integrates each
      // frame's absolute offset, not the mean. Spike safety is preserved by the
      // STREAK, not the mean: a lone 600ms outlier is a streak of 1 and resets on
      // the next clean frame, so it never trips. The mean's SIGN is still used —
      // but only to name the laggard side in _pickMonoSide, never as a magnitude.
      if (Math.abs(skew) >= G1Core.SKEW_MONO_THRESHOLD_MS) {
        this._monoBreachStreak++;
        if (this._monoBreachStreak >= G1Core.SKEW_MONO_BREACH_COUNT) {
          const keep = this._pickMonoSide(this._skewMeanMs);
          // Log the PER-FRAME skew that actually tripped the gate, not the mean
          // — the gate is per-frame-streaked (see comment above), so printing the
          // mean (which the sign-flip cancels toward ~0) reads as a false "1ms ≥
          // 40ms" contradiction and misleads the next log reader. meanSign names
          // the laggard that _pickMonoSide used; |skew| is the magnitude.
          this._log(
            `[G1] MONO-FALLBACK seq=${seq} |skew|=${Math.abs(skew)}ms ≥ ` +
            `${G1Core.SKEW_MONO_THRESHOLD_MS}ms for ${G1Core.SKEW_MONO_BREACH_COUNT} ` +
            `frames (meanSign=${this._skewMeanMs >= 0 ? '+' : '-'}${meanAbs.toFixed(0)}ms)`,
          );
          // Shared drop: latches stereo off, resets streaks, notifies the HUD.
          this._tripMono(keep, `skew seq=${seq}`);
        }
      } else {
        this._monoBreachStreak = 0;
      }
    } else {
      // In mono: STAGE RULE — once dropped to mono, STAY mono for the rest of the
      // session. We do NOT auto-resume stereo mid-run. Rationale (operator, from
      // field use): on stage, reliant on one button, the glasses must never
      // flicker the echo back on their own while you're mid-sentence. An
      // automatic stereo re-entry that guesses "pace looks sustainable now" can
      // be wrong for one frame, and one frame of doubling in front of an audience
      // is the exact humiliation this whole subsystem exists to prevent. Stereo
      // is a PRE-SHOW decision, re-earned only by a deliberate operator action
      // (restart the prompter / explicit re-enable), never by the engine on its
      // own. We still track the recover streak purely for diagnostics/logging so
      // we can see whether the link WOULD have recovered, without acting on it.
      if (meanAbs < G1Core.SKEW_MONO_RECOVER_MS) {
        this._monoRecoverStreak++;
        if (this._monoRecoverStreak === G1Core.SKEW_MONO_RECOVER_COUNT) {
          this._log(
            `[G1] MONO-STABLE seq=${seq} |mean|=${meanAbs.toFixed(0)}ms < threshold for ` +
            `${G1Core.SKEW_MONO_RECOVER_COUNT} frames — link would support stereo, but ` +
            `staying mono (session-latched; stereo re-entry is a deliberate action only)`,
          );
        }
      } else {
        this._monoRecoverStreak = 0;
      }
    }
    const lead = skew > 0 ? 'R' : skew < 0 ? 'L' : '=';
    // Root-cause attribution: pull each side's write-accept vs ack-latency split.
    // L=write/ack  R=write/ack lets a reader see at a glance whether R's skew
    // comes from the RADIO (R.write >> L.write ⇒ iOS starvation) or the
    // FIRMWARE (R.ack >> L.ack ⇒ render/ESB-sync lag). Stamped with app state.
    const lt = this._textAckTiming.L.get(seq);
    const rt = this._textAckTiming.R.get(seq);
    // Per-side climb/jitter: rolling max (baseline) and Δa vs previous frame.
    // max↑ over a run ⇒ session-wide firmware degradation (timer re-handshake);
    // large +Δa that max doesn't track ⇒ transient render hitch (reactive).
    const climb = (s: Side, t?: { writeMs: number; ackLatMs: number }) => {
      if (!t) return '—';
      const prev = this._ackLatPrev[s];
      const d = prev === undefined ? 0 : t.ackLatMs - prev;
      this._ackLatPrev[s] = t.ackLatMs;
      if (t.ackLatMs > this._ackLatMax[s]) this._ackLatMax[s] = t.ackLatMs;
      return `w${t.writeMs}/a${t.ackLatMs}/Δ${d >= 0 ? '+' : ''}${d}/max${this._ackLatMax[s]}`;
    };
    const lFmt = climb('L', lt);
    const rFmt = climb('R', rt);
    this._log(
      `[G1] SKEW seq=${seq} L−R=${skew >= 0 ? '+' : ''}${skew}ms ` +
      `(${lead} leads) mean=${this._skewMeanMs >= 0 ? '+' : ''}${this._skewMeanMs.toFixed(0)}ms ` +
      `L[${lFmt}] R[${rFmt}] app=${this._appState}`,
    );
    // Drop both entries so the maps don't grow unbounded across a long scroll.
    this._textAckAt[side].delete(seq);
    this._textAckAt[other].delete(seq);
    this._textAckTiming[side].delete(seq);
    this._textAckTiming[other].delete(seq);
  }

  /**
   * #26: flip LensState.displayIdle and notify subscribers. Only fires a status
   * change on an actual transition so the UI doesn't re-render per line.
   * Note: a NACK on a side that is already disconnected (drained waiter) must
   * not mark it idle — _onDisconnected owns that state.
   */
  private _setDisplayIdle(side: Side, idle: boolean): void {
    const lens = side === 'L' ? this.status.left : this.status.right;
    if (lens.displayIdle === idle) return;
    if (idle && !lens.txReady) return;
    lens.displayIdle = idle;
    this._log(`[G1] displayIdle [${side}] = ${idle}`);
    this._emitStatus();
  }

  private _setAsleep(side: Side, asleep: boolean): void {
    const lens = side === 'L' ? this.status.left : this.status.right;
    if (lens.asleep === asleep) return;
    lens.asleep = asleep;
    this._log(`[G1] asleep [${side}] = ${asleep}`);
    this._emitStatus();
  }

  /** #27: resolves on the next RX frame from `side`, or when the side disconnects. */
  private _waitForWake(side: Side): Promise<void> {
    return new Promise<void>((resolve) => {
      this._wakeWaiters[side]?.();
      this._wakeWaiters[side] = resolve;
    });
  }

  private _resolveWake(side: Side): void {
    const w = this._wakeWaiters[side];
    if (!w) return;
    this._wakeWaiters[side] = undefined;
    w();
  }

  /**
   * Write to LEFT then RIGHT back-to-back; the queue gate is LEFT's ACK only.
   *
   * #25: the master lens defers its OP_TEXT ACK to the display thread, so a
   * right lens whose display is idle holds the ACK for the full
   * ACK_TIMEOUT_TEXT_MS. Awaiting it serially here throttled a *healthy* left
   * lens to one line per 25 s (L ACKs arrived in bursts right after each R
   * timeout). R's waiter still runs — logs, NACK counter and displayIdle all
   * see its result — it just no longer blocks the next send.
   *
   * The two writes are still issued in L→R order on the wire; only the
   * awaiting changed. sendBmp already issues both sides in parallel.
   */
  private async _sendBoth(data: Uint8Array): Promise<void> {
    // Barrier: L's ACK (#25 — never wait on R's 25 s text ACK) AND R's write
    // being accepted by the lens. Without the R-write barrier, a slow R let
    // _sendQueue advance on L's ACK alone, R's CoreBluetooth write queue grew
    // by one frame per tick, and R rendered one line behind L for the whole
    // scroll (field report 2026-11-04). Awaiting R's write caps R's lag at one
    // write (≤3 s via WRITE_TIMEOUT_MS) and lets sendText coalescing drop the
    // intermediate frames so both lenses land on the same line.
    //
    // Order: R write FIRST, then L. Firmware main.c:214 — the slave (R) drops
    // the master's ESB frame-sync with "slave recv wrong up package" when its
    // own BLE-received seq (esb_up_id) doesn't match the seq L is syncing, and
    // L only emits the deferred 0x4e ACK after that sync (threads.c:2183).
    // Issuing L and R concurrently let L's display thread sync before R had
    // the packet → R rejected the sync and stayed one line behind. Writing R
    // first costs one write RTT (~15-50 ms) and closes that window.
    // Mono-fallback: skew is un-fusible (see _monoSide). We show text on ONE
    // lens (the reader) and a blank on the other, so the viewer gets a single
    // clean image instead of a ghosted stereo pair. Only diverts TEXT frames;
    // control frames (battery, brightness, exit) still go to both lenses so
    // telemetry/state stay consistent.
    //
    // KEEP BOTH LENSES LIVE (2026-11-16 finding — see _pickMonoSide). We do NOT
    // one-shot-blank the non-content lens and leave it silent: on G1 the ESB
    // master starves if its slave stops receiving frames, which is what froze
    // keep-L in the old doctrine. Instead BOTH lenses get a fresh text frame
    // every tick — the reader gets 'data', the other gets a blank sharing the
    // SAME seq so the pair stays frame-aligned the way the firmware expects.
    // Write order mirrors the stereo barrier (R first so the slave has the
    // packet before the master syncs). Verified: L runs clean as reader this
    // way (log 2026-11-16T20:51, L ACKed 55s with no latency climb).
    if (this._monoSide !== null && data[0] === P.OP_TEXT) {
      const keep = this._monoSide;
      const drop: Side = keep === 'L' ? 'R' : 'L';

      const blank = P.text(' ', data[1], 1, 1, P.NewScreen.TEXT);
      const rFrame = keep === 'R' ? data : blank;
      const lFrame = keep === 'L' ? data : blank;
      let rWrittenMono!: () => void;
      const rWrittenMonoP = new Promise<void>((r) => { rWrittenMono = r; });
      const rSend = this._send('R', rFrame, true, rWrittenMono);
      rSend.catch((e) => this._warn(`[G1] mono [R] send error: ${e?.message ?? e}`));
      await rWrittenMonoP;
      await this._send('L', lFrame);
      this._trace(`[G1] mono seq=${data[1]} → text on ${keep}, blank on ${drop} (both live)`);
      return;
    }

    let rWritten!: () => void;
    const rWrittenP = new Promise<void>((r) => { rWritten = r; });
    const t0 = Date.now();
    const right = this._send('R', data, true, rWritten);
    right.catch((e) => this._warn(`[G1] _sendBoth [R] background send error: ${e?.message ?? e}`));
    await rWrittenP;
    await this._send('L', data);
    if (data[0] === P.OP_TEXT) {
      this._trace(`[G1] text seq=${data[1]} barrier released +${Date.now() - t0}ms (R written → L ack)`);
      // ── PROBE (Bug B triage, telemetry-only) ────────────────────────────
      // The barrier releases on "R written + L ack" but NEVER confirms R
      // rendered the seq. Field symptom: one load lands on one lens only
      // (left=old, right=new) and the coalescer never re-sends. R's text ACK
      // is awaited in the background (right.catch above) and recorded into
      // _textAckAt['R'] by _recordTextAckSeq. Here we watch that map: if R has
      // not acked THIS seq within the window, log an explicit R-ACK MISS so we
      // can confirm the split is "R silently dropped the frame" before changing
      // the send path. L is awaited above, so an L miss can't happen here.
      // Does NOT alter behavior — no re-send, no NACK, no state change.
      const probeSeq = data[1];
      const probeT0 = Date.now();
      setTimeout(() => {
        const rAcked = this._rAckedSeqs.has(probeSeq);
        const lAcked = this._lAckedSeqs.has(probeSeq);
        this._rAckedSeqs.delete(probeSeq); // probe owns pruning
        this._lAckedSeqs.delete(probeSeq);
        if (!rAcked || !lAcked) {
          const miss = !rAcked && !lAcked ? 'BOTH' : !rAcked ? 'R' : 'L';
          this._warn(
            `[G1] *** ACK MISS side=${miss} seq=${probeSeq} +${Date.now() - probeT0}ms — ` +
            `write flushed but no text ACK in window; likely one-lens desync. ${this.syncSnapshot}`,
          );
          // Background dead-lens detector. The skew path is dormant while locked
          // (no paired ACKs to tick it), so a sustained one-sided miss streak is
          // the only live signal that a lens has died. A single-side miss (L xor
          // R) names the dead lens; keep the OTHER lens. BOTH-miss is a total
          // stall (radio down, not one dead lens) — don't trip mono, it would
          // just move the reader onto an equally-dead lens; reset the streak.
          if (this._monoSide === null && (miss === 'L' || miss === 'R')) {
            if (this._ackMissSide === miss) {
              this._ackMissStreak++;
            } else {
              this._ackMissSide = miss;
              this._ackMissStreak = 1;
            }
            if (this._ackMissStreak >= G1Core.ACK_MISS_MONO_COUNT) {
              const keep: Side = miss === 'R' ? 'L' : 'R'; // keep the acking lens
              this._tripMono(keep, `ack-miss x${this._ackMissStreak} side=${miss}`);
              this._ackMissSide = null;
              this._ackMissStreak = 0;
            }
          } else {
            // BOTH-miss or already mono: the streak isn't evidence of one dead
            // lens, so clear it to avoid a stale trip when single misses resume.
            this._ackMissSide = null;
            this._ackMissStreak = 0;
          }
        } else {
          this._trace(`[G1] ack OK seq=${probeSeq} (L+R) within +${Date.now() - probeT0}ms`);
          // Clean paired ACK — the lens recovered. Reset the miss streak so an
          // intermittent single drop never accumulates across healthy frames.
          this._ackMissSide = null;
          this._ackMissStreak = 0;
        }
      }, G1Core.R_ACK_PROBE_MS);

      // Optional blind settle delay (default 0 = no-op). Holds the send queue
      // before the next frame so a lagging lens can flush/paint, reducing the
      // visible line-transition skew. See _settleDelayMs / setSettleDelayMs.
      if (this._settleDelayMs > 0) {
        await new Promise<void>((r) => setTimeout(r, this._settleDelayMs));
      }
    }
  }
  /** Window after barrier release within which R's text ACK is expected.
   *  Typical skew tethered is ~30ms; 800ms is generous headroom without
   *  colliding with R's pathological 15-25s audio-streaming ACK delay. */
  private static readonly R_ACK_PROBE_MS = 800;

  /** OPTIONAL line-transition settle delay (ms), OFF by default (0).
   *  After the send barrier releases, hold the queue this long before the
   *  NEXT frame can go out, giving a lagging lens's radio time to flush/paint
   *  so both lenses repaint closer together. This is a BLIND UX mitigation for
   *  the intrinsic two-radio display jitter (see _textAckAt caveat) — the skew
   *  is unobservable in software, so this cannot be auto-tuned; it's a
   *  judge-by-eye knob. Trade-off: every line transition is slowed by this
   *  amount. Set via setSettleDelayMs(). Default 0 = no behavior change. */
  private _settleDelayMs = 0;

  /** Set the optional line-transition settle delay (see _settleDelayMs).
   *  0 disables (default). Clamped to [0, 250] — beyond that the scroll feels
   *  laggy and the coalescer starts dropping user-intended lines. */
  setSettleDelayMs(ms: number): void {
    this._settleDelayMs = Math.max(0, Math.min(250, Math.round(ms)));
    this._log(`[G1] settleDelayMs set to ${this._settleDelayMs}ms`);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  private _hbCount = 0;

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this._hbCount = 0;
    // EXPERIMENT (2026-11-04): firmware low_speed_peripheral_dispatch_thread.c:217
    // disconnects (reason 0x13) when no app sync packet arrives for 30s, and
    // ble_process_put_req.c:6689 case 0x25 logs "received app send sync packet"
    // — the heartbeat is APP→GLASSES, not the reverse as previously assumed.
    // Log shows R dropping every ~31s with ios=7 (remote terminated). Send the
    // official-app heartbeat every 8s: 25 06 00 <seq> 04 <seq>.
    this.heartbeatTimer = setInterval(async () => {
      const seq = this._hbCount & 0xff;
      const hb = new Uint8Array([0x25, 0x06, 0x00, seq, 0x04, seq]);
      this._send('L', hb, false).catch(() => {});
      this._send('R', hb, false).catch(() => {});
      if (++this._hbCount % 4 === 0) {
        // Defer battery polling while text frames are actively flowing. The
        // poll shares the per-side _send queue with OP_TEXT; firing it mid-scroll
        // backs up the queue, forces coalescing to drop frames, and makes L/R
        // drop *different* lines → visible counter desync (field repro
        // 2026-11-05, beating at this % 4 cadence). _lastSent.at is stamped by
        // sendText; if the last text frame is younger than BATTERY_POLL_QUIET_MS
        // the user is mid-scroll, so skip this cycle — battery re-polls on the
        // next idle % 4 tick (≤4 × HEARTBEAT_INTERVAL_MS later).
        //
        // Also skip while backgrounded: a battery reading is useless when the
        // phone is locked, and iOS stops delivering the write so it NACKs every
        // cycle — a NACK storm for the whole lock duration (field 2026-11-16:
        // 0x2c NACKing ~every 2s for 29 min). The 0x25 keepalive above still
        // fires so the 30s firmware watchdog (reason 0x13) can't drop the link;
        // only the pointless poll is suppressed. Zoracon: this removes the junk
        // signal at its source, it does not mask a failed write.
        const sinceText = this._lastSent ? Date.now() - this._lastSent.at : Infinity;
        if (this._appState !== 'active') {
          this._trace('[G1] battery poll skipped — app backgrounded');
        } else if (sinceText < BATTERY_POLL_QUIET_MS) {
          this._trace(`[G1] battery poll deferred — text active (${sinceText}ms since last frame)`);
        } else {
          await this._send('L', P.batteryRequest(PHONE));
          await this._send('R', P.batteryRequest(PHONE));
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _nextSeq(): number {
    const s = this.seq & 0xff;
    this.seq = (this.seq + 1) & 0xff;
    return s;
  }

  private _emitStatus(): void {
    this.onStatusChange?.({
      left:  { ...this.status.left },
      right: { ...this.status.right },
      firmwareVersion: this.status.firmwareVersion,
      poweredOff: this.status.poweredOff,
    });
  }

  private _setConnected(side: Side, connected: boolean): void {
    const lens = side === 'L' ? this.status.left : this.status.right;
    lens.connected = connected;
    lens.displayIdle = false; // #26: fresh link, no evidence yet either way
    if (!connected) lens.asleep = false;
    if (!connected) { lens.rssi = null; lens.txReady = false; }
    // Drop any half-paired skew samples for this side on a link transition so a
    // reconnect doesn't pair a pre-drop ack with a post-reconnect one.
    this._textAckAt[side].clear();
    this._textAckTiming[side].clear();
    this._emitStatus();
    // Issue #7: restart heartbeat whenever both lenses are now up — covers the
    // single-lens reconnect path (_scheduleReconnect → _connectLens) which never
    // called _startHeartbeat. _startHeartbeat calls _stopHeartbeat first so this
    // is safe to call even if the timer is already running.
    if (connected && this.status.left.txReady && this.status.right.txReady) {
      this._startHeartbeat();
    }
  }
}
