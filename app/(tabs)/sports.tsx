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

const ALL_LEAGUES: League[] = ['NBA', 'NHL', 'NCAAM'];

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

export default function SportsScreen() {
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
  useEffect(() => () => { feedRef.current?.stop(); core.releaseDisplay('sports'); }, [core]);

  const start = useCallback(() => {
    feedRef.current?.stop();
    setError(null);
    // Take the lens for the sports mode. The teleprompter screen stays mounted
    // in the tab stack and its resync effects would otherwise re-push a script
    // line over our scores (the toggling bug). Claiming makes sports the sole
    // owner; teleprompter pushes tagged 'teleprompter' are dropped until we
    // release on stop.
    core.claimDisplay('sports');
    const feed = new SportsFeed({
      leagues,
      pollMs: DEFAULT_POLL_MS,
      onGames: (g) => { setGames(g); setLastUpdate(Date.now()); },
      onFrame: (frame) => {
        // Only push to the lenses when both are usable (isConnected = AND of
        // txReady). Guarding here avoids enqueuing frames that would be dropped.
        if (isConnectedRef.current && !core.status.poweredOff) {
          core.note('[sports] push HUD frame');
          void core.sendText(frame, 1, 1, true, undefined, 'sports');
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
    core.releaseDisplay('sports');
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
    <SafeAreaView style={styles.safe}>
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 16 },
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
});
