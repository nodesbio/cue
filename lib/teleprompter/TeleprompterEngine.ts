/**
 * TeleprompterEngine.ts — state machine for the rolling teleprompter.
 *
 * Owns:
 *   - The wrapped line list (from lineWrapper)
 *   - Current scroll position (topIndex)
 *   - Play / pause / speed state
 *   - Loop mode
 *   - The interval timer that advances the window
 *
 * Does NOT own BLE — it calls a sendFrame callback you provide.
 * This keeps it fully testable and decoupled from G1Core.
 */

import { wrapScript, formatFrame, DEFAULT_SCRIPT, WINDOW_SIZE } from './lineWrapper';

// ── Types ──────────────────────────────────────────────────────────────────

export type EngineState = 'idle' | 'playing' | 'paused' | 'ended';

export interface EngineSnapshot {
  state: EngineState;
  topIndex: number;
  totalLines: number;
  secondsPerLine: number;
  loop: boolean;
  /** True when state=playing but auto-scroll is suspended after a prev() — resumes on next next(). */
  timerSuspended: boolean;
  /** The 5-line string currently on the glasses (or ready to send). */
  frame: string;
}

export interface TeleprompterEngineOptions {
  /** Called every time a new frame should be sent to the glasses. */
  onFrame: (frame: string, curLine: number, totalLines: number) => void;
  /** Called when state changes (play/pause/ended) — drives UI re-renders. */
  onStateChange: (snapshot: EngineSnapshot) => void;
  /** Initial script text. Defaults to DEFAULT_SCRIPT. */
  script?: string;
  /** Initial speed in seconds per line. Default 3.5s. */
  secondsPerLine?: number;
  /** Whether to loop. Default false. */
  loop?: boolean;
}

// ── Speed presets (seconds / line) ────────────────────────────────────────

export const SPEED_SLOW   = 4.5;
export const SPEED_NORMAL = 2.75; // default — midpoint of TURBO..SLOW range
export const SPEED_FAST   = 2.5;
export const SPEED_TURBO  = 1.0; // max speed (fastest)
export const SPEED_STEP   = 0.25; // step per +/− press
export const SPEED_MANUAL = Infinity;

// Gap between end-of-script and loop restart (ms)
const LOOP_RESTART_DELAY_MS = 3000;

// ── Engine ─────────────────────────────────────────────────────────────────

export class TeleprompterEngine {
  private lines: string[] = [];
  private topIndex = 0;
  private state: EngineState = 'idle';
  private secondsPerLine: number;
  private loop: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rewindTimer: ReturnType<typeof setInterval> | null = null;
  private loopRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private leftBat: number | null = null;
  private rightBat: number | null = null;
  // gestureHint is computed from live state — no timer needed.

  private onFrame: TeleprompterEngineOptions['onFrame'];
  private onStateChange: TeleprompterEngineOptions['onStateChange'];

  constructor(opts: TeleprompterEngineOptions) {
    this.onFrame = opts.onFrame;
    this.onStateChange = opts.onStateChange;
    this.secondsPerLine = opts.secondsPerLine ?? SPEED_NORMAL;
    this.loop = opts.loop ?? false;
    this.loadScript(opts.script ?? DEFAULT_SCRIPT);
  }

  // ── Script loading ────────────────────────────────────────────────────────

  /** Load a new script. Stops playback and resets position. */
  loadScript(script: string): void {
    this._clearTimers();
    this.lines = wrapScript(script);
    this.topIndex = 0;
    this.state = 'idle';
    this._emit('loadScript');
  }

  // ── Playback controls ─────────────────────────────────────────────────────

  play(): void {
    if (this.lines.length === 0) return;
    if (this.state === 'ended') {
      // Restart from top
      this.topIndex = 0;
    }
    this.state = 'playing';
    this._emit('play');
    if (this.secondsPerLine === Infinity) return; // manual mode — no timer
    if (this.timer) { clearInterval(this.timer); this.timer = null; } // guard: never double-start
    this._startTimer();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this._clearTimers();
    this.state = 'paused';
    this._emit('pause');
  }

  toggle(): void {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  /** Computed gesture hint: ↑ = playing forward, ↓ = rewinding, · = paused/idle/ended. */
  private _gestureHint(): '↑' | '↓' | '·' {
    if (this.rewindTimer !== null) return '↓';
    if (this.state === 'playing' && !this.timerSuspended) return '↑';
    return '·';
  }

  /** Update battery levels — reflected in the status bar on next frame. */
  setBattery(left: number | null, right: number | null): void {
    this.leftBat = left;
    this.rightBat = right;
  }

  /** Advance one line forward. Resets the timer if playing. */
  next(): void {
    this._clearTimers();
    this._advance();
    if (this.state === 'playing' && this.secondsPerLine !== Infinity) {
      this._startTimer();
    }
  }

  /** Go back one line. Pauses the auto-scroll timer — resumes on next next() call. */
  prev(): void {
    this._clearTimers();
    if (this.topIndex > 0) this.topIndex--;
    // If we were playing, stay logically "playing" but suspend the timer.
    // The user is recovering — don't race them. next() will restart the clock.
    if (this.state === 'ended') this.state = 'paused';
    this._emit('prev');
    // Intentionally no _startTimer() here.
  }

  /**
   * Pause and step back one line immediately; hold head_down keeps stepping at REWIND_INTERVAL_MS.
   * Leaves state as 'paused' so the line is sticky — call play() to resume forward scroll.
   */
  static readonly REWIND_INTERVAL_MS = 300;
  startRewind(): void {
    if (this.rewindTimer) return; // already rewinding
    if (this.lines.length === 0) return;
    // Pause and suspend forward timer
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.state === 'playing') { this.state = 'paused'; }
    // Step back immediately, then repeat at fixed fast rate while held
    if (this.topIndex > 0) { this.topIndex--; this._emit('rewindStart'); }
    this.rewindTimer = setInterval(() => {
      if (!this.rewindTimer) return;
      if (this.topIndex > 0) {
        this.topIndex--;
        this._emit('rewindTick');
      } else {
        this.stopRewind();
      }
    }, TeleprompterEngine.REWIND_INTERVAL_MS);
  }

  /** Returns true if a rewind interval is currently running. */
  isRewinding(): boolean { return this.rewindTimer !== null; }

  /** Stop rewinding and resume forward auto-scroll. */
  stopRewind(): void {
    if (this.rewindTimer) { clearInterval(this.rewindTimer); this.rewindTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // State is already 'paused' (set in startRewind) — caller decides when to play()
    this._emit('stopRewind');
  }

  restart(): void {
    this._clearTimers();
    this.topIndex = 0;
    this.state = 'paused';
    this._emit('restart');
  }

  // ── Speed ─────────────────────────────────────────────────────────────────

  /** Set speed in seconds per line. Takes effect immediately. */
  setSpeed(secondsPerLine: number): void {
    this.secondsPerLine = secondsPerLine;
    if (this.state === 'playing') {
      this._clearTimers();
      if (secondsPerLine !== Infinity) this._startTimer();
    }
    this._emit('setSpeed');
  }

  // ── Loop mode ─────────────────────────────────────────────────────────────

  setLoop(loop: boolean): void {
    this.loop = loop;
    this._emit('setLoop');
  }

  // ── Head gesture navigation ───────────────────────────────────────────────

  /**
   * Route a G1 event name to an action.
   * head_up → next, head_down → prev.
   * Only acts when state = 'playing' (by design — no accidental jumps while paused).
   * Debounce is handled externally (G1Context fires these with 700ms debounce).
   */
  handleGesture(eventName: string): void {
    if (this.state !== 'playing') return;
    if (eventName === 'head_up') this.next();
    else if (eventName === 'head_down') this.prev();
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  get timerSuspended(): boolean {
    return this.state === 'playing' && this.timer === null && this.secondsPerLine !== Infinity;
  }

  getSnapshot(): EngineSnapshot {
    return {
      state: this.state,
      topIndex: this.topIndex,
      totalLines: this.lines.length,
      secondsPerLine: this.secondsPerLine,
      loop: this.loop,
      timerSuspended: this.timerSuspended,
      frame: this._buildFrame(),
    };
  }

  // ── Frame rendering ───────────────────────────────────────────────────────

  /**
   * Build a display frame for any arbitrary topIndex (not just the current one).
   * Used by the phone UI to render prev/next pages in the swipeable HUD preview.
   * Clamps topIndex to [0, lines.length - 1].
   */
  getFrameAt(topIndex: number): string {
    const clamped = Math.max(0, Math.min(topIndex, Math.max(0, this.lines.length - 1)));
    return formatFrame(this._buildStatusBar(), this.lines, clamped);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  /** Re-wire callbacks after React remounts so closures stay fresh. */
  setCallbacks(opts: Pick<TeleprompterEngineOptions, 'onFrame' | 'onStateChange'>): void {
    this.onFrame = opts.onFrame;
    this.onStateChange = opts.onStateChange;
  }

  destroy(): void {
    this._clearTimers();
    this.onFrame = () => {};
    this.onStateChange = () => {};
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _startTimer(): void {
    this.timer = setInterval(() => {
      this._advance();
    }, this.secondsPerLine * 1000);
  }

  private _clearTimers(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.rewindTimer) { clearInterval(this.rewindTimer); this.rewindTimer = null; }
    if (this.loopRestartTimer) { clearTimeout(this.loopRestartTimer); this.loopRestartTimer = null; }
  }

  /** Advance topIndex by 1. Handles end-of-script and loop logic. */
  private _advance(): void {
    // Guard: if a rewind started between when this callback was enqueued and now,
    // discard the stale tick to prevent the forward/rewind oscillation.
    if (this.rewindTimer) return;
    const lastTop = Math.max(0, this.lines.length - 1);

    if (this.topIndex >= lastTop) {
      // Reached end
      this._clearTimers();

      if (this.loop) {
        // Show restart indicator in frame, then loop after delay
        this.state = 'playing'; // stays playing visually
        this.topIndex = lastTop;
        this._emitLoopRestart();
        this.loopRestartTimer = setTimeout(() => {
          this.topIndex = 0;
          this._emit('loopRestart');
          if (this.secondsPerLine !== Infinity) this._startTimer();
        }, LOOP_RESTART_DELAY_MS);
      } else {
        this.topIndex = lastTop;
        this.state = 'ended';
        this._emit('ended');
      }
      return;
    }

    this.topIndex++;
    this._emit('tick');
  }

  private _buildStatusBar(): string {
    const now = new Date();
    const hh = now.getHours();
    const mm = now.getMinutes().toString().padStart(2, '0');
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const h12 = ((hh % 12) || 12).toString();
    const playIcon = (this.state === 'playing' && !this.timerSuspended) ? '▶' : '⏸';
    const cur = this.topIndex + 1;
    const tot = this.lines.length;
    const batL = this.leftBat != null ? `L${this.leftBat}%` : '';
    const batR = this.rightBat != null ? `R${this.rightBat}%` : '';
    const bat = [batL, batR].filter(Boolean).join(' ');
    const middle = bat ? ` ${bat}` : '';
    return `${h12}:${mm}${middle} ${playIcon}${cur}/${tot} ${this._gestureHint()}`;
  }

  private _buildFrame(): string {
    if (this.state === 'ended') {
      const statusBar = this._buildStatusBar();
      // Show end-of-script indicator on the last visible window
      const endLines = [...this.lines.slice(this.topIndex, this.topIndex + 3), '── End of script ──'];
      return [statusBar, ...endLines].join('\n');
    }
    return formatFrame(this._buildStatusBar(), this.lines, this.topIndex);
  }

  private _emit(reason = 'unknown'): void {
    const snap = this.getSnapshot();
    this.onFrame(snap.frame, this.topIndex + 1, this.lines.length);
    this.onStateChange(snap);
  }

  private _emitLoopRestart(): void {
    const statusBar = this._buildStatusBar();
    const loopLines = [...this.lines.slice(this.topIndex, this.topIndex + 3), '↺ Restarting...'];
    const frame = [statusBar, ...loopLines].join('\n');
    this.onFrame(frame, this.topIndex + 1, this.lines.length);
    this.onStateChange({ ...this.getSnapshot(), frame });
  }
}
