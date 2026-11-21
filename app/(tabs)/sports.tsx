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
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useG1 } from '@/lib/g1/G1Context';
import { SportsFeed, DEFAULT_POLL_MS } from '@/lib/sports/SportsFeed';
import { LEAGUE_LABEL } from '@/lib/sports/espn';
import type { GameSnapshot, League } from '@/lib/sports/types';
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

const ALL_LEAGUES: League[] = ['NBA', 'NHL', 'NCAAM'];

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

  const updatedLabel = useMemo(() => {
    if (!lastUpdate) return '';
    const secs = Math.round((Date.now() - lastUpdate) / 1000);
    return secs < 5 ? 'just now' : `${secs}s ago`;
  }, [lastUpdate]);

  return (
    <View style={styles.liveBody}>
      <View style={styles.header}>
        <Text style={styles.title}>Live Sports</Text>
        <Text style={[styles.conn, { color: isConnected ? C.accent : C.dim }]}>
          {isConnected ? '● glasses' : '○ glasses'}
        </Text>
      </View>

      {/* League filter */}
      <View style={styles.leagueRow}>
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
      </View>

      {/* Start / stop */}
      <Pressable onPress={live ? stop : start} style={[styles.cta, live && styles.ctaLive]}>
        <Text style={styles.ctaText}>{live ? 'Stop feed' : 'Start 24/7 feed'}</Text>
      </Pressable>

      {live && (
        <Text style={styles.status}>
          {error ? `⚠ ${error}` : `Updated ${updatedLabel} · polling every ${DEFAULT_POLL_MS / 1000}s`}
        </Text>
      )}

      {/* Ranked list */}
      <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 24 }}>
        {games.length === 0 && live && !error && (
          <Text style={styles.empty}>No live games right now.</Text>
        )}
        {games.map((g, i) => (
          <View key={g.gameId} style={styles.game}>
            <View style={styles.gameLeft}>
              <Text style={styles.league}>{LEAGUE_LABEL[g.league]}</Text>
              <Text style={styles.matchup}>{g.away} {g.awayScore} · {g.home} {g.homeScore}</Text>
              <Text style={styles.gameStatus}>{g.status}</Text>
              {g.leaders.length > 0 && (
                <Text style={styles.leaders} numberOfLines={1}>
                  {g.leaders
                    .map((l) => `${l.player} ${l.value} ${l.stat}`)
                    .join('  ·  ')}
                </Text>
              )}
            </View>
            <View style={styles.gameRight}>
              <Text style={[styles.score, { color: heat(g.excitement) }]}>{g.excitement}</Text>
              {i === 0 && <Text style={styles.onGlasses}>on lens</Text>}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
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
  chip: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1, borderColor: C.border },
  chipOn: { backgroundColor: C.card, borderColor: C.accent },
  chipText: { color: C.dim, fontSize: 13, fontWeight: '600' },
  chipTextOn: { color: C.text },
  cta: { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  ctaLive: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hot },
  ctaText: { color: C.text, fontSize: 16, fontWeight: '700' },
  status: { color: C.dim, fontSize: 12, marginTop: 8, textAlign: 'center' },
  list: { marginTop: 16 },
  empty: { color: C.dim, textAlign: 'center', marginTop: 40, fontSize: 14 },
  game: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.card, borderRadius: 10, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  gameLeft: { flex: 1 },
  league: { color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  matchup: { color: C.text, fontSize: 16, fontWeight: '600', marginTop: 2 },
  gameStatus: { color: C.dim, fontSize: 12, marginTop: 2 },
  leaders: { color: C.accent, fontSize: 12, marginTop: 3, fontWeight: '600' },
  gameRight: { alignItems: 'flex-end', marginLeft: 12 },
  score: { fontSize: 22, fontWeight: '800' },
  onGlasses: { color: C.accent, fontSize: 10, fontWeight: '700', marginTop: 2 },

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
