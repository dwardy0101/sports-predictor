/**
 * Dota 2 and CS2 from PandaScore (free plan, needs a token).
 * Team strength = an Elo rating we compute from the last few hundred finished
 * matches, so no extra data source is needed. Recent form comes from the same data.
 */
import { config } from "../config.ts";
import { getJson } from "../http.ts";
import type { Match, SportGroup, TeamSide } from "../types.ts";

const PS = "https://api.pandascore.co";
// PandaScore kept the "csgo" path for Counter-Strike 2.
const GAME_SLUG: Record<string, string> = { dota2: "dota2", cs2: "csgo" };

export interface PastMatch { begin_at: string; winner_id: number | null; a: number; b: number; aName: string; bName: string }
export interface TeamStats { rating: number; games: number; recent: { date: string; opponent: string; result: "W" | "L" }[] }

export async function fetchEsportsMatches(groups: SportGroup[], from: Date, to: Date): Promise<Match[]> {
  if (!config.pandascoreToken) {
    if (groups.some((g) => g in GAME_SLUG)) console.warn("[esports] PANDASCORE_TOKEN not set; skipping Dota 2 / CS2");
    return [];
  }
  const headers = { Authorization: `Bearer ${config.pandascoreToken}` };
  const out: Match[] = [];

  for (const g of groups) {
    const slug = GAME_SLUG[g];
    if (!slug) continue;
    const range = `${from.toISOString()},${to.toISOString()}`;
    const list = await getJson<any[]>(`${PS}/${slug}/matches/upcoming?range[begin_at]=${range}&sort=begin_at&per_page=50`, { headers });
    if (!Array.isArray(list) || !list.length) continue;

    const history: PastMatch[] = [];
    for (let page = 1; page <= config.esportsHistoryPages; page++) {
      const past = await getJson<any[]>(`${PS}/${slug}/matches/past?sort=-begin_at&per_page=100&page=${page}`, { headers });
      if (!Array.isArray(past) || !past.length) break;
      for (const m of past) {
        const [A, B] = (m?.opponents ?? []).map((o: any) => o?.opponent);
        if (A?.id && B?.id) history.push({ begin_at: m.begin_at, winner_id: m.winner_id ?? null, a: A.id, b: B.id, aName: A.name, bName: B.name });
      }
    }
    const stats = computeElo(history);

    for (const pm of list) {
      const opp = pm?.opponents ?? [];
      if (opp.length !== 2) continue;
      const start = new Date(pm.begin_at ?? pm.scheduled_at);
      if (isNaN(start.getTime()) || start < from || start > to) continue;
      const [A, B] = opp.map((o: any) => o.opponent);

      const side = (t: any): TeamSide => {
        const s = stats.get(t.id);
        const recent = s?.recent.slice(0, 10) ?? [];
        const wins = recent.filter((r) => r.result === "W").length;
        return {
          name: t.name,
          id: String(t.id),
          form: recent.map((r) => r.result).reverse(),
          record: recent.length ? { w: wins, d: 0, l: recent.length - wins } : undefined,
          // A rating from fewer than 5 games is mostly noise.
          rating: s && s.games >= 5 ? s.rating : undefined,
        };
      };

      out.push({
        key: `ps:${slug}:${pm.id}`,
        sport: g,
        league: [pm.league?.name, pm.serie?.full_name, pm.tournament?.name].filter(Boolean).join(" – "),
        start,
        home: side(A),
        away: side(B),
        hasDraw: false,
        neutral: true,
        bestOf: pm.number_of_games,
        link: pm.streams_list?.find((s: any) => s.main)?.raw_url,
        context: {
          tier: pm.tournament?.tier,
          bestOf: pm.number_of_games,
          recentA: stats.get(A.id)?.recent.slice(0, 10),
          recentB: stats.get(B.id)?.recent.slice(0, 10),
          headToHead: stats.get(A.id)?.recent.filter((r) => r.opponent === B.name),
        },
      });
    }
  }
  return out;
}

/** Standard Elo (start 1500, K=32) over matches in time order. `recent` is newest first. */
export function computeElo(history: PastMatch[]): Map<number, TeamStats> {
  const stats = new Map<number, TeamStats>();
  const get = (id: number) => stats.get(id) ?? (stats.set(id, { rating: 1500, games: 0, recent: [] }), stats.get(id)!);
  const ordered = [...history].filter((m) => m.winner_id).sort((x, y) => +new Date(x.begin_at) - +new Date(y.begin_at));
  for (const m of ordered) {
    const A = get(m.a), B = get(m.b);
    const expA = 1 / (1 + 10 ** ((B.rating - A.rating) / 400));
    const scoreA = m.winner_id === m.a ? 1 : 0;
    A.rating += 32 * (scoreA - expA);
    B.rating -= 32 * (scoreA - expA);
    A.games++; B.games++;
    A.recent.unshift({ date: m.begin_at, opponent: m.bName, result: scoreA ? "W" : "L" });
    B.recent.unshift({ date: m.begin_at, opponent: m.aName, result: scoreA ? "L" : "W" });
  }
  return stats;
}
