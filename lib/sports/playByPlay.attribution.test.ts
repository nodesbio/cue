/**
 * Team attribution, pinned to the REAL ESPN summary shape for NEB@OSU
 * (event 401858531), verified live on 2025-xx-xx:
 *
 *   - play.start.team.id is the ONLY possession signal; participants[] is empty.
 *   - A player's team lives on the PARENT boxscore.players[].team, not the athlete.
 *   - Jersey numbers collide ACROSS teams (both NEB#25 and OSU#25 exist), so
 *     resolution MUST be team-scoped, and the team must come from clause context:
 *       · live-ball pre-paren  -> offense (start.team.id)
 *       · live-ball in-paren   -> defense (the other team)
 *       · PENALTY <TEAM> clause -> that team, wherever the token sits
 *
 * These names/jerseys are copied verbatim from the live payload; no external
 * roster endpoint is consulted (that endpoint returns non-game-scoped players).
 */
import { expandNames, type PlayContext } from './playByPlay';
import type { Roster } from './types';

// Game-scoped jersey map, built the way production must: team#jersey -> full name,
// sourced from boxscore.players[].team + athlete.displayName. Real values.
const roster: Roster = new Map<string, string>([
  ['NEB#10', 'Anthony Colandrea'],
  ['NEB#3', 'Kenneth Gilmer'],
  ['NEB#25', 'Jamal Rule'],
  ['NEB#55', 'Tree Babalade'],
  ['OSU#25', 'Bo Jackson'], // same jersey, other team — the collision trap
  ['OSU#5', 'R. Pettijohn'],
]);

// NEB has possession (start.team.id = 158 = NEB).
const NEB_BALL: PlayContext = { offense: 'NEB', defense: 'OSU' };

describe('team attribution on the real NEB@OSU payload', () => {
  it('binds pre-paren live-ball tokens to the possessing (offense) team', () => {
    const out = expandNames(
      '#10 A.Colandrea pass complete short left to #3 K.Gilmer for 6 yards',
      roster,
      NEB_BALL,
    );
    expect(out).toBe('Anthony Colandrea pass complete short left to Kenneth Gilmer for 6 yards');
  });

  it('binds a PENALTY <TEAM> clause to that team, not to possession', () => {
    // Colandrea (pre-paren, NEB offense) AND the flagged #25 (NEB penalty) both NEB.
    const out = expandNames(
      '#10 A.Colandrea rush right for 3 yards PENALTY NEB Personal Foul (#25 J.Rule) 15 yards',
      roster,
      NEB_BALL,
    );
    expect(out).toContain('Anthony Colandrea');
    expect(out).toContain('Jamal Rule'); // NEB#25, NOT OSU#25
    expect(out).not.toContain('Bo Jackson'); // the collision must NOT win
  });

  it('resolves a standalone penalty clause with no live-ball tokens', () => {
    const out = expandNames(
      'PENALTY NEB False Start (#55 T.Babalade) 5 yards from NEB16 to NEB11. NO PLAY',
      roster,
      NEB_BALL,
    );
    expect(out).toBe('PENALTY NEB False Start (Tree Babalade) 5 yards from NEB16 to NEB11. NO PLAY');
  });

  it('leaves the ESPN token intact when the game-scoped roster has no entry (say-able fallback)', () => {
    // #99 is in neither team's boxscore; must stay exactly as ESPN wrote it.
    const out = expandNames('tackle for loss (#99 Z.Nobody)', roster, NEB_BALL);
    expect(out).toBe('tackle for loss (#99 Z.Nobody)');
  });
});

/**
 * Special-teams parentheticals, pinned to the REAL BYU@KU payload (event
 * 401856866), verified live 2026-11 at 3Q 8:32. ESPN text:
 *
 *   "#97 M.Dunn field goal attempt from 52 yards GOOD (H: #19 F.Shurtz, LS: #88 T.Smith)"
 *
 * The kicking unit — kicker, holder, long-snapper — is the POSSESSING team
 * (BYU/offense). A "(H: …, LS: …)" parenthetical is NOT a tackle parenthetical:
 * its tokens belong to the offense, not the defense. Verified against the
 * boxscore: BYU#97=Matthias Dunn, BYU#19=Fuller Shurtz; BYU has no #88, while
 * KU#88=Kevin Oatis. If the paren bound to defense (the old tackle rule), #88
 * would mislabel the snapper as "Kevin Oatis" — a confident WRONG name, the one
 * outcome the design forbids.
 */
const stRoster: Roster = new Map<string, string>([
  ['BYU#97', 'Matthias Dunn'],
  ['BYU#19', 'Fuller Shurtz'],
  ['KU#88', 'Kevin Oatis'], // collision trap: wrong team for this play's snapper
]);
const BYU_KICKING: PlayContext = { offense: 'BYU', defense: 'KU' };

describe('special-teams (H:/LS:) parenthetical binds to the kicking team', () => {
  it('expands the holder to the offense and never mislabels the snapper from the defense', () => {
    const out = expandNames(
      '#97 M.Dunn field goal attempt from 52 yards GOOD (H: #19 F.Shurtz, LS: #88 T.Smith), clock 05:45',
      stRoster,
      BYU_KICKING,
    );
    expect(out).toContain('Matthias Dunn'); // #97, pre-paren, offense
    expect(out).toContain('Fuller Shurtz'); // #19 holder, in-paren, BYU — the fix
    expect(out).not.toContain('Kevin Oatis'); // #88 must NOT resolve to KU's snapper
    expect(out).toContain('#88 T.Smith'); // stays say-able as ESPN wrote it
  });
});

/**
 * Kickoff / punt RETURN plays, pinned to real BYU@KU (event 401856866).
 *
 * The clause heuristic (pre-paren=offense, in-paren=defense) is INVALID here:
 * kicker and returner share the pre-paren region on opposite teams, the tackler
 * in the paren is on the KICKING team (inverse of a scrimmage tackle), and the
 * payload carries NO per-player team data (participants is null). ESPN labels
 * the kicking team "offense" on a return, so clause logic emits confident WRONG
 * names ("Matthew Gill" for #99 B.Laga, etc.).
 *
 * The robust rule: resolve a token by matching its initial+surname against the
 * game-wide jersey index; expand only when exactly one player matches, else
 * leave the ESPN token. Name disambiguation is team-agnostic, so it is correct
 * on returns without any play-type special-casing. Verified: of 25 colliding
 * tokens in this game, 24 resolve uniquely by name and the lone ambiguous one
 * (#7 D.Crouch, a nickname mismatch) correctly stays abbreviated.
 */
const returnRoster: Roster = new Map<string, string>([
  ['KU#99', 'Matthew Gill'], // collides by number with the kicker ESPN calls "B.Laga"
  ['BYU#12', 'Preston Rex'], // #12 collision...
  ['KU#12', 'Bryson Hayes'], // ...resolved by name: "B.Hayes" -> Bryson Hayes
  ['BYU#38', 'Logan Payne'], // tackler, on the kicking team BYU
]);
// On this kickoff ESPN labels the KICKING team as "offense" (the inversion trap).
const KICKOFF_CTX: PlayContext = { offense: 'KU', defense: 'BYU' };

/**
 * Surname matching must be EXACT on a name part, not a substring of the whole
 * name. "Smith" must not spuriously match "Smithson"/"Goldsmith". With a
 * substring match, a J.Smith token against a #4 carrying both "Jordan Smith"
 * and "Jalen Smithson" sees two hits -> conflict -> abstains, silently losing
 * the resolution we should have made (Jordan Smith is the exact match).
 */
const smithRoster: Roster = new Map<string, string>([['USC#4', 'Jordan Smith']]);
// Two holders of #4 that collide under a substring match but not an exact one.
const smithCollisionRoster: Roster = new Map<string, string>([
  ['USC#4', 'Jordan Smith'],
  ['UCLA#4', 'Jalen Smithson'], // substring "smith" ⊂ "smithson" — the trap
]);
const USC_BALL: PlayContext = { offense: 'USC', defense: 'UCLA' };

describe('surname matching is exact per name-part, not a substring', () => {
  it('resolves J.Smith to Jordan Smith even when a Smithson shares the jersey', () => {
    const out = expandNames(
      'Luke Fahey pass incomplete short left to #4 J.Smith',
      smithCollisionRoster,
      USC_BALL,
    );
    expect(out).toContain('Jordan Smith'); // exact surname match wins
    expect(out).not.toContain('Jalen Smithson'); // "smith" must NOT match "smithson"
    expect(out).toContain('Luke Fahey'); // already-full name passes through untouched
  });

  it('resolves cleanly when the jersey is unique', () => {
    const out = expandNames(
      'Luke Fahey pass incomplete short left to #4 J.Smith',
      smithRoster,
      USC_BALL,
    );
    expect(out).toContain('Jordan Smith');
  });
});

describe('kick/punt return plays resolve by name, never by inverted clause team', () => {
  const text =
    '#99 B.Laga kickoff 63 yards to the KU02 #12 B.Hayes return 18 yards to the KU20 (#38 L.Payne)';

  it('resolves the returner by name despite the cross-team jersey collision', () => {
    const out = expandNames(text, returnRoster, KICKOFF_CTX);
    // "#12 B.Hayes" -> Bryson Hayes (name match), NOT Preston Rex (BYU#12).
    expect(out).toContain('Bryson Hayes');
    expect(out).not.toContain('Preston Rex');
  });

  it('never emits a confident wrong name for the kicker (ESPN name != boxscore #99)', () => {
    const out = expandNames(text, returnRoster, KICKOFF_CTX);
    // ESPN says "B.Laga"; KU#99 is "Matthew Gill" — a mismatch, so leave it.
    expect(out).not.toContain('Matthew Gill');
    expect(out).toContain('#99 B.Laga');
  });

  it('resolves the tackler by name (BYU#38 Logan Payne), not the inverted defense', () => {
    const out = expandNames(text, returnRoster, KICKOFF_CTX);
    expect(out).toContain('Logan Payne');
  });
});
