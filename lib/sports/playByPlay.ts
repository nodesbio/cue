/**
 * ESPN play-by-play fetch + normalization.
 *
 * Uses ESPN's public summary endpoint — …/summary?event={id} — no API key,
 * no auth (verified keyless against live CFB 2026-11). Split into a pure
 * normalizer (`extractPlayByPlay`) and a thin fetch wrapper (`fetchPlayByPlay`)
 * so the ordering/flattening logic is testable without network I/O — same
 * shape as espn.ts (rankScoreboard / fetchLiveGames).
 *
 * Two feed shapes, one normalizer:
 *   - basketball/hockey → flat `plays[]`
 *   - football          → plays nested under `drives.previous[] + drives.current`
 * We read whichever the payload carries. Newest play first (what you'd glance
 * at on the lens). Empty feeds surface as [] — never a silent partial.
 */
import type {
  EspnAthlete,
  EspnPlay,
  EspnSummary,
  EspnTeamRoster,
  League,
  PlayLine,
  Roster,
} from './types';

/**
 * Build the jersey -> full names map for one game. Pure.
 *
 * Two sources, joined on jersey number:
 *   - the summary boxscore: only players who have recorded a stat so far
 *   - each team's full roster (optional): everyone, including a receiver who
 *     has been targeted but hasn't caught a ball yet
 *
 * Numbers are shared freely, across the two teams and within one (offense and
 * defense reuse them), so every name is kept. expandNames picks between them
 * by initial + surname.
 */
export function extractRoster(summary: EspnSummary, teamRosters: EspnTeamRoster[] = []): Roster {
  const roster: Roster = new Map();
  const add = (player?: EspnAthlete) => {
    if (!player?.jersey || !player.displayName) return;
    const names = roster.get(player.jersey);
    if (!names) roster.set(player.jersey, [player.displayName]);
    else if (!names.includes(player.displayName)) names.push(player.displayName);
  };

  for (const team of summary.boxscore?.players ?? []) {
    for (const cat of team.statistics ?? []) {
      for (const a of cat.athletes ?? []) add(a.athlete);
    }
  }
  for (const team of teamRosters) {
    for (const group of team.athletes ?? []) {
      for (const player of group.items ?? []) add(player);
    }
  }
  return roster;
}

/**
 * Strip the read-only noise that front-loads ESPN play text so the say-able
 * part leads. Pure, team-agnostic.
 *
 *   "(08:46) No Huddle-Shotgun #10 A.Colandrea pass complete..."
 *     -> "#10 A.Colandrea pass complete..."
 *
 * Removes the leading play-clock "(08:46) " and the formation prefix
 * ("No Huddle", "Shotgun", "Pistol", "Under Center"). The lens renders only the
 * top wrapped lines, so leading with the clock/formation pushed the actual play
 * off-screen — this is the fix for that, not a truncation.
 */
export function cleanPlayText(text: string): string {
  return text
    .trim()
    .replace(/^\(\d{1,2}:\d{2}\)\s*/, '')
    .replace(/^(No[- ]Huddle[- ]?)?(Shotgun|Pistol|Under Center)?[- ]*/i, '')
    .trim()
    .replace(FINAL_PERIOD, '$1');
}

// ESPN ends some one-sentence plays with a period and not others ("Steal." next
// to "misses 9-foot jumper"), so the list reads unevenly. Drop the final period
// of a single-sentence play. Left alone: multi-sentence text (an inner ". "),
// where stripping only the last one would be the uneven result, and a closing
// "Jr." / "Sr.", where the period belongs to the name.
const FINAL_PERIOD = /^((?:(?!\.\s).)*(?<![JS]r))\.$/s;

// Abbreviated player name in ESPN play text. Two forms:
//   college: "#10 A.Colandrea" / "#7 J.Mathews Jr."   (jersey number first)
//   NFL:     "T.Etienne" / "Ja.Johnson" / "CHI-J.Johnson"   (no number; a longer
//            first-name prefix where one initial would fit two teammates)
// then an optional suffix: "Jr.", "Sr.", or a Roman numeral ("III"). The numeral
// must end at a word boundary, or "K.Coleman INTERCEPTED" loses its "I".
// The surname stops before a period, so the one ending a sentence stays put.
// Capture groups: 1=jersey number (college only), 2=first-name prefix,
// 3=first surname word, 4=suffix.
const NAME_TOKEN =
  /(?:#(\d{1,2})\s+|(?<![\w.#']))([A-Z][a-z]{0,2})\.(St\.|[A-Za-z'-]+)(\s(?:[JS]r\.|(?:I{1,3}|IV|V)\b))?/g;

/**
 * Expand jersey tokens to full names you can SAY, keeping ESPN's number:
 *
 *   "#10 A.Colandrea pass complete" -> "#10 Anthony Colandrea pass complete"
 *   "T.Etienne left end (J.Lynch)"   -> "Travis Etienne left end (Jordan Lynch)"
 *
 * NFL text has no number, and none is added.
 *
 * Pure. A token is matched on first initial + surname:
 *   1. among the players wearing that number (college text only; NFL text
 *      has no number, so it starts at 2);
 *   2. if none of them has that name, across the whole roster. ESPN's play
 *      text and its rosters often disagree on a player's number (8 of 71
 *      tokens in NEB @ OSU, 2026-11), so the name is the half to trust.
 *
 * Exactly one match expands. Anything else (no such name, or two players it
 * could be) leaves the token exactly as ESPN wrote it: a wrong name on the
 * lens is worse than an abbreviation.
 */
export function expandNames(text: string, roster: Roster): string {
  if (roster.size === 0) return text;
  const everyone = [...new Set([...roster.values()].flat())];

  let out = '';
  let done = 0; // how much of `text` is already in `out`
  for (const m of text.matchAll(NAME_TOKEN)) {
    const [token, num, prefix, surname] = m;
    const sur = surname.toLowerCase();
    // Exact name parts, not substrings: "Smith" must not match "Smithson".
    // First part supplies the initial; any later part may be the surname
    // (handles "Van Jefferson", "St. Brown").
    const named = (names: string[]) =>
      names.filter((name) => {
        const [first, ...rest] = name.split(/\s+/);
        return first.toLowerCase().startsWith(prefix.toLowerCase()) && rest.some((part) => part.toLowerCase() === sur);
      });
    const wearing = num ? named(roster.get(num) ?? []) : [];
    const hits = wearing.length > 0 ? wearing : named(everyone);
    if (hits.length !== 1) continue;

    // The token pattern stops at the first surname word. When the surname is
    // longer ("R.Van Poppel"), the rest follows in the text: swallow it so the
    // lens doesn't read "Riley Van Poppel Poppel".
    const rest = hits[0].split(/\s+/).slice(1);
    const after = rest.slice(rest.findIndex((part) => part.toLowerCase() === sur) + 1);
    const tail = after.length > 0 ? ` ${after.join(' ')}` : '';
    const tokenEnd = m.index + token.length;

    out += `${text.slice(done, m.index)}${num ? `#${num} ` : ''}${hits[0]}`;
    done = tokenEnd + (tail && text.startsWith(tail, tokenEnd) ? tail.length : 0);
  }
  return out + text.slice(done);
}

const SPORT_PATH: Record<League, string> = {
  NBA: 'basketball/nba',
  NHL: 'hockey/nhl',
  NCAAM: 'basketball/mens-college-basketball',
  NCAAW: 'basketball/womens-college-basketball',
  NCAAF: 'football/college-football',
  NFL: 'football/nfl',
};

/** Regulation periods per league, and the letter its periods go by. */
const PERIODS: Record<League, { count: number; prefix: string }> = {
  NBA: { count: 4, prefix: 'Q' },
  NHL: { count: 3, prefix: 'P' },
  NCAAM: { count: 2, prefix: 'H' },
  NCAAW: { count: 4, prefix: 'Q' },
  NCAAF: { count: 4, prefix: 'Q' },
  NFL: { count: 4, prefix: 'Q' },
};

/**
 * Short label for a period number: "Q3", "H2" (men's college halves), "P2"
 * (hockey), then "OT", "2OT"… past regulation. Empty when the period is unknown.
 */
export function periodLabel(league: League, period: number): string {
  if (!(period > 0)) return '';
  const { count, prefix } = PERIODS[league];
  if (period <= count) return `${prefix}${period}`;
  const extra = period - count;
  return extra === 1 ? 'OT' : `${extra}OT`;
}

/** Normalize one raw ESPN play into a PlayLine, expanding say-able names. */
function toPlayLine(p: EspnPlay, index: number, roster: Roster): PlayLine {
  const away = p.awayScore;
  const home = p.homeScore;
  const haveScore = Number.isFinite(away) && Number.isFinite(home);
  const text = expandNames(cleanPlayText(p.text ?? ''), roster);
  return {
    // ESPN ids are neither always present NOR always unique — the live summary
    // feed emits the same play id twice (seen on NCAAF 401858531205). Index is
    // the uniqueness guarantee; the raw id/sequence is only a readable prefix.
    id: `${p.id ?? p.sequenceNumber ?? 'p'}-${index}`,
    text,
    period: p.period?.number ?? 0,
    clock: p.clock?.displayValue ?? '',
    score: haveScore ? `${away}-${home}` : '',
    scoring: p.scoringPlay === true,
  };
}

/**
 * Every raw play in the payload, oldest first. Football carries plays under
 * drives (previous[] oldest→newest, then current); basketball/hockey carry a
 * flat chronological plays[].
 */
function rawPlays(summary: EspnSummary): EspnPlay[] {
  if (Array.isArray(summary.plays) && summary.plays.length > 0) return summary.plays;
  return [...(summary.drives?.previous ?? []), summary.drives?.current].flatMap(
    (drive) => drive?.plays ?? [],
  );
}

/**
 * Flatten a summary payload into a normalized, newest-first play list. Pure.
 * Plays with no text are dropped (ESPN occasionally emits placeholder rows).
 *
 * Defaults to the boxscore-only roster (no network). fetchPlayByPlay passes one
 * that also includes both teams' full rosters.
 */
export function extractPlayByPlay(summary: EspnSummary, rosterOverride?: Roster): PlayLine[] {
  const roster = rosterOverride ?? extractRoster(summary);
  const lines = rawPlays(summary)
    .map((p, i) => toPlayLine(p, i, roster))
    .filter((l) => l.text.length > 0);

  // Source order is oldest→newest; the lens/list wants newest first.
  lines.reverse();
  return lines;
}

// ESPN returns 100 athletes per team unless asked for more, and a college
// roster runs past that (Nebraska: 115, checked live 2026-11).
const ROSTER_LIMIT = 300;

// Both teams' rosters, fetched once per game and shared by every poll.
const teamRosterCache = new Map<string, Promise<EspnTeamRoster[]>>();

async function fetchTeamRosters(
  summary: EspnSummary,
  league: League,
  signal?: AbortSignal,
): Promise<EspnTeamRoster[]> {
  const teamIds = (summary.header?.competitions?.[0]?.competitors ?? [])
    .map((c) => c.team?.id)
    .filter((id): id is string => !!id);
  return Promise.all(
    teamIds.map(async (id) => {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${SPORT_PATH[league]}/teams/${encodeURIComponent(id)}/roster?limit=${ROSTER_LIMIT}`;
      const resp = await fetch(url, { signal });
      if (!resp.ok) throw new Error(`ESPN ${league} roster ${id} HTTP ${resp.status}`);
      return (await resp.json()) as EspnTeamRoster;
    }),
  );
}

/**
 * Fetch and normalize play-by-play for one game. Thin wrapper over
 * extractPlayByPlay. Throws on network / non-2xx (the caller shows the error —
 * we do not swallow it into an empty list, which would masquerade as
 * "no plays yet").
 */
export async function fetchPlayByPlay(
  gameId: string,
  league: League,
  signal?: AbortSignal,
): Promise<PlayLine[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${SPORT_PATH[league]}/summary?event=${encodeURIComponent(gameId)}`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`ESPN ${league} summary HTTP ${resp.status}`);
  const summary = (await resp.json()) as EspnSummary;

  // The boxscore only lists players with a stat, so the full team rosters fill
  // in everyone else. They include players not dressed for this game; that is
  // safe because expandNames matches on initial + surname and leaves the token
  // alone whenever two players could be meant. (An earlier merge of this
  // endpoint was reverted for wrong names: Appendix C, 2026-11.)
  //
  // Only fetched when the feed actually abbreviates names.
  let teamRosters: EspnTeamRoster[] = [];
  if (rawPlays(summary).some((p) => (p.text ?? '').search(NAME_TOKEN) >= 0)) {
    const key = `${league}:${gameId}`;
    let pending = teamRosterCache.get(key);
    if (!pending) {
      pending = fetchTeamRosters(summary, league, signal);
      teamRosterCache.set(key, pending);
    }
    try {
      teamRosters = await pending;
    } catch (e) {
      // Don't cache a failure: the next poll tries again.
      if (teamRosterCache.get(key) === pending) teamRosterCache.delete(key);
      if (signal?.aborted) throw e;
      // Plays still show, with boxscore-only names, rather than no plays at all.
      console.warn(`[sports] ${league} team rosters failed:`, (e as Error).message);
    }
  }

  return extractPlayByPlay(summary, extractRoster(summary, teamRosters));
}
