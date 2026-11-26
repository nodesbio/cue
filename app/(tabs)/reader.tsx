/**
 * Ambient news reader (#47) — DISCREET, SmartRemote-controlled.
 *
 * The non-conversational mode: when you have no one to talk to, the glasses show
 * a news HEADLINE you can glance at. One remote button advances; another expands
 * the headline into ESPN's description so you can read more — all without the
 * phone leaving your pocket (the whole point: fiddling with a phone mid-conversation
 * reads as rude; a remote in your hand does not).
 *
 *   next  (SmartRemote >>)         → next headline
 *   select  (SmartRemote play/pause) → expand ⇄ collapse the current headline
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
import { useLensOwnership } from '@/lib/g1/useLensOwner';
import { cardsFromNews, type NewsCard, type EspnNewsResponse } from '@/lib/sports/cards';
import type { Topic } from '@/lib/sports/audience';
import { wrapParagraph, MAX_CHARS } from '@/lib/teleprompter/lineWrapper';

const OWNER = 'reader';

/**
 * Glasses line-wrap width for reader cards. The G1 font is PROPORTIONAL, not
 * monospaced (device-measured 2026-11 via settings.tsx width probe: a 44-char
 * mixed-case team line fits one line with room to spare; a digit ruler runs to
 * ~64 before wrapping; all-caps W/M wrap earliest at ~36). So "chars per line"
 * is a soft limit, not a hard one — we reuse the teleprompter's established
 * MAX_CHARS=45 soft limit (SPEC.md §2: "~45, proportional font, treat as soft
 * limit") rather than a separate lower number. 45 fits all real team strings;
 * worst-case all-caps wraps a touch early, which is the accepted tradeoff. */
const GLASSES_COLS = MAX_CHARS;

/** Hands-free auto-read cycle. The reader must deliver value with NO input at all
 *  (no SmartRemote, no touchpad, no head gesture), so each card reads itself:
 *    headline  → hold HEADLINE_MS  → (if it has a blurb) auto-expand → hold DETAIL_MS → next
 *  A card with no blurb just holds HEADLINE_MS and advances. These are glance-paced
 *  guesses; tune on-device. Any gesture (head_up / tap) freezes the cycle to read. */
const HEADLINE_MS = 5000;
const DETAIL_MS   = 7000;

/** How often to re-pull the feeds. ESPN turns over through the day; refreshing
 *  keeps the loop fed with new material so the reader stops feeling repetitive.
 *  New stories are merged + deduped into the pool, not replaced wholesale. */
const REFRESH_MS = 10 * 60 * 1000;

/** League news endpoints we read for the ambient feed. Keyless ESPN, limit=50
 *  (the max it honors). Broadened beyond NBA/NFL/F1 so the pool is large and
 *  varied enough that the cycle doesn't repeat within a sitting. */
const FEEDS: Array<{ sport: string; league: string; label: string; url: string }> = [
  { sport: 'basketball', league: 'nba',           label: 'NBA',     url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=50' },
  { sport: 'football',   league: 'nfl',           label: 'NFL',     url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50' },
  { sport: 'racing',     league: 'f1',            label: 'F1',      url: 'https://site.api.espn.com/apis/site/v2/sports/racing/f1/news?limit=50' },
  { sport: 'football',   league: 'college-football', label: 'CFB',  url: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/news?limit=50' },
  { sport: 'basketball', league: 'mens-college-basketball', label: 'NCAAB', url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/news?limit=50' },
  { sport: 'soccer',     league: 'eng.1',         label: 'EPL',     url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/news?limit=50' },
];

/** Minimal league topic for the reader. No audience, no stance voice — we render
 *  the plain headline/description, not the stance hook. 'know' is inert here. */
function readerTopic(f: { sport: string; league: string; label: string }): Topic {
  return { kind: 'league', sport: f.sport, league: f.league, label: f.label, stance: 'know' };
}

export default function ReaderScreen() {
  const { core, isConnected } = useG1();
  // Lifecycle + guarded push for the shared lens arbiter. The reader is an
  // imperative timer state machine, so it uses the lifecycle hook (claim on
  // focus / yield on blur+unmount) and calls lens.push() at its own sequencing
  // points — NOT the reactive useLensOwner wrapper, which would double-write.
  // Stable callbacks only — the `lens` object re-identifies when `on` flips,
  // which would re-fire the focus effect below (claim→yield→claim churn).
  const { start: lensStart, stop: lensStop, push: lensPush } =
    useLensOwnership(core, isConnected, OWNER);
  const [cards, setCards] = useState<NewsCard[]>([]);
  const [idx, setIdx] = useState(0);
  const [expanded, setExpanded] = useState(false);   // showing the blurb vs the headline
  const [frozen, setFrozen] = useState(false);       // gesture-held so you can read at your pace
  const [loading, setLoading] = useState(true);

  // Refs so the (once-registered) event handler + self-scheduling cycle always
  // see current state without re-arming timers.
  const cardsRef = useRef<NewsCard[]>([]);
  const idxRef = useRef(0);
  const expandedRef = useRef(false);
  const frozenRef = useRef(false);
  const cycleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Cards shown since the last wrap. We advance through unseen cards first and
   *  only reset (allowing repeats) once the whole pool has been read — so you
   *  don't re-see story #3 while #40 is still waiting. */
  const seenRef = useRef<Set<string>>(new Set());
  useEffect(() => { cardsRef.current = cards; }, [cards]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);
  useEffect(() => { frozenRef.current = frozen; }, [frozen]);

  // ── Fetch + periodic refresh; merge new stories into the pool, deduped ───────
  useEffect(() => {
    let alive = true;

    const pull = async () => {
      const fetched: NewsCard[] = [];
      for (const f of FEEDS) {
        try {
          const res = (await (await fetch(f.url)).json()) as EspnNewsResponse;
          fetched.push(...cardsFromNews(readerTopic(f), res));
        } catch (e) {
          // Zoracon: surface, don't swallow. One dead feed shouldn't blank the reader.
          core.note(`[reader] feed failed ${f.league}: ${String(e)}`);
        }
      }
      if (!alive) return;
      // Merge by stable id (key#news:published). New stories join the pool;
      // existing ones keep their slot so the current read position isn't jostled.
      // Merged from cardsRef, not inside a setCards updater: an updater runs
      // during render, and logging from one re-rendered the log listener mid-render.
      const byId = new Map<string, NewsCard>();
      for (const c of cardsRef.current) byId.set(c.id, c);
      let added = 0;
      for (const c of fetched) if (!byId.has(c.id)) { byId.set(c.id, c); added++; }
      const merged = [...byId.values()].sort((a, b) => b.published - a.published);
      cardsRef.current = merged;
      setCards(merged);
      if (added) core.note(`[reader] refresh +${added} new (pool ${merged.length})`);
      setLoading(false);
    };

    void pull();
    const timer = setInterval(() => { void pull(); }, REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [core]);

  // ── Push the current card to the lens ──────────────────────────────────────
  const push = useCallback(() => {
    const list = cardsRef.current;
    if (!list.length) return;
    const card = list[idxRef.current];
    if (!card) return;
    const body = expandedRef.current && card.description ? card.description : card.headline;
    // Word-wrap to the glasses soft limit (≤45 proportional cols, left-aligned, plain text).
    // Header and body are separate "thoughts" → blank line between them per spec.
    // Long words hard-break (wrapParagraph handles it) so nothing clips off-screen.
    // Pagination of very long blurbs across frames is still a follow-on; for now a
    // long blurb fills the lens top-down and the overflow tail is not shown.
    const header = `${card.topicLabel} · ${new Date(card.published).toLocaleDateString()}`;
    const frame = [
      ...wrapParagraph(header, GLASSES_COLS),
      '',
      ...wrapParagraph(body, GLASSES_COLS),
    ].join('\n');
    core.note(`[reader] push idx=${idxRef.current}/${list.length} expanded=${expandedRef.current}`);
    // lens.push owns the connected/poweredOff guard + arbiter owner tag.
    lensPush(frame);
  }, [core, lensPush]);

  const clearCycle = useCallback(() => {
    if (cycleRef.current) { clearTimeout(cycleRef.current); cycleRef.current = null; }
  }, []);

  /** Pick the next card index that hasn't been shown since the last wrap. When
   *  every card has been seen, clear the seen-set and start a fresh pass from the
   *  freshest story — so repeats only happen after you've exhausted the pool. */
  const nextUnseenIdx = useCallback((): number => {
    const list = cardsRef.current;
    if (!list.length) return 0;
    const seen = seenRef.current;
    // Scan forward from the current position for the first unseen card.
    for (let step = 1; step <= list.length; step++) {
      const i = (idxRef.current + step) % list.length;
      if (!seen.has(list[i].id)) return i;
    }
    // Whole pool exhausted → reset and begin a new pass at the top (freshest).
    seen.clear();
    core.note('[reader] pool exhausted — starting a fresh pass');
    return 0;
  }, [core]);

  /** Record a card as shown so nextUnseenIdx skips it until the next pass. */
  const markSeen = useCallback((i: number) => {
    const card = cardsRef.current[i];
    if (card) seenRef.current.add(card.id);
  }, []);

  /** The self-driving hands-free cycle. Each call paints the current phase, then
   *  schedules the next step — headline → (auto-expand) detail → next card → … —
   *  so the feed reads itself with no input. While frozen, it stops rescheduling
   *  (the current card stays on the lens until a gesture resumes it). */
  const tick = useCallback(() => {
    clearCycle();
    const list = cardsRef.current;
    if (!list.length) return;
    const card = list[idxRef.current];
    if (!card) return;

    markSeen(idxRef.current); // the card now on the lens counts as read
    push(); // paint whatever expanded/idx currently say
    if (frozenRef.current) return; // held for reading — don't schedule the next step

    const hasDetail = !!card.description;
    if (!expandedRef.current && hasDetail) {
      // Phase 1 → 2: after the headline dwell, auto-expand into the blurb.
      cycleRef.current = setTimeout(() => {
        expandedRef.current = true;
        setExpanded(true);
        tick();
      }, HEADLINE_MS);
    } else {
      // Phase 2 (or headline-only card): after the dwell, advance to the next unseen card.
      const dwell = expandedRef.current ? DETAIL_MS : HEADLINE_MS;
      cycleRef.current = setTimeout(() => {
        idxRef.current = nextUnseenIdx();
        expandedRef.current = false;
        setIdx(idxRef.current);
        setExpanded(false);
        tick();
      }, dwell);
    }
  }, [push, clearCycle, markSeen, nextUnseenIdx]);

  /** Skip to the next unseen card now (next / on-screen Skip). Keeps the cycle running. */
  const skip = useCallback(() => {
    const list = cardsRef.current;
    if (!list.length) return;
    idxRef.current = nextUnseenIdx();
    expandedRef.current = false;
    setIdx(idxRef.current);
    setExpanded(false);
    tick();
  }, [tick, nextUnseenIdx]);

  /** Freeze / resume. head_up (or select) holds the current card AND expands it
   *  so you can read at your own pace with no remote. head_down / another gesture
   *  resumes the auto-cycle. This is the hands-free "look up to read" control. */
  const freeze = useCallback(() => {
    frozenRef.current = true;
    setFrozen(true);
    const card = cardsRef.current[idxRef.current];
    if (card?.description && !expandedRef.current) {
      expandedRef.current = true;
      setExpanded(true);
    }
    tick(); // repaint, then (because frozen) stop scheduling
  }, [tick]);

  const resume = useCallback(() => {
    frozenRef.current = false;
    setFrozen(false);
    tick(); // resumes scheduling from the current card
  }, [tick]);

  const toggleFreeze = useCallback(() => {
    if (frozenRef.current) resume(); else freeze();
  }, [freeze, resume]);

  // ── Own the display + input while focused; the auto-read cycle starts on focus ─
  useFocusEffect(useCallback(() => {
    lensStart();                  // claim the lens (synchronous; push() is safe now)
    frozenRef.current = false;    // opening Reader (re)starts the hands-free cycle
    expandedRef.current = false;
    setFrozen(false);
    setExpanded(false);

    const handler = (event: { name: string }) => {
      switch (event.name) {
        case 'head_up':    freeze(); break;   // hands-free: look up to hold & read
        case 'head_down':  resume(); break;   // look down to let it roll again
        case 'select': toggleFreeze(); break; // temple touchpad / remote: hold ⇄ resume
        case 'next': skip(); break;     // temple touchpad / remote: skip now
        // everything else ignored.
      }
    };
    core.addEventHandler(handler);

    tick(); // kick off the self-driving cycle immediately — value with zero input

    return () => {
      clearCycle();
      core.removeEventHandler(handler);
      lensStop();
    };
  }, [core, lensStart, lensStop, tick, skip, freeze, resume, toggleFreeze, clearCycle]));

  const current = cards[idx];

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Ambient Reader</Text>
      <Text style={styles.hint}>
        {frozen ? 'Held — reading ⏸' : 'Reading itself ▶'}. No controller needed: headlines
        expand and advance on their own. Look up to hold &amp; read, look down to resume.
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
            <Text style={styles.dim}>detail expands automatically…</Text>
          ) : (
            <Text style={styles.dim}>(headline only)</Text>
          )}
        </ScrollView>
      )}
      {/* On-screen mirrors of the gestures, for testing without the glasses. */}
      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={toggleFreeze}>
          <Text style={styles.btnText}>{frozen ? 'Resume ▶' : 'Hold & read ⏸'}</Text>
        </Pressable>
        <Pressable style={styles.btn} onPress={skip}><Text style={styles.btnText}>Skip ⏭</Text></Pressable>
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
