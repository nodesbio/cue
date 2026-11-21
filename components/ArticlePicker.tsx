/**
 * ArticlePicker — phone-side picker for the ambient article stream (#49).
 *
 * Core loop: browse team/league news on the phone → tap to queue articles →
 * hand the queue to the lens stream, which reads full prose past your eyes,
 * hands-free, phone in pocket ("fall asleep seeing OSU narratives").
 *
 * This component owns ONLY the phone-side pick: list, tap-to-queue, per-item
 * status, and the "Stream N articles" handoff. It does not fetch prose or push
 * to the lens — that's useArticleStream, wired by the parent on handoff. Keeping
 * the pick pure of lens concerns mirrors the deck/live split in sports.tsx.
 *
 * Video items are greyed with a provisional hint (newsFeed.maybeVideo); the
 * authoritative "no prose" verdict still comes from the stream's reason:'video'
 * at play time. We never hide an item — surfacing beats silent dropping.
 *
 * SOURCE-AGNOSTIC: the parent supplies `sources` (label + news URL). OSU is a
 * configured source, never hardcoded here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { fetchNewsList, type NewsItem } from '@/lib/sports/newsFeed';
import { loadSeen, partitionBySeen, type SeenMap } from '@/lib/sports/SeenStore';

/** A named news source the picker can browse (label + prebuilt list URL). */
export interface NewsSource {
  id: string;
  label: string;
  /** Prebuilt URL from newsFeed.teamNewsUrl / leagueNewsUrl. */
  url: string;
}

export interface ArticlePickerProps {
  /** Sources to browse (e.g. OSU team, player, league). First is selected. */
  sources: NewsSource[];
  /**
   * Called when the wearer commits the queue to the lens. Ordered by pick order
   * (queue order == read order). The parent wires these ids into
   * useArticleStream and claims the display.
   */
  onStream: (articleIds: string[]) => void;
}

const C = {
  bg: '#0a0a0a',
  card: '#141414',
  border: '#1f1f1f',
  text: '#ffffff',
  dim: '#777777',
  accent: '#39d353',
  hot: '#ff6b3d',
  queued: '#2b7fff',
};

export function ArticlePicker({ sources, onStream }: ArticlePickerProps) {
  const [sourceId, setSourceId] = useState<string | null>(sources[0]?.id ?? null);
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Queue is kept ORDERED (array, not set) so read order == pick order.
  const [queue, setQueue] = useState<string[]>([]);

  // Already-streamed set (#49 dedup). Loaded once on mount; drives the dimmed
  // "SEEN" tag and the Fresh-only filter so a nightly listener surfaces NEW
  // articles instead of last night's. A corrupt read is surfaced (seenWarn) but
  // we default to show-all — a readable picker beats blocking on history, and
  // the store's contract is "caller decides" (SeenStore throws, we choose here).
  const [seen, setSeen] = useState<SeenMap>({});
  const [seenWarn, setSeenWarn] = useState<string | null>(null);
  const [freshOnly, setFreshOnly] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const source = sources.find((s) => s.id === sourceId) ?? null;

  // Load the seen-set once. Refreshed each time a source loads so returning from
  // a stream reflects what was just read (markSeen runs in useArticleStream).
  useEffect(() => {
    void (async () => {
      try {
        setSeen(await loadSeen());
        setSeenWarn(null);
      } catch (e) {
        // Surface, don't silence: history unreadable → show everything, but say so.
        setSeenWarn('Couldn\u2019t read your history — showing all articles.');
        setSeen({});
      }
    })();
  }, [sourceId]);

  // Load the selected source's news list. Aborts an in-flight load on switch.
  useEffect(() => {
    if (!source) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const list = await fetchNewsList(source.url, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setItems(list);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        // Surface the failure — don't fall back to a stale/empty list (Zoracon).
        setError(e instanceof Error ? e.message : String(e));
        setItems([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [source]);

  // Tear down any in-flight fetch on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const toggleQueue = useCallback((id: string) => {
    setQueue((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const clearQueue = useCallback(() => setQueue([]), []);

  const stream = useCallback(() => {
    if (queue.length > 0) onStream(queue);
  }, [queue, onStream]);

  // Split by history; freshOnly hides already-seen items. Order is preserved so
  // the newest headlines stay on top.
  const { fresh, seen: seenItems } = partitionBySeen(items, seen);
  const visible = freshOnly ? fresh : items;
  const seenCount = seenItems.length;

  return (
    <View style={styles.body}>
      <View style={styles.header}>
        <Text style={styles.title}>Pick articles</Text>
        <View style={styles.headerRight}>
          {seenCount > 0 && (
            <Pressable
              onPress={() => setFreshOnly((v) => !v)}
              hitSlop={6}
              style={[styles.freshToggle, freshOnly && styles.freshToggleOn]}
            >
              <Text style={[styles.freshText, freshOnly && styles.freshTextOn]}>
                {freshOnly ? `Fresh only · ${fresh.length}` : `Hide seen · ${seenCount}`}
              </Text>
            </Pressable>
          )}
          {queue.length > 0 && (
            <Pressable onPress={clearQueue} hitSlop={6}>
              <Text style={styles.clear}>Clear ({queue.length})</Text>
            </Pressable>
          )}
        </View>
      </View>
      {seenWarn && <Text style={styles.seenWarn}>⚠ {seenWarn}</Text>}

      {/* Source chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sourceRow}>
        {sources.map((s) => {
          const on = s.id === sourceId;
          return (
            <Pressable
              key={s.id}
              onPress={() => setSourceId(s.id)}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{s.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* News list */}
      <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 96 }}>
        {loading && (
          <View style={styles.center}>
            <ActivityIndicator color={C.dim} />
            <Text style={styles.muted}>Loading {source?.label ?? ''} news…</Text>
          </View>
        )}
        {error && !loading && <Text style={styles.errorText}>⚠ {error}</Text>}
        {!loading && !error && items.length === 0 && (
          <Text style={styles.muted}>No articles for this source right now.</Text>
        )}
        {!loading && !error && items.length > 0 && visible.length === 0 && (
          <Text style={styles.muted}>
            {'You\u2019ve seen everything here. Turn off Fresh only to re-read.'}
          </Text>
        )}
        {!loading &&
          visible.map((it) => {
            const queued = queue.includes(it.id);
            const pos = queue.indexOf(it.id) + 1;
            const isSeen = Object.prototype.hasOwnProperty.call(seen, it.id);
            return (
              <Pressable
                key={it.id}
                onPress={() => toggleQueue(it.id)}
                style={[styles.item, queued && styles.itemQueued, isSeen && !queued && styles.itemSeen]}
              >
                <View style={styles.itemLeft}>
                  <Text
                    style={[
                      styles.itemHead,
                      (it.maybeVideo || isSeen) && styles.itemHeadMuted,
                    ]}
                    numberOfLines={2}
                  >
                    {it.headline}
                  </Text>
                  <View style={styles.itemMetaRow}>
                    {isSeen && <Text style={styles.seenTag}>SEEN</Text>}
                    {it.maybeVideo && <Text style={styles.videoTag}>VIDEO · likely no prose</Text>}
                    {!it.maybeVideo && it.type !== '' && (
                      <Text style={styles.typeTag}>{it.type}</Text>
                    )}
                  </View>
                </View>
                <View style={styles.itemRight}>
                  {queued ? (
                    <View style={styles.badgeQueued}>
                      <Text style={styles.badgeQueuedText}>{pos}</Text>
                    </View>
                  ) : (
                    <Text style={styles.addGlyph}>＋</Text>
                  )}
                </View>
              </Pressable>
            );
          })}
      </ScrollView>

      {/* Commit bar */}
      {queue.length > 0 && (
        <Pressable onPress={stream} style={styles.streamBar}>
          <Text style={styles.streamText}>
            Stream {queue.length} {queue.length === 1 ? 'article' : 'articles'} →
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: { color: C.text, fontSize: 20, fontWeight: '700' },
  clear: { color: C.hot, fontSize: 13, fontWeight: '600' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  freshToggle: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  freshToggleOn: { backgroundColor: C.accent, borderColor: C.accent },
  freshText: { color: C.dim, fontSize: 12, fontWeight: '600' },
  freshTextOn: { color: '#000000' },
  seenWarn: {
    color: C.hot,
    fontSize: 12,
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  sourceRow: { flexDirection: 'row', paddingHorizontal: 12, maxHeight: 44 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    marginHorizontal: 4,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
  },
  chipOn: { backgroundColor: C.accent, borderColor: C.accent },
  chipText: { color: C.dim, fontSize: 13, fontWeight: '600' },
  chipTextOn: { color: '#000000' },
  list: { flex: 1, paddingHorizontal: 12, marginTop: 8 },
  center: { alignItems: 'center', paddingVertical: 40, gap: 8 },
  muted: { color: C.dim, fontSize: 14, textAlign: 'center', paddingVertical: 24 },
  errorText: { color: C.hot, fontSize: 14, paddingVertical: 24, paddingHorizontal: 4 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  itemQueued: { borderColor: C.queued },
  itemSeen: { opacity: 0.55 },
  itemLeft: { flex: 1, paddingRight: 12 },
  itemHead: { color: C.text, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  itemHeadMuted: { color: C.dim },
  itemMetaRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  videoTag: { color: C.hot, fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  seenTag: { color: C.queued, fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  typeTag: { color: C.dim, fontSize: 11, fontWeight: '600', letterSpacing: 0.3 },
  itemRight: { width: 36, alignItems: 'center', justifyContent: 'center' },
  addGlyph: { color: C.dim, fontSize: 22, fontWeight: '400' },
  badgeQueued: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: C.queued,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeQueuedText: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
  streamBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 20,
    backgroundColor: C.accent,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  streamText: { color: '#000000', fontSize: 16, fontWeight: '700' },
});
