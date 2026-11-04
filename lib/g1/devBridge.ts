/**
 * Dev-only bridge: lets the Mac drive the HUD from a terminal.
 *
 *   node scripts/hud.mjs text "hello"
 *
 * The app connects OUT to a WebSocket on the Metro host (port 8910), so no
 * IP is hardcoded and nothing listens on the phone. Compiled out of release
 * builds via __DEV__. Only the whitelisted commands below are executable —
 * this is not a generic eval channel.
 */
import Constants from 'expo-constants';
import type { G1Core } from './G1Core';

const PORT = 8910;
const RETRY_MS = 3000;

type Cmd =
  | { id: number; cmd: 'text'; text: string; ns?: number }
  | { id: number; cmd: 'test' }
  | { id: number; cmd: 'clear' }
  | { id: number; cmd: 'dashboard' }
  | { id: number; cmd: 'status' }
  | { id: number; cmd: 'logs'; tail?: number };

type Deps = { core: G1Core; getLogs: () => string[]; log: (m: string) => void };

let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let started = false;

function hostFromMetro(): string | null {
  const uri = Constants.expoConfig?.hostUri;
  return uri ? uri.split(':')[0] : null;
}

async function run(c: Cmd, d: Deps): Promise<unknown> {
  switch (c.cmd) {
    case 'text':      await d.core.sendText(c.text, 1, 1, true, c.ns as any); return `sent ns=0x${(c.ns ?? 0x41).toString(16)}`;
    case 'test':      await d.core.sendTestDisplay(); return 'sent';
    case 'clear':     await Promise.all([d.core.clearDisplay('L'), d.core.clearDisplay('R')]); return 'cleared';
    case 'dashboard': await d.core.exitToDashboard(); return 'ok';
    case 'status':    return d.core.status;
    case 'logs':      return d.getLogs().slice(-(c.tail ?? 40));
  }
}

function connect(d: Deps): void {
  const host = hostFromMetro();
  if (!host) return; // not running against Metro — nothing to bridge to
  const sock = new WebSocket(`ws://${host}:${PORT}`);
  ws = sock;
  sock.onopen = () => d.log(`[DevBridge] connected to ${host}:${PORT}`);
  sock.onmessage = async (e) => {
    let c: Cmd;
    try { c = JSON.parse(String(e.data)); } catch { return; }
    try {
      const result = await run(c, d);
      sock.send(JSON.stringify({ id: c.id, ok: true, result }));
    } catch (err: any) {
      sock.send(JSON.stringify({ id: c.id, ok: false, error: err?.message ?? String(err) }));
    }
  };
  sock.onerror = () => {}; // onclose follows and schedules the retry
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    retry = setTimeout(() => connect(d), RETRY_MS);
  };
}

export function startDevBridge(d: Deps): void {
  if (!__DEV__ || started) return;
  started = true;
  connect(d);
}
