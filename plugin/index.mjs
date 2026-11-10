import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPolicyLoader } from "./lib/policy.mjs";
import { createFacts } from "./lib/facts.mjs";
import { inspectRequest } from "./lib/eligibility.mjs";
import { buildList, eligibleIds } from "./lib/builder.mjs";
import { createJev, buildPayload, buildMenuPayload, askText, requestSource } from "./lib/jev.mjs";
import { eligibleItems, attemptsFor, stickyChoice, stickyCfg, itemById, hostThinking, thinkingWord, cachedShare, specialistsIn, kindAllows, turnCostRatio } from "./lib/menu.mjs";
import { applyThinkingToList, minFallbacks, toHostThinking } from "./lib/thinking.mjs";
import { createHealth } from "./lib/health.mjs";
import { isSmallTalk } from "./lib/easy.mjs";
import { conversationKey, isFresh, createSessions, hash, headerValue, isApiSession } from "./lib/sessions.mjs";
import { createLog } from "./lib/decision-log.mjs";
import { windowsFor } from "./lib/windows.mjs";

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

  // UP-16: Jev is asked only in the pools policy.jev.pools names (absent = both). The free pool is one route with
  // three thinking values, so its choice buys nothing a guest pays for while every call costs money.
  function jevPool(cfg, pool) {
    const list = cfg?.pools;
    return !Array.isArray(list) || list.includes(pool);
  }

  // Sessions named in jev.skip_sessions (the app's upstream canaries, session "canary") are never sent to Jev:
  // every candidate can answer them, so Jev is unconfident by design and each call is only cost.
  function jevSkipped(cfg, headers) {
    const list = cfg?.skip_sessions;
    if (!Array.isArray(list) || !list.length) return false;
    const v = headerValue(headers, cfg.session_header ?? "x-opencode-session");
    return !!v && list.includes(v);
  }

  // Jev: shadow = ask in the background and only log; on = wait (<= deadline) and lead with a confident pick.
  // jev.hidden: ids Jev is never shown (they stay in the order as fallback routes).
  function jevStep({ ctx, pool, policy, f, req, body, key, fresh, staticHead, previous }) {
    const cfg = policy.jev;
    if (!jevPool(cfg, pool) || !cfg || cfg.mode === "off" || !cfg.mode || !fresh) return null;
    const cap = cfg.max_shown?.[pool] ?? (pool === "paid" ? 12 : 8);
    const hidden = new Set(cfg.hidden ?? []);
    const el = eligibleIds({ pool, policy, facts: f, req, health });
    const shown = el.main.filter((id) => !el.cooling.includes(id) && !hidden.has(id)).slice(0, cap);
    if (shown.length < 2) return null;
    const ask = askText(body);
    const payload = buildPayload({ ask, req, shown, facts: f, policy, seed: ctx.requestId ?? ask, previous, source: requestSource(ctx.headers, cfg) });
    const p = jevClient.ask(cfg, payload).then((res) => {
      const pick = res.ok ? payload.order[res.index] : null;
      const thr = cfg.threshold ?? 0.5;
      // opt-in labelling aid: a short ask excerpt for turns where Jev disagrees with the static head
      if (cfg.sample_file && res.ok && pick !== staticHead) {
        createLog(path.resolve(path.dirname(policyFile), cfg.sample_file))({ id: ctx.requestId ?? null, pool, ask: payload.state.request.slice(0, cfg.sample_chars ?? 300), tools: req.usesTools,
          static_head: staticHead, jev_pick: pick, confidence: Number(res.confidence.toFixed(3)), shown: payload.order.map((id, n) => ({ id, desc: payload.questions.model.criteria[payload.ids[n]] })) });
      }
      const confident = res.ok && res.confidence >= thr;
      const outcome = !res.ok ? "unavailable" : !confident ? "unconfident" : cfg.mode === "on" ? "applied" : "shadow";
      log({ event: "jev", id: ctx.requestId ?? null, mode: cfg.mode, pool, conv: hash(key), ok: res.ok, outcome, source: res.source, jev_model: res.model, served_model: res.served_model, requested_model: res.requested_model, latency_ms: res.latency_ms, usage: res.usage, shown, order: payload.order, state: { source: payload.state.source, system_prompt: payload.state.system_prompt, tools: payload.state.tools, previous_model: payload.state.previous_model, previous_tier: payload.state.previous_tier },
        pick, effort: res.ok ? res.effort : undefined, effort_confidence: res.ok ? res.effort_confidence : undefined,
        confidence: res.ok ? Number(res.confidence.toFixed(3)) : undefined, probabilities: res.ok ? res.probabilities : undefined,
        static_head: staticHead, differs: res.ok ? pick !== staticHead : undefined, would_apply: res.ok ? res.confidence >= thr && pick !== staticHead : undefined,
        tried: res.ok && !res.tried.length ? undefined : res.tried });
      return { res, pick, thr };
    }).catch((e) => { log({ event: "jev_error", error: String(e?.message ?? e) }); return null; });
    return { mode: cfg.mode, promise: p };
  }

  // UP-10c: what each request was sent with, so onRouteResult can say which attempt answered (a backup or the head).
  const sent = new Map();
  const remember = (id, rec) => { if (!id) return; if (sent.size >= 2000) sent.delete(sent.keys().next().value); sent.set(id, rec); };

  /**
   * UP-10c, the menu: one (model + thinking) pair per turn from policy.menu, in both pools. Jev chooses among the
   * eligible items in one question; a confident pick is weighed against the conversation's last item by the sticky
   * rules; otherwise the last item stays, else the pool default. Every attempt carries its own native thinking.
   */
  async function decideMenu(ctx, { pool, policy, body, req, key, fresh, known, api }) {
    // UP-13: the app sends x-warslop-prompt-cache: cold on the first call of a turn whose prefix is being rebuilt
    // (a fold or an idle gap). The miss happens either way, so a switch is free; only this boundary carries the header.
    const coldPrefix = headerValue(ctx.headers, "x-warslop-prompt-cache") === "cold";
    const menu = policy.menu;
    const f = factsSrc.get(policy);
    const deny = policy.denylist ?? [];
    const { items, excluded } = eligibleItems({ menu, pool, facts: f, req, body, health, deny });
    if (!items.length) return undefined; // nothing on the menu can answer: OmniRoute's own combo does
    const ok = new Set(items.map((i) => i.id));
    const def = itemById(menu, menu.defaults?.[pool]);
    const fallback = def && ok.has(def.id) ? def : items[0];
    // The last item counts only in its own pool: one session id can carry both pools (the app's canary does).
    const prevItem = known?.item ? itemById(menu, known.item) : null;
    const last = prevItem?.pool === pool ? prevItem : null;
    const cfg = policy.jev ?? {};
    const thr = menu.threshold ?? cfg.threshold ?? 0.85;
    const shut = !jevPool(cfg, pool); // UP-16: this pool is left out of policy.jev.pools
    const skipped = jevSkipped(cfg, ctx.headers);
    const asking = !!cfg.mode && cfg.mode !== "off" && !shut && !skipped && items.length >= 2;
    let choice, jevInfo, pick = null;

    if (!fresh) {
      // Locked within a turn: a continuation (tool result, agent step) keeps the turn's item without asking Jev.
      choice = last && ok.has(last.id)
        ? { item: last, source: "session", reason: "continuation", streak: known.streak ?? 0 }
        : { item: fallback, source: "default", reason: last ? "continuation_ineligible" : "continuation_unknown", streak: 0 };
    } else if (shut) {
      // UP-16: no choice call on this pool. The pool default answers; the UP-2a small-talk list may still lower the
      // effort, but only within the default item's own model (a lighter pair, never a different model).
      const same = items.filter((i) => i.model === fallback.model);
      const light = same.reduce((a, b) => (b.rank < a.rank ? b : a), same[0]);
      const easy = pool === "free" && !api && light.rank < fallback.rank && isSmallTalk(askText(body));
      choice = { item: easy ? light : fallback, source: "default", reason: easy ? "easy" : "pool_default", streak: 0 };
    } else {
      if (asking) {
        const previous = !api && last ? { item: last.id } : null;
        // Addendum item 9: while a specialist is on offer Jev also names the task kind; a specialist pick stands only when
        // Jev is confident about the kind too and it is one of that specialist's kinds.
        const kinds = specialistsIn(items).length && menu.kinds ? menu.kinds : null;
        const payload = buildMenuPayload({ ask: askText(body), req, items, seed: ctx.requestId ?? askText(body), previous, source: requestSource(ctx.headers, cfg), body, kinds });
        const res = await jevClient.ask(cfg, payload).catch((e) => ({ ok: false, error: String(e?.message ?? e), tried: [] }));
        const picked = res.ok ? itemById(menu, payload.order[res.index]) : null;
        const conf = res.ok ? Number(res.confidence.toFixed(3)) : undefined;
        const kindOk = kindAllows(picked, res.kind, (res.kind_confidence ?? 0) >= thr);
        // Lead 2026-11-05: a fresh pick stands at menu.threshold; leaving the conversation's last item still needs
        // menu.switch_threshold (the stricter rule switches had), so a lower fresh threshold does not make chats jumpy.
        const switching = !!picked && !!previous && picked.id !== last.id;
        const need = switching && !coldPrefix ? Math.max(thr, menu.switch_threshold ?? thr) : thr;
        const held = switching && res.confidence >= thr && res.confidence < need;
        const confident = !!picked && res.confidence >= need && kindOk;
        if (confident && cfg.mode === "on") pick = picked;
        jevInfo = { ok: res.ok, outcome: !res.ok ? "unavailable" : !kindOk && res.confidence >= thr ? "specialist_kind" : held ? "switch_held" : !confident ? "unconfident" : cfg.mode === "on" ? "applied" : "shadow",
          pick: picked?.id, confidence: conf, probabilities: res.ok ? res.probabilities : undefined, order: payload.order,
          ...(kinds && res.ok ? { kind: res.kind, kind_confidence: res.kind_confidence !== undefined ? Number(res.kind_confidence.toFixed(3)) : undefined } : {}),
          source: res.source, jev_model: res.model, latency_ms: res.latency_ms, usage: res.usage, tried: res.tried?.length ? res.tried : undefined };
      }
      // Stateless API calls (session v<voucher>) have no conversation to stick to; each call stands alone.
      choice = api ? (pick ? { item: pick, source: "jev", reason: "api", streak: 0 } : { item: fallback, source: "default", reason: "api", streak: 0 })
        : stickyChoice({ last, pick, ok, fallback, streak: known?.streak ?? 0, cfg: stickyCfg(menu), cold: coldPrefix });
      if (jevInfo && !jevInfo.ok) choice = { ...choice, reason: choice.reason === "unconfident" ? "jev_unavailable" : choice.reason };
      if (skipped) choice = { ...choice, reason: `${choice.reason}:skip_session` };
    }

    const { attempts, skipped: skippedTargets, short } = attemptsFor(choice.item, { menu, facts: f, req, deny, health });
    if (!attempts.length) return undefined;
    sessions.set(key, { item: choice.item.id, head: attempts[0].model, streak: choice.streak }, now());
    const models = attempts.map((a) => a.model);
    const windows = windowsFor(models, f);
    const byModel = Object.fromEntries(attempts.map((a) => [a.model, hostThinking(a.thinking)]));
    const values = new Set(attempts.map((a) => JSON.stringify(a.thinking)));
    const specialist = choice.item.specialist === true;
    remember(ctx.requestId, { item: choice.item.id, specialist, attempts: attempts.map((a) => ({ m: a.model, thinking: thinkingWord(a.thinking), from: a.from })) });
    log({
      event: "decision", menu: true, id: ctx.requestId ?? null, pool, conv: hash(key), fresh, est_tokens: req.tokens, tools: req.usesTools, images: req.images,
      item: choice.item.id, specialist, model: attempts[0].model, thinking: thinkingWord(attempts[0].thinking),
      prompt_cache: coldPrefix ? "cold" : undefined,
      cost_ratio: turnCostRatio(choice.item, { menu, req, body }) ?? undefined,
      attempts: attempts.map((a) => ({ m: a.model, thinking: thinkingWord(a.thinking), from: a.from })),
      source: choice.source, sticky: choice.reason, streak: choice.streak || undefined, last: last?.id,
      confidence: jevInfo?.confidence, jev: jevInfo, excluded: excluded.length ? excluded : undefined,
      jev_skipped: fresh && !asking ? true : undefined,
      skipped: skippedTargets.length ? skippedTargets : undefined, short: short || undefined,
      cached_share: req.tokens ? Math.round(cachedShare(body) * 1000) / 1000 : undefined,
    });
    return {
      models,
      // UP-16: static is a real choice call that did not apply (asked and unconfident/unavailable); static:skip says no
      // call was made (pool left out, mode off, skip session, fewer than two items), so warslop's LIM-8 stops drawing.
      reason: choice.source === "jev" ? "jev" : !fresh ? "static:cont" : asking ? "static" : "static:skip",
      ...(choice.source === "jev" && jevInfo?.confidence !== undefined ? { confidence: jevInfo.confidence } : {}),
      item: choice.item.id,
      specialist, // addendum item 11: the app decides how to show a specialist answer
      // Patch 0010: each attempt's own native value. `thinking` stays for a host without 0010 (0008 writes it into the
      // shared body): the pair's value only when every attempt shares it, else none, so an old host never sends one
      // model's value to another.
      thinking_by_model: byModel,
      thinking: values.size === 1 ? hostThinking(attempts[0].thinking) : { control: "none" },
      // Patch 0011: each dispatch id's own window, so the host can echo the answering route's figures.
      ...(windows ? { windows_by_model: windows } : {}),
    };
  }

  async function decide(ctx) {
    const pool = ctx.model;
    if (!POOLS.has(pool)) return undefined;
    const policy = loadPolicy();
    if (!policy) return undefined;
    log = createLog(policy.log_file ? path.resolve(path.dirname(policyFile), policy.log_file) : null);
    syncHealth(policy);
    if (policy.menu) {
      const body = ctx.body ?? {};
      const key = conversationKey(ctx.headers, body, policy.jev);
      const api = isApiSession(headerValue(ctx.headers, policy.jev?.session_header ?? "x-opencode-session"), policy.jev);
      const fresh = isFresh(body);
      return decideMenu(ctx, { pool, policy, body, req: inspectRequest(body), key, fresh, known: sessions.get(key, now()), api });
    }
    const body = ctx.body ?? {};
    const req = inspectRequest(body);
    const key = conversationKey(ctx.headers, body, policy.jev);
    const fresh = isFresh(body);
    const known = sessions.get(key, now());
    // Stickiness: a continuation keeps the head; with Jev on, a new turn of an existing conversation also keeps the
    // previous model and tier unless Jev is confident in a different one (switching model loses the prompt cache).
    // Stateless API calls (session `v<voucher>`) have no new turns: each fresh call is decided on its own.
    const api = isApiSession(headerValue(ctx.headers, policy.jev?.session_header ?? "x-opencode-session"), policy.jev);
    const sticky = fresh && !!known && !api && policy.jev?.mode === "on";
    const prev = fresh && !sticky ? null : known;
    const f = factsSrc.get(policy);
    let preferred = prev?.head ?? null;
    let { models, excluded, nofit, cooling } = buildList({ pool, policy, facts: f, req, preferred, health });
    let jevInfo;
    let desiredEffort = null, effortSource = null;
    const skipped = jevSkipped(policy.jev, ctx.headers);
    const step = models.length && !skipped ? jevStep({ ctx, pool, policy, f, req, body, key, fresh, staticHead: models[0], previous: fresh && known && !api ? known : null }) : null;
    const asked = !!step; // jevStep returns null when the pool is left out, the mode is off or fewer than two are shown
    if (step?.mode === "on") {
      const out = await step.promise;
      if (out?.res.ok && out.res.confidence >= out.thr) {
        ({ models, excluded, nofit, cooling } = buildList({ pool, policy, facts: f, req, preferred: out.pick, health }));
        jevInfo = { applied: out.pick, confidence: Number(out.res.confidence.toFixed(3)), effort: out.res.effort };
        // Effort is a paid-pool decision. Free still logs Jev's answer but never applies it. A sticky turn changes
        // its tier only when Jev is confident about the tier too.
        const effortSure = (out.res.effort_confidence ?? out.res.confidence) >= out.thr;
        if (pool === "paid" && (!sticky || !prev?.effort || effortSure || out.res.effort === prev.effort)) { desiredEffort = out.res.effort; effortSource = "jev"; }
      }
    }

    // One abstract need per request; the head model decides the native value and the fallback
    // list keeps only models where the exact same control+value applies. Continuations reuse the
    // fresh task's need; a paid turn with no Jev answer falls back to normal (the provider default).
    if (pool === "paid" && policy.jev?.mode === "on") {
      if (!desiredEffort && (!fresh || sticky) && prev?.effort) { desiredEffort = prev.effort; effortSource = "session"; }
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
        ...(plan.floor ? { floor: true, would_keep: plan.wouldKeep, min_fallbacks: minFallbacks(policy) } : {}),
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
      event: "decision", id: ctx.requestId ?? null, pool, conv: hash(key), fresh, sticky: sticky || undefined, est_tokens: req.tokens, reserve: req.reserve,
      tools: req.usesTools, images: req.images, nofit, excluded: excluded.length ? excluded : undefined, models, jev: jevInfo, jev_mode: step?.mode, jev_skipped: fresh && !asked ? true : undefined, effort: effortInfo, demoted: cooling?.length ? cooling : undefined,
    });
    // Response-header provenance (patch 0007): reason is jev | static[:cont|:skip|:sticky]; confidence
    // only when Jev's pick was applied. The pool itself is already the request model.
    const windows = windowsFor(models, f);
    return {
      models,
      // UP-16: static means a real choice call that did not apply; static:skip means none was made (pool left out,
      // mode off, skip session, fewer than two models), so warslop's LIM-8 stops drawing for it.
      reason: jevInfo ? "jev" : !fresh ? "static:cont" : !asked ? "static:skip" : sticky ? "static:sticky" : "static",
      ...(jevInfo ? { confidence: jevInfo.confidence } : {}),
      // Applied native control as {control, value} (the 0008 wire shape; the log keeps `native`),
      // or an explicit none/clear when normal/free/no mapping wins.
      ...(effortInfo ? { thinking: toHostThinking(effortInfo.applied) } : {}),
      // Patch 0011: each dispatch id's own window, so the host can echo the answering route's figures.
      ...(windows ? { windows_by_model: windows } : {}),
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
      // UP-10c: which pair answered. The head is attempt 0 of what was sent; any other success is a backup.
      const was = payload.requestId ? sent.get(payload.requestId) : null;
      if (was) sent.delete(payload.requestId);
      const won = [...payload.attempts].reverse().find((a) => a.ok)?.model;
      const menuInfo = was ? { item: was.item, specialist: was.specialist, answered_by: won ?? null, backup_used: won ? won !== was.attempts[0]?.m : undefined, thinking: was.attempts.find((a) => a.m === won)?.thinking } : {};
      log({ event: "result", id: payload.requestId ?? null, pool: payload.model, status: payload.status, ...menuInfo,
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
