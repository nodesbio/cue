/**
 * SportsFeed — formatter purity + poll/emit lifecycle (with an injected fetcher,
 * no network).
 */
import { SportsFeed, formatFrame, topLeader } from './SportsFeed';
import { rankScoreboard, extractLeaders } from './espn';
import type { GameSnapshot, Leader } from './types';

function snap(p: Partial<GameSnapshot> & { excitement: number }): GameSnapshot {
  return {
    gameId: p.gameId ?? '1',
    league: p.league ?? 'NBA',
    excitement: p.excitement,
    home: p.home ?? 'LAL',
    away: p.away ?? 'BOS',
    homeFull: p.homeFull ?? 'Lakers',
    awayFull: p.awayFull ?? 'Celtics',
    homeScore: p.homeScore ?? '96',
    awayScore: p.awayScore ?? '98',
    status: p.status ?? '2:13 - 4th',
    leaders: p.leaders ?? [],
  };
}

function lead(p: Partial<Leader> & { stat: string; value: string }): Leader {
  return {
    stat: p.stat,
    value: p.value,
    player: p.player ?? 'L. Doncic',
    team: p.team ?? 'LAL',
    pos: p.pos ?? 'G',
  };
}

describe('formatFrame', () => {
  it('shows a placeholder when nothing is live', () => {
    expect(formatFrame([])).toBe('No live games right now');
  });

  it('renders league header, both teams, and a +N more tail', () => {
    const frame = formatFrame([snap({ excitement: 90 }), snap({ excitement: 50 }), snap({ excitement: 10 })]);
    const lines = frame.split('\n');
    expect(lines[0]).toContain('NBA');
    expect(lines[0]).toContain('2:13 - 4th');
    expect(lines[1]).toBe('BOS 98');
    expect(lines[2]).toBe('LAL 96');
    expect(lines[3]).toBe('+2 more live');
  });

  it('omits the tail for a single game', () => {
    expect(formatFrame([snap({ excitement: 90 })]).split('\n')).toHaveLength(3);
  });

  it('leads with the top performer line when leaders are present', () => {
    const frame = formatFrame([
      snap({ excitement: 90, leaders: [lead({ stat: 'PTS', value: '34', player: 'L. Doncic' })] }),
    ]);
    const lines = frame.split('\n');
    // header, away, home, star — star uses the ★ glyph and reads naturally
    expect(lines[3]).toBe('\u2605 L. Doncic 34 PTS');
  });

  it('has no star line when a game carries no leaders', () => {
    const frame = formatFrame([snap({ excitement: 90, leaders: [] })]);
    expect(frame.split('\n')).toHaveLength(3);
  });
});

describe('topLeader', () => {
  it('prefers PTS over other stats regardless of order', () => {
    const g = snap({
      excitement: 90,
      leaders: [lead({ stat: 'REB', value: '12' }), lead({ stat: 'PTS', value: '30' })],
    });
    expect(topLeader(g)?.stat).toBe('PTS');
  });

  it('falls back to the first stat when PTS is absent (e.g. NHL)', () => {
    const g = snap({ excitement: 90, leaders: [lead({ stat: 'AST', value: '3', player: 'C. McDavid' })] });
    expect(topLeader(g)?.player).toBe('C. McDavid');
  });

  it('returns null with no leaders', () => {
    expect(topLeader(snap({ excitement: 90, leaders: [] }))).toBeNull();
  });
});

describe('extractLeaders', () => {
  const cat = (name: string, value: string, player: string, pos = 'G') => ({
    name,
    leaders: [{ displayValue: value, athlete: { shortName: player, position: { abbreviation: pos } } }],
  });

  it('pulls PTS/REB/AST ordered, taking the higher value across both teams', () => {
    const comp = {
      competitors: [
        { score: '80', team: { abbreviation: 'LAL' }, leaders: [cat('points', '30', 'L. Doncic'), cat('rebounds', '8', 'A. Davis', 'F')] },
        { score: '78', team: { abbreviation: 'BOS' }, leaders: [cat('points', '24', 'J. Tatum'), cat('rebounds', '11', 'A. Horford', 'C'), cat('assists', '9', 'D. White')] },
      ],
    };
    const out = extractLeaders(comp as any);
    expect(out.map((l) => l.stat)).toEqual(['PTS', 'REB', 'AST']);
    expect(out[0]).toMatchObject({ stat: 'PTS', value: '30', player: 'L. Doncic', team: 'LAL' });
    expect(out[1]).toMatchObject({ stat: 'REB', value: '11', player: 'A. Horford', team: 'BOS' }); // higher reb wins
  });

  it('ignores unknown categories and leaderless competitors', () => {
    const comp = {
      competitors: [
        { score: '0', team: { abbreviation: 'A' }, leaders: [cat('rating', '55', 'X. Y')] },
        { score: '0', team: { abbreviation: 'B' } }, // no leaders block
      ],
    };
    expect(extractLeaders(comp as any)).toEqual([]);
  });

  it('skips a category whose displayValue is non-numeric', () => {
    const comp = {
      competitors: [{ score: '0', team: { abbreviation: 'A' }, leaders: [{ name: 'points', leaders: [{ displayValue: '-', athlete: { shortName: 'N. A' } }] }] }],
    };
    expect(extractLeaders(comp as any)).toEqual([]);
  });
});

describe('rankScoreboard', () => {
  it('drops non-live games and sorts by excitement', () => {
    const board = {
      events: [
        {
          id: 'pre',
          status: { type: { state: 'pre', detail: '' } },
          competitions: [{ competitors: [{ score: '0', team: { abbreviation: 'A' } }, { score: '0', team: { abbreviation: 'B' } }] }],
        },
        {
          id: 'live-blowout',
          status: { type: { state: 'in', detail: '3rd' }, period: 3, displayClock: '8:00' },
          competitions: [{ competitors: [{ score: '80', team: { abbreviation: 'C' } }, { score: '60', team: { abbreviation: 'D' } }] }],
        },
        {
          id: 'live-nailbiter',
          status: { type: { state: 'in', detail: '4th' }, period: 4, displayClock: '1:00' },
          competitions: [{ competitors: [
            { score: '99', homeAway: 'home', team: { abbreviation: 'E' } },
            { score: '98', homeAway: 'away', team: { abbreviation: 'F' } },
          ] }],
        },
      ],
    };
    const ranked = rankScoreboard(board as any, 'NBA');
    expect(ranked.map((g) => g.gameId)).toEqual(['live-nailbiter', 'live-blowout']); // nailbiter first, pre dropped
  });

  it('assigns home/away by homeAway role, not array order (NHL lists away first)', () => {
    const board = {
      events: [
        {
          id: 'g',
          status: { type: { state: 'in', detail: '3rd' }, period: 3, displayClock: '4:00' },
          competitions: [{ competitors: [
            // away listed FIRST (NHL ordering) — must not be read as home
            { score: '2', homeAway: 'away', team: { abbreviation: 'NYR', displayName: 'Rangers' } },
            { score: '3', homeAway: 'home', team: { abbreviation: 'BOS', displayName: 'Bruins' } },
          ] }],
        },
      ],
    };
    const [g] = rankScoreboard(board as any, 'NHL');
    expect(g.home).toBe('BOS');
    expect(g.homeScore).toBe('3');
    expect(g.away).toBe('NYR');
    expect(g.awayScore).toBe('2');
  });
});

describe('SportsFeed lifecycle', () => {
  afterEach(() => jest.useRealTimers());

  it('emits a frame on poll via the injected fetcher', async () => {
    const frames: string[] = [];
    const feed = new SportsFeed({
      onFrame: (f) => frames.push(f),
      fetcher: async () => [snap({ excitement: 90 })],
    });
    await feed.poll();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('BOS 98');
  });

  it('reports errors via onError and does not throw', async () => {
    const errors: unknown[] = [];
    const feed = new SportsFeed({
      onFrame: () => {},
      onError: (e) => errors.push(e),
      fetcher: async () => { throw new Error('espn down'); },
    });
    await feed.poll();
    expect(errors).toHaveLength(1);
  });

  it('suppresses callbacks after stop() during an in-flight poll', async () => {
    let resolveFetch!: (g: GameSnapshot[]) => void;
    const frames: string[] = [];
    const feed = new SportsFeed({
      onFrame: (f) => frames.push(f),
      fetcher: () => new Promise((res) => { resolveFetch = res; }),
    });
    const p = feed.poll();
    feed.stop();              // stop while fetch is pending
    resolveFetch([snap({ excitement: 90 })]);
    await p;
    expect(frames).toHaveLength(0); // late result suppressed
  });

  it('start() is idempotent and sets isRunning', () => {
    jest.useFakeTimers();
    const feed = new SportsFeed({ onFrame: () => {}, fetcher: async () => [] });
    feed.start();
    expect(feed.isRunning).toBe(true);
    feed.start(); // no-op, no second timer
    feed.stop();
    expect(feed.isRunning).toBe(false);
  });
});
