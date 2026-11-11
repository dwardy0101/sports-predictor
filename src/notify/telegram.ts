import { config } from "../config.ts";
import type { Prediction, Probabilities } from "../types.ts";

/** "quarter Kelly" reads better than "0.25 Kelly" for the usual settings. */
const kellyLabel = (f: number) => (f === 0.25 ? "quarter Kelly" : f === 0.5 ? "half Kelly" : f === 1 ? "full Kelly" : `${f}× Kelly`);

/** "6m ago" / "2h 10m ago", or nothing when the odds service doesn't say. */
function ago(iso: string | undefined, now: Date): string | undefined {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return undefined;
  const mins = Math.round((now.getTime() - t) / 60_000);
  if (mins < 0 || mins > 7 * 24 * 60) return undefined;
  return mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (p: number) => `${Math.round(p * 100)}%`;
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");
/** A small tappable link icon, only for https links. */
const icon = (u?: string) => (u && /^https:\/\//.test(u) ? ` <a href="${attr(u)}">🔗</a>` : "");
const tzLabel = () => (config.timezone === "Asia/Manila" ? "PHT" : config.timezone);
const part = (d: Date, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, ...opts }).format(d).replace(/\u202f/g, " ");
const dayKey = (d: Date) => part(d, { year: "numeric", month: "numeric", day: "numeric" });
/** "11:30 PM" in the configured timezone. */
export const clock = (d: Date) => part(d, { hour: "numeric", minute: "2-digit", hour12: true });
/** "Tue, Nov 3" in the configured timezone. */
export const dayLabel = (d: Date) => part(d, { weekday: "short", month: "short", day: "numeric" });
/** Time of day, with "+1d" when it falls on a later local day than `ref` (e.g. just after midnight). */
const clockOn = (d: Date, ref: Date) => (dayKey(d) === dayKey(ref) ? clock(d) : `${clock(d)} +1d`);
const ICON: Record<string, string> = { nba: "🏀", wnba: "🏀", basketball: "🏀", football: "⚽", tennis: "🎾", dota2: "🎮", cs2: "🔫" };
/** Telegram's limit is 4096 characters; leave room for HTML entities. */
const MAX_LEN = 3800;

function probLine(p: Prediction, pr: Probabilities): string {
  const m = p.match;
  const A = esc(m.home.name), B = esc(m.away.name);
  return m.hasDraw ? `${A} ${pct(pr.home)} · draw ${pct(pr.draw)} · ${B} ${pct(pr.away)}` : `${A} ${pct(pr.home)} · ${B} ${pct(pr.away)}`;
}

/** Where the percentages come from: P = Pinnacle, C = consensus, B = one bookmaker, M = stats model only. */
const sourceTag = (p: Prediction) => (!p.fair ? "M" : p.fair.kind === "sharp" ? "P" : p.fair.kind === "consensus" ? "C" : "B");

/**
 * One compact message for everything starting soon. Returns one or more
 * message texts (split to stay under Telegram's length limit).
 */
export function formatDigest(preds: Prediction[]): string[] {
  if (!preds.length) return [];
  const sorted = [...preds].sort((a, b) => +a.match.start - +b.match.start);
  const first = sorted[0].match.start, last = sorted[sorted.length - 1].match.start;
  const header = `⏱ <b>Starting soon</b> · ${preds.length} match${preds.length > 1 ? "es" : ""} · ${dayLabel(first)} · ${clock(first)}${clock(last) === clock(first) && dayKey(last) === dayKey(first) ? "" : `–${clockOn(last, first)}`} ${tzLabel()}`;

  const blocks: string[] = [];
  const byLeague = new Map<string, Prediction[]>();
  for (const p of sorted) {
    const k = `${p.match.sport}|${p.match.league.split(" – ")[0]}`;
    byLeague.set(k, [...(byLeague.get(k) ?? []), p]);
  }
  for (const [k, ps] of byLeague) {
    const [sport, league] = k.split("|");
    const lines = [`${ICON[sport] ?? "🏟"} <b>${esc(league)}</b>`];
    for (const p of ps) {
      const gem = p.value ? " 💎" : "";
      lines.push(`${clockOn(p.match.start, first)} ${probLine(p, p.final)} <i>${sourceTag(p)}</i>${gem}${icon(p.betLink)}`);
    }
    blocks.push(lines.join("\n"));
  }
  const footer = "<i>P = Pinnacle no-vig · C = bookmaker consensus · B = one bookmaker · M = stats model only. 💎 = value bet (details follow). 🔗 = match page at your bookmaker.</i>";
  return chunk([header, ...blocks, footer]);
}

/** Detailed message for one value bet. */
export function formatAlert(p: Prediction, now = new Date()): string {
  const m = p.match, v = p.value!;
  const mins = Math.max(0, Math.round((m.start.getTime() - now.getTime()) / 60000));
  const A = esc(m.home.name), B = esc(m.away.name);
  const pick = v.side === "home" ? A : v.side === "away" ? B : "Draw";

  const L: string[] = [];
  const where = v.link && /^https:\/\//.test(v.link) ? `<a href="${attr(v.link)}">${esc(v.book)}</a>` : esc(v.book);
  L.push(`💎 <b>Value bet: ${pick} @ ${v.price.toFixed(2)}</b> on ${where}`);
  L.push(`${ICON[m.sport] ?? "🏟"} ${A} vs ${B}`);
  L.push(`🏆 ${esc(m.league)}${m.bestOf ? ` · Bo${m.bestOf}` : ""}`);
  L.push(`🕒 ${dayLabel(m.start)} · ${clock(m.start)} ${tzLabel()} (in ${Math.floor(mins / 60)}h ${mins % 60}m)`);
  L.push("");
  L.push(`📊 Fair chances (${esc(p.fair!.source)}): ${probLine(p, p.final)}`);
  L.push(`   Stats model: ${probLine(p, p.model)}`);
  L.push(`➜ Fair price ${v.fairPrice.toFixed(2)}, offered ${v.price.toFixed(2)}: expected value <b>+${v.evPct.toFixed(1)}%</b>`);
  if (v.stakePct) {
    const money = config.bankroll ? ` ≈ ${((v.stakePct / 100) * config.bankroll).toFixed(2)}` : "";
    L.push(`💵 Stake: <b>${v.stakePct.toFixed(2)}% of bankroll</b>${money} (${kellyLabel(config.kellyFraction)}, capped at ${config.maxStakePct}%)`);
  }
  if (p.best) {
    const b = p.best;
    const parts = [
      b.home && `${A} ${b.home.price.toFixed(2)} (${esc(b.home.book)})`,
      m.hasDraw && b.draw && `Draw ${b.draw.price.toFixed(2)} (${esc(b.draw.book)})`,
      b.away && `${B} ${b.away.price.toFixed(2)} (${esc(b.away.book)})`,
    ].filter(Boolean);
    L.push(`💰 Best odds: ${parts.join(" | ")}`);
  }
  if (p.factors.length) {
    L.push("");
    L.push(`🔍 <b>Key factors${p.aiUsed ? " (AI)" : ""}:</b>`);
    for (const f of p.factors.slice(0, 6)) L.push(` • ${esc(f)}`);
  }
  if (p.risks.length) {
    L.push("");
    L.push(`⚠️ <b>Check before betting:</b>`);
    for (const r of p.risks.slice(0, 3)) L.push(` • ${esc(r)}`);
  }
  L.push("");
  const seen = ago(v.priceAt, now);
  L.push(`Confidence: ${p.confidence}${seen ? ` · price last moved ${seen}` : ""} · prices move, so check the current odds${m.link && /^https:\/\//.test(m.link) ? ` · <a href="${attr(m.link)}">match page</a>` : ""}`);
  return L.join("\n");
}

const plain = (html: string) =>
  html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/**
 * Join blocks with blank lines into messages under the length limit. A block that is too long on its
 * own (a huge league) is split between lines, never inside one, so no HTML tag is ever cut in half.
 */
export function chunk(blocks: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  const add = (piece: string, sep: string) => {
    if (cur && cur.length + sep.length + piece.length > MAX_LEN) { out.push(cur); cur = piece; }
    else cur = cur ? cur + sep + piece : piece;
  };
  for (const b of blocks) {
    if (b.length <= MAX_LEN) { add(b, "\n\n"); continue; }
    b.split("\n").forEach((line, i) => add(line.length > MAX_LEN ? plain(line).slice(0, MAX_LEN) : line, i === 0 ? "\n\n" : "\n"));
  }
  if (cur) out.push(cur);
  return out;
}

/** Cut a message that is over Telegram's limit at a line break (every line of ours is self-contained HTML). */
export function fitTelegram(html: string): string {
  if (html.length <= 4000) return html;
  const kept: string[] = [];
  let len = 0;
  for (const line of html.split("\n")) {
    if (len + line.length + 1 > MAX_LEN) break;
    kept.push(line);
    len += line.length + 1;
  }
  return kept.join("\n") || plain(html).slice(0, MAX_LEN);
}

export async function sendTelegram(html: string): Promise<boolean> {
  if (config.dryRun || !config.telegramToken || !config.telegramChatId) {
    console.log("\n----- (dry run: message not sent) -----\n" + plain(html));
    return true;
  }
  let text = fitTelegram(html);
  let asHtml = true;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegramChatId, text, ...(asHtml ? { parse_mode: "HTML" } : {}), link_preview_options: { is_disabled: true } }),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as unknown as Response);
    if (res.ok) return true;
    const body = await res.text();
    if (res.status === 429) {
      let wait = 3;
      try { wait = JSON.parse(body)?.parameters?.retry_after ?? 3; } catch { /* keep default */ }
      await new Promise((r) => setTimeout(r, 1000 * wait));
      continue;
    }
    // Telegram refused the HTML (a character or tag it dislikes): send the same words as plain text instead of losing them.
    if (res.status === 400 && asHtml && /parse entities/i.test(body)) {
      console.warn("[telegram] HTML rejected; sending as plain text");
      asHtml = false;
      text = plain(text);
      continue;
    }
    console.error(`[telegram] send failed: ${body}`);
    return false;
  }
  return false;
}
