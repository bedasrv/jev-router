// Jev usage accounting: the `usage` object Jev returns per call, reduced to numbers only (never text),
// and a per-day sum over the decision log's `jev` events for the price rebalance.

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const first = (...v) => v.map(num).find((x) => x !== undefined);

// Money is integer nano-USD: a live Jev call costs ~32 µUSD (0.000031962 -> 31962), below µUSD
// precision, and float sums drift. Formatting back to USD happens only in report.mjs.
const nusd = (v) => (num(v) === undefined ? undefined : Math.round(v * 1e9));

// OpenAI-style (prompt_/completion_tokens, prompt_tokens_details.cached_tokens) or Anthropic-style
// (input_/output_tokens, cache_read_input_tokens; the live Jev shape is {input_tokens, output_tokens,
// cost}) names map to one shape.
export function normalizeUsage(u) {
  if (!u || typeof u !== "object" || Array.isArray(u)) return undefined;
  const out = {
    prompt_tokens: first(u.prompt_tokens, u.input_tokens),
    completion_tokens: first(u.completion_tokens, u.output_tokens),
    cached_tokens: first(u.cached_tokens, u.prompt_tokens_details?.cached_tokens, u.input_tokens_details?.cached_tokens, u.cache_read_input_tokens),
    total_tokens: num(u.total_tokens),
    cost_nusd: nusd(u.cost),
    list_cost_nusd: nusd(u.list_cost),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

// A `jev` event's outcome: applied (mode on, confident), unconfident (answered below threshold),
// shadow (confident but only logged), unavailable (no source answered). Rows logged before the field
// existed carry no threshold, so an answered one is only "answered".
export const outcomeOf = (r) => r.outcome ?? (r.ok ? "answered" : "unavailable");

// Every call in one `jev` event that returned usage: the answer plus failed attempts (malformed answer).
const usagesOf = (r) => [r.usage, ...(r.tried ?? []).map((t) => t?.usage)].filter(Boolean);
// The Jev model ids that actually answered in one `jev` event: the answer's served id plus failed attempts that
// named one. Rows from before `served_model` existed (no `requested_model`) only had `jev_model`, set from the
// served id whenever Jev sent one; an attempt then kept its id only next to usage.
export const servedModelsOf = (r) => [
  r.ok ? (r.served_model ?? (r.requested_model === undefined ? r.jev_model : undefined)) : undefined,
  ...(r.tried ?? []).map((t) => t?.served_model ?? (t?.usage ? t.model : undefined)),
].filter((m) => typeof m === "string" && m);
// An attempt cut off by our timeout after the request went out: Jev may still bill it, but no usage came
// back, so the day's cost is a lower bound. Older rows have no `timeout` flag, only the error text.
export const isUnpriced = (t) => !!t && !t.usage && (t.timeout === true || (t.timeout === undefined && /timeout|timed out|aborted/i.test(String(t.error ?? ""))));

export function dailyUsage(rows) {
  const days = {};
  for (const r of rows) {
    if (r?.event !== "jev") continue;
    const day = String(r.t ?? "").slice(0, 10) || "unknown";
    const d = (days[day] ??= { calls: 0, answered: 0, outcomes: {}, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cost_nusd: 0, list_cost_nusd: 0, priced: 0, list_priced: 0, unpriced_attempts: 0, served: {} });
    d.calls += 1;
    if (r.ok) d.answered += 1;
    const o = outcomeOf(r); d.outcomes[o] = (d.outcomes[o] ?? 0) + 1;
    for (const m of servedModelsOf(r)) d.served[m] = (d.served[m] ?? 0) + 1;
    for (const u of usagesOf(r)) {
      for (const k of ["prompt_tokens", "completion_tokens", "cached_tokens", "cost_nusd", "list_cost_nusd"]) d[k] += Number.isSafeInteger(u[k]) ? u[k] : 0;
      if (Number.isSafeInteger(u.cost_nusd)) d.priced += 1;
      if (Number.isSafeInteger(u.list_cost_nusd)) d.list_priced += 1;
    }
    d.unpriced_attempts += (r.tried ?? []).filter(isUnpriced).length;
  }
  return Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)));
}
