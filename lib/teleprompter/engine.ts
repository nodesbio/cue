/**
 * Process-wide TeleprompterEngine singleton.
 *
 * One engine for the app lifetime, shared by the Teleprompter, Compose and
 * Scripts tabs. Callbacks are (re)wired by the Teleprompter screen on mount —
 * callers here only need load/pause/etc.
 *
 * Fast Refresh replaces this module; module.hot.dispose kills the old engine's
 * timers first so there is never more than one live engine.
 */
import { TeleprompterEngine } from './TeleprompterEngine';

let _engine: TeleprompterEngine | null = null;

declare const module: { hot?: { dispose: (cb: () => void) => void } } | undefined;
if (typeof module !== 'undefined' && module?.hot) {
  module.hot.dispose(() => {
    _engine?.destroy();
    _engine = null;
  });
}

export function getEngine(): TeleprompterEngine {
  if (!_engine) {
    _engine = new TeleprompterEngine({ onFrame: () => {}, onStateChange: () => {} });
  }
  return _engine;
}
