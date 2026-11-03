/**
 * Optional AI analyst (Claude). It only runs for value-bet alerts, so it costs
 * cents per month on the default model (claude-haiku-5-5). It reads the data
 * pack (records, form, injuries, news, head-to-head, fair odds vs. the best
 * price) and returns the key factors plus anything that could explain why the
 * price looks too generous (a "risk" the bettor should check first).
 * If ANTHROPIC_API_KEY is not set, the pipeline skips this step.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import type { Prediction } from "../types.ts";

export interface AnalystResult {
  key_factors: string[];
  risks: string[];
  confidence: "low" | "medium" | "high";
}

const SCHEMA = {
  type: "object",
  properties: {
    key_factors: { type: "array", items: { type: "string" }, description: "3 to 5 short factors for this match, each under 15 words." },
    risks: {
      type: "array",
      items: { type: "string" },
      description: "0 to 3 concrete reasons the value bet might be a trap (e.g. key player news the price may already reflect). Empty if none in the data.",
    },
    confidence: { type: "string", enum: ["low", "medium", "high"], description: "How much the data supports the bet." },
  },
  required: ["key_factors", "risks", "confidence"],
  additionalProperties: false,
} as const;

const SYSTEM = `You are a careful sports betting analyst. You get a data pack for one upcoming match: team data, the fair (no-margin) probabilities from the sharpest bookmaker or a consensus of bookmakers, and one bookmaker's price that is higher than fair, which is why this match was flagged as a value bet.
Your job: list the key factors for the match, and point out anything in the data that could explain the generous price (late injury or lineup news, rotation, motivation, a mismatch in team names).
Rules:
- Use only facts in the data pack. Never invent players, injuries or results. If the pack is thin, say so and set confidence to low.
- Keep each item short and concrete, e.g. "Embiid out (knee), team 3-7 without him".`;

let client: Anthropic | undefined;

/** Models that accept the server-side refusal fallback (Haiku doesn't). */
const supportsFallback = (model: string) => /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);

export async function analyze(p: Prediction): Promise<AnalystResult | null> {
  if (!config.anthropicKey || !p.value) return null;
  client ??= new Anthropic();
  const m = p.match;
  const pct = (x: number) => +(x * 100).toFixed(1);

  const pack = {
    sport: m.sport, league: m.league, startUtc: m.start.toISOString(), bestOf: m.bestOf, neutralVenue: m.neutral,
    firstSide: m.home, secondSide: m.away,
    fairProbabilitiesPct: p.fair && { source: p.fair.source, first: pct(p.fair.probs.home), second: pct(p.fair.probs.away), draw: pct(p.fair.probs.draw) },
    statsModelPct: { first: pct(p.model.home), second: pct(p.model.away), draw: pct(p.model.draw) },
    flaggedBet: {
      outcome: p.value.side === "home" ? "first side" : p.value.side === "away" ? "second side" : "draw",
      price: p.value.price, bookmaker: p.value.book, fairPrice: +p.value.fairPrice.toFixed(2), expectedValuePct: +p.value.evPct.toFixed(1),
    },
    context: m.context,
  };

  try {
    const params: Record<string, unknown> = {
      model: config.llmModel,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: `Data pack:\n${JSON.stringify(pack)}` }],
    };
    if (supportsFallback(config.llmModel)) {
      // If a safety classifier declines, the API retries on a fallback model in the same call.
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    const res = (await client.beta.messages.create(params as any)) as Anthropic.Beta.BetaMessage;
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
      console.warn(`[ai] ${m.home.name} vs ${m.away.name}: stopped (${res.stop_reason})`);
      return null;
    }
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return JSON.parse(text) as AnalystResult;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) console.error("[ai] invalid ANTHROPIC_API_KEY");
    else if (err instanceof Anthropic.RateLimitError) console.warn("[ai] rate limited; skipping AI for this match");
    else if (err instanceof Anthropic.APIError) console.warn(`[ai] API error ${err.status}: ${err.message}`);
    else console.warn(`[ai] failed: ${(err as Error).message}`);
    return null;
  }
}
