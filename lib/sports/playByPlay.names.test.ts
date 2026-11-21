/**
 * Say-able play text: strip read-only noise, expand jersey tokens to full
 * names. The lens surfaces what you can SAY ("Anthony Colandrea") and suppresses
 * what you can only READ (play-clock, formation).
 *
 * Disambiguation is 100%: football structure IS the key. The passer/rusher/
 * receiver precede the "(...)" tackle parenthetical and belong to the offense;
 * tacklers inside it belong to the defense. With each play's offense/defense
 * team IDs, every "#NN" resolves to exactly one team. Fixtures use real OSU+NEB
 * data to lock team-agnosticism and the fail-safe (unresolved, missing context).
 */
import {
  buildTeamIndex,
  cleanPlayText,
  expandNames,
  extractRoster,
  extractPlayByPlay,
  playContext,
  type PlayContext,
} from './playByPlay';
import type { EspnSummary, EspnPlay, Roster } from './types';

/** Minimal boxscore builder: team abbr -> [ [jersey, fullName], ... ]. */
function boxscore(teams: Record<string, Array<[string, string]>>): EspnSummary {
  return {
    boxscore: {
      players: Object.entries(teams).map(([abbr, roster]) => ({
        team: { abbreviation: abbr },
        statistics: [
          { athletes: roster.map(([jersey, displayName]) => ({ athlete: { jersey, displayName } })) },
        ],
      })),
    },
    header: {
      competitions: [
        {
          competitors: Object.keys(teams).map((abbr, i) => ({
            team: { id: String(100 + i), abbreviation: abbr },
          })),
        },
      ],
    },
  };
}

// Real rosters from OSU@NEB (401858531). Both teams carry a #25 and a #3 —
// the cross-team collisions that per-play offense/defense now disambiguates.
const GAME = boxscore({
  OSU: [
    ['13', 'Luke Fahey'],
    ['4', 'Jeremiah Smith'],
    ['86', 'Mason Williams'],
    ['7', 'Jermaine Mathews Jr.'],
    ['1', 'Earl Little Jr.'],
    ['25', 'Bo Jackson'],
    ['16', 'Dontavius Odem III'],
  ],
  NEB: [
    ['10', 'Anthony Colandrea'],
    ['3', 'Kwinten Gilmer'],
    ['25', 'Marques Buford'],
  ],
});
// OSU is competitor id "100", NEB is "101" (builder assigns in key order).
const OSU = { offense: 'OSU', defense: 'NEB' } satisfies PlayContext;
const NEB = { offense: 'NEB', defense: 'OSU' } satisfies PlayContext;

describe('cleanPlayText', () => {
  it('strips leading play-clock and formation so the play leads', () => {
    expect(
      cleanPlayText('(08:46) No Huddle-Shotgun #10 A.Colandrea pass complete short left'),
    ).toBe('#10 A.Colandrea pass complete short left');
  });

  it('handles Shotgun-only and Pistol formations', () => {
    expect(cleanPlayText('(12:03) Shotgun #4 J.Smith rush right')).toBe('#4 J.Smith rush right');
    expect(cleanPlayText('(05:00) Pistol #13 L.Fahey kneels')).toBe('#13 L.Fahey kneels');
  });

  it('leaves plays with no clock/formation untouched', () => {
    expect(cleanPlayText('Timeout Kansas, clock 02:00')).toBe('Timeout Kansas, clock 02:00');
  });
});

describe('extractRoster', () => {
  it('maps team+jersey to full name and keeps both teams\u2019 #25', () => {
    const r = extractRoster(GAME);
    expect(r.get('NEB#10')).toBe('Anthony Colandrea');
    expect(r.get('OSU#25')).toBe('Bo Jackson');
    expect(r.get('NEB#25')).toBe('Marques Buford');
  });

  it('drops within-team collisions (same number twice on one team)', () => {
    const dup = boxscore({ OSU: [['9', 'Zion Grady'], ['9', 'Someone Else']] });
    expect(extractRoster(dup).has('OSU#9')).toBe(false);
  });
});

describe('buildTeamIndex + playContext', () => {
  it('maps team ids to abbreviations and reads offense/defense from a play', () => {
    const idx = buildTeamIndex(GAME); // OSU=100, NEB=101
    const play: EspnPlay = {
      teamParticipants: [
        { id: '101', type: 'offense' },
        { id: '100', type: 'defense' },
      ],
    };
    expect(playContext(play, idx)).toEqual({ offense: 'NEB', defense: 'OSU' });
  });

  it('falls back to start.team.id for offense when participants absent', () => {
    const idx = buildTeamIndex(GAME);
    expect(playContext({ start: { team: { id: '100' } } }, idx)).toEqual({ offense: 'OSU' });
  });
});

describe('expandNames \u2014 offense/defense disambiguation', () => {
  const roster: Roster = extractRoster(GAME);

  it('resolves the offensive passer and receiver against the offense team', () => {
    expect(expandNames('#10 A.Colandrea pass complete to #3 K.Gilmer', roster, NEB)).toBe(
      'Anthony Colandrea pass complete to Kwinten Gilmer',
    );
  });

  it('resolves tacklers in the parenthetical against the defense team', () => {
    // NEB has the ball (Colandrea->Gilmer); the OSU defenders Mathews & Little
    // make the tackle. Offense tokens -> NEB roster, paren tokens -> OSU roster.
    const out = expandNames(
      '#10 A.Colandrea pass complete to #3 K.Gilmer (#7 J.Mathews Jr.; #1 E.Little Jr.)',
      roster,
      NEB,
    );
    expect(out).toBe(
      'Anthony Colandrea pass complete to Kwinten Gilmer (Jermaine Mathews Jr.; Earl Little Jr.)',
    );
  });

  it('disambiguates cross-team #25: OSU #25 on offense vs NEB #25 on defense', () => {
    // OSU has the ball; #25 before paren = Bo Jackson (OSU), #25 in paren = Marques Buford (NEB).
    const out = expandNames('#25 B.Jackson rush right (#25 M.Buford)', roster, OSU);
    expect(out).toBe('Bo Jackson rush right (Marques Buford)');
  });

  it('expands a Roman-numeral suffix (#16 D.Odem III) \u2014 live-feed case', () => {
    expect(expandNames('tackled by (#16 D.Odem III)', roster, NEB)).toBe(
      'tackled by (Dontavius Odem III)',
    );
  });

  it('leaves an unresolved token as-is when the player is not in the boxscore', () => {
    expect(expandNames('to #22 I.Mozee for 6 yards', roster, NEB)).toBe(
      'to #22 I.Mozee for 6 yards',
    );
  });

  it('resolves by name even without team context when the jersey+name is unique game-wide', () => {
    // #10 A.Colandrea is unique across both rosters, so the initial+surname pins
    // the player with zero team ambiguity — no offense/defense context needed.
    // (This is the kick-return property: name is authoritative, team-agnostic.)
    expect(expandNames('#10 A.Colandrea pass', roster, {})).toBe('Anthony Colandrea pass');
  });

  it('fail-safe: a collided jersey with no context and no name match stays abbreviated', () => {
    // Both teams wear #25; with no context AND a name ESPN abbreviates to a
    // surname that could match either, we must not guess a team.
    expect(expandNames('#25 X.Unknown rush', roster, {})).toBe('#25 X.Unknown rush');
  });

  it('is a no-op with an empty roster', () => {
    expect(expandNames('#10 A.Colandrea pass', new Map(), NEB)).toBe('#10 A.Colandrea pass');
  });
});

describe('expandNames \u2014 compound + penalty clauses', () => {
  const roster: Roster = extractRoster(
    boxscore({
      OSU: [
        ['25', 'Bo Jackson'],
        ['51', 'Luke Montgomery'],
        ['76', 'Jonah Cook'],
        ['67', 'Austin Siereveld'],
        ['13', 'Luke Fahey'],
      ],
      NEB: [
        ['24', 'DeShon Foster'],
        ['55', 'Tree Babalade'],
        ['10', 'Anthony Colandrea'],
      ],
    }),
  );

  it('binds a mid-string PENALTY paren to the penalty team, not the defense', () => {
    // OSU has the ball. The tackler (#24, in the live-ball paren) is NEB defense;
    // the holder (#51, in the PENALTY OSU paren) is OSU \u2014 even though OSU is offense.
    const out = expandNames(
      '#25 B.Jackson rush left for 4 yards gain to the OSU29 (#24 D.Foster) PENALTY OSU Holding (#51 L.Montgomery) 10 yards',
      roster,
      OSU,
    );
    expect(out).toBe(
      'Bo Jackson rush left for 4 yards gain to the OSU29 (DeShon Foster) PENALTY OSU Holding (Luke Montgomery) 10 yards',
    );
  });

  it('resolves a live-ball play that is then penalized (compound, OSU holding on offense)', () => {
    const out = expandNames(
      '#13 L.Fahey rush left for 2 yards gain to the NEB44, out of bounds at NEB44 PENALTY OSU Holding (#67 A.Siereveld) 10 yards from NEB46',
      roster,
      OSU,
    );
    expect(out).toBe(
      'Luke Fahey rush left for 2 yards gain to the NEB44, out of bounds at NEB44 PENALTY OSU Holding (Austin Siereveld) 10 yards from NEB46',
    );
  });

  it('resolves a penalty-only play with no live-ball region (NO PLAY)', () => {
    // Penalty team differs from offense: OSU has the ball but NEB jumped offside-equiv.
    const out = expandNames('PENALTY NEB False Start (#55 T.Babalade) 5 yards from OSU28 to OSU33. NO PLAY', roster, OSU);
    expect(out).toBe('PENALTY NEB False Start (Tree Babalade) 5 yards from OSU28 to OSU33. NO PLAY');
  });

  it('handles PENALTY with no named player (declined) as a no-op', () => {
    const out = expandNames('#10 A.Colandrea sacked for loss of 2 yards (#5 R.Pettijohn) PENALTY NEB Holding declined', roster, NEB);
    // Pettijohn not in roster -> stays; everything else untouched.
    expect(out).toBe('Anthony Colandrea sacked for loss of 2 yards (#5 R.Pettijohn) PENALTY NEB Holding declined');
  });
});

describe('extractPlayByPlay \u2014 end to end say-able text', () => {
  function footballPlay(text: string, offenseId: string, defenseId: string): EspnPlay {
    return {
      id: 'p1',
      sequenceNumber: '1',
      text,
      period: { number: 2 },
      clock: { displayValue: '8:46' },
      awayScore: 7,
      homeScore: 10,
      teamParticipants: [
        { id: offenseId, type: 'offense' },
        { id: defenseId, type: 'defense' },
      ],
    };
  }

  it('cleans, disambiguates and expands a NEB-possession play', () => {
    const summary: EspnSummary = {
      ...GAME,
      drives: {
        previous: [
          {
            team: { abbreviation: 'NEB' },
            plays: [
              footballPlay(
                '(08:46) No Huddle-Shotgun #10 A.Colandrea pass complete short left to #3 K.Gilmer (#7 J.Mathews Jr.)',
                '101', // NEB offense
                '100', // OSU defense
              ),
            ],
          },
        ],
        current: null,
      },
    };
    const [line] = extractPlayByPlay(summary);
    expect(line.text).toBe(
      'Anthony Colandrea pass complete short left to Kwinten Gilmer (Jermaine Mathews Jr.)',
    );
    expect(line.score).toBe('7-10');
  });

  it('is team-agnostic: OSU possession renders the same way', () => {
    const summary: EspnSummary = {
      ...GAME,
      plays: [footballPlay('(09:40) Shotgun #13 L.Fahey pass complete to #4 J.Smith, 1ST DOWN', '100', '101')],
    };
    const [line] = extractPlayByPlay(summary);
    expect(line.text).toBe('Luke Fahey pass complete to Jeremiah Smith, 1ST DOWN');
  });
});
