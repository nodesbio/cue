/**
 * newsFeed.ts — the pickable list source for the article picker (#49).
 *
 * The picker needs a LIST of articles (headline + id + a video hint) so you can
 * tap to queue them; `articleStream.fetchArticleBody(id)` then pulls the full
 * prose for each queued id. This module is that list source.
 *
 * Keyless, like the rest of the ESPN integration: site.api.espn.com ...news
 * returns article stubs with a numeric `id` that the content.core body endpoint
 * (articleStream) consumes directly — the two halves of the loop join on `id`.
 *
 * SOURCE/SCOPE AGNOSTIC: the caller supplies the sport path and optional team id.
 * OSU (football, team 194) is a fixture in tests, never hardcoded here.
 *
 * VIDEO HINT, NOT VERDICT (Watkins): the list `type` ("Media"/"HeadlineNews"/
 * "Recap"/...) correlates with video but is not authoritative — the real video
 * guard lives in articleStream.isVideo on the body fetch. We surface
 * `maybeVideo` so the picker can grey an item provisionally; the stream's
 * `reason: 'video'` remains the source of truth. We never drop items here.
 */

export const SITE_API_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

/** One pickable article stub from a news list. Joins to prose on `id`. */
export interface NewsItem {
  /** Numeric ESPN article id, as a string — the key into fetchArticleBody. */
  id: string;
  headline: string;
  /** ESPN content type ("HeadlineNews", "Recap", "Media", "Preview", …). */
  type: string;
  /** Provisional video hint from the list type. NOT authoritative (see above). */
  maybeVideo: boolean;
  /** Publish time in epoch ms, or null if the list omitted it. */
  publishedMs: number | null;
  /** Short description/blurb, when the list provides one. */
  description: string | null;
}

/** Shape of the ESPN news list payload we depend on (narrowed, not exhaustive). */
export interface EspnNewsListResponse {
  articles?: EspnNewsStub[];
}

export interface EspnNewsStub {
  id?: number | string;
  headline?: string;
  type?: string;
  published?: string;
  description?: string;
}

/**
 * List `type` values that denote a video clip (no readable prose). Matches the
 * verified finding: "Media" items (e.g. "Full Highlights") carry no story body.
 * Case-insensitive. This only sets the provisional `maybeVideo` hint.
 */
const VIDEO_TYPES: ReadonlySet<string> = new Set(['media', 'video', 'clip']);

/**
 * Normalize an ESPN news list payload into pickable NewsItems. Pure — no I/O.
 *
 * Stubs without a usable numeric id are dropped (they can't be joined to a body
 * fetch, so they're unpickable by construction — not a maskable error, there's
 * simply nothing to queue). Everything else is surfaced, video or not.
 */
export function normalizeNewsList(payload: EspnNewsListResponse): NewsItem[] {
  const out: NewsItem[] = [];
  for (const a of payload.articles ?? []) {
    const id = a.id != null ? String(a.id) : '';
    if (!id) continue; // no join key → not pickable
    const type = a.type ?? '';
    const publishedMs = a.published ? Date.parse(a.published) : NaN;
    out.push({
      id,
      headline: a.headline ?? '(untitled)',
      type,
      maybeVideo: VIDEO_TYPES.has(type.toLowerCase()),
      publishedMs: Number.isFinite(publishedMs) ? publishedMs : null,
      description: a.description?.trim() || null,
    });
  }
  return out;
}

/** Build the team news URL for a given sport path + numeric team id. */
export function teamNewsUrl(sportPath: string, teamId: string, limit = 50): string {
  return `${SITE_API_BASE}/${sportPath}/teams/${teamId}/news?limit=${limit}`;
}

/** Build the league-wide news URL for a given sport path. */
export function leagueNewsUrl(sportPath: string, limit = 50): string {
  return `${SITE_API_BASE}/${sportPath}/news?limit=${limit}`;
}

/**
 * Fetch and normalize a news list from a prebuilt URL. Thin wrapper — keeps the
 * normalizer testable without network I/O. Network/HTTP failures throw and are
 * surfaced by the caller (Zoracon: no silent empty list on error).
 */
export async function fetchNewsList(url: string, signal?: AbortSignal): Promise<NewsItem[]> {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`ESPN news HTTP ${resp.status} for ${url}`);
  const payload = (await resp.json()) as EspnNewsListResponse;
  return normalizeNewsList(payload);
}
