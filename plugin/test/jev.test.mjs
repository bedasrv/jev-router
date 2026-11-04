import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRouter } from "../index.mjs";
import { createJev, confidence, askText, describeCandidate, buildPayload, descriptionProblems, shuffleFor, requestSource, INSTRUCTIONS } from "../lib/jev.mjs";

const answer = (choice, probs, effort = "normal", effortProbs = { trivial: 0.05, normal: 0.6, hard: 0.25, frontier: 0.1 }) => ({ ok: true, status: 200, json: async () => ({ answers: { model: { choice, probabilities: probs }, effort: { choice: effort, probabilities: effortProbs } } }) });
const src = (name) => ({ name, url: `http://x/${name}`, model: "jev-1.13-free" });
const cfg = (extra = {}) => ({ mode: "shadow", threshold: 0.5, deadline_ms: 3000, sources: [src("a"), src("b")], ...extra });
const thinking = { control: "effort", values: ["none", "low", "medium", "high"], default: null, budget: null, map: { trivial: "none", normal: null, hard: "high", frontier: "high" } };

function policy(jev) {
  return {
    limits: { max_main: 3, max_spill: 2 },
    order: { paid: ["a/p1", "b/p2", "c/p3"], free: ["f/x"] },
    models: Object.fromEntries(["a/p1", "b/p2", "c/p3", "f/x"].map((i) => [i, { context_length: 1000000, tools: true, vision: true, traits: `trait ${i} 9x`, thinking }])),
    jev,
  };
}
function mk(jev, jevClient, edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevj-")); const file = path.join(dir, "policy.json");
  const p = policy(jev); edit?.(p); p.log_file = "log.jsonl"; fs.writeFileSync(file, JSON.stringify(p));
  const r = createRouter({ policyFile: file, jev: jevClient, facts: { get: (pol) => Object.fromEntries([...pol.order.paid, ...pol.order.free].map((i) => [i, pol.models[i]])) } });
  return { r, logs: () => fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}
const turn = (t = "refactor the module") => ({ model: "paid", requestId: "r1", headers: {}, body: { messages: [{ role: "user", content: t }] } });
// A fake Jev answers by model id (`pick`): the shown order is shuffled per request, so the option id is looked up.
const stub = (res) => ({ ask: async (_cfg, payload) => (res.pick && payload?.order ? { ...res, index: payload.order.indexOf(res.pick), choice: payload.ids[payload.order.indexOf(res.pick)] } : res) });
const hit = { ok: true, source: "a", latency_ms: 5, pick: "b/p2", probabilities: { c1: 0.05, c2: 0.9, c3: 0.05 }, confidence: 0.85, effort: "hard", effort_confidence: 0.6, tried: [] };

test("shadow: returns the static list at once, logs Jev's differing pick afterwards", async () => {
  const { r, logs } = mk(cfg(), stub(hit));
  const out = await r.onRoute(turn());
  assert.equal(out.models[0], "a/p1"); // unchanged
  assert.equal(out.thinking, undefined); // shadow: effort is logged, not applied
  await new Promise((res) => setTimeout(res, 20));
  const j = logs().find((l) => l.event === "jev");
  assert.equal(j.pick, "b/p2"); assert.equal(j.static_head, "a/p1"); assert.equal(j.differs, true); assert.equal(j.would_apply, true); assert.equal(j.mode, "shadow");
  assert.equal(j.effort, "hard");
});
test("on: a confident pick leads the list; low confidence and failures keep the static order", async () => {
  let { r } = mk(cfg({ mode: "on" }), stub(hit));
  let out = await r.onRoute(turn());
  assert.equal(out.models[0], "b/p2");
  assert.equal(out.reason, "jev");
  assert.equal(out.confidence, 0.85);
  assert.deepEqual(out.thinking, { control: "effort", value: "high" });
  ({ r } = mk(cfg({ mode: "on" }), stub({ ...hit, confidence: 0.2 })));
  out = await r.onRoute(turn());
  assert.equal(out.models[0], "a/p1");
  assert.equal(out.reason, "static");
  assert.equal(out.confidence, undefined);
  assert.deepEqual(out.thinking, { control: "none" }); // fail-open normal clears any client effort
  ({ r } = mk(cfg({ mode: "on" }), stub({ ok: false, error: "x", tried: [] })));
  out = await r.onRoute(turn());
  assert.equal(out.models[0], "a/p1");
  assert.equal(out.reason, "static");
  assert.deepEqual(out.thinking, { control: "none" });
});
test("reason is static:cont on a continuation turn", async () => {
  const { r } = mk(cfg({ mode: "on" }), stub(hit));
  const msgs = [{ role: "user", content: "go" }, { role: "assistant", content: "", tool_calls: [{}] }, { role: "tool", content: "ok" }];
  const out = await r.onRoute({ model: "paid", headers: {}, body: { messages: msgs } });
  assert.equal(out.reason, "static:cont");
  assert.equal(out.confidence, undefined);
  assert.deepEqual(out.thinking, { control: "none" }); // default normal clears any client effort
});
test("continuation reuses the fresh task's effort without a second Jev call", async () => {
  let calls = 0;
  const { r } = mk(cfg({ mode: "on" }), { ask: async () => { calls++; return { ...hit, effort: "hard" }; } });
  const h = { "x-omniroute-session-id": "s-effort" };
  const msgs = [{ role: "user", content: "go" }];
  const first = await r.onRoute({ model: "paid", headers: h, body: { messages: msgs } });
  assert.deepEqual(first.thinking, { control: "effort", value: "high" });
  const again = await r.onRoute({ model: "paid", headers: h, body: { messages: [...msgs, { role: "assistant", content: "", tool_calls: [{}] }, { role: "tool", content: "ok" }] } });
  assert.equal(calls, 1);
  assert.deepEqual(again.thinking, { control: "effort", value: "high" });
  assert.equal(again.reason, "static:cont");
});
test("free requests never apply Jev effort (one candidate)", async () => {
  const { r } = mk(cfg({ mode: "on" }), stub({ ...hit, effort: "frontier" }));
  const out = await r.onRoute({ model: "free", headers: {}, body: { messages: [{ role: "user", content: "hi" }] } });
  assert.deepEqual(out.thinking, { control: "none" });
});
test("free with two candidates still never applies Jev effort (hard answer)", async () => {
  const { r, logs } = mk(cfg({ mode: "on" }), stub({ ...hit, effort: "hard" }), (p) => {
    p.order.free = ["f/x", "f/y"]; p.models["f/y"] = { ...p.models["f/x"] };
  });
  const out = await r.onRoute({ model: "free", headers: {}, body: { messages: [{ role: "user", content: "hi" }] } });
  assert.deepEqual(out.thinking, { control: "none" });
  const d = logs().find((l) => l.event === "decision");
  assert.equal(d.jev.effort, "hard");
  assert.equal(d.effort.reason, "free_pool");
  assert.equal(d.effort.applied, null);
});
test("off / continuation / single candidate never call Jev", async () => {
  let calls = 0; const spy = { ask: async () => { calls++; return hit; } };
  let { r } = mk(cfg({ mode: "off" }), spy); await r.onRoute(turn());
  ({ r } = mk(cfg(), spy));
  const msgs = [{ role: "user", content: "go" }, { role: "assistant", content: "", tool_calls: [{}] }, { role: "tool", content: "ok" }, { role: "user", content: "synthetic" }];
  await r.onRoute({ model: "paid", headers: {}, body: { messages: msgs } });
  assert.equal(calls, 0);
  await r.onRoute({ model: "free", headers: {}, body: { messages: [{ role: "user", content: "hi" }] } }); // one eligible free candidate
  assert.equal(calls, 0);
});
test("jev.skip_sessions: the app's canary session is never sent to Jev; other sessions are", async () => {
  let calls = 0; const spy = { ask: async () => { calls++; return hit; } };
  const canary = (h) => ({ ...turn("Reply with the single word OK."), headers: h });
  let { r, logs } = mk(cfg({ mode: "on", skip_sessions: ["canary"] }), spy);
  const out = await r.onRoute(canary({ "x-opencode-session": "canary" }));
  assert.equal(calls, 0);
  assert.equal(out.models[0], "a/p1"); assert.equal(out.reason, "static");
  assert.deepEqual(out.thinking, { control: "none" }); // the paid default (normal), as for an unconfident turn
  const d = logs().find((l) => l.event === "decision");
  assert.equal(d.jev_skipped, true); assert.equal(d.jev_mode, undefined);
  await r.onRoute(canary({ "X-OpenCode-Session": "canary" })); // header names are case-insensitive
  assert.equal(calls, 0);
  await r.onRoute(canary({ "x-opencode-session": "guest-1" }));
  assert.equal(calls, 1);
  assert.equal(logs().filter((l) => l.event === "decision").at(-1).jev_skipped, undefined);
  ({ r } = mk(cfg({ mode: "on", skip_sessions: ["canary"], session_header: "x-session" }), spy));
  await r.onRoute(canary({ "x-session": "canary", "x-opencode-session": "guest-1" }));
  assert.equal(calls, 1);
  ({ r } = mk(cfg({ mode: "on" }), spy)); // no list: the canary is asked, as before
  await r.onRoute(canary({ "x-opencode-session": "canary" }));
  assert.equal(calls, 2);
});
test("instructions are neutral: no audience, no language line, no tie-break to c1", () => {
  const txt = JSON.stringify(INSTRUCTIONS);
  assert.equal(INSTRUCTIONS.question, "Which model should answer this request?");
  assert.ok(!/cafe|guest|Indonesian|premium|paid|c1/i.test(txt), txt);
  assert.equal(INSTRUCTIONS.tie_break, undefined);
  const pl = buildPayload({ ask: "x", req: { tokens: 10, images: 0, usesTools: false }, shown: ["a/p1", "b/p2"], facts: {}, policy: { models: {} } });
  assert.equal(pl.state.pool, undefined);
});
test("state facts are named fields: source, system_prompt, tools, previous_model/previous_tier on a follow-up", () => {
  const req = (n, system) => ({ tokens: 10, images: 0, usesTools: n > 0, toolCount: n, system });
  const shown = ["a/p1", "b/p2", "c/p3"];
  let pl = buildPayload({ ask: "x", req: req(0, false), shown, facts: {}, policy: { models: {} }, seed: "r1" });
  assert.deepEqual(pl.state, { request: "x", source: "chat app", system_prompt: "absent", tools: "none", has_image: "no", size: "short conversation" });
  pl = buildPayload({ ask: "x", req: req(3, true), shown, facts: {}, policy: { models: {} }, seed: "r1", source: "API client", previous: { head: "c/p3", effort: "hard" } });
  assert.equal(pl.state.source, "API client"); assert.equal(pl.state.system_prompt, "present"); assert.equal(pl.state.tools, "few");
  assert.equal(pl.state.conversation, "follow-up turn"); assert.equal(pl.state.previous_tier, "hard");
  assert.equal(pl.order[pl.ids.indexOf(pl.state.previous_model)], "c/p3"); // the option id of the previous model, wherever it is shown
  assert.equal(buildPayload({ ask: "x", req: req(20, true), shown, facts: {}, policy: { models: {} } }).state.tools, "many");
  // the previous model is not offered (hidden or cooling): only its tier is said
  pl = buildPayload({ ask: "x", req: req(0, false), shown, facts: {}, policy: { models: {} }, previous: { head: "z/gone", effort: "normal" } });
  assert.equal(pl.state.previous_model, undefined); assert.equal(pl.state.previous_tier, "normal");
  // the app's stateless API calls carry session v<voucher> (warslop API-12a); the chat app sends its conversation id
  assert.equal(requestSource({ "x-opencode-session": "v42" }, {}), "API client");
  assert.equal(requestSource({ "X-OpenCode-Session": "4c1d9e" }, {}), "chat app");
  assert.equal(requestSource({}, {}), "chat app");
  assert.equal(requestSource({ "x-s": "api-7" }, { session_header: "x-s", api_session_pattern: "^api-" }), "API client");
});
test("shuffle: the shown order varies by request id, is the same for the same id, and maps Jev's choice back", async () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  assert.deepEqual(shuffleFor(ids, "r1"), shuffleFor(ids, "r1"));
  const seen = new Set(Array.from({ length: 40 }, (_, i) => shuffleFor(ids, `req-${i}`)[0]));
  assert.equal(seen.size, 6, "every option leads for some request");
  assert.deepEqual([...shuffleFor(ids, "r9")].sort(), ids);
  // the router applies the model Jev chose, not whatever the configured order has at that position
  for (const id of ["r1", "r2", "r3", "r4"]) {
    const { r } = mk(cfg({ mode: "on" }), stub({ ...hit, pick: "c/p3" }));
    const out = await r.onRoute({ ...turn(), requestId: id });
    assert.equal(out.models[0], "c/p3", id);
  }
});
test("jev.hidden: a hidden model is never shown to Jev but stays a fallback route", async () => {
  let shown;
  const spy = { ask: async (_c, payload) => { shown = payload.order; return { ok: false, error: "x", tried: [] }; } };
  const { r } = mk(cfg({ mode: "on", hidden: ["c/p3"] }), spy);
  const out = await r.onRoute(turn());
  assert.deepEqual([...shown].sort(), ["a/p1", "b/p2"]);
  assert.ok(out.models.includes("c/p3"));
});
test("stickiness: a new turn of a conversation keeps the previous model and tier unless Jev is confident otherwise", async () => {
  const h = { "x-omniroute-session-id": "s-sticky" };
  const say = (t, prior = []) => ({ model: "paid", requestId: t, headers: h, body: { messages: [...prior, { role: "user", content: t }] } });
  const prior = [{ role: "user", content: "first" }, { role: "assistant", content: "done" }];
  let answerNow = { ...hit, pick: "c/p3", effort: "hard", confidence: 0.9, effort_confidence: 0.9 };
  let payloads = [];
  const jev = { ask: async (c, payload) => { payloads.push(payload); return stub(answerNow).ask(c, payload); } };
  const { r, logs } = mk(cfg({ mode: "on" }), jev);
  let out = await r.onRoute(say("first"));
  assert.equal(out.models[0], "c/p3"); assert.deepEqual(out.thinking, { control: "effort", value: "high" });
  // unconfident on the next turn: the previous model and tier stay (not the configured head a/p1, not normal)
  answerNow = { ...hit, pick: "a/p1", effort: "trivial", confidence: 0.2, effort_confidence: 0.2 };
  out = await r.onRoute(say("second", prior));
  assert.equal(out.models[0], "c/p3"); assert.deepEqual(out.thinking, { control: "effort", value: "high" });
  assert.equal(out.reason, "static:sticky");
  const st = payloads.at(-1).state;
  assert.equal(payloads.at(-1).order[payloads.at(-1).ids.indexOf(st.previous_model)], "c/p3"); assert.equal(st.previous_tier, "hard");
  assert.equal(logs().filter((l) => l.event === "decision").at(-1).sticky, true);
  // confident in another model, unsure about the tier: the model switches, the tier stays
  answerNow = { ...hit, pick: "b/p2", effort: "trivial", confidence: 0.9, effort_confidence: 0.1 };
  out = await r.onRoute(say("third", prior));
  assert.equal(out.models[0], "b/p2"); assert.deepEqual(out.thinking, { control: "effort", value: "high" });
  // confident in both: both switch
  answerNow = { ...hit, pick: "a/p1", effort: "trivial", confidence: 0.9, effort_confidence: 0.9 };
  out = await r.onRoute(say("fourth", prior));
  assert.equal(out.models[0], "a/p1"); assert.deepEqual(out.thinking, { control: "effort", value: "none" });
  // a brand-new conversation that Jev is unsure about takes the configured head (the default in code)
  answerNow = { ...hit, pick: "c/p3", confidence: 0.2 };
  out = await r.onRoute({ model: "paid", requestId: "n1", headers: { "x-omniroute-session-id": "s-new" }, body: { messages: [{ role: "user", content: "hi" }] } });
  assert.equal(out.models[0], "a/p1"); assert.equal(out.reason, "static");
  // shadow mode: no stickiness (the static order is what is served), but Jev still sees the follow-up facts
  payloads = [];
  const sh = mk(cfg({ mode: "shadow" }), jev);
  await sh.r.onRoute(say("first"));
  out = await sh.r.onRoute(say("second", prior));
  assert.equal(out.reason, "static"); assert.equal(payloads.at(-1).state.conversation, "follow-up turn");
});
test("stickiness keys on Warslop's real header shape: x-opencode-session, prompt_cache_key, no x-omniroute-session-id", async () => {
  // src/upstream.ts: the conversation id goes in x-opencode-session and prompt_cache_key; src/turn.ts: a new
  // conversation's system text is the same for every guest (empty memory block).
  const sys = { role: "system", content: "You are Warslop.\n<memory></memory>" };
  const call = (sid, rid, msgs) => ({ model: "paid", requestId: rid, headers: { authorization: "Bearer x", "content-type": "application/json", "x-opencode-session": sid, "x-correlation-id": rid + "-corr" }, body: { model: "paid", messages: [sys, ...msgs], stream: true, stream_options: { include_usage: true }, prompt_cache_key: sid } });
  let answerNow = { ...hit, pick: "c/p3", effort: "hard", confidence: 0.9, effort_confidence: 0.9 };
  const { r, logs } = mk(cfg({ mode: "on" }), { ask: async (c, payload) => stub(answerNow).ask(c, payload) });
  let out = await r.onRoute(call("conv-a", "a1", [{ role: "user", content: "halo" }]));
  assert.equal(out.models[0], "c/p3");
  // a second guest opens with the same "halo" in a new conversation; Jev is unsure: the configured head, not c/p3
  answerNow = { ...hit, pick: "b/p2", effort: "trivial", confidence: 0.2, effort_confidence: 0.2 };
  out = await r.onRoute(call("conv-b", "b1", [{ role: "user", content: "halo" }]));
  assert.equal(out.models[0], "a/p1"); assert.equal(out.reason, "static");
  assert.notEqual(logs().find((l) => l.id === "a1" && l.event === "decision").conv, logs().find((l) => l.id === "b1" && l.event === "decision").conv);
  // the first guest's next turn is the same conversation: sticky
  out = await r.onRoute(call("conv-a", "a2", [{ role: "user", content: "halo" }, { role: "assistant", content: "hai" }, { role: "user", content: "apa kabar" }]));
  assert.equal(out.models[0], "c/p3"); assert.equal(out.reason, "static:sticky");
});
test("stateless API calls (session v<voucher>) get no new-turn stickiness; a tool loop still keeps its head", async () => {
  const call = (rid, msgs) => ({ model: "paid", requestId: rid, headers: { "x-opencode-session": "v42" }, body: { messages: msgs, prompt_cache_key: "v42" } });
  let answerNow = { ...hit, pick: "c/p3", effort: "hard", confidence: 0.9, effort_confidence: 0.9 };
  let payloads = [];
  const { r, logs } = mk(cfg({ mode: "on" }), { ask: async (c, payload) => { payloads.push(payload); return stub(answerNow).ask(c, payload); } });
  const opening = [{ role: "user", content: "summarise this" }];
  let out = await r.onRoute(call("v1", opening));
  assert.equal(out.models[0], "c/p3");
  // the same voucher sends another call, even one that replays a prior exchange: decided on its own
  answerNow = { ...hit, pick: "b/p2", confidence: 0.2, effort_confidence: 0.2 };
  out = await r.onRoute(call("v2", [...opening, { role: "assistant", content: "ok" }, { role: "user", content: "again" }]));
  assert.equal(out.models[0], "a/p1"); assert.equal(out.reason, "static");
  assert.equal(payloads.at(-1).state.previous_model, undefined);
  assert.equal(logs().filter((l) => l.event === "decision").at(-1).sticky, undefined);
  // a continuation (tool result waiting) of the first call keeps its head
  answerNow = { ...hit, pick: "c/p3", effort: "hard", confidence: 0.9, effort_confidence: 0.9 };
  await r.onRoute(call("v3", [{ role: "user", content: "use the tool" }]));
  out = await r.onRoute(call("v4", [{ role: "user", content: "use the tool" }, { role: "assistant", content: null, tool_calls: [{ id: "t", type: "function", function: { name: "f", arguments: "{}" } }] }, { role: "tool", tool_call_id: "t", content: "42" }]));
  assert.equal(out.models[0], "c/p3");
});
test("askText keeps the head and the tail of a long ask", () => {
  const long = "A".repeat(700) + "middle" + "Z".repeat(700);
  const t = askText({ messages: [{ role: "user", content: long }] });
  assert.ok(t.startsWith("A".repeat(600)) && t.endsWith("Z".repeat(600)));
  assert.ok(!t.includes("middle")); assert.ok(t.length < 1210);
  assert.equal(askText({ messages: [{ role: "user", content: "short" }] }), "short");
});
test("description rules: no model names, digits, negations or references to other options; cost is one word", () => {
  const ids = ["ocpaid/opencode-go/deepseek-v4.1-flash", "ocpaid/opencode-go/mimo-v2.6-pro"];
  assert.deepEqual(descriptionProblems({ good_at: "agentic work and tool use", weak_at: "slow start", cost: "standard" }, ids), []);
  const bad = descriptionProblems({ good_at: "better than deepseek at 3 things", weak_at: "not for small talk", cost: "included in the subscription" }, ids);
  for (const want of ["good_at: digits", "good_at: names a model (deepseek)", "good_at: refers to other options (better)", "weak_at: negation (not)", "cost: one of"])
    assert.ok(bad.some((p) => p.startsWith(want)), `${want}: ${bad}`);
  assert.ok(descriptionProblems({ good_at: "like mimo", cost: "pricier" }, ids).some((p) => p.includes("names a model")));
});
test("client: failover to the next source, cooldown after three failures, malformed answers rejected", async () => {
  const calls = []; let t = 0;
  const fetchImpl = async (url) => { calls.push(url); if (url.endsWith("/a")) return { ok: false, status: 500 }; return answer("c1", { c1: 0.8, c2: 0.2 }); };
  const jev = createJev({ fetchImpl, now: () => (t += 1) });
  const payload = { ids: ["c1", "c2"], state: {}, questions: { model: {}, effort: {} } }; // the model + effort payload (the menu one has no effort)
  const r1 = await jev.ask(cfg(), payload);
  assert.equal(r1.ok, true); assert.equal(r1.source, "b"); assert.equal(r1.tried[0].source, "a");
  await jev.ask(cfg(), payload); await jev.ask(cfg(), payload); // a fails 3x -> cools
  calls.length = 0; await jev.ask(cfg(), payload);
  assert.deepEqual(calls, ["http://x/b"]);
  const bad = createJev({ fetchImpl: async () => answer("zz", { zz: 1 }) });
  assert.equal((await bad.ask(cfg({ sources: [src("a")] }), payload)).ok, false);
  const badEffort = createJev({ fetchImpl: async () => answer("c1", { c1: 0.8, c2: 0.2 }, "maximum") });
  assert.equal((await badEffort.ask(cfg({ sources: [src("a")] }), payload)).ok, false);
  const one = await createJev({ fetchImpl: async () => answer("c1", { c1: 0.8, c2: 0.2 }, "hard"), now: () => 1 }).ask(cfg({ sources: [src("a")] }), payload);
  assert.equal(one.ok, true); assert.equal(one.effort, "hard");
});
test("helpers: confidence formula, ask text after the last assistant, descriptions carry no digits", () => {
  assert.ok(Math.abs(confidence({ a: 0.5, b: 0.5 })) < 1e-9); assert.equal(confidence({ a: 1, b: 0 }), 1);
  assert.equal(askText({ messages: [{ role: "user", content: "old" }, { role: "assistant", content: "x" }, { role: "user", content: "real task" }, { role: "user", content: "reminder" }] }), "real task\nreminder");
  assert.ok(!/[0-9]/.test(describeCandidate("i", { context_length: 262144 }, "budget 5x; fast")));
  const pl = buildPayload({ pool: "paid", ask: "x", req: { tokens: 10, images: 0, usesTools: true }, shown: ["a/p1", "b/p2"], facts: { "a/p1": { context_length: 1e6 }, "b/p2": { context_length: 1e5 } }, policy: { models: {} } });
  assert.deepEqual(Object.keys(pl.questions.model.criteria), ["c1", "c2"]); assert.ok(pl.questions.model.criteria.c1.includes("huge"));
  assert.deepEqual(pl.ids, ["c1", "c2"]); assert.deepEqual(pl.effortChoices, ["trivial", "normal", "hard", "frontier"]);
  assert.deepEqual(Object.keys(pl.questions.effort.criteria), ["trivial", "normal", "hard", "frontier"]);
  assert.equal(pl.state.tools, "few"); assert.equal(typeof pl.state.size, "string");
});
test("structured options: good_at/weak_at/cost/thinking become an object without digits; the model name is never sent", () => {
  const d = describeCandidate("ocgoa/x-5.3", { context_length: 1e6 }, { good_at: "Indonesian writing, code 4x", weak_at: "very long math", cost: "included in subscription", thinking });
  assert.deepEqual(Object.keys(d), ["good_at", "weak_at", "cost", "context", "thinking"]);
  assert.ok(!/[0-9]/.test(JSON.stringify(d))); assert.equal(d.context, "huge context window"); assert.equal(d.thinking, "can think harder for difficult tasks");
  const pl = buildPayload({ pool: "free", ask: "halo", req: { tokens: 10, images: 1, usesTools: false }, shown: ["ocgoa/x-5.3", "openrouter/y"], facts: {}, policy: { models: { "ocgoa/x-5.3": { good_at: "chat", cost: "free", thinking } } } });
  const sent = JSON.stringify({ state: pl.state, questions: pl.questions });
  assert.ok(!sent.includes("ocgoa") && !sent.includes("openrouter")); assert.equal(pl.state.has_image, "yes");
  assert.equal(typeof pl.questions.model.criteria[pl.ids[pl.order.indexOf("openrouter/y")]], "string"); // no good_at: the one-line fallback
  assert.ok(pl.questions.model.criteria[pl.ids[pl.order.indexOf("openrouter/y")]].includes("fixed thinking level")); // unknown model: omit
});
test("client: the request body carries model, state and questions only (no internal ids)", async () => {
  let sentBody; const jev = createJev({ fetchImpl: async (_u, init) => { sentBody = JSON.parse(init.body); return answer("c1", { c1: 1, c2: 0 }); } });
  await jev.ask(cfg({ sources: [src("a")] }), { ids: ["c1", "c2"], state: { request: "x" }, questions: { model: { type: "choice" } } });
  assert.deepEqual(Object.keys(sentBody).sort(), ["model", "questions", "state"]);
});
