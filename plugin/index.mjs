import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPolicyLoader } from "./lib/policy.mjs";
import { createFacts } from "./lib/facts.mjs";
import { inspectRequest } from "./lib/eligibility.mjs";
import { buildList, eligibleIds } from "./lib/builder.mjs";
import { createJev, buildPayload, askText } from "./lib/jev.mjs";
import { applyThinkingToList } from "./lib/thinking.mjs";
import { createHealth } from "./lib/health.mjs";
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
  let health = createHealth({ now, log: (r) => log(r) });
  let healthCfg = "";

  // Jev: shadow = ask in the background and only log; on = wait (<= deadline) and lead with a confident pick.
  function jevStep({ ctx, pool, policy, f, req, body, key, fresh, staticHead }) {
    const cfg = policy.jev;
    if (!cfg || cfg.mode === "off" || !cfg.mode || !fresh) return null;
    const cap = cfg.max_shown?.[pool] ?? (pool === "paid" ? 12 : 8);
    const el = eligibleIds({ pool, policy, facts: f, req, health });
    const shown = el.main.filter((id) => !el.cooling.includes(id)).slice(0, cap);
    if (shown.length < 2) return null;
    const payload = buildPayload({ pool, ask: askText(body), req, shown, facts: f, policy });
    const p = jevClient.ask(cfg, payload).then((res) => {
      const pick = res.ok ? shown[res.index] : null;
      const thr = cfg.threshold ?? 0.5;
      // opt-in labelling aid: a short ask excerpt for turns where Jev disagrees with the static head
      if (cfg.sample_file && res.ok && pick !== staticHead) {
        createLog(path.resolve(path.dirname(policyFile), cfg.sample_file))({ id: ctx.requestId ?? null, pool, ask: payload.state.request.slice(0, cfg.sample_chars ?? 300), tools: req.usesTools,
          static_head: staticHead, jev_pick: pick, confidence: Number(res.confidence.toFixed(3)), shown: shown.map((id, n) => ({ id, desc: payload.questions.model.criteria[payload.ids[n]] })) });
      }
      log({ event: "jev", id: ctx.requestId ?? null, mode: cfg.mode, pool, conv: hash(key), ok: res.ok, source: res.source, latency_ms: res.latency_ms, shown,
        pick, effort: res.ok ? res.effort : undefined, effort_confidence: res.ok ? res.effort_confidence : undefined,
        confidence: res.ok ? Number(res.confidence.toFixed(3)) : undefined, probabilities: res.ok ? res.probabilities : undefined,
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
    syncHealth(policy);
    const body = ctx.body ?? {};
    const req = inspectRequest(body);
    const key = conversationKey(ctx.headers, body);
    const fresh = isFresh(body);
    const prev = fresh ? null : sessions.get(key, now());
    const f = factsSrc.get(policy);
    let preferred = prev?.head ?? null;
    let { models, excluded, nofit, cooling } = buildList({ pool, policy, facts: f, req, preferred, health });
    let jevInfo;
    let desiredEffort = null, effortSource = null;
    const step = models.length ? jevStep({ ctx, pool, policy, f, req, body, key, fresh, staticHead: models[0] }) : null;
    if (step?.mode === "on") {
      const out = await step.promise;
      if (out?.res.ok && out.res.confidence >= out.thr) {
        ({ models, excluded, nofit, cooling } = buildList({ pool, policy, facts: f, req, preferred: out.pick, health }));
        jevInfo = { applied: out.pick, confidence: Number(out.res.confidence.toFixed(3)), effort: out.res.effort };
        // Effort is a paid-pool decision. Free still logs Jev's answer but never applies it.
        if (pool === "paid") { desiredEffort = out.res.effort; effortSource = "jev"; }
      }
    }

    // One abstract need per request; the head model decides the native value and the fallback
    // list keeps only models where the exact same control+value applies. Continuations reuse the
    // fresh task's need; a paid turn with no Jev answer falls back to normal (the provider default).
    if (pool === "paid" && policy.jev?.mode === "on") {
      if (!desiredEffort && !fresh && prev?.effort) { desiredEffort = prev.effort; effortSource = "session"; }
      if (!desiredEffort) { desiredEffort = "normal"; effortSource = "default"; }
    }
    let effortInfo = null;
    if (desiredEffort) {
      const plan = applyThinkingToList({ models, abstract: desiredEffort, policy });
      models = plan.models;
      effortInfo = {
        source: effortSource, need: desiredEffort, abstract: desiredEffort, model: models[0],
        applied: plan.applied, control: plan.applied?.control ?? null, native: plan.applied?.native ?? null,
        native_tier: plan.applied?.native ?? null,
        clamped: !!plan.clamped, omitted: !!plan.omitted, reason: plan.reason ?? undefined,
        dropped: plan.dropped?.length ? plan.dropped : undefined,
      };
      if (jevInfo) {
        jevInfo.effort_applied = plan.applied ?? null;
        jevInfo.effort_clamped = !!plan.clamped;
        jevInfo.effort_omitted = !!plan.omitted;
      }
    } else if (pool === "free") {
      effortInfo = { source: "free", need: null, abstract: null, model: models[0], applied: null, control: null, native: null, native_tier: null, clamped: false, omitted: true, reason: "free_pool" };
    }

    if (!models.length) return undefined;
    sessions.set(key, { head: models[0], effort: desiredEffort ?? null }, now());
    log({
      event: "decision", id: ctx.requestId ?? null, pool, conv: hash(key), fresh, est_tokens: req.tokens, reserve: req.reserve,
      tools: req.usesTools, images: req.images, nofit, excluded: excluded.length ? excluded : undefined, models, jev: jevInfo, jev_mode: step?.mode, effort: effortInfo, demoted: cooling?.length ? cooling : undefined,
    });
    // Response-header provenance (patch 0007): reason is jev | static[:cont]; confidence
    // only when Jev's pick was applied. The pool itself is already the request model.
    return {
      models,
      reason: jevInfo ? "jev" : fresh ? "static" : "static:cont",
      ...(jevInfo ? { confidence: jevInfo.confidence } : {}),
      // Applied native control, or an explicit none/clear when normal/free/no mapping wins.
      ...(effortInfo ? { thinking: effortInfo.applied ?? { control: "none" } } : {}),
    };
  }

  // Health knobs live in policy.health; changing them keeps what was learned (only the thresholds change).
  function syncHealth(policy) {
    const key = JSON.stringify(policy.health ?? {});
    if (key !== healthCfg) { healthCfg = key; health = createHealth({ now, cfg: policy.health ?? {}, log: (r) => log(r), prev: health }); }
  }

  // onRouteResult: OmniRoute tells us how each of our picks went. One-way; must never throw.
  function onRouteResult(payload) {
    try {
      if (!payload || !Array.isArray(payload.attempts)) return;
      const before = Object.keys(health.snapshot()).length;
      health.record(payload);
      const bad = payload.attempts.filter((a) => !a.ok);
      log({ event: "result", id: payload.requestId ?? null, pool: payload.model, status: payload.status,
        attempts: payload.attempts.map((a) => ({ m: a.model, ok: a.ok, s: a.status, k: a.kind, ms: a.latencyMs })),
        skipped: payload.skipped?.length ? payload.skipped : undefined,
        cooling: Object.keys(health.snapshot()).length !== before || bad.length ? health.snapshot() : undefined });
    } catch (e) { log({ event: "error", error: String(e?.message ?? e) }); }
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
  return { onRoute, onRouteResult, decide, health: () => health };
}

const router = createRouter();
export const onRoute = router.onRoute;
export const onRouteResult = router.onRouteResult;
