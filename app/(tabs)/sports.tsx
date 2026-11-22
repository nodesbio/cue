/**
 * sports.tsx — 24x7 live sports HUD.
 *
 * Picks the most exciting live game across NBA/NHL/NCAA (via the ESPN-backed
 * SportsFeed) and streams a compact score HUD to the glasses. Phone shows the
 * full ranked list; the lenses show the top game.
 *
 * Revenue angle: a hands-free, always-on glasses mode that gives someone a
 * reason to wear the device all day — the "why would I keep these on" answer.
 * Highly demo-able and shareable (watch the game without looking at your phone).
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useG1 } from '@/lib/g1/G1Context';
import type { G1Core } from '@/lib/g1/G1Core';
import { useLivePlay } from '@/lib/sports/useLivePlay';
import { SportsFeed, DEFAULT_POLL_MS } from '@/lib/sports/SportsFeed';
import { LEAGUE_LABEL } from '@/lib/sports/espn';
import { fetchPlayByPlay, periodLabel } from '@/lib/sports/playByPlay';
import type { GameSnapshot, League, PlayLine } from '@/lib/sports/types';
import { AudienceBuilder } from '@/components/AudienceBuilder';
import { listAudiences } from '@/lib/sports/AudienceStore';
import type { Audience } from '@/lib/sports/audience';
import { useDeck } from '@/lib/sports/useDeck';
import { ArticlePicker, type NewsSource } from '@/components/ArticlePicker';
import { useArticleStream } from '@/lib/sports/useArticleStream';
import { buildStreamSources } from '@/lib/sports/streamSources';

/**
 * Stream sources for the article picker (#49). OSU is the configured example
 * here — a UI fixture, not library-level hardcoding. The library (newsFeed) is
 * sport/team-agnostic; this screen picks which team/league to browse. Swapping
 * teams is a config change, not a code change.
 */
// Derived from the CATALOG (#49 content depth) — every covered team + standalone
// league is pickable, so a nightly listener doesn't run dry after ~50 articles.
// Adding teams is now a catalog edit, not a code change here.
const STREAM_SOURCES: NewsSource[] = buildStreamSources(50);

// NOTE: must stay in sync with the League union + ENDPOINTS map in espn.ts.
// CFB (NCAAF) matters on football Saturdays — omitting it made the Live feed
// surface a stale low-activity basketball game instead of OSU@NEB / WAKE@GT.
const ALL_LEAGUES: League[] = ['NBA', 'NHL', 'NCAAM', 'NCAAW', 'NCAAF', 'NFL'];

/** Which Sports surface is showing. */
type SportsMode = 'live' | 'audiences' | 'deck' | 'stream';

/** No live-game promotion in the standalone deck yet (#46 v1). */
const NO_LIVE: ReadonlySet<string> = new Set<string>();

// Distinct lens-owner token for the live HUD (#43). DeckView and StreamView own
// 'sports.deck' / 'sports.stream' via their hooks; keeping these separate means
// an outgoing segment's releaseDisplay on unmount can't clear the incoming one.
const LIVE_OWNER = 'sports.live';

const MODE_LABEL: Record<SportsMode, string> = {
  live: 'Live',
  audiences: 'Audiences',
  deck: 'Deck',
  stream: 'Stream',
};

const C = {
  bg: '#0a0a0a',
  card: '#141414',
  border: '#1f1f1f',
  text: '#ffffff',
  dim: '#777777',
  accent: '#39d353',
  hot: '#ff6b3d',
};

/** Color a game's excitement score for the list. */
function heat(excitement: number): string {
  if (excitement >= 80) return C.hot;
  if (excitement >= 50) return C.accent;
  return C.dim;
}

/**
 * SportsScreen — the Sports tab shell. A segmented control switches between the
 * always-on live HUD and the audience builder (#44); the conversation deck (#46)
 * will add a third segment here.
 */
export default function SportsScreen() {
  const [mode, setMode] = useState<SportsMode>('live');

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.segmentRow}>
        {(['live', 'audiences', 'deck', 'stream'] as SportsMode[]).map((m) => {
          const on = mode === m;
          return (
            <Pressable
              key={m}
              onPress={() => setMode(m)}
              style={[styles.segment, on && styles.segmentOn]}
              hitSlop={6}
            >
              <Text style={[styles.segmentText, on && styles.segmentTextOn]}>
                {MODE_LABEL[m]}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {mode === 'live' && <LiveSportsView />}
      {mode === 'audiences' && <AudienceBuilder />}
      {mode === 'deck' && <DeckView />}
      {mode === 'stream' && <StreamView />}
    </SafeAreaView>
  );
}

/** The always-on live sports HUD (the original Sports screen). */
function LiveSportsView() {
  const { core, isConnected } = useG1();

  const [leagues, setLeagues] = useState<League[]>(ALL_LEAGUES);
  const [games, setGames] = useState<GameSnapshot[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [selected, setSelected] = useState<GameSnapshot | null>(null);

  const feedRef = useRef<SportsFeed | null>(null);
  const isConnectedRef = useRef(isConnected);
  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);

  // Tear down the feed on unmount and hand the lens back to whoever's next.
  useEffect(() => () => { feedRef.current?.stop(); core.releaseDisplay(LIVE_OWNER); }, [core]);

  const start = useCallback(() => {
    feedRef.current?.stop();
    setError(null);
    // Take the lens for the sports mode. The teleprompter screen stays mounted
    // in the tab stack and its resync effects would otherwise re-push a script
    // line over our scores (the toggling bug). Claiming makes sports the sole
    // owner; teleprompter pushes tagged 'teleprompter' are dropped until we
    // release on stop.
    core.claimDisplay(LIVE_OWNER);
    const feed = new SportsFeed({
      leagues,
      pollMs: DEFAULT_POLL_MS,
      onGames: (g) => { setGames(g); setLastUpdate(Date.now()); },
      onFrame: (frame) => {
        // Only push to the lenses when both are usable (isConnected = AND of
        // txReady). Guarding here avoids enqueuing frames that would be dropped.
        if (isConnectedRef.current && !core.status.poweredOff) {
          core.note('[sports] push HUD frame');
          void core.sendText(frame, 1, 1, true, undefined, LIVE_OWNER);
        }
      },
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
    feedRef.current = feed;
    feed.start();
    setLive(true);
  }, [leagues, core]);

  const stop = useCallback(() => {
    feedRef.current?.stop();
    feedRef.current = null;
    // Release the lens so the teleprompter (or a future mode) can own it again.
    core.releaseDisplay(LIVE_OWNER);
    setLive(false);
  }, [core]);

  // The selected tab owns the lens: leaving Sports blanks it and stops the feed.
  useFocusEffect(useCallback(() => () => {
    core.yieldDisplay(LIVE_OWNER);
    stop();
  }, [core, stop]));

  // Restarting with a changed league set while live.
  const toggleLeague = useCallback((lg: League) => {
    setLeagues((prev) => {
      const next = prev.includes(lg) ? prev.filter((l) => l !== lg) : [...prev, lg];
      return next.length === 0 ? prev : next; // never allow empty
    });
  }, []);

  // If leagues change while live, relaunch the feed with the new set.
  useEffect(() => {
    if (live) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagues]);

  // The open game follows the feed. `selected` is the snapshot from the tap, so
  // on its own the sheet header keeps the score and clock from when it opened.
  // If the game drops off the live list (final), keep the last snapshot.
  const selectedGame = useMemo(
    () => (selected ? games.find((g) => g.gameId === selected.gameId) ?? selected : null),
    [selected, games],
  );

  const updatedLabel = useMemo(() => {
    if (!lastUpdate) return '';
    const secs = Math.round((Date.now() - lastUpdate) / 1000);
    return secs < 5 ? 'just now' : `${secs}s ago`;
  }, [lastUpdate]);

  // One status line for every feed state, so the line is always there.
  const statusLine = live
    ? (error ? `⚠ ${error}` : `Updated ${updatedLabel} · polling every ${DEFAULT_POLL_MS / 1000}s`)
    : games.length > 0
      ? 'Feed stopped · scores below are not updating'
      : 'Feed off';
  // The top row is tagged only while the feed is running with the glasses up.
  // (It used to be tagged whenever it was first in the list, even after Stop.)
  const onLens = live && isConnected;

  return (
    <View style={styles.liveBody}>
      <View style={styles.header}>
        <Text style={styles.title}>Live Sports</Text>
        <Text style={[styles.conn, { color: isConnected ? C.accent : C.dim }]}>
          {isConnected ? '● glasses' : '○ glasses'}
        </Text>
      </View>

      {/* League filter. Scrolls sideways: six chips are wider than the screen,
          and in a plain row the last ones sat off the edge, unreachable. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.leagueScroll}
        contentContainerStyle={styles.leagueScrollContent}
      >
        {ALL_LEAGUES.map((lg) => {
          const on = leagues.includes(lg);
          return (
            <Pressable
              key={lg}
              onPress={() => toggleLeague(lg)}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{LEAGUE_LABEL[lg]}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Start / stop */}
      <Pressable onPress={live ? stop : start} style={[styles.cta, live && styles.ctaLive]}>
        <Text style={styles.ctaText}>{live ? 'Stop feed' : 'Start 24/7 feed'}</Text>
      </Pressable>

      {/* Always rendered, with a reserved line, so starting or stopping the feed
          moves nothing below it. */}
      <Text style={styles.feedStatus} numberOfLines={2}>{statusLine}</Text>
      <Text style={styles.scoreHelp} numberOfLines={2}>
        Lens priority (0–100): highest is listed first. A close score counts most; the second
        half, the last minutes of a period, and the postseason add to it.
      </Text>

      {/* Ranked list */}
      <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 24 }}>
        {games.length === 0 && live && !error && (
          <Text style={styles.empty}>No live games right now.</Text>
        )}
        {games.map((g, i) => (
          <Pressable
            key={g.gameId}
            style={({ pressed }) => [styles.game, styles.gameStack, pressed && styles.gamePressed]}
            onPress={() => setSelected(g)}
            accessibilityRole="button"
            accessibilityLabel={`${g.away} at ${g.home}, play by play`}
          >
            <View style={styles.gameTop}>
              <View style={styles.gameLeft}>
                <Text style={styles.league} numberOfLines={1}>
                  {LEAGUE_LABEL[g.league]}
                  {onLens && i === 0 && <Text style={styles.onGlasses}>{'  ·  ON LENS'}</Text>}
                </Text>
                <Text style={styles.matchup} numberOfLines={1}>{g.away} {g.awayScore} · {g.home} {g.homeScore}</Text>
                <Text style={styles.gameStatus} numberOfLines={1}>{g.status}</Text>
              </View>
              <View style={styles.gameRight}>
                <Text style={[styles.score, { color: heat(g.excitement) }]}>{g.excitement}</Text>
                <Text style={styles.scoreLabel}>priority</Text>
                <Text style={styles.tapHint}>tap ›</Text>
              </View>
            </View>
            {/* Full card width and always rendered, so every card is the same
                height whether or not the game has leaders. */}
            <Text style={styles.leaders} numberOfLines={1}>
              {g.leaders.map((l) => `${l.player} ${l.value} ${l.stat}`).join('  ·  ') || ' '}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <PlayByPlayModal
        game={selectedGame}
        core={core}
        isConnected={isConnected}
        onClose={() => setSelected(null)}
      />
    </View>
  );
}

/** How often to refresh play-by-play while the modal is open. */
const PBP_POLL_MS = 15000;

/**
 * PlayByPlayModal — tap a game to see its live play-by-play. Fetches on open,
 * polls every 15s while open, and shows loading / error / empty states
 * honestly (an empty feed says "no plays yet", it never fakes a row). Closing
 * aborts any in-flight fetch and clears the poll.
 */
function PlayByPlayModal({
  game,
  core,
  isConnected,
  onClose,
}: {
  game: GameSnapshot | null;
  core: G1Core;
  isConnected: boolean;
  onClose: () => void;
}) {
  const [plays, setPlays] = useState<PlayLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Live-play lens stream (#49). The newest play pushes to the glasses as plays
  // land; "to lens" starts it, closing or "off lens" stops + goes dark.
  const live = useLivePlay(core, game?.gameId ?? '', game?.league ?? 'NCAAF', isConnected);

  // Stop the lens stream whenever the modal closes, so we never strand the
  // glasses on a frozen play after the user walks away (#43 ownership release).
  useEffect(() => {
    if (!game && live.streaming) live.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game]);

  // Key the fetch on the game's identity, not the snapshot object: the parent
  // hands down a fresh snapshot on every feed poll, and that must not restart
  // the play-by-play load.
  const gameId = game?.gameId;
  const league = game?.league;

  useEffect(() => {
    if (!gameId || !league) return;
    let cancelled = false;
    const ctrl = new AbortController();

    const load = async (initial: boolean) => {
      if (initial) setLoading(true);
      try {
        const lines = await fetchPlayByPlay(gameId, league, ctrl.signal);
        if (!cancelled) {
          setPlays(lines);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled && !ctrl.signal.aborted) {
          setErr(e instanceof Error ? e.message : 'Failed to load play-by-play');
        }
      } finally {
        if (!cancelled && initial) setLoading(false);
      }
    };

    load(true);
    const timer = setInterval(() => load(false), PBP_POLL_MS);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(timer);
    };
  }, [gameId, league]);

  // Reset transient state when the modal closes so the next open starts clean.
  useEffect(() => {
    if (!game) {
      setPlays([]);
      setErr(null);
      setLoading(false);
    }
  }, [game]);

  return (
    <Modal visible={!!game} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalTitle}>
                {game ? `${game.away} ${game.awayScore} · ${game.home} ${game.homeScore}` : ''}
              </Text>
              <Text style={styles.modalSub}>{game?.status ?? ''}</Text>
            </View>
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => (live.streaming ? live.stop() : live.start())}
                disabled={!isConnected}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={live.streaming ? 'Stop streaming to glasses' : 'Stream to glasses'}
                style={[
                  styles.lensBtn,
                  live.streaming && styles.lensBtnOn,
                  !isConnected && styles.lensBtnOff,
                ]}
              >
                <Text style={[styles.lensBtnText, live.streaming && styles.lensBtnTextOn]}>
                  {live.streaming ? '● on lens' : isConnected ? 'to lens' : 'no glasses'}
                </Text>
              </Pressable>
              <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
                <Text style={styles.modalClose}>Done</Text>
              </Pressable>
            </View>
          </View>
          {live.error && <Text style={styles.modalError}>lens: {live.error}</Text>}

          {live.streaming && (
            <View style={styles.lensMirror}>
              <Text style={styles.lensMirrorLabel}>ON THE LENS NOW</Text>
              {live.currentFrame
                ? live.currentFrame.split('\n').map((l, i) => (
                    <Text key={i} style={styles.lensMirrorLine}>{l}</Text>
                  ))
                : <Text style={styles.lensMirrorWait}>waiting for the next play…</Text>}
            </View>
          )}

          {loading && (
            <View style={styles.modalCenter}>
              <ActivityIndicator color="#4ade80" />
            </View>
          )}
          {err && !loading && <Text style={styles.modalError}>{err}</Text>}
          {!loading && !err && plays.length === 0 && (
            <Text style={styles.empty}>No plays yet.</Text>
          )}

          <ScrollView style={styles.pbpList} contentContainerStyle={{ paddingBottom: 24 }}>
            {plays.map((p) => (
              <View key={p.id} style={[styles.pbpRow, p.scoring && styles.pbpScoring]}>
                <View style={styles.pbpMeta}>
                  <Text style={styles.pbpClock}>
                    {[league ? periodLabel(league, p.period) : '', p.clock].filter(Boolean).join(' ')}
                  </Text>
                  {p.score !== '' && <Text style={styles.pbpScore}>{p.score}</Text>}
                </View>
                <Text style={[styles.pbpText, p.scoring && styles.pbpTextScoring]}>{p.text}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/**
 * DeckView — the conversation deck (#46). Pick an audience, step through its
 * cards, and mirror the current card to the lens. Play claims the lens and
 * pushes; Pause blanks it and hands ownership back (the #43 arbiter). Stepping
 * is manual so the wearer paces the conversation.
 */
function DeckView() {
  const { core, isConnected } = useG1();
  const connected = isConnected;

  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [audienceId, setAudienceId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await listAudiences();
      if (!alive) return;
      setAudiences(list);
      setAudienceId((cur) => cur ?? list[0]?.id ?? null);
    })();
    return () => { alive = false; };
  }, []);

  const audience = audiences.find((a) => a.id === audienceId) ?? null;
  const { deck, index, current, loading, error, playing, next, prev, pause, play, refresh } =
    useDeck(core, audience, NO_LIVE, connected);

  // The selected tab owns the lens: leaving Sports pauses the deck.
  useFocusEffect(useCallback(() => () => pause(), [pause]));

  const atStart = index <= 0;
  const atEnd = index >= deck.length - 1;

  return (
    <View style={styles.liveBody}>
      <View style={styles.header}>
        <Text style={styles.title}>Deck</Text>
        <Text style={[styles.conn, { color: connected ? C.accent : C.dim }]}>
          {connected ? '● glasses' : '○ no glasses'}
        </Text>
      </View>

      {/* Audience picker */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.leagueRow}>
        {audiences.map((a) => {
          const on = a.id === audienceId;
          return (
            <Pressable
              key={a.id}
              onPress={() => { setAudienceId(a.id); if (playing) pause(); }}
              style={[styles.chip, on && styles.chipOn, { marginRight: 8 }]}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{a.name}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {audiences.length === 0 && (
        <Text style={styles.empty}>No audiences yet. Build one in the Audiences tab.</Text>
      )}

      {/* Card viewer */}
      {audience && (
        <View style={styles.deckCard}>
          {loading ? (
            <Text style={styles.deckMuted}>Loading cards…</Text>
          ) : error ? (
            <Text style={[styles.deckMuted, { color: C.hot }]}>⚠ {error}</Text>
          ) : current ? (
            <>
              <View style={styles.deckMeta}>
                <Text style={styles.league}>{current.topicLabel.toUpperCase()}</Text>
                <View style={[styles.stanceBadge, current.stance === 'know' ? styles.stanceKnow : styles.stanceLearn]}>
                  <Text style={styles.stanceText}>{current.stance === 'know' ? 'SHARE' : 'ASK'}</Text>
                </View>
              </View>
              <Text style={styles.deckText}>{current.text}</Text>
              <Text style={styles.deckCount}>{index + 1} / {deck.length}</Text>
            </>
          ) : (
            <Text style={styles.deckMuted}>No cards for this audience right now.</Text>
          )}
        </View>
      )}

      {/* Navigation + play/pause */}
      {current && (
        <View style={styles.deckNav}>
          <Pressable onPress={prev} disabled={atStart} style={[styles.navBtn, atStart && styles.navBtnOff]} hitSlop={8}>
            <Text style={styles.navText}>‹ Prev</Text>
          </Pressable>
          <Pressable onPress={playing ? pause : play} style={[styles.cta, { flex: 1, marginHorizontal: 8 }, playing && styles.ctaLive]}>
            <Text style={styles.ctaText}>{playing ? 'Pause lens' : 'Play to lens'}</Text>
          </Pressable>
          <Pressable onPress={next} disabled={atEnd} style={[styles.navBtn, atEnd && styles.navBtnOff]} hitSlop={8}>
            <Text style={styles.navText}>Next ›</Text>
          </Pressable>
        </View>
      )}

      {audience && !loading && (
        <Pressable onPress={refresh} hitSlop={6}>
          <Text style={styles.status}>↻ Refresh cards</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * StreamView — the core loop (#49). Two phases on one surface:
 *   1. PICK: browse team/league news, tap to queue (ArticlePicker).
 *   2. STREAM: full article prose auto-advances past your eyes on the lens,
 *      hands-free, phone in pocket; plays through then goes dark (sleep-safe).
 *
 * onStream hands the queued ids to useArticleStream, which pre-wraps all prose
 * BEFORE playing (survives backgrounding) and claims the lens on play. "Back to
 * picking" pauses (releasing the lens via the #43 arbiter) and returns to phase 1.
 */
function StreamView() {
  const { core, isConnected } = useG1();
  const [picking, setPicking] = useState(true);

  const {
    lines, index, currentHeadline, loading, error, skipped,
    playing, done, load, play, pause, next, prev, lastTop, currentFrame, resume,
  } = useArticleStream(core, isConnected);

  // The selected tab owns the lens: leaving Sports pauses the stream.
  useFocusEffect(useCallback(() => () => pause(), [pause]));

  // On mount, offer to resume a stream a prior session froze (cold-kill mid-
  // stream, #49). If one restores, drop straight out of the picker into it —
  // the wearer woke the app to keep watching, not to re-pick. No re-fetch.
  useEffect(() => {
    let alive = true;
    // resume() self-starts playback off the just-loaded snapshot (calling
    // play() here would read stale render-time lines and no-op). We only leave
    // the picker when a stream was actually restored.
    void resume().then((restored) => {
      if (alive && restored) setPicking(false);
    });
    return () => { alive = false; };
    // Run once on mount; resume/play are stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onStream = useCallback((ids: string[]) => {
    setPicking(false);
    // Pre-wrap all prose up front, then auto-play — no network mid-stream.
    void load(ids).then(() => play());
  }, [load, play]);

  const backToPicking = useCallback(() => {
    pause(); // releases the lens (#43 arbiter)
    setPicking(true);
  }, [pause]);

  // Tear down on unmount: hand the lens back to whoever's next. Must match the
  // token useArticleStream claims under ('sports.stream'), else this is a no-op.
  useEffect(() => () => { core.releaseDisplay('sports.stream'); }, [core]);

  if (picking) {
    return <ArticlePicker sources={STREAM_SOURCES} onStream={onStream} />;
  }

  // atEnd derives from the hook's lastTop (= lines.length - WINDOW_SIZE), the
  // actual last reachable window top. Using lines.length - 1 here left Fwd ›
  // permanently enabled-but-dead, since the clock/next() clamp never reaches it.
  const atStart = index <= 0;
  const atEnd = index >= lastTop;

  return (
    <View style={styles.liveBody}>
      <View style={styles.header}>
        <Text style={styles.title}>Stream</Text>
        <Text style={[styles.conn, { color: isConnected ? C.accent : C.dim }]}>
          {isConnected ? '● glasses' : '○ no glasses'}
        </Text>
      </View>

      <View style={styles.deckCard}>
        {loading ? (
          <Text style={styles.deckMuted}>Preparing prose…</Text>
        ) : error ? (
          <Text style={[styles.deckMuted, { color: C.hot }]}>⚠ {error}</Text>
        ) : done ? (
          <Text style={styles.deckMuted}>Stream complete. Lens is dark.</Text>
        ) : lines.length > 0 ? (
          <>
            <Text style={styles.league} numberOfLines={2}>{currentHeadline}</Text>
            {/* Mirror the lens exactly — currentFrame is the same windowed text
                the wearer sees; cap at a window's worth of lines. */}
            <Text style={styles.deckText} numberOfLines={4}>
              {currentFrame}
            </Text>
            <Text style={styles.deckCount}>line {index + 1} / {lines.length}</Text>
          </>
        ) : (
          <Text style={styles.deckMuted}>Nothing to stream.</Text>
        )}
      </View>

      {/* Surfaced unstreamable articles — never silently dropped (Zoracon). */}
      {skipped.length > 0 && (
        <View style={styles.skipBox}>
          {skipped.map((s) => (
            <Text key={s.articleId} style={styles.skipText} numberOfLines={1}>
              ⤫ {s.reason === 'video' ? 'video (no prose)' : s.reason === 'empty-body' ? 'empty body' : 'fetch failed'} · {s.articleId}
            </Text>
          ))}
        </View>
      )}

      {lines.length > 0 && !done && (
        <View style={styles.deckNav}>
          <Pressable onPress={prev} disabled={atStart} style={[styles.navBtn, atStart && styles.navBtnOff]} hitSlop={8}>
            <Text style={styles.navText}>‹ Back</Text>
          </Pressable>
          <Pressable onPress={playing ? pause : play} style={[styles.cta, { flex: 1, marginHorizontal: 8 }, playing && styles.ctaLive]}>
            <Text style={styles.ctaText}>{playing ? 'Pause' : 'Play'}</Text>
          </Pressable>
          <Pressable onPress={next} disabled={atEnd} style={[styles.navBtn, atEnd && styles.navBtnOff]} hitSlop={8}>
            <Text style={styles.navText}>Fwd ›</Text>
          </Pressable>
        </View>
      )}

      <Pressable onPress={backToPicking} hitSlop={6}>
        <Text style={styles.status}>‹ Back to picking</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  liveBody: { flex: 1, paddingHorizontal: 16 },
  segmentRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  segment: { flex: 1, paddingVertical: 8, borderRadius: 18, borderWidth: 1, borderColor: C.border, alignItems: 'center' },
  segmentOn: { backgroundColor: C.card, borderColor: C.accent },
  segmentText: { color: C.dim, fontSize: 14, fontWeight: '700' },
  segmentTextOn: { color: C.text },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 12 },
  title: { color: C.text, fontSize: 24, fontWeight: '700' },
  conn: { fontSize: 13, fontWeight: '600' },
  leagueRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  // flexGrow 0: a horizontal ScrollView otherwise grows to share the column's height.
  leagueScroll: { flexGrow: 0, marginBottom: 12, flexShrink: 0 },
  leagueScrollContent: { gap: 8, alignItems: 'center' },
  // Live view's own status line (styles.status is shared with the other views).
  feedStatus: { color: C.dim, fontSize: 12, marginTop: 8, textAlign: 'center', lineHeight: 16, minHeight: 16 },
  scoreHelp: { color: C.dim, fontSize: 11, lineHeight: 15, marginTop: 6 },
  gameStack: { flexDirection: 'column', alignItems: 'stretch' },
  gameTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scoreLabel: { color: C.dim, fontSize: 10, lineHeight: 12, fontWeight: '700', letterSpacing: 0.5 },
  chip: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1, borderColor: C.border, minHeight: 34, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: C.card, borderColor: C.accent },
  chipText: { color: C.dim, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  chipTextOn: { color: C.text },
  cta: { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: C.accent },
  ctaLive: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hot },
  ctaText: { color: C.text, fontSize: 16, fontWeight: '700' },
  status: { color: C.dim, fontSize: 12, marginTop: 8, textAlign: 'center' },
  list: { marginTop: 16, flex: 1 },
  empty: { color: C.dim, textAlign: 'center', marginTop: 40, fontSize: 14 },
  game: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.card, borderRadius: 10, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  gameLeft: { flex: 1 },
  league: { color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1, lineHeight: 14 },
  matchup: { color: C.text, fontSize: 16, fontWeight: '600', marginTop: 2, lineHeight: 22 },
  gameStatus: { color: C.dim, fontSize: 12, marginTop: 2, lineHeight: 16 },
  leaders: { color: C.accent, fontSize: 12, marginTop: 6, fontWeight: '600', lineHeight: 16, minHeight: 16 },
  gameRight: { alignItems: 'flex-end', marginLeft: 12, minWidth: 56 },
  score: { fontSize: 22, fontWeight: '800', lineHeight: 26 },
  onGlasses: { color: C.accent, fontSize: 10, fontWeight: '700', marginTop: 2 },
  gamePressed: { opacity: 0.6 },
  tapHint: { color: C.dim, fontSize: 11, fontWeight: '600', marginTop: 2 },

  // Play-by-play modal
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: C.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '82%', paddingHorizontal: 16, paddingTop: 16 },
  modalHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  modalTitle: { color: C.text, fontSize: 18, fontWeight: '700' },
  modalSub: { color: C.dim, fontSize: 13, marginTop: 2 },
  modalClose: { color: C.accent, fontSize: 16, fontWeight: '700' },
  modalActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  lensBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: C.accent },
  lensBtnOn: { backgroundColor: C.accent, borderColor: C.accent },
  lensBtnOff: { borderColor: C.border },
  lensBtnText: { color: C.accent, fontSize: 13, fontWeight: '700' },
  lensBtnTextOn: { color: C.bg },
  lensMirror: {
    marginTop: 10, marginBottom: 6, padding: 12, borderRadius: 10,
    borderWidth: 1, borderColor: C.accent, backgroundColor: 'rgba(74,222,128,0.06)',
  },
  lensMirrorLabel: { color: C.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 6 },
  lensMirrorLine: {
    color: C.accent, fontSize: 18, lineHeight: 24,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  lensMirrorWait: { color: C.dim, fontSize: 14, fontStyle: 'italic' },
  modalCenter: { paddingVertical: 32, alignItems: 'center' },
  modalError: { color: C.hot, fontSize: 13, textAlign: 'center', marginTop: 24 },
  pbpList: { marginTop: 10 },
  pbpRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border },
  pbpScoring: { backgroundColor: C.card, borderRadius: 8, paddingHorizontal: 10, marginVertical: 2, borderBottomWidth: 0 },
  pbpMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 3 },
  pbpClock: { color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  pbpScore: { color: C.accent, fontSize: 11, fontWeight: '800' },
  pbpText: { color: C.text, fontSize: 14, lineHeight: 19 },
  pbpTextScoring: { fontWeight: '700' },

  // Deck (#46)
  deckCard: { backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 18, marginTop: 8, minHeight: 180, justifyContent: 'center' },
  deckMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  deckText: { color: C.text, fontSize: 20, fontWeight: '600', lineHeight: 28 },
  deckCount: { color: C.dim, fontSize: 12, marginTop: 14, textAlign: 'right' },
  deckMuted: { color: C.dim, fontSize: 14, textAlign: 'center' },
  stanceBadge: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: 10 },
  stanceKnow: { backgroundColor: C.accent },
  stanceLearn: { backgroundColor: C.hot },
  stanceText: { color: C.text, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  deckNav: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  navBtn: { paddingVertical: 14, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, borderColor: C.border },
  navBtnOff: { opacity: 0.35 },
  navText: { color: C.text, fontSize: 15, fontWeight: '700' },
  skipBox: { marginTop: 10, gap: 2 },
  skipText: { color: C.hot, fontSize: 11, fontWeight: '600' },
});
