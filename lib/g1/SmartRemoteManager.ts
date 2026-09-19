/**
 * SmartRemoteManager.ts
 *
 * Intercepts MPRemoteCommandCenter media key events (from the Even Realities
 * SmartRemote or headphone buttons) and re-emits them as G1Events so the
 * teleprompter controls work identically to the G1 glasses tap gestures.
 *
 * Button → G1Event mapping
 * ─────────────────────────
 *   Next Track  (▶▶)  →  single_tap   (advance one cue line)
 *   Prev Track  (◀◀)  →  double_tap   (go back one cue line)
 *   Play/Pause  (⏯)   →  triple_tap   (toggle play/pause)
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

class SmartRemoteManager {
  private handlers = new Set<EventHandler>();
  private running = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private player: any = null;

  addEventHandler(h: EventHandler): void    { this.handlers.add(h); }
  removeEventHandler(h: EventHandler): void { this.handlers.delete(h); }

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
      const { createAudioPlayer } = require('expo-audio');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
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

    MusicControl.on(Command.nextTrack,       () => { console.log('[SmartRemoteManager] nextTrack → single_tap');       this._emit('single_tap'); });
    MusicControl.on(Command.previousTrack,   () => { console.log('[SmartRemoteManager] previousTrack → double_tap');   this._emit('double_tap'); });
    MusicControl.on(Command.togglePlayPause, () => { console.log('[SmartRemoteManager] togglePlayPause → triple_tap'); this._emit('triple_tap'); });
    MusicControl.on(Command.play,            () => { console.log('[SmartRemoteManager] play → triple_tap');            this._emit('triple_tap'); });
    MusicControl.on(Command.pause,           () => { console.log('[SmartRemoteManager] pause → triple_tap');           this._emit('triple_tap'); });

    this.running = true;
    console.log('[SmartRemoteManager] Media key interception active.');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('react-native-music-control');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const MusicControl: any = mod?.default ?? null;
      if (!MusicControl) return;
      if (this.player) {
        this.player.pause();
        this.player.release();
        this.player = null;
      }
      MusicControl.updatePlayback({ state: MusicControl.STATE_STOPPED });
      MusicControl.resetNowPlaying();
      MusicControl.enableBackgroundMode(false);
    } catch (e) {
      console.warn('[SmartRemoteManager] stop() error:', e);
    }
  }

  private _emit(name: string): void {
    const event = { name } as Parameters<EventHandler>[0];
    this.handlers.forEach(h => h(event));
  }
}

export const smartRemoteManager = new SmartRemoteManager();
