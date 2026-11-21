/**
 * SportsFeed — the 24x7 live sports HUD driver.
 *
 * Polls ESPN on a cadence, ranks live games by excitement, formats a compact
 * HUD frame for the glasses, and emits it via callback. Deliberately
 * BLE-agnostic: it never imports G1Core. The UI layer forwards the emitted
 * string to `core.sendText(frame)`. This keeps the feed pure-ish and testable,
 * and means a feed failure can never corrupt the BLE/reliability layer.
 *
 * Frame layout (≤ MAX_CHARS per line, reuses the teleprompter line width so it
 * renders identically on the lens):
 *
 *   NBA  · 2:13 4th Qtr        <- league + clock (top game)
 *   BOS 98                     <- away
 *   LAL 96                     <- home
 *   ★ L. Doncic 34 PTS         <- top performer (the conversational hook)
 *   +2 more live               <- count of other live games (optional)
 */
import { fetchLiveGames, LEAGUE_LABEL } from './espn';
import type { GameSnapshot, League } from './types';
import { MAX_CHARS } from '../teleprompter/lineWrapper';

export const DEFAULT_POLL_MS = 20_000;

export interface SportsFeedOptions {
  /** Leagues to include (default: all). */
  leagues?: League[];
  /** Poll interval in ms (default 20s). */
  pollMs?: number;
  /** Called with a ready-to-send HUD frame string on each successful poll. */
  onFrame: (frame: string) => void;
  /** Called with the full ranked list (for the in-app list view). Optional. */
  onGames?: (games: GameSnapshot[]) => void;
  /** Called on a poll error (all leagues failed / empty). Optional. */
  onError?: (err: unknown) => void;
  /** Injectable fetcher for tests. Defaults to the real ESPN fetch. */
  fetcher?: typeof fetchLiveGames;
}

function clip(s: string): string {
  return s.length <= MAX_CHARS ? s : s.slice(0, MAX_CHARS);
}

/**
 * Format the top-ranked game (plus a "+N more" tail) into a lens frame.
 * Pure — exported for testing. Returns a placeholder when nothing is live.
 */
export function formatFrame(games: GameSnapshot[]): string {
  if (games.length === 0) return 'No live games right now';

  const top = games[0];
  const header = clip(`${LEAGUE_LABEL[top.league]}  ${top.status}`.trim());
  const away = clip(`${top.away} ${top.awayScore}`);
  const home = clip(`${top.home} ${top.homeScore}`);

  const lines = [header, away, home];

  // Lead-performer line — the payload you actually talk about. People discuss
  // people, not box scores: "Doncic's got 34" is a conversation; "108-104" is
  // not. Pick the top scorer (leaders[] is already PTS-first), fall back to
  // whatever stat leads if PTS is absent (e.g. an NHL feed). Only one line —
  // the lens is narrow and a single star beats a crowded stat dump.
  const star = topLeader(top);
  if (star) lines.push(clip(`\u2605 ${star.player} ${star.value} ${star.stat}`));

  if (games.length > 1) lines.push(`+${games.length - 1} more live`);
  return lines.join('\n');
}

/** The headline performer for a game: prefer PTS, else first available stat. */
export function topLeader(game: GameSnapshot): GameSnapshot['leaders'][number] | null {
  if (!game.leaders || game.leaders.length === 0) return null;
  return game.leaders.find((l) => l.stat === 'PTS') ?? game.leaders[0];
}

/**
 * A running sports feed. Call start() to begin polling and stop() to tear down.
 * Safe to stop()/start() repeatedly; stop() aborts any in-flight fetch.
 */
export class SportsFeed {
  private readonly leagues?: League[];
  private readonly pollMs: number;
  private readonly onFrame: (frame: string) => void;
  private readonly onGames?: (games: GameSnapshot[]) => void;
  private readonly onError?: (err: unknown) => void;
  private readonly fetcher: typeof fetchLiveGames;

  private timer: ReturnType<typeof setInterval> | null = null;
  private abort: AbortController | null = null;
  private running = false;

  constructor(opts: SportsFeedOptions) {
    this.leagues = opts.leagues;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.onFrame = opts.onFrame;
    this.onGames = opts.onGames;
    this.onError = opts.onError;
    this.fetcher = opts.fetcher ?? fetchLiveGames;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Begin polling. Fires an immediate first poll, then every pollMs. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  /** Stop polling and abort any in-flight request. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
  }

  /**
   * One poll cycle. Exposed for tests / manual refresh — works standalone
   * without start(). Callbacks are suppressed only if THIS poll's request was
   * aborted (by a later poll or by stop()), tracked via its AbortController's
   * signal rather than the running flag (so a standalone poll() still emits).
   */
  async poll(): Promise<void> {
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    try {
      const games = await this.fetcher(this.leagues, controller.signal);
      if (controller.signal.aborted) return; // superseded / stopped — drop
      this.onGames?.(games);
      this.onFrame(formatFrame(games));
    } catch (err) {
      if (controller.signal.aborted) return; // aborted — not a real error
      this.onError?.(err);
    }
  }
}
