/**
 * ESPN's public JSON endpoints: free, no API key. Unofficial, so fields can
 * change; every read here is defensive and skips anything it can't parse.
 */
import { ESPN_LEAGUES, type LeagueDef } from "../config.ts";
import { getJson, norm, ymd } from "../http.ts";
import type { MarketOdds, Match, SportGroup, TeamSide } from "../types.ts";

const BASE = "https://site.api.espn.com/apis/site/v2/sports";

export async function fetchEspnMatches(groups: SportGroup[], from: Date, to: Date): Promise<Match[]> {
  const out: Match[] = [];
  // ESPN "dates" are US-local days, so ask for the day before, of, and after.
  const days = new Set<string>();
  for (let t = from.getTime() - 86400000; t <= to.getTime() + 86400000; t += 86400000) days.add(ymd(new Date(t)));

  for (const g of groups) {
    for (const lg of ESPN_LEAGUES[g] ?? []) {
      for (const day of days) {
        const data = await getJson(`${BASE}/${lg.sport}/${lg.league}/scoreboard?dates=${day}&limit=300`);
        for (const { ev, comp, label } of competitions(data)) {
          const m = parseCompetition(ev, comp, lg, label);
          if (m && m.start >= from && m.start <= to) out.push(m);
        }
      }
    }
  }
  // Same event can appear on two "dates" pages.
  const unique = [...new Map(out.map((m) => [m.key, m])).values()];
  await applyTennisRankings(unique);
  return unique;
}

/** Flatten a scoreboard into competitions. Tennis nests them under "groupings" (singles, doubles...). */
export function competitions(data: any): { ev: any; comp: any; label?: string }[] {
  const out: { ev: any; comp: any; label?: string }[] = [];
  for (const ev of data?.events ?? []) {
    if (Array.isArray(ev.groupings)) {
      for (const gr of ev.groupings) {
        const slug = String(gr?.grouping?.slug ?? gr?.grouping?.displayName ?? "").toLowerCase();
        if (slug && !slug.includes("singles")) continue; // skip doubles
        for (const c of gr.competitions ?? []) out.push({ ev, comp: c, label: gr?.grouping?.displayName });
      }
    } else {
      for (const c of ev.competitions ?? []) out.push({ ev, comp: c });
    }
  }
  return out;
}

function parseCompetition(ev: any, comp: any, lg: LeagueDef, label?: string): Match | null {
  const state = comp?.status?.type?.state ?? ev?.status?.type?.state;
  if (state && state !== "pre") return null;
  const start = new Date(comp?.date ?? ev?.date);
  if (isNaN(start.getTime())) return null;
  const cs: any[] = comp?.competitors ?? [];
  if (cs.length !== 2) return null;

  const isTennis = lg.sport === "tennis";
  const isSoccer = lg.sport === "soccer";
  let home = cs.find((c) => c.homeAway === "home") ?? cs[0];
  let away = cs.find((c) => c.homeAway === "away") ?? cs[1];
  if (home === away) [home, away] = [cs[0], cs[1]];

  const side = (c: any, venue: "home" | "road"): TeamSide => {
    const name = competitorName(c);
    const recs: any[] = c?.records ?? [];
    const overall = recs.find((r) => r.type === "total" || /overall|all/i.test(r.name ?? "")) ?? recs[0];
    const ven = recs.find((r) => r.type === venue || new RegExp(venue, "i").test(r.name ?? ""));
    return {
      name,
      id: c?.team?.id ?? c?.athlete?.id ?? c?.id,
      record: parseRecord(overall?.summary, isSoccer),
      venueRecord: parseRecord(ven?.summary, isSoccer),
      // ESPN's soccer "form" mixes all competitions; it's still useful as recent form.
      form: typeof c?.form === "string" ? c.form.toUpperCase().split("").filter((x: string) => "WDL".includes(x)) : undefined,
      // Tennis rank is filled in later from the real rankings. ESPN's curatedRank here is only the tournament seed.
    };
  };

  const h = side(home, "home");
  const a = side(away, "road");
  if (h.name === "Unknown" || a.name === "Unknown" || /TBD/i.test(h.name + a.name)) return null;

  const seeds = isTennis ? [home, away].map((c) => Number(c?.curatedRank?.current ?? c?.seed)).map((s) => (s > 0 && s < 200 ? s : undefined)) : [];
  return {
    key: `espn:${lg.league}:${comp?.id ?? ev.id}`,
    sport: lg.group,
    league: label ? `${ev.name ?? lg.name} – ${label}` : lg.name,
    tournament: isTennis ? String(ev.name ?? "") : undefined,
    start,
    home: h,
    away: a,
    hasDraw: isSoccer,
    neutral: isTennis || comp?.neutralSite === true,
    odds: parseEspnOdds(comp?.odds, isSoccer),
    link: ev?.links?.find((l: any) => /gamecast|summary|match/i.test((l.rel ?? []).join(" ")))?.href ?? ev?.links?.[0]?.href,
    context: {
      venue: comp?.venue?.fullName,
      notes: comp?.notes?.map((n: any) => n.headline).filter(Boolean),
      ...(seeds.some(Boolean) ? { seeds: { [h.name]: seeds[0], [a.name]: seeds[1] } } : {}),
    },
    espn: { sport: lg.sport, league: lg.league, eventId: String(ev.id), compId: String(comp?.id ?? ev.id) },
  };
}

export const competitorName = (c: any): string =>
  c?.team?.displayName ?? c?.athlete?.displayName ?? c?.athlete?.fullName ?? "Unknown";

export function parseRecord(summary: unknown, threeWay: boolean) {
  if (typeof summary !== "string") return undefined;
  const n = summary.split("-").map((x) => Number(x.trim()));
  if (n.some((x) => !Number.isFinite(x))) return undefined;
  if (threeWay && n.length === 3) return { w: n[0], d: n[1], l: n[2] };
  if (n.length === 2) return { w: n[0], d: 0, l: n[1] };
  if (n.length === 3) return { w: n[0], d: n[2], l: n[1] }; // W-L-T style
  return undefined;
}

export function americanToDecimal(ml: unknown): number | undefined {
  const v = Number(ml);
  if (ml === null || ml === undefined || ml === "" || !Number.isFinite(v) || v === 0) return undefined;
  return v > 0 ? 1 + v / 100 : 1 + 100 / Math.abs(v);
}

/** ESPN shows one US bookmaker's line. Good for display; too little to find value with. */
function parseEspnOdds(odds: any[] | undefined, hasDraw: boolean): MarketOdds | undefined {
  const o = odds?.[0];
  if (!o) return undefined;
  const title = o?.provider?.name ?? "ESPN";
  const pick = (x: any) => americanToDecimal(x?.moneyLine ?? x?.close?.odds ?? x?.current?.moneyLine);
  const home = pick(o.homeTeamOdds) ?? pick(o.moneyline?.home);
  const away = pick(o.awayTeamOdds) ?? pick(o.moneyline?.away);
  const draw = pick(o.drawOdds) ?? pick(o.moneyline?.draw);
  if (!home || !away || (hasDraw && !draw)) return undefined;
  return { books: [{ key: norm(title), title, home, away, draw }], source: "ESPN" };
}

/** Real ATP/WTA rankings (top 150) from ESPN. Players outside the top 150 stay unranked. */
async function applyTennisRankings(matches: Match[]) {
  const tennis = matches.filter((m) => m.sport === "tennis");
  for (const tour of ["atp", "wta"]) {
    const ms = tennis.filter((m) => m.espn?.league === tour);
    if (!ms.length) continue;
    const ranks = await fetchRankings(tour);
    for (const m of ms) {
      m.home.rank = ranks.get(norm(m.home.name));
      m.away.rank = ranks.get(norm(m.away.name));
    }
  }
}

export async function fetchRankings(tour: string): Promise<Map<string, number>> {
  const data = await getJson(`${BASE}/tennis/${tour}/rankings`);
  const map = new Map<string, number>();
  for (const r of data?.rankings?.[0]?.ranks ?? []) {
    const name = r?.athlete?.displayName;
    const rank = Number(r?.current);
    if (name && rank > 0) map.set(norm(name), rank);
  }
  return map;
}

/** Injuries, recent news and head-to-head from ESPN's game summary. Small and trimmed for the AI. */
export async function fetchEspnContext(m: Match): Promise<Record<string, unknown>> {
  if (!m.espn || m.espn.sport === "tennis") return {};
  const s = await getJson(`${BASE}/${m.espn.sport}/${m.espn.league}/summary?event=${m.espn.eventId}`);
  if (!s) return {};
  const injuries = (s.injuries ?? []).map((t: any) => ({
    team: t?.team?.displayName,
    out: (t?.injuries ?? []).slice(0, 12).map((i: any) => `${i?.athlete?.displayName} (${i?.status ?? i?.type?.description ?? "?"})`),
  }));
  const news = (s.news?.articles ?? []).slice(0, 6).map((a: any) => a?.headline).filter(Boolean);
  const h2h = (s.headToHeadGames?.[0]?.events ?? []).slice(0, 5).map((e: any) => ({
    date: e?.gameDate, result: e?.gameResult, score: e?.score, home: e?.homeTeamScore, away: e?.awayTeamScore,
  }));
  const lastFive = (s.lastFiveGames ?? []).map((t: any) => ({
    team: t?.team?.displayName,
    games: (t?.events ?? []).map((e: any) => `${e?.gameResult ?? "?"} ${e?.score ?? ""} vs ${e?.opponent?.displayName ?? ""}`.trim()),
  }));
  return { injuries, news, headToHead: h2h, lastFive };
}
