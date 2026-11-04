/**
 * useLiveMirror — "whatever I type shows in my eye, right now."
 *
 * Bypasses the TeleprompterEngine: no scroll, no pages. Wraps the text to the
 * glasses' width, keeps the tail WINDOW_SIZE lines (so the newest words are
 * always visible), and pushes each frame as a single MANUAL (0x51) frame.
 *
 * Latency model: a text frame is not "sent" until the glasses ACK it, which
 * takes a few hundred ms over BLE. Typing produces frames far faster than
 * that, so a naive push-per-change piles stale frames onto G1Core's serial
 * send queue and the HUD lags further behind with every keystroke.
 *
 * Fix: at most ONE frame in flight, ONE pending. A new frame overwrites the
 * pending slot; when the in-flight send settles we push whatever is pending
 * *now*. Intermediate frames are dropped — only the latest text matters.
 * The small debounce just avoids re-wrapping on every keystroke when BLE is
 * keeping up.
 */
import { useEffect, useRef } from 'react';
import { formatFrame, wrapScript, WINDOW_SIZE } from './lineWrapper';

const DEBOUNCE_MS = 60;

export function useLiveMirror(
  enabled: boolean,
  text: string,
  send: (frame: string) => Promise<void>,
): void {
  const timer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const pending  = useRef<string | null>(null);
  const sendRef  = useRef(send);
  sendRef.current = send;

  const pumpRef = useRef<() => void>(() => {});
  pumpRef.current = () => {
    if (inFlight.current || pending.current === null) return;
    const frame = pending.current;
    pending.current = null;
    inFlight.current = true;
    sendRef.current(frame).finally(() => {
      inFlight.current = false;
      pumpRef.current();
    });
  };

  useEffect(() => {
    if (!enabled) { pending.current = null; return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const lines = wrapScript(text);
      const top = Math.max(0, lines.length - WINDOW_SIZE);
      pending.current = formatFrame('● LIVE', lines.length ? lines : [''], top);
      pumpRef.current();
    }, DEBOUNCE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [enabled, text]);
}
