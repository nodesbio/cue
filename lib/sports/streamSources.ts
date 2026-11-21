/**
 * streamSources.ts — derive the article-picker's source list from the CATALOG
 * (#49 content depth).
 *
 * The picker was running dry: STREAM_SOURCES hardcoded two feeds (OSU team +
 * college football), so a nightly listener exhausts ~50 articles and has nothing
 * new to queue. The catalog already models every team and pickable league we
 * cover; this module expands it into NewsSource[] so the full inventory is
 * pickable — ~one source per team plus each standalone league.
 *
 * Pure, no I/O. DRY against catalog.ts: teams are never re-listed here. Source
 * ids are stable and unique (sport.league.teamId / sport.league for a league),
 * so the picker's selection and any future "already streamed" dedup can key on
 * them. Team ids are only unique within a league (id 5 = Browns/Guardians/Cavs),
 * hence the sport+league prefix.
 */

import { CATALOG, type CatalogLeague } from './catalog';
import { teamNewsUrl, leagueNewsUrl } from './newsFeed';
import type { NewsSource } from '../../components/ArticlePicker';

/** ESPN path slug for a league, e.g. 'football/college-football'. */
function sportPath(l: CatalogLeague): string {
  return `${l.sport}/${l.league}`;
}

/**
 * Expand one catalog league into pickable sources: one per team, plus the league
 * itself when `leaguePickable` (Premier/Champions/F1 have no team list but are
 * sensible standalone topics). `limit` is forwarded to the news URL builders.
 */
export function sourcesForLeague(l: CatalogLeague, limit = 50): NewsSource[] {
  const path = sportPath(l);
  const out: NewsSource[] = l.teams.map((t) => ({
    id: `${l.sport}.${l.league}.${t.teamId}`,
    label: t.label,
    url: teamNewsUrl(path, t.teamId, limit),
  }));
  if (l.leaguePickable) {
    out.push({
      id: `${l.sport}.${l.league}`,
      label: l.label,
      url: leagueNewsUrl(path, limit),
    });
  }
  return out;
}

/**
 * The full picker source list, derived from the catalog in catalog order. This
 * replaces the two hardcoded STREAM_SOURCES: every covered team and standalone
 * league becomes pickable, turning a ~2-feed well into the whole inventory.
 */
export function buildStreamSources(limit = 50): NewsSource[] {
  return CATALOG.flatMap((l) => sourcesForLeague(l, limit));
}
