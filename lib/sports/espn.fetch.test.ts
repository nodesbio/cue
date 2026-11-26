/**
 * fetchLiveGames failure semantics. Regression: when EVERY league failed
 * (offline, DNS, ESPN down) it returned [] — indistinguishable from a quiet
 * night — so SportsFeed put "No live games right now" on the lens and onError
 * never fired. One league failing is still tolerated (ESPN routinely 503s a
 * single sport); all of them failing is an error, not "no data".
 */
import { fetchLiveGames } from './espn';

const realFetch = global.fetch;
let warn: jest.SpyInstance;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { global.fetch = realFetch; warn.mockRestore(); });

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe('fetchLiveGames', () => {
  it('throws when every league fails (offline is not "no live games")', async () => {
    global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); }) as typeof fetch;
    await expect(fetchLiveGames(['NBA', 'NHL'])).rejects.toThrow(/all 2 leagues failed.*Network request failed/i);
  });

  it('throws on all-HTTP-error too', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }) as Response) as typeof fetch;
    await expect(fetchLiveGames(['NBA'])).rejects.toThrow(/ESPN NBA HTTP 503/);
  });

  it('tolerates a partial failure and returns the leagues that worked', async () => {
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('nba')) throw new TypeError('Network request failed');
      return ok({ events: [] });
    }) as typeof fetch;
    await expect(fetchLiveGames(['NBA', 'NHL'])).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled(); // the failed league is still surfaced in logs
  });

  it('a genuinely quiet night (all ok, no events) is [] — not an error', async () => {
    global.fetch = jest.fn(async () => ok({ events: [] })) as typeof fetch;
    await expect(fetchLiveGames(['NBA', 'NHL'])).resolves.toEqual([]);
  });
});
