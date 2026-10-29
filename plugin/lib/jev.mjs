import fs from "node:fs";
import { ABSTRACT_LEVELS, thinkingPhrase } from "./thinking.mjs";
import { normalizeUsage } from "./usage.mjs";

// Jev (TypeSafe classifier) client: one batched `choice` question over a shortlist, priority failover
// across sources, per-source cooldown, an overall deadline. Never throws: returns {ok:false,error}.

const windowClass = (ctx) => (ctx >= 700000 ? "huge context window" : ctx >= 300000 ? "large context window" : "standard context window");
const words = (t) => String(t).replace(/[0-9]/g, "").replace(/\s+/g, " ").trim();

// Fixed phrases, never numbers (Jev is weak on numerics). A model with `good_at` in the policy is
// described as a structured option (what it is good at, where it is weak, what it costs); otherwise
// the older one-line `traits` text is used.
export function describeCandidate(id, f, m) {
  const meta = typeof m === "string" ? { traits: m } : (m ?? {});
  const ctx = Number.isFinite(f?.context_length) ? f.context_length : 0;
  const thinking = thinkingPhrase(meta.thinking ?? f?.thinking);
  if (!meta.good_at) return `${words(meta.traits ?? "general purpose model")}; ${windowClass(ctx)}; ${thinking}`;
  const out = { good_at: words(meta.good_at) };
  if (meta.weak_at) out.weak_at = words(meta.weak_at);
  out.cost = words(meta.cost ?? "unknown cost");
  out.context = windowClass(ctx);
  out.thinking = thinking;
  return out;
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

const sizeWords = (tokens) => (tokens > 60000 ? "very long conversation or large attached text" : tokens > 8000 ? "long conversation" : tokens > 1500 ? "medium conversation" : "short conversation");

// One Choice question. The options are the shortlist (ids c1..cn, never model names); the state is the
// guest's request plus facts code knows (tools, images, size in words).
export const INSTRUCTIONS = {
  question: "Which model should answer this request from a cafe guest?",
  goal: "The answer must be complete and correct in one pass. Guests usually write Indonesian and expect fluent, natural Indonesian back.",
  judge: [
    "how much reasoning, knowledge, writing quality or code the request really needs",
    "whether it needs tool use such as running code or working with files",
    "how much harm a wrong or sloppy answer would do",
  ],
  ignore: "how long the guest wants the answer to be",
  tie_break: "If several options can fully do it, pick the one that costs less: included in the subscription costs less than pay per use.",
};

export const EFFORT_INSTRUCTIONS = {
  question: "How much thinking should the chosen model do for this request?",
  goal: "Pick the lowest tier that still lets the model complete the request correctly in one pass; normal is the provider default.",
  ignore: "how long the guest wants the answer to be",
  tie_break: "when unsure between two adjacent tiers, choose the lower one; frontier is rare",
};

export const EFFORT_CRITERIA = {
  trivial: "no real reasoning: greetings, small talk, a single lookup, or a direct rewrite",
  normal: "everyday thinking: ordinary writing and reasoning, standard coding, explanations, summaries; leave the model at its default",
  hard: "hard thinking: difficult multi-step code, maths, proofs, long agentic work, high-stakes or ambiguous requests",
  frontier: "the hardest work where the model should use its top thinking level; not for ordinary hard tasks",
};

export function buildPayload({ pool, ask, req, shown, facts, policy }) {
  const ids = shown.map((_, n) => `c${n + 1}`);
  const criteria = Object.fromEntries(shown.map((id, n) => [ids[n], describeCandidate(id, facts[id], policy.models?.[id])]));
  return {
    ids,
    effortChoices: [...ABSTRACT_LEVELS],
    state: {
      request: ask,
      pool: pool === "paid" ? "premium (paid) guest" : "free guest",
      needs_tools: req.usesTools ? "yes, the request comes with tools the model may call" : "no",
      has_image: req.images > 0 ? "yes" : "no",
      size: sizeWords(req.tokens),
    },
    questions: {
      model: { type: "choice", instructions: INSTRUCTIONS, criteria },
      effort: { type: "choice", instructions: EFFORT_INSTRUCTIONS, criteria: EFFORT_CRITERIA },
    },
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
      let usage, model = src.model;
      try {
        const headers = { "content-type": "application/json" };
        const key = keyOf(src);
        if (key) headers.authorization = "Bearer " + key;
        const r = await fetchImpl(src.url, { method: "POST", headers, body: JSON.stringify({ model: src.model, state: payload.state, questions: payload.questions }), signal: AbortSignal.timeout(Math.min(cfg.source_timeout_ms ?? 1200, left)) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        // Usage and the served model id are numbers and an id only; a failed parse still bills, so keep it.
        usage = normalizeUsage(j?.usage);
        if (typeof j?.model === "string" && j.model) model = j.model.slice(0, 120);
        const answers = j?.answers;
        const a = answers?.model, e = answers?.effort;
        const ids = payload.ids;
        if (!a || !ids.includes(a.choice) || typeof a.probabilities !== "object") throw new Error("malformed model answer");
        if (!e || !ABSTRACT_LEVELS.includes(e.choice)) throw new Error("malformed effort answer");
        health.delete(src.name);
        return {
          ok: true, source: src.name, model, latency_ms: now() - ts, ...(usage ? { usage } : {}),
          choice: a.choice, index: ids.indexOf(a.choice), probabilities: a.probabilities, confidence: confidence(a.probabilities),
          effort: e.choice,
          ...(e.probabilities && typeof e.probabilities === "object" ? { effort_probabilities: e.probabilities, effort_confidence: confidence(e.probabilities) } : {}),
          tried,
        };
      } catch (e) {
        cool(src.name); // timeout: aborted by source_timeout_ms after the request was sent, so possibly billed with no usage
        const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
        tried.push({ source: src.name, error: String(e?.message ?? e), latency_ms: now() - ts, ...(timeout ? { timeout } : {}), ...(usage ? { model, usage } : {}) });
      }
    }
    return { ok: false, error: "no source answered", latency_ms: now() - t0, tried };
  }
  return { ask, health };
}
