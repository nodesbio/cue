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
