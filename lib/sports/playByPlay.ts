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
  EspnPlay,
  EspnSummary,
  League,
  PlayLine,
  Roster,
} from './types';

/**
 * Build a team+jersey -> full name map from the boxscore. Pure.
 *
 * The lens surfaces what you can SAY: a full name ("Anthony Colandrea") is a
 * word you speak at the bar; "#10 A.Colandrea" is a box score you decode. Only
 * players who have recorded a stat appear here — early-game or no-touch players
 * stay abbreviated until they show up, which is honest (we never invent a name).
 *
 * Jersey numbers are NOT unique within a team (offense/defense/ST reuse — OSU
 * carries #25 for two players). Collisions are dropped, not guessed: a name you
 * might say wrong is worse than one you leave abbreviated.
 */
export function extractRoster(summary: EspnSummary): Roster {
  const roster: Roster = new Map();
  const collided = new Set<string>();

  for (const team of summary.boxscore?.players ?? []) {
    const abbr = team.team?.abbreviation;
    if (!abbr) continue;
    for (const cat of team.statistics ?? []) {
      for (const a of cat.athletes ?? []) {
        const jersey = a.athlete?.jersey;
        const name = a.athlete?.displayName;
        if (!jersey || !name) continue;
        const key = `${abbr}#${jersey}`;
        if (roster.has(key) && roster.get(key) !== name) collided.add(key);
        roster.set(key, name);
      }
    }
  }
  for (const key of collided) roster.delete(key);
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
    .trim();
}

// Jersey token in ESPN play text: "#10 A.Colandrea" / "#7 J.Mathews Jr." —
// a number, then an abbreviated name (initial, dot, surname, optional suffix:
// "Jr.", "Sr.", or a Roman numeral like "III" seen in the live feed).
const JERSEY_TOKEN =
  /#(\d{1,2})\s+[A-Z]\.[A-Za-z'.-]+(?:\s(?:[JS]r\.|I{1,3}|IV|V))?/g;

/**
 * Which teams are on offense/defense for a single play. Abbreviations
 * (e.g. "NEB"/"OSU"), matching the roster key prefix. Either may be undefined
 * if the play lacks participant data (non-football, pre-game, etc.).
 */
export interface PlayContext {
  offense?: string;
  defense?: string;
}

/**
 * Build team-id -> abbreviation from the summary header competitors. Pure.
 * Lets us translate a play's numeric team IDs (158) into roster prefixes (NEB).
 */
export function buildTeamIndex(summary: EspnSummary): Map<string, string> {
  const index = new Map<string, string>();
  for (const comp of summary.header?.competitions ?? []) {
    for (const c of comp.competitors ?? []) {
      const id = c.team?.id;
      const abbr = c.team?.abbreviation;
      if (id && abbr) index.set(id, abbr);
    }
  }
  return index;
}

/** Resolve a play's offense/defense team abbreviations from its participants. */
export function playContext(
  play: EspnPlay,
  teamIndex: Map<string, string>,
): PlayContext {
  const ctx: PlayContext = {};
  for (const tp of play.teamParticipants ?? []) {
    const abbr = tp.id ? teamIndex.get(tp.id) : undefined;
    if (!abbr) continue;
    if (tp.type === 'offense') ctx.offense = abbr;
    else if (tp.type === 'defense') ctx.defense = abbr;
  }
  // Fallback: possessing team is the offense when participants are absent.
  if (!ctx.offense && play.start?.team?.id) {
    ctx.offense = teamIndex.get(play.start.team.id);
  }
  return ctx;
}

/**
 * Expand jersey tokens to full names you can SAY. Pure, fully disambiguated.
 *
 * Football structure IS the disambiguator: the passer/rusher/receiver appear
 * BEFORE the trailing "(...)" tackle parenthetical and belong to the offense;
 * the tacklers inside the parenthetical belong to the defense. Combined with
 * the play's offense/defense team IDs, every "#NN" resolves to exactly one
 * team — "NEB#10" or "OSU#10", never a probe-both-and-hope.
 *
 * Fail-safe: if context is missing or the team's roster lacks that jersey
 * (player not yet in the boxscore), the token is left exactly as ESPN wrote it.
 * Confident or silent, never a guess.
 */
// A penalty clause names its team explicitly: "PENALTY OSU Holding (#67 ...)".
// It can appear anywhere in the text (compound plays append it after live action),
// so we anchor on the keyword, not position 0. Team abbr is 2-4 uppercase letters.
const PENALTY_CLAUSE = /PENALTY\s+([A-Z]{2,4})\b/g;

// A special-teams parenthetical labels its occupants by ROLE: "(H: #19 …, LS: #88 …)"
// on a FG/PAT, "(K: …)" / punter clauses on kicks. The kicking unit (holder,
// long-snapper, kicker) is the POSSESSING team — the offense — NOT the defense
// the tackle-parenthetical rule assumes. Verified against BYU@KU 401856866: the
// holder #19 is on BYU (offense); the defense's #88 would mislabel the snapper.
const SPECIAL_TEAMS_PAREN = /\((?:[HK]|LS|LG):\s/;

/**
 * Expand jersey tokens to full names you can SAY. Pure, clause-aware.
 *
 * A play's text is a SEQUENCE of clauses, each with its own team binding:
 *
 *   - Live-ball region (before any PENALTY): the passer/rusher/receiver precede
 *     the "(...)" tackle parenthetical and belong to the OFFENSE; tacklers inside
 *     it belong to the DEFENSE.
 *   - Penalty region ("PENALTY <TEAM> ... (#NN X.Surname)"): the flagged player
 *     in the parenthetical belongs to <TEAM> named right there \u2014 independent of
 *     offense/defense. Compound plays can carry BOTH a tackle paren (defense) and
 *     a penalty paren (penalty team), bound to different teams in one string.
 *
 * We scan left to right, splitting at each "PENALTY <TEAM>". Within a region,
 * tokens before the region's first "(" bind to the region's "pre" team, tokens
 * from the first "(" onward bind to its "paren" team.
 *
 * Fail-safe: missing context or a jersey absent from the team's roster leaves the
 * token exactly as ESPN wrote it. Say a full name when we can; never guess.
 */
export function expandNames(
  text: string,
  roster: Roster,
  ctx: PlayContext = {},
): string {
  if (roster.size === 0) return text;

  // Find clause boundaries: index of each "PENALTY <TEAM>" and the team it names.
  const boundaries: Array<{ start: number; team?: string }> = [];
  for (const m of text.matchAll(PENALTY_CLAUSE)) {
    boundaries.push({ start: m.index ?? 0, team: m[1] });
  }

  // Region 0 is the live-ball clause: pre-paren=offense, in-paren=defense.
  // Each subsequent region is a penalty clause: pre-paren AND in-paren = penalty
  // team (the flagged player is on that team wherever they appear in the clause).
  type Region = { text: string; preTeam?: string; parenTeam?: string };
  const regions: Region[] = [];
  const firstPenalty = boundaries[0]?.start ?? text.length;

  if (firstPenalty > 0) {
    const liveBall = text.slice(0, firstPenalty);
    // Tackle parentheticals belong to the defense; special-teams role
    // parentheticals (H:/LS:/K:) belong to the kicking unit = the offense.
    const parenTeam = SPECIAL_TEAMS_PAREN.test(liveBall) ? ctx.offense : ctx.defense;
    regions.push({ text: liveBall, preTeam: ctx.offense, parenTeam });
  }
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].start;
    const end = boundaries[i + 1]?.start ?? text.length;
    const team = boundaries[i].team;
    regions.push({ text: text.slice(start, end), preTeam: team, parenTeam: team });
  }

  const resolve = (team: string | undefined) => (token: string, num: string) =>
    team ? roster.get(`${team}#${num}`) ?? token : token;

  return regions
    .map((r) => {
      const parenIdx = r.text.indexOf('(');
      const pre = parenIdx === -1 ? r.text : r.text.slice(0, parenIdx);
      const paren = parenIdx === -1 ? '' : r.text.slice(parenIdx);
      return pre.replace(JERSEY_TOKEN, resolve(r.preTeam)) + paren.replace(JERSEY_TOKEN, resolve(r.parenTeam));
    })
    .join('');
}

const SPORT_PATH: Record<League, string> = {
  NBA: 'basketball/nba',
  NHL: 'hockey/nhl',
  NCAAM: 'basketball/mens-college-basketball',
  NCAAF: 'football/college-football',
};

/** Normalize one raw ESPN play into a PlayLine, expanding say-able names. */
function toPlayLine(
  p: EspnPlay,
  index: number,
  roster: Roster,
  teamIndex: Map<string, string>,
): PlayLine {
  const away = p.awayScore;
  const home = p.homeScore;
  const haveScore = Number.isFinite(away) && Number.isFinite(home);
  const text = expandNames(cleanPlayText(p.text ?? ''), roster, playContext(p, teamIndex));
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
 * Flatten a summary payload into a normalized, newest-first play list. Pure.
 *
 * Football carries plays under drives (previous[] oldest→newest, then current);
 * basketball/hockey carry a flat chronological plays[]. In both source orders
 * plays run oldest→newest, so we collect in that order, then reverse once.
 * Plays with no text are dropped (ESPN occasionally emits placeholder rows).
 */
export function extractPlayByPlay(summary: EspnSummary, rosterOverride?: Roster): PlayLine[] {
  const raw: EspnPlay[] = [];

  if (Array.isArray(summary.plays) && summary.plays.length > 0) {
    raw.push(...summary.plays);
  } else if (summary.drives) {
    for (const drive of summary.drives.previous ?? []) {
      raw.push(...(drive.plays ?? []));
    }
    if (summary.drives.current?.plays) {
      raw.push(...summary.drives.current.plays);
    }
  }

  // Default to the boxscore-only roster (pure, no network). Callers that fetched
  // full team rosters pass a pre-merged map for maximal say-able coverage.
  const roster = rosterOverride ?? extractRoster(summary);
  const teamIndex = buildTeamIndex(summary);
  const lines = raw
    .map((p, i) => toPlayLine(p, i, roster, teamIndex))
    .filter((l) => l.text.length > 0);

  // Source order is oldest→newest; the lens/list wants newest first.
  lines.reverse();
  return lines;
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

  // Names come ONLY from the in-payload boxscore, which is game-scoped by
  // construction. The separate …/teams/{id}/roster endpoint was tried and
  // reverted: it returns non-game-scoped players (observed returning athletes
  // not dressed for the game), so merging it introduced wrong names — the exact
  // failure mode the boxscore-only path avoids. See the attribution test and
  // Appendix C (2026-11, cue roster-merge revert).
  const roster = extractRoster(summary);
  return extractPlayByPlay(summary, roster);
}
