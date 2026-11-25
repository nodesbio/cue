/**
 * SmartRemoteManager.ts
 *
 * Intercepts MPRemoteCommandCenter media key events (from the Even Realities
 * SmartRemote or headphone buttons) and re-emits them as G1Events so the
 * teleprompter controls work identically to the G1 glasses tap gestures.
 *
 * Button → G1Event mapping
 * ─────────────────────────
 *   Next Track  (▶▶)  →  next   (advance one cue line)
 *   Prev Track  (◀◀)  →  prev   (go back one cue line)
 *   Play/Pause  (⏯)   →  select   (toggle play/pause)
 *
 * HOW IT STEALS MEDIA KEYS FROM SPOTIFY
 * ──────────────────────────────────────
 * iOS routes MPRemoteCommandCenter events to whichever app last activated an
 * AVAudioSession. MusicControl.enableBackgroundMode(true) activates the session
 * with AVAudioSessionCategoryPlayback, which transfers media key ownership to
 * this app. The `audio` UIBackgroundMode in Info.plist is required for this to
 * persist when the app is backgrounded.
 *
 * Requires: native build with react-native-music-control pod + `audio` in
 * UIBackgroundModes (Info.plist).
 */

import { Platform } from 'react-native';
import type { EventHandler } from './G1Core';

interface G1Event { name: string; raw?: number[] }

/**
 * Minimum gap (ms) between two logical events of the SAME kind. A single
 * physical SmartRemote press can surface as multiple MPRemoteCommandCenter
 * callbacks (e.g. togglePlayPause + play on one tap, or BLE HID key repeat),
 * which double-toggles the engine and feels unresponsive. Collapsing repeats
 * within this window to one event is the "sensitivity" knob — tune live over
 * the wired dev client. 250ms is below human double-press cadence (~400ms+)
 * so intentional rapid presses still register.
 */
const PRESS_DEDUP_MS = 250;

class SmartRemoteManager {
  private handlers = new Set<EventHandler>();
  private running = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private player: any = null;
  /** Last emit time per logical event name, for same-event dedup. */
  private lastEmitAt: Record<string, number> = {};

  addEventHandler(h: EventHandler): void    { this.handlers.add(h); }
  removeEventHandler(h: EventHandler): void { this.handlers.delete(h); }

  /** Timestamped log: `[SmartRemoteManager HH:MM:SS.mmm] ...`. Millisecond
   *  precision is required to measure the inter-lens / key-repeat gap that
   *  sizes PRESS_DEDUP_MS. */
  private _log(msg: string): void {
    const d = new Date();
    const t =
      `${String(d.getHours()).padStart(2, '0')}:` +
      `${String(d.getMinutes()).padStart(2, '0')}:` +
      `${String(d.getSeconds()).padStart(2, '0')}.` +
      `${String(d.getMilliseconds()).padStart(3, '0')}`;
    console.log(`[SmartRemoteManager ${t}] ${msg}`);
  }

  start(): void {
    if (this.running || Platform.OS !== 'ios') return;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-music-control');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const MusicControl: any = mod?.default ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Command: any = mod?.Command ?? null;

    // If the native module itself is missing (binary built without the pod),
    // MusicControl.enableBackgroundMode will be a no-op wrapper around `{}`.
    // Detect this and bail cleanly.
    const { NativeModules } = require('react-native');
    if (!NativeModules.MusicControlManager) {
      console.warn('[SmartRemoteManager] MusicControlManager native module missing — rebuild dev client.');
      return;
    }
    if (!MusicControl || !Command) {
      console.warn('[SmartRemoteManager] react-native-music-control not available.');
      return;
    }

    // Activate a NON-mixable AVAudioSession and play a silent loop.
    // iOS routes MPRemoteCommandCenter events only to the "Now Playing app":
    // the app with a non-mixable playback session that is ACTUALLY playing
    // audio. Metadata alone doesn't qualify — hence the silent loop.
    // Side effect: this pauses Spotify (iOS allows only one media-key owner).
    MusicControl.enableBackgroundMode(true);

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createAudioPlayer, setAudioModeAsync } = require('expo-audio');
      // Keep the silent loop playing when the screen locks, and own the
      // media keys non-mixably. Per expo-audio docs, lock-screen remote
      // controls require interruptionMode: 'doNotMix' AND the session must
      // stay active in the background (shouldPlayInBackground). Without this
      // iOS deactivates the loop on lock → Cue loses "Now Playing app"
      // status → SmartRemote presses are dropped/batched on the lock screen.
      // Fire-and-forget is safe: the mode applies to the session, and the
      // loop lives for the whole SmartRemote session.
      setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        interruptionMode: 'doNotMix',
        shouldRouteThroughEarpiece: false,
      }).catch((e: unknown) =>
        console.warn('[SmartRemoteManager] setAudioModeAsync failed:', e),
      );
      this.player = createAudioPlayer(require('../../assets/silence.mp3'));
      this.player.loop = true;
      this.player.play();
    } catch (e) {
      console.warn('[SmartRemoteManager] silent-loop player failed — media keys will not route to Cue:', e);
      return;
    }
    MusicControl.setNowPlaying({
      title:  'Cue',
      artist: 'SmartRemote active',
      duration: 0,
      elapsedTime: 0,
    });
    MusicControl.updatePlayback({ state: MusicControl.STATE_PLAYING });

    MusicControl.enableControl(Command.nextTrack,       true);
    MusicControl.enableControl(Command.previousTrack,   true);
    MusicControl.enableControl(Command.togglePlayPause, true);
    MusicControl.enableControl(Command.play,            true);
    MusicControl.enableControl(Command.pause,           true);

    MusicControl.on(Command.nextTrack,       () => { this._log('nextTrack → next');       this._emit('next'); });
    MusicControl.on(Command.previousTrack,   () => { this._log('previousTrack → prev');   this._emit('prev'); });
    MusicControl.on(Command.togglePlayPause, () => { this._log('togglePlayPause → select'); this._emit('select'); });
    MusicControl.on(Command.play,            () => { this._log('play → select');            this._emit('select'); });
    MusicControl.on(Command.pause,           () => { this._log('pause → select');           this._emit('select'); });

    this.running = true;
    this._log('Media key interception active.');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('react-native-music-control');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const MusicControl: any = mod?.default ?? null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Command: any = mod?.Command ?? null;
      if (!MusicControl) return;
      if (this.player) {
        this.player.pause();
        this.player.release();
        this.player = null;
      }
      // Unregister command handlers. MusicControl.on() APPENDS listeners and
      // never dedups; without this, a second start() (e.g. Fast Refresh re-runs
      // the mount effect while the module-level singleton survives the reload)
      // leaves the old handlers registered, so one press fires N times. The
      // PRESS_DEDUP_MS gate only hides this when the duplicates land <250ms
      // apart — it does NOT fix the stacked-handler root cause.
      if (Command) {
        for (const c of [Command.nextTrack, Command.previousTrack,
                         Command.togglePlayPause, Command.play, Command.pause]) {
          MusicControl.off(c);
        }
      }
      MusicControl.updatePlayback({ state: MusicControl.STATE_STOPPED });
      MusicControl.resetNowPlaying();
      MusicControl.enableBackgroundMode(false);
    } catch (e) {
      console.warn('[SmartRemoteManager] stop() error:', e);
    }
  }

  private _emit(name: string): void {
    // Collapse same-event repeats within PRESS_DEDUP_MS. play/pause/toggle all
    // map to select, so a single press that fires toggle+play would emit
    // twice; keying on the LOGICAL name (not the raw command) dedups that too.
    const now = Date.now();
    const last = this.lastEmitAt[name] ?? 0;
    if (now - last < PRESS_DEDUP_MS) {
      this._log(`deduped repeat ${name} (${now - last}ms)`);
      return;
    }
    this.lastEmitAt[name] = now;
    const event = { name } as Parameters<EventHandler>[0];
    this.handlers.forEach(h => h(event));
  }
}

export const smartRemoteManager = new SmartRemoteManager();
