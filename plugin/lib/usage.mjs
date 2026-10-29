// Jev usage accounting: the `usage` object Jev returns per call, reduced to numbers only (never text),
// and a per-day sum over the decision log's `jev` events for the price rebalance.

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const first = (...v) => v.map(num).find((x) => x !== undefined);

// OpenAI-style (prompt_/completion_tokens, prompt_tokens_details.cached_tokens) or Anthropic-style
// (input_/output_tokens, cache_read_input_tokens) names map to one shape; cost/list_cost as given.
export function normalizeUsage(u) {
  if (!u || typeof u !== "object" || Array.isArray(u)) return undefined;
  const out = {
    prompt_tokens: first(u.prompt_tokens, u.input_tokens),
    completion_tokens: first(u.completion_tokens, u.output_tokens),
    cached_tokens: first(u.cached_tokens, u.prompt_tokens_details?.cached_tokens, u.input_tokens_details?.cached_tokens, u.cache_read_input_tokens),
    total_tokens: num(u.total_tokens),
    cost: num(u.cost),
    list_cost: num(u.list_cost),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

// A `jev` event's outcome: applied (mode on, confident), unconfident (answered below threshold),
// shadow (confident but only logged), unavailable (no source answered). Rows logged before the field
// existed carry no threshold, so an answered one is only "answered".
export const outcomeOf = (r) => r.outcome ?? (r.ok ? "answered" : "unavailable");

// Every billed call in one `jev` event: the answer plus failed attempts that still returned usage.
const usagesOf = (r) => [r.usage, ...(r.tried ?? []).map((t) => t?.usage)].filter(Boolean);

export function dailyUsage(rows) {
  const days = {};
  for (const r of rows) {
    if (r?.event !== "jev") continue;
    const day = String(r.t ?? "").slice(0, 10) || "unknown";
    const d = (days[day] ??= { calls: 0, answered: 0, outcomes: {}, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cost: 0, list_cost: 0, priced: 0, models: {} });
    d.calls += 1;
    if (r.ok) d.answered += 1;
    const o = outcomeOf(r); d.outcomes[o] = (d.outcomes[o] ?? 0) + 1;
    if (r.jev_model) d.models[r.jev_model] = (d.models[r.jev_model] ?? 0) + 1;
    for (const u of usagesOf(r)) {
      for (const k of ["prompt_tokens", "completion_tokens", "cached_tokens", "cost", "list_cost"]) d[k] += num(u[k]) ?? 0;
      if (num(u.cost) !== undefined || num(u.list_cost) !== undefined) d.priced += 1;
    }
  }
  return Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)));
}
