import { sourcesForLeague, buildStreamSources } from './streamSources';
import { CATALOG, type CatalogLeague } from './catalog';

describe('streamSources — catalog → picker sources (#49)', () => {
  it('emits one source per team for a team-centric league', () => {
    const osu: CatalogLeague = {
      sport: 'football', league: 'college-football', label: 'College Football',
      leaguePickable: false, teams: [{ teamId: '194', label: 'Ohio State Buckeyes' }],
    };
    const srcs = sourcesForLeague(osu);
    expect(srcs).toHaveLength(1);
    expect(srcs[0].id).toBe('football.college-football.194');
    expect(srcs[0].label).toBe('Ohio State Buckeyes');
    expect(srcs[0].url).toContain('/football/college-football/news?');
    expect(srcs[0].url).toContain('team=194');
  });

  it('appends a league source only when leaguePickable', () => {
    const f1: CatalogLeague = {
      sport: 'racing', league: 'f1', label: 'Formula 1', leaguePickable: true, teams: [],
    };
    const srcs = sourcesForLeague(f1);
    expect(srcs).toHaveLength(1);
    expect(srcs[0].id).toBe('racing.f1');
    expect(srcs[0].url).toContain('/racing/f1/news');
    expect(srcs[0].url).not.toContain('team=');
  });

  it('team-centric league does NOT get a league source', () => {
    const nfl = CATALOG.find((l) => l.league === 'nfl')!;
    const srcs = sourcesForLeague(nfl);
    expect(srcs.every((s) => /[?&]team=\d+/.test(s.url))).toBe(true);
  });

  it('a pickable league with teams emits both (teams + league)', () => {
    const l: CatalogLeague = {
      sport: 'soccer', league: 'eng.1', label: 'Premier League', leaguePickable: true,
      teams: [{ teamId: '360', label: 'Arsenal' }],
    };
    const srcs = sourcesForLeague(l);
    expect(srcs).toHaveLength(2);
    expect(srcs.map((s) => s.id)).toEqual(['soccer.eng.1.360', 'soccer.eng.1']);
  });

  it('forwards the limit to the URL builders', () => {
    const osu = CATALOG.find((l) => l.league === 'college-football')!;
    const srcs = sourcesForLeague(osu, 25);
    expect(srcs[0].url).toContain('limit=25');
  });

  it('buildStreamSources expands the whole catalog with unique stable ids', () => {
    const all = buildStreamSources();
    // More than the old 2 hardcoded feeds — content depth is the whole point.
    expect(all.length).toBeGreaterThan(10);
    const ids = all.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // ids unique (sport+league prefix)
    // Every pickable league appears as its own source.
    for (const l of CATALOG.filter((c) => c.leaguePickable)) {
      expect(ids).toContain(`${l.sport}.${l.league}`);
    }
  });

  it('is team-agnostic: OSU is just one of many derived sources', () => {
    const ids = buildStreamSources().map((s) => s.id);
    expect(ids).toContain('football.college-football.194'); // OSU present
    expect(ids).toContain('hockey.nhl.29');                 // but not special
    expect(ids).toContain('baseball.mlb.5');
  });
});
