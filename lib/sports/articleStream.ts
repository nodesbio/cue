/**
 * articleStream.ts — fetch the FULL prose body of an ESPN story by id, cleaned
 * to plain text, ready to hand to the teleprompter's wrapScript() for ambient
 * streaming on the lens.
 *
 * This is the core of the "pick on phone, stream prose on lens" loop (#49).
 *
 * KEY FINDING (verified live 2026-11-21): the story BODY does NOT live on the
 * site.api.espn.com news/overview feeds — those carry headline + a short blurb
 * only. The full prose lives on the content.core API, keyed by article id:
 *
 *     https://content.core.api.espn.com/v1/sports/news/{articleId}
 *
 * This module is deliberately TEAM/LEAGUE-AGNOSTIC. It takes an article id and
 * nothing else about who the story is about. Ohio State is only ever a test
 * fixture — there are no team ids, league names, or sport literals in here.
 *
 * Two hard guards (Zoracon — an empty result that *looks* like "no content" is
 * usually "wrong thing", and we must surface it, never render blank):
 *   1. Video items carry no prose. A story whose links point at a video clip is
 *      rejected with a typed reason, not streamed as an empty card.
 *   2. An empty/missing story body is surfaced as an error, never returned as ''.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export const CONTENT_CORE_BASE = 'https://content.core.api.espn.com/v1/sports/news';

/** Why an article id could not be turned into streamable prose. */
export type ArticleRejectReason = 'video' | 'empty-body' | 'not-found';

export class ArticleUnavailableError extends Error {
  readonly reason: ArticleRejectReason;
  readonly articleId: string;
  constructor(articleId: string, reason: ArticleRejectReason, detail?: string) {
    super(`article ${articleId} unavailable: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ArticleUnavailableError';
    this.reason = reason;
    this.articleId = articleId;
  }
}

/** Streamable prose for one article. `body` is clean plain text (no HTML). */
export interface ArticleProse {
  articleId: string;
  headline: string;
  /** Clean plain-text body, paragraphs separated by '\n\n'. Never empty. */
  body: string;
  /** Rough read time estimate for the phone picker, in seconds. */
  readSeconds: number;
  publishedMs: number | null;
}

/** Shape of the content.core response we depend on (narrowed, not exhaustive). */
export interface EspnContentResponse {
  headlines?: EspnContentHeadline[];
}
export interface EspnContentHeadline {
  id?: number | string;
  type?: string; // 'Story' | 'Media' | ...
  headline?: string;
  story?: string; // HTML prose body — the thing we actually want
  published?: string;
  links?: {
    web?: { href?: string };
    api?: Record<string, { href?: string }>;
  };
}

// ── Pure helpers (no network — unit tested directly) ─────────────────────────

const WORDS_PER_MINUTE = 200;

/** Strip HTML tags and decode the handful of entities ESPN emits, to plain text. */
export function htmlToText(html: string): string {
  const noTags = html
    // block-level closers become paragraph breaks
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const decoded = noTags
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…');
  return decoded
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True if this headline is a video clip (no readable prose). */
export function isVideo(h: EspnContentHeadline): boolean {
  if ((h.type ?? '').toLowerCase() === 'video') return true;
  const web = h.links?.web?.href ?? '';
  const self = h.links?.api?.self?.href ?? '';
  return /\/video\//.test(web) || /\/video\//.test(self);
}

function estimateReadSeconds(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round((words / WORDS_PER_MINUTE) * 60));
}

/**
 * Normalize a content.core response into streamable prose, or throw a typed
 * ArticleUnavailableError. Pure — feed it a fixture to test without network.
 */
export function proseFromContent(
  articleId: string,
  resp: EspnContentResponse,
): ArticleProse {
  const h = resp.headlines?.[0];
  if (!h) throw new ArticleUnavailableError(articleId, 'not-found');
  if (isVideo(h)) throw new ArticleUnavailableError(articleId, 'video');

  const raw = (h.story ?? '').trim();
  if (raw === '') throw new ArticleUnavailableError(articleId, 'empty-body');

  const body = htmlToText(raw);
  if (body === '') throw new ArticleUnavailableError(articleId, 'empty-body');

  const published = h.published ? Date.parse(h.published) : NaN;
  return {
    articleId,
    headline: h.headline ?? '',
    body,
    readSeconds: estimateReadSeconds(body),
    publishedMs: Number.isNaN(published) ? null : published,
  };
}

// ── Network ──────────────────────────────────────────────────────────────────

/** Build the content.core URL for an article id. Team/league-agnostic by design. */
export function articleUrl(articleId: string): string {
  return `${CONTENT_CORE_BASE}/${encodeURIComponent(articleId)}`;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(url, { signal });
  if (resp.status === 404) throw new Error('http-404');
  if (!resp.ok) throw new Error(`content.core HTTP ${resp.status} for ${url}`);
  return (await resp.json()) as T;
}

/**
 * Fetch and clean the full prose for one article id. Throws
 * ArticleUnavailableError('video' | 'empty-body' | 'not-found') so the phone
 * picker can mark/skip it rather than queueing a blank stream.
 */
export async function fetchArticleBody(
  articleId: string,
  signal?: AbortSignal,
): Promise<ArticleProse> {
  let resp: EspnContentResponse;
  try {
    resp = await getJson<EspnContentResponse>(articleUrl(articleId), signal);
  } catch (e) {
    if ((e as Error).message === 'http-404') {
      throw new ArticleUnavailableError(articleId, 'not-found');
    }
    throw e; // real network/HTTP failure — do not mask it (Zoracon)
  }
  return proseFromContent(articleId, resp);
}
