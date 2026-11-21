/**
 * Say-able play text: strip read-only noise, then expand jersey tokens to
 * "#NN Full Name".
 *
 * A token is matched on first initial + surname against the game's roster
 * (boxscore plus both teams' full rosters): first among players wearing that
 * number, then, if none of them has that name, across everyone. Exactly one
 * match expands; anything else stays exactly as ESPN wrote it.
 *
 * Inputs here are hand-built to the ESPN payload shapes, not captured payloads.
 */
import {
  cleanPlayText,
  expandNames,
  extractPlayByPlay,
  extractRoster,
  fetchPlayByPlay,
} from './playByPlay';
import type { EspnSummary, EspnTeamRoster, Roster } from './types';

/** Minimal boxscore builder: team abbr -> [ [jersey, fullName], ... ]. */
function boxscore(teams: Record<string, Array<[string, string]>>): EspnSummary {
  return {
    boxscore: {
      players: Object.entries(teams).map(([abbr, players]) => ({
        team: { abbreviation: abbr },
        statistics: [
          { athletes: players.map(([jersey, displayName]) => ({ athlete: { jersey, displayName } })) },
        ],
      })),
    },
  };
}

/** Minimal team-roster builder: one unit group of [jersey, fullName] players. */
function teamRoster(players: Array<[string, string]>): EspnTeamRoster {
  return { athletes: [{ items: players.map(([jersey, displayName]) => ({ jersey, displayName })) }] };
}

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
  it('keeps every name wearing a number, across teams and within one', () => {
    const r = extractRoster(
      boxscore({
        OSU: [['25', 'Bo Jackson']],
        NEB: [['25', 'Marques Buford'], ['25', 'Jamal Rule'], ['10', 'Anthony Colandrea']],
      }),
    );
    expect(r.get('25')).toEqual(['Bo Jackson', 'Marques Buford', 'Jamal Rule']);
    expect(r.get('10')).toEqual(['Anthony Colandrea']);
  });

  it('adds team-roster players and lists a player in both sources once', () => {
    const r = extractRoster(boxscore({ NEB: [['11', 'Cameron Lenhardt']] }), [
      teamRoster([['11', 'Cameron Lenhardt'], ['11', 'Demitrius Bell']]),
    ]);
    expect(r.get('11')).toEqual(['Cameron Lenhardt', 'Demitrius Bell']);
  });

  it('skips players with no jersey or no name', () => {
    const r = extractRoster({}, [teamRoster([['', 'No Number'], ['12', '']])]);
    expect(r.size).toBe(0);
  });
});

describe('expandNames', () => {
  const roster: Roster = new Map([
    ['10', ['Anthony Colandrea']],
    ['25', ['Bo Jackson', 'Marques Buford']], // shared number, different names
    ['7', ['Jermaine Mathews Jr.']],
    ['16', ['Dontavius Odem III']],
    ['4', ['Jordan Smith', 'Jalen Smithson']], // same initial; surname only a prefix match
    ['9', ['John Brown', 'James Brown']], // same initial + surname: genuinely ambiguous
    ['3', ['James Smith']], // a second J.Smith, under another number
    ['17', ['Kwazi Gilmer']],
    ['5', ['Riley Van Poppel']],
  ]);

  it('expands a unique match and keeps the jersey number', () => {
    expect(expandNames('#10 A.Colandrea pass complete', roster)).toBe(
      '#10 Anthony Colandrea pass complete',
    );
  });

  it('tells two players wearing the same number apart by name', () => {
    expect(expandNames('#25 B.Jackson rush right (#25 M.Buford)', roster)).toBe(
      '#25 Bo Jackson rush right (#25 Marques Buford)',
    );
  });

  it('handles Jr. and Roman-numeral suffixes', () => {
    expect(expandNames('(#7 J.Mathews Jr.; #16 D.Odem III)', roster)).toBe(
      '(#7 Jermaine Mathews Jr.; #16 Dontavius Odem III)',
    );
  });

  it('matches the surname exactly, not as a prefix (Smith is not Smithson)', () => {
    expect(expandNames('to #4 J.Smith for 6 yards', roster)).toBe('to #4 Jordan Smith for 6 yards');
  });

  it('expands by name when the play text and the roster disagree on the number', () => {
    // Seen live (NEB @ OSU): the play text says #3, ESPN's roster says #17.
    expect(expandNames('to #3 K.Gilmer caught at NEB21', roster)).toBe(
      'to #3 Kwazi Gilmer caught at NEB21',
    );
  });

  it('lets the number pick between two players with the same name token', () => {
    expect(expandNames('#3 J.Smith; #4 J.Smith', roster)).toBe('#3 James Smith; #4 Jordan Smith');
  });

  it('expands a multi-word surname without doubling it', () => {
    expect(expandNames('Offside (#44 R.Van Poppel) 5 yards', roster)).toBe(
      'Offside (#44 Riley Van Poppel) 5 yards',
    );
  });

  it('leaves the token when nobody matches', () => {
    // Number not in the roster at all.
    expect(expandNames('to #22 I.Mozee for 6 yards', roster)).toBe('to #22 I.Mozee for 6 yards');
    // Number is in the roster, but under a different name.
    expect(expandNames('#10 B.Laga kickoff 63 yards', roster)).toBe('#10 B.Laga kickoff 63 yards');
  });

  it('leaves the token when two players match', () => {
    // Both wear the number.
    expect(expandNames('#9 J.Brown rush left', roster)).toBe('#9 J.Brown rush left');
    // Neither wears the number, so the number can't pick.
    expect(expandNames('#12 J.Brown rush left', roster)).toBe('#12 J.Brown rush left');
    expect(expandNames('#8 J.Smith rush left', roster)).toBe('#8 J.Smith rush left');
  });

  it('is a no-op with an empty roster or text that has no tokens', () => {
    expect(expandNames('#10 A.Colandrea pass', new Map())).toBe('#10 A.Colandrea pass');
    expect(expandNames('Anthony Colandrea pass complete', roster)).toBe(
      'Anthony Colandrea pass complete',
    );
  });
});

describe('extractPlayByPlay: say-able text end to end', () => {
  it('cleans the play text and expands names from the summary boxscore', () => {
    const summary: EspnSummary = {
      ...boxscore({
        NEB: [['10', 'Anthony Colandrea'], ['3', 'Kwinten Gilmer']],
        OSU: [['7', 'Jermaine Mathews Jr.']],
      }),
      plays: [
        {
          id: 'p1',
          text: '(08:46) No Huddle-Shotgun #10 A.Colandrea pass complete short left to #3 K.Gilmer (#7 J.Mathews Jr.)',
          period: { number: 2 },
          clock: { displayValue: '8:46' },
          awayScore: 7,
          homeScore: 10,
        },
      ],
    };
    const [line] = extractPlayByPlay(summary);
    expect(line.text).toBe(
      '#10 Anthony Colandrea pass complete short left to #3 Kwinten Gilmer (#7 Jermaine Mathews Jr.)',
    );
    expect(line.score).toBe('7-10');
  });
});

describe('fetchPlayByPlay: team rosters', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  // Colandrea has a stat (boxscore). Bell has none: he is only on the team roster.
  const tokenSummary: EspnSummary = {
    header: { competitions: [{ competitors: [{ team: { id: '158' } }, { team: { id: '194' } }] }] },
    ...boxscore({ NEB: [['10', 'Anthony Colandrea']] }),
    plays: [{ id: 'p1', text: '#10 A.Colandrea pass incomplete deep left to #11 D.Bell' }],
  };
  const rosters: Record<string, EspnTeamRoster> = {
    '158': teamRoster([['10', 'Anthony Colandrea'], ['11', 'Cameron Lenhardt'], ['11', 'Demitrius Bell']]),
    '194': teamRoster([['11', 'Brandon Inniss']]),
  };

  /** Route summary and roster URLs to canned payloads; returns the fetch mock. */
  function mockEspn(summary: EspnSummary, rosterStatus = 200): jest.Mock {
    const mock = jest.fn(async (url: string) => {
      const teamId = /\/teams\/(\d+)\/roster/.exec(url)?.[1];
      if (!teamId) return { ok: true, status: 200, json: async () => summary };
      return { ok: rosterStatus === 200, status: rosterStatus, json: async () => rosters[teamId] };
    });
    global.fetch = mock as unknown as typeof fetch;
    return mock;
  }
  const rosterCalls = (mock: jest.Mock) =>
    mock.mock.calls.filter(([url]) => String(url).includes('/roster'));

  it('expands a player who is only on the team roster', async () => {
    mockEspn(tokenSummary);
    const [line] = await fetchPlayByPlay('game-expand', 'NCAAF');
    expect(line.text).toBe(
      '#10 Anthony Colandrea pass incomplete deep left to #11 Demitrius Bell',
    );
  });

  it('fetches both rosters once per game, not once per poll', async () => {
    const mock = mockEspn(tokenSummary);
    await fetchPlayByPlay('game-once', 'NCAAF');
    await fetchPlayByPlay('game-once', 'NCAAF');
    expect(rosterCalls(mock)).toHaveLength(2); // two teams, one fetch each
    expect(String(rosterCalls(mock)[0][0])).toContain('limit=');
  });

  it('still returns plays when the roster fetch fails, warns, and retries next poll', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mock = mockEspn(tokenSummary, 500);
    const [line] = await fetchPlayByPlay('game-fail', 'NCAAF');
    // Boxscore names still apply; Bell stays as ESPN wrote him.
    expect(line.text).toBe('#10 Anthony Colandrea pass incomplete deep left to #11 D.Bell');
    expect(warn).toHaveBeenCalledTimes(1);

    await fetchPlayByPlay('game-fail', 'NCAAF');
    expect(rosterCalls(mock)).toHaveLength(4); // failure was not cached
  });

  it('does not fetch rosters when the feed has no jersey tokens', async () => {
    const mock = mockEspn({
      ...tokenSummary,
      plays: [{ id: 'p1', text: 'Anthony Colandrea pass complete to Demitrius Bell' }],
    });
    await fetchPlayByPlay('game-fullnames', 'NCAAF');
    expect(rosterCalls(mock)).toHaveLength(0);
  });
});
