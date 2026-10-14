import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPolicyLoader } from "./lib/policy.mjs";
import { createFacts } from "./lib/facts.mjs";
import { inspectRequest } from "./lib/eligibility.mjs";
import { buildList, eligibleIds } from "./lib/builder.mjs";
import { createJev, buildPayload, askText } from "./lib/jev.mjs";
import { conversationKey, isFresh, createSessions, hash } from "./lib/sessions.mjs";
import { createLog } from "./lib/decision-log.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DEADLINE_MS = 3500; // OmniRoute kills the child at 5 s and never respawns it
const POOLS = new Set(["free", "paid"]);

export function createRouter({ policyFile = process.env.JEV_POLICY_FILE ?? path.join(DIR, "policy.json"), facts, jev, now = Date.now } = {}) {
  let log = () => {};
  const loadPolicy = createPolicyLoader(policyFile, (r) => log(r));
  const factsSrc = facts ?? createFacts({ log: (r) => log(r) });
  const sessions = createSessions();
  const jevClient = jev ?? createJev();

  // Jev: shadow = ask in the background and only log; on = wait (<= deadline) and lead with a confident pick.
  function jevStep({ ctx, pool, policy, f, req, body, key, fresh, staticHead }) {
    const cfg = policy.jev;
    if (!cfg || cfg.mode === "off" || !cfg.mode || !fresh) return null;
    const cap = cfg.max_shown?.[pool] ?? (pool === "paid" ? 12 : 8);
    const shown = eligibleIds({ pool, policy, facts: f, req }).main.slice(0, cap);
    if (shown.length < 2) return null;
    const payload = buildPayload({ pool, ask: askText(body), req, shown, facts: f, policy });
    const p = jevClient.ask(cfg, payload).then((res) => {
      const pick = res.ok ? shown[res.index] : null;
      const thr = cfg.threshold ?? 0.5;
      // opt-in labelling aid: a short ask excerpt for turns where Jev disagrees with the static head
      if (cfg.sample_file && res.ok && pick !== staticHead) {
        createLog(path.resolve(path.dirname(policyFile), cfg.sample_file))({ id: ctx.requestId ?? null, pool, ask: payload.state.ask.slice(0, cfg.sample_chars ?? 300), tools: req.usesTools,
          static_head: staticHead, jev_pick: pick, confidence: Number(res.confidence.toFixed(3)), shown: shown.map((id, n) => ({ id, desc: payload.state.candidates[n].description })) });
      }
      log({ event: "jev", id: ctx.requestId ?? null, mode: cfg.mode, pool, conv: hash(key), ok: res.ok, source: res.source, latency_ms: res.latency_ms, shown,
        pick, confidence: res.ok ? Number(res.confidence.toFixed(3)) : undefined, probabilities: res.ok ? res.probabilities : undefined,
        static_head: staticHead, differs: res.ok ? pick !== staticHead : undefined, would_apply: res.ok ? res.confidence >= thr && pick !== staticHead : undefined,
        tried: res.ok && !res.tried.length ? undefined : res.tried });
      return { res, pick, thr };
    }).catch((e) => { log({ event: "jev_error", error: String(e?.message ?? e) }); return null; });
    return { mode: cfg.mode, promise: p };
  }

  async function decide(ctx) {
    const pool = ctx.model;
    if (!POOLS.has(pool)) return undefined;
    const policy = loadPolicy();
    if (!policy) return undefined;
    log = createLog(policy.log_file ? path.resolve(path.dirname(policyFile), policy.log_file) : null);
    const body = ctx.body ?? {};
    const req = inspectRequest(body);
    const key = conversationKey(ctx.headers, body);
    const fresh = isFresh(body);
    const prev = fresh ? null : sessions.get(key, now());
    const f = factsSrc.get(policy);
    let preferred = prev?.head ?? null;
    let { models, excluded, nofit } = buildList({ pool, policy, facts: f, req, preferred });
    let jevInfo;
    const step = models.length ? jevStep({ ctx, pool, policy, f, req, body, key, fresh, staticHead: models[0] }) : null;
    if (step?.mode === "on") {
      const out = await step.promise;
      if (out?.res.ok && out.res.confidence >= out.thr) {
        ({ models, excluded, nofit } = buildList({ pool, policy, facts: f, req, preferred: out.pick }));
        jevInfo = { applied: out.pick, confidence: Number(out.res.confidence.toFixed(3)) };
      }
    }
    if (!models.length) return undefined;
    sessions.set(key, { head: models[0] }, now());
    log({
      event: "decision", id: ctx.requestId ?? null, pool, conv: hash(key), fresh, est_tokens: req.tokens, reserve: req.reserve,
      tools: req.usesTools, images: req.images, nofit, excluded: excluded.length ? excluded : undefined, models, jev: jevInfo, jev_mode: step?.mode,
    });
    return { models, reason: `${jevInfo ? "jev" : "static"}:${pool}${fresh ? "" : ":cont"}` };
  }

  // Fail-open with a hard deadline: return nothing rather than reach OmniRoute's kill path.
  async function onRoute(ctx) {
    try {
      return await Promise.race([
        decide(ctx),
        new Promise((res) => setTimeout(() => res(undefined), DEADLINE_MS).unref?.()),
      ]);
    } catch (e) {
      log({ event: "error", error: String(e?.message ?? e) });
      return undefined;
    }
  }
  return { onRoute, decide };
}

const router = createRouter();
export const onRoute = router.onRoute;
