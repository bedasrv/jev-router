import fs from "node:fs";
import crypto from "node:crypto";
import { ABSTRACT_LEVELS, thinkingPhrase } from "./thinking.mjs";
import { normalizeUsage } from "./usage.mjs";

// Jev (TypeSafe classifier) client: one batched `choice` question over a shortlist, priority failover
// across sources, per-source cooldown, an overall deadline. Never throws: returns {ok:false,error}.

const windowClass = (ctx) => (ctx >= 700000 ? "huge context window" : ctx >= 300000 ? "large context window" : "standard context window");
const words = (t) => String(t).replace(/[0-9]/g, "").replace(/\s+/g, " ").trim();

// Fixed phrases, never numbers (Jev is weak on numerics). A model with `good_at` in the policy is
// described as a structured option (what it is good at, where it is weak, what it costs, at which thinking
// setting it was measured); otherwise the older one-line `traits` text is used.
export function describeCandidate(id, f, m) {
  const meta = typeof m === "string" ? { traits: m } : (m ?? {});
  const ctx = Number.isFinite(f?.context_length) ? f.context_length : 0;
  const thinking = thinkingPhrase(meta.thinking ?? f?.thinking);
  if (!meta.good_at) return `${words(meta.traits ?? "general purpose model")}; ${windowClass(ctx)}; ${thinking}`;
  const out = { good_at: words(meta.good_at) };
  if (meta.weak_at) out.weak_at = words(meta.weak_at);
  out.cost = words(meta.cost ?? "unknown cost");
  if (meta.measured) out.measured = words(meta.measured);
  out.context = windowClass(ctx);
  out.thinking = thinking;
  return out;
}

// The description rules (jev-prompt-v2): Jev reads each option on its own, so a description names no model, holds
// no digits, says what the model does rather than what it does not, and never points at another option; cost is one
// relative word from the Go list prices. Returns the problems, [] when the description is clean.
export const COST_WORDS = ["cheapest", "standard", "pricier", "free"];
const NAMES = /\b(deepseek|glm|qwen|mimo|muse|luna|gpt|kimi|grok|claude|haiku|sonnet|opus|beam|minimax|ling|nemotron|longcat|iceman|gemini|llama|mistral|openai|anthropic|meta|xiaomi|zhipu|alibaba)\b/i;
const NEGATION = /\b(not|no|never|none|nothing|without|cannot|avoid|lacks?|neither|nor|unable)\b|n't\b/i;
const OTHERS = /\b(than|others?|another|best|worst|most|least|stronger|weaker|better|worse|faster|slower|cheaper|costlier|next|instead|rest|alternatives?|options?|step up)\b/i;
export function descriptionProblems(meta, ids = []) {
  const out = [];
  const families = ids.map((id) => String(id).split("/").at(-1).split(/[-.]/)[0].replace(/[0-9]+$/, "").toLowerCase()).filter((x) => x.length > 2);
  for (const field of ["good_at", "weak_at", "measured"]) {
    const t = meta?.[field];
    if (t === undefined) continue;
    if (typeof t !== "string" || !t.trim()) { out.push(`${field}: empty`); continue; }
    if (/[0-9]/.test(t)) out.push(`${field}: digits`);
    const name = t.match(NAMES)?.[0] ?? families.find((f) => new RegExp(`\\b${f}`, "i").test(t));
    if (name) out.push(`${field}: names a model (${name})`);
    const neg = t.match(NEGATION)?.[0]; if (neg) out.push(`${field}: negation (${neg})`);
    const oth = t.match(OTHERS)?.[0]; if (oth) out.push(`${field}: refers to other options (${oth})`);
  }
  if (!meta?.good_at) out.push("good_at: missing");
  if (!COST_WORDS.includes(meta?.cost)) out.push(`cost: one of ${COST_WORDS.join("|")}`);
  return out;
}

// The task text: the user message(s) after the last assistant message (clients such as opencode
// append a synthetic trailing user message, so "the last user message" alone can be the wrong one).
// A long ask keeps its head and its tail (where the actual question usually is, after pasted text).
export function askText(body, head = 600, tail = 600) {
  const msgs = body?.messages ?? [];
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i]?.role !== "assistant") i--;
  const txt = (m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.filter((p) => p?.type === "text").map((p) => p.text).join(" ") : "");
  const t = msgs.slice(i + 1).filter((m) => m?.role === "user").map(txt).join("\n");
  return t.length <= head + tail ? t : `${t.slice(0, head)}\n...\n${t.slice(-tail)}`;
}

// Facts about the request that code knows, as named fields (no prose): who sent it, whether it brings its own
// system prompt, how many tools. API calls of the app are stateless and carry the session id `v<voucher>`
// (warslop API-12a), so jev.api_session_pattern tells them from the chat app's conversations.
export function requestSource(headers, cfg) {
  const name = (cfg?.session_header ?? "x-opencode-session").toLowerCase();
  const v = [Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1]].flat()[0];
  let re; try { re = new RegExp(cfg?.api_session_pattern ?? "^v[0-9]+$"); } catch { re = /^v[0-9]+$/; }
  return typeof v === "string" && re.test(v) ? "API client" : "chat app";
}
export const toolsWord = (n) => (!n ? "none" : n <= 8 ? "few" : "many");
const hasSystem = (body) => (body?.messages ?? []).some((m) => m?.role === "system" || m?.role === "developer");

// The order the options are shown in, shuffled per call but the same for the same request id: Jev favours the
// first option (TypeSafe, jev-1.13), so a fixed order would turn that bias into a fixed pick.
export function shuffleFor(ids, seed) {
  if (seed === undefined || seed === null || ids.length < 2) return [...ids];
  let x = crypto.createHash("sha256").update(String(seed)).digest().readUInt32LE(0) || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

const sizeWords = (tokens) => (tokens > 60000 ? "very long conversation or large attached text" : tokens > 8000 ? "long conversation" : tokens > 1500 ? "medium conversation" : "short conversation");

// One Choice question. The options are the shortlist (ids c1..cn in a shuffled order, never model names); the
// state is the request plus facts code knows, as named fields. There is no tie-break: when several options fit,
// Jev's answer is spread, confidence is low, and code keeps the default (the configured head, or the conversation's
// previous model).
export const INSTRUCTIONS = {
  question: "Which model should answer this request?",
  goal: "The answer must be complete and correct in one pass.",
  judge: [
    "how much reasoning, knowledge, writing quality or code the request really needs",
    "whether it needs tool use such as running code or working with files",
    "how much harm a wrong or sloppy answer would do",
  ],
  ignore: "how long the answer is asked to be",
};

export const EFFORT_INSTRUCTIONS = {
  question: "How much thinking should the chosen model do for this request?",
  goal: "Pick the lowest tier that still lets the model complete the request correctly in one pass; normal is the provider default.",
  ignore: "how long the answer is asked to be",
  tie_break: "when unsure between two adjacent tiers, choose the lower one; frontier is rare",
};

export const EFFORT_CRITERIA = {
  trivial: "no real reasoning: greetings, small talk, a single lookup, or a direct rewrite",
  normal: "everyday thinking: ordinary writing and reasoning, standard coding, explanations, summaries; leave the model at its default",
  hard: "hard thinking: difficult multi-step code, maths, proofs, long agentic work, high-stakes or ambiguous requests",
  frontier: "the hardest work where the model should use its top thinking level; not for ordinary hard tasks",
};

// `order` is the shortlist as shown (c1 = order[0]); `seed` (the request id) fixes the shuffle; `previous` is the
// conversation's last decision {head, effort} on a new turn of an existing conversation: its option id and its
// thinking tier, so Jev can weigh staying (the prompt cache) against switching through facts, not prose.
export function buildPayload({ ask, req, shown, facts, policy, seed, previous = null, source = "chat app", body = null }) {
  const order = shuffleFor(shown, seed);
  const ids = order.map((_, n) => `c${n + 1}`);
  const criteria = Object.fromEntries(order.map((id, n) => [ids[n], describeCandidate(id, facts[id], policy.models?.[id])]));
  const prevAt = previous?.head ? order.indexOf(previous.head) : -1;
  return {
    ids,
    order,
    effortChoices: [...ABSTRACT_LEVELS],
    state: {
      request: ask,
      source,
      system_prompt: (body ? hasSystem(body) : !!req.system) ? "present" : "absent",
      tools: toolsWord(req.toolCount ?? (req.usesTools ? 1 : 0)),
      has_image: req.images > 0 ? "yes" : "no",
      size: sizeWords(req.tokens),
      ...(previous ? { conversation: "follow-up turn" } : {}),
      ...(prevAt >= 0 ? { previous_model: ids[prevAt] } : {}),
      ...(previous?.effort ? { previous_tier: previous.effort } : {}),
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
      let usage, served, model = src.model;
      try {
        const headers = { "content-type": "application/json" };
        const key = keyOf(src);
        if (key) headers.authorization = "Bearer " + key;
        const r = await fetchImpl(src.url, { method: "POST", headers, body: JSON.stringify({ model: src.model, state: payload.state, questions: payload.questions }), signal: AbortSignal.timeout(Math.min(cfg.source_timeout_ms ?? 1200, left)) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        // Usage and the served model id are numbers and an id only; a failed parse still bills, so keep it.
        usage = normalizeUsage(j?.usage);
        // `served_model` is only what Jev answered with; `model` falls back to the configured alias (`jev_model`).
        if (typeof j?.model === "string" && j.model) model = served = j.model.slice(0, 120);
        const answers = j?.answers;
        const a = answers?.model, e = answers?.effort;
        const ids = payload.ids;
        if (!a || !ids.includes(a.choice) || typeof a.probabilities !== "object") throw new Error("malformed model answer");
        if (!e || !ABSTRACT_LEVELS.includes(e.choice)) throw new Error("malformed effort answer");
        health.delete(src.name);
        return {
          ok: true, source: src.name, model, requested_model: src.model, ...(served ? { served_model: served } : {}), latency_ms: now() - ts, ...(usage ? { usage } : {}),
          choice: a.choice, index: ids.indexOf(a.choice), probabilities: a.probabilities, confidence: confidence(a.probabilities),
          effort: e.choice,
          ...(e.probabilities && typeof e.probabilities === "object" ? { effort_probabilities: e.probabilities, effort_confidence: confidence(e.probabilities) } : {}),
          tried,
        };
      } catch (e) {
        cool(src.name); // timeout: aborted by source_timeout_ms after the request was sent, so possibly billed with no usage
        const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
        tried.push({ source: src.name, error: String(e?.message ?? e), latency_ms: now() - ts, ...(timeout ? { timeout } : {}), ...(served ? { served_model: served } : {}), ...(usage ? { model, usage } : {}) });
      }
    }
    return { ok: false, error: "no source answered", latency_ms: now() - t0, tried };
  }
  return { ask, health };
}
