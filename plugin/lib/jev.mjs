import fs from "node:fs";

// Jev (TypeSafe classifier) client: one batched `choice` question over a shortlist, priority failover
// across sources, per-source cooldown, an overall deadline. Never throws: returns {ok:false,error}.

const windowClass = (ctx) => (ctx >= 700000 ? "huge context window" : ctx >= 300000 ? "large context window" : "standard context window");

// Fixed phrases, never numbers (Jev is weak on numerics): traits text from policy + a window class.
export function describeCandidate(id, f, traits) {
  const t = (traits ?? "general purpose model").replace(/[0-9]/g, "").replace(/\s+/g, " ").trim();
  const ctx = Number.isFinite(f?.context_length) ? f.context_length : 0;
  return `${t}; ${windowClass(ctx)}`;
}

// The task text: the user message(s) after the last assistant message (clients such as opencode
// append a synthetic trailing user message, so "the last user message" alone can be the wrong one).
export function askText(body, max = 1200) {
  const msgs = body?.messages ?? [];
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i]?.role !== "assistant") i--;
  const txt = (m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.filter((p) => p?.type === "text").map((p) => p.text).join(" ") : "");
  return msgs.slice(i + 1).filter((m) => m?.role === "user").map(txt).join("\n").slice(0, max);
}

export function buildPayload({ pool, ask, req, shown, facts, policy }) {
  const candidates = shown.map((id, n) => ({ id: `c${n + 1}`, description: describeCandidate(id, facts[id], policy.models?.[id]?.traits) }));
  const criteria = Object.fromEntries(candidates.map((c) => [c.id, c.description]));
  return {
    state: { ask, pool, context: { chars: req.tokens * 4, has_image: req.images > 0, uses_tools: req.usesTools }, candidates },
    questions: { model: { type: "choice", instructions: "Pick the specialist that can fully complete this request in one pass. Judge required reasoning, scope, ambiguity, tool use and blast radius, not requested answer length. If two fit, pick the cheaper one.", criteria } },
  };
}

// (pmax - 1/n) / (1 - 1/n): published exact formula, 1 = all mass on one option, 0 = even split.
export const confidence = (probs) => {
  const v = Object.values(probs ?? {}).map(Number);
  const n = v.length;
  return n > 1 ? (Math.max(...v) - 1 / n) / (1 - 1 / n) : 1;
};

export function createJev({ fetchImpl = fetch, readFile = (f) => fs.readFileSync(f, "utf8"), now = Date.now } = {}) {
  const health = new Map(); // source name -> {fails, until}
  const cool = (name) => {
    const h = health.get(name) ?? { fails: 0, until: 0 };
    h.fails += 1;
    if (h.fails >= 3) h.until = now() + Math.min(6 * 3600e3, 600e3 * 2 ** (h.fails - 3));
    health.set(name, h);
  };
  const keyOf = (src) => {
    if (!src.key_file) return src.key ?? "";
    const raw = readFile(src.key_file).trim();
    if (!src.key_var) return raw;
    return (raw.match(new RegExp(`^\\s*${src.key_var}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  };

  async function ask(cfg, payload) {
    const t0 = now(), budget = cfg.deadline_ms ?? 3000, tried = [];
    for (const src of cfg.sources ?? []) {
      const left = budget - (now() - t0);
      if (left <= 50) break;
      if ((health.get(src.name)?.until ?? 0) > now()) { tried.push({ source: src.name, error: "cooling" }); continue; }
      const ts = now();
      try {
        const headers = { "content-type": "application/json" };
        const key = keyOf(src);
        if (key) headers.authorization = "Bearer " + key;
        const r = await fetchImpl(src.url, { method: "POST", headers, body: JSON.stringify({ ...payload, model: src.model }), signal: AbortSignal.timeout(Math.min(cfg.source_timeout_ms ?? 1200, left)) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const a = (await r.json())?.answers?.model;
        const ids = payload.state.candidates.map((c) => c.id);
        if (!a || !ids.includes(a.choice) || typeof a.probabilities !== "object") throw new Error("malformed answer");
        health.delete(src.name);
        return { ok: true, source: src.name, latency_ms: now() - ts, choice: a.choice, index: ids.indexOf(a.choice), probabilities: a.probabilities, confidence: confidence(a.probabilities), tried };
      } catch (e) {
        cool(src.name); tried.push({ source: src.name, error: String(e?.message ?? e), latency_ms: now() - ts });
      }
    }
    return { ok: false, error: "no source answered", tried };
  }
  return { ask, health };
}
