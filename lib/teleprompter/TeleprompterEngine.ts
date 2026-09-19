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

import { wrapScript, formatFrame, DEFAULT_SCRIPT } from './lineWrapper';

// ── Types ──────────────────────────────────────────────────────────────────

export type EngineState = 'idle' | 'playing' | 'paused' | 'ended';

export interface EngineSnapshot {
  state: EngineState;
  topIndex: number;
  totalLines: number;
  secondsPerLine: number;
  loop: boolean;
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
export const SPEED_NORMAL = 3.5; // default
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
  private loopRestartTimer: ReturnType<typeof setTimeout> | null = null;

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
    this._emit();
  }

  // ── Playback controls ─────────────────────────────────────────────────────

  play(): void {
    if (this.lines.length === 0) return;
    if (this.state === 'ended') {
      // Restart from top
      this.topIndex = 0;
    }
    this.state = 'playing';
    this._emit();
    if (this.secondsPerLine === Infinity) return; // manual mode — no timer
    this._startTimer();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this._clearTimers();
    this.state = 'paused';
    this._emit();
  }

  toggle(): void {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  /** Advance one line forward. Resets the timer if playing. */
  next(): void {
    this._clearTimers();
    this._advance();
    if (this.state === 'playing' && this.secondsPerLine !== Infinity) {
      this._startTimer();
    }
  }

  /** Go back one line. Resets the timer if playing. */
  prev(): void {
    this._clearTimers();
    if (this.topIndex > 0) this.topIndex--;
    this.state = this.state === 'ended' ? 'paused' : this.state;
    this._emit();
    if (this.state === 'playing' && this.secondsPerLine !== Infinity) {
      this._startTimer();
    }
  }

  restart(): void {
    this._clearTimers();
    this.topIndex = 0;
    this.state = 'paused';
    this._emit();
  }

  // ── Speed ─────────────────────────────────────────────────────────────────

  /** Set speed in seconds per line. Takes effect immediately. */
  setSpeed(secondsPerLine: number): void {
    this.secondsPerLine = secondsPerLine;
    if (this.state === 'playing') {
      this._clearTimers();
      if (secondsPerLine !== Infinity) this._startTimer();
    }
    this._emit();
  }

  // ── Loop mode ─────────────────────────────────────────────────────────────

  setLoop(loop: boolean): void {
    this.loop = loop;
    this._emit();
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

  getSnapshot(): EngineSnapshot {
    return {
      state: this.state,
      topIndex: this.topIndex,
      totalLines: this.lines.length,
      secondsPerLine: this.secondsPerLine,
      loop: this.loop,
      frame: this._buildFrame(),
    };
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  destroy(): void {
    this._clearTimers();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _startTimer(): void {
    this.timer = setInterval(() => {
      this._advance();
    }, this.secondsPerLine * 1000);
  }

  private _clearTimers(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.loopRestartTimer) { clearTimeout(this.loopRestartTimer); this.loopRestartTimer = null; }
  }

  /** Advance topIndex by 1. Handles end-of-script and loop logic. */
  private _advance(): void {
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
          this._emit();
          if (this.secondsPerLine !== Infinity) this._startTimer();
        }, LOOP_RESTART_DELAY_MS);
      } else {
        this.topIndex = lastTop;
        this.state = 'ended';
        this._emit();
      }
      return;
    }

    this.topIndex++;
    this._emit();
  }

  private _buildStatusBar(): string {
    const now = new Date();
    const hh = now.getHours();
    const mm = now.getMinutes().toString().padStart(2, '0');
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const h12 = ((hh % 12) || 12).toString();
    const playIcon = this.state === 'playing' ? '▶' : '⏸';
    const cur = this.topIndex + 1;
    const tot = this.lines.length;
    return `${h12}:${mm} ${ampm}  ${playIcon} ${cur}/${tot}`;
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

  private _emit(): void {
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
