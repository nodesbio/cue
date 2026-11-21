/**
 * Ambient news reader (#47) — DISCREET, SmartRemote-controlled.
 *
 * The non-conversational mode: when you have no one to talk to, the glasses show
 * a news HEADLINE you can glance at. One remote button advances; another expands
 * the headline into ESPN's description so you can read more — all without the
 * phone leaving your pocket (the whole point: fiddling with a phone mid-conversation
 * reads as rude; a remote in your hand does not).
 *
 *   single_tap  (SmartRemote >>)         → next headline
 *   triple_tap  (SmartRemote play/pause) → expand ⇄ collapse the current headline
 *
 * SCOPE / HONEST LIMITS (see docs/issues/47 + #43):
 *   - This owns the display ('reader') via the arbiter, so stray teleprompter
 *     re-pushes can't stomp a lens while we're foreground.
 *   - INPUT ownership is NOT yet solved (#43): core broadcasts every press to all
 *     registered handlers. This screen is safe ONLY when the teleprompter is not
 *     also running — i.e. use the reader standalone, not while teleprompting.
 *     That's a real constraint, stated plainly, not a hidden fallback.
 *   - No model calls, no takes, no new ESPN fetches — reuses the deck's cards.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useG1 } from '@/lib/g1/G1Context';
import { cardsFromNews, type NewsCard, type EspnNewsResponse } from '@/lib/sports/cards';
import type { Topic } from '@/lib/sports/audience';

const OWNER = 'reader';

/** League news endpoints we read for the ambient feed. Keyless ESPN. */
const FEEDS: Array<{ sport: string; league: string; label: string; url: string }> = [
  { sport: 'basketball', league: 'nba', label: 'NBA', url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=20' },
  { sport: 'football',   league: 'nfl', label: 'NFL', url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=20' },
  { sport: 'racing',     league: 'f1',  label: 'F1',  url: 'https://site.api.espn.com/apis/site/v2/sports/racing/f1/news?limit=20' },
];

/** Minimal league topic for the reader. No audience, no stance voice — we render
 *  the plain headline/description, not the stance hook. 'know' is inert here. */
function readerTopic(f: { sport: string; league: string; label: string }): Topic {
  return { kind: 'league', sport: f.sport, league: f.league, label: f.label, stance: 'know' };
}

export default function ReaderScreen() {
  const { core, isConnected } = useG1();
  const [cards, setCards] = useState<NewsCard[]>([]);
  const [idx, setIdx] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);

  // Refs so the remote handler (registered once) always sees current state.
  const cardsRef = useRef<NewsCard[]>([]);
  const idxRef = useRef(0);
  const expandedRef = useRef(false);
  const connectedRef = useRef(isConnected);
  useEffect(() => { cardsRef.current = cards; }, [cards]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);
  useEffect(() => { connectedRef.current = isConnected; }, [isConnected]);

  // ── Fetch news once on mount (reuses the deck's cardsFromNews) ──────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      const all: NewsCard[] = [];
      for (const f of FEEDS) {
        try {
          const res = (await (await fetch(f.url)).json()) as EspnNewsResponse;
          all.push(...cardsFromNews(readerTopic(f), res));
        } catch (e) {
          // Zoracon: surface, don't swallow. One dead feed shouldn't blank the reader.
          core.note(`[reader] feed failed ${f.league}: ${String(e)}`);
        }
      }
      if (!alive) return;
      all.sort((a, b) => b.published - a.published); // freshest first
      setCards(all);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [core]);

  // ── Push the current card to the lens ──────────────────────────────────────
  const push = useCallback(() => {
    const list = cardsRef.current;
    if (!list.length || !connectedRef.current || core.status.poweredOff) return;
    const card = list[idxRef.current];
    if (!card) return;
    const body = expandedRef.current && card.description ? card.description : card.headline;
    // Single page for the headline; expanded blurb paginates via the engine.
    // For tonight we send as one frame — long blurbs will clip; pagination is a
    // follow-on (acceptance item), not needed for a usable first cut.
    const frame = `${card.topicLabel} · ${new Date(card.published).toLocaleDateString()}\n${body}`;
    core.note(`[reader] push idx=${idxRef.current}/${list.length} expanded=${expandedRef.current}`);
    void core.sendText(frame, 1, 1, true, undefined, OWNER);
  }, [core]);

  const advance = useCallback(() => {
    const list = cardsRef.current;
    if (!list.length) return;
    idxRef.current = (idxRef.current + 1) % list.length;
    expandedRef.current = false; // new card always starts collapsed
    setIdx(idxRef.current);
    setExpanded(false);
    push();
  }, [push]);

  const toggleExpand = useCallback(() => {
    const card = cardsRef.current[idxRef.current];
    if (!card) return;
    if (!card.description) {
      core.note('[reader] expand no-op — card has no description'); // not swallowed
      return;
    }
    expandedRef.current = !expandedRef.current;
    setExpanded(expandedRef.current);
    push();
  }, [core, push]);

  // ── Own the display + remote while focused ─────────────────────────────────
  useFocusEffect(useCallback(() => {
    core.claimDisplay(OWNER);
    const handler = (event: { name: string }) => {
      if (event.name === 'single_tap') advance();
      else if (event.name === 'triple_tap') toggleExpand();
      // head_up/down and everything else: ignored by the reader.
    };
    core.addEventHandler(handler);
    push(); // paint the current card on (re)focus
    return () => {
      core.removeEventHandler(handler);
      core.releaseDisplay(OWNER);
    };
  }, [core, advance, toggleExpand, push]));

  const current = cards[idx];

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Ambient Reader</Text>
      <Text style={styles.hint}>
        SmartRemote: ⏭ next headline · ▶❙❙ expand / collapse. Keep the phone in your pocket.
      </Text>
      {!isConnected && <Text style={styles.warn}>Glasses not connected — connect to read on the HUD.</Text>}
      {loading ? (
        <Text style={styles.dim}>Loading news…</Text>
      ) : !cards.length ? (
        <Text style={styles.dim}>No fresh headlines right now.</Text>
      ) : (
        <ScrollView style={styles.card} contentContainerStyle={styles.cardInner}>
          <Text style={styles.meta}>
            {current?.topicLabel} · {current ? new Date(current.published).toLocaleDateString() : ''} · {idx + 1}/{cards.length}
          </Text>
          <Text style={styles.headline}>{current?.headline}</Text>
          {expanded && current?.description ? (
            <Text style={styles.body}>{current.description}</Text>
          ) : current?.description ? (
            <Text style={styles.dim}>▶❙❙ to expand</Text>
          ) : (
            <Text style={styles.dim}>(no detail to expand)</Text>
          )}
        </ScrollView>
      )}
      {/* On-screen mirrors of the remote, for testing without the glasses. */}
      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={toggleExpand}><Text style={styles.btnText}>Expand ⇄</Text></Pressable>
        <Pressable style={styles.btn} onPress={advance}><Text style={styles.btnText}>Next ⏭</Text></Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 20, paddingTop: 60, backgroundColor: '#0b0b0c' },
  title: { color: '#fff', fontSize: 24, fontWeight: '800' },
  hint: { color: '#9aa', fontSize: 13, marginTop: 6, marginBottom: 12 },
  warn: { color: '#f5a623', fontSize: 13, marginBottom: 10 },
  dim: { color: '#778', fontSize: 14, marginTop: 10 },
  card: { flex: 1, backgroundColor: '#161618', borderRadius: 14, marginTop: 6 },
  cardInner: { padding: 18 },
  meta: { color: '#8ab4f8', fontSize: 13, fontWeight: '600', marginBottom: 8 },
  headline: { color: '#fff', fontSize: 20, fontWeight: '700', lineHeight: 26 },
  body: { color: '#cdd', fontSize: 16, lineHeight: 24, marginTop: 14 },
  row: { flexDirection: 'row', gap: 12, marginTop: 14 },
  btn: { flex: 1, backgroundColor: '#2a2a2e', paddingVertical: 16, borderRadius: 12, alignItems: 'center' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
