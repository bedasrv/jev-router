import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRouter } from "../index.mjs";
import { createJev, confidence, askText, describeCandidate, buildPayload } from "../lib/jev.mjs";

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
function mk(jev, jevClient) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevj-")); const file = path.join(dir, "policy.json");
  const p = policy(jev); p.log_file = "log.jsonl"; fs.writeFileSync(file, JSON.stringify(p));
  const r = createRouter({ policyFile: file, jev: jevClient, facts: { get: (pol) => Object.fromEntries([...pol.order.paid, ...pol.order.free].map((i) => [i, pol.models[i]])) } });
  return { r, logs: () => fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}
const turn = (t = "refactor the module") => ({ model: "paid", requestId: "r1", headers: {}, body: { messages: [{ role: "user", content: t }] } });
const stub = (res) => ({ ask: async () => res });
const hit = { ok: true, source: "a", latency_ms: 5, index: 1, choice: "c2", probabilities: { c1: 0.05, c2: 0.9, c3: 0.05 }, confidence: 0.85, effort: "hard", effort_confidence: 0.6, tried: [] };

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
  assert.deepEqual(out.thinking, { control: "effort", native: "high" });
  ({ r } = mk(cfg({ mode: "on" }), stub({ ...hit, confidence: 0.2 })));
  out = await r.onRoute(turn());
  assert.equal(out.models[0], "a/p1");
  assert.equal(out.reason, "static");
  assert.equal(out.confidence, undefined);
  assert.equal(out.thinking, undefined); // fail-open normal = provider default
  ({ r } = mk(cfg({ mode: "on" }), stub({ ok: false, error: "x", tried: [] })));
  out = await r.onRoute(turn());
  assert.equal(out.models[0], "a/p1");
  assert.equal(out.reason, "static");
  assert.equal(out.thinking, undefined);
});
test("reason is static:cont on a continuation turn", async () => {
  const { r } = mk(cfg({ mode: "on" }), stub(hit));
  const msgs = [{ role: "user", content: "go" }, { role: "assistant", content: "", tool_calls: [{}] }, { role: "tool", content: "ok" }];
  const out = await r.onRoute({ model: "paid", headers: {}, body: { messages: msgs } });
  assert.equal(out.reason, "static:cont");
  assert.equal(out.confidence, undefined);
  assert.equal(out.thinking, undefined); // default normal = omit
});
test("continuation reuses the fresh task's effort without a second Jev call", async () => {
  let calls = 0;
  const { r } = mk(cfg({ mode: "on" }), { ask: async () => { calls++; return { ...hit, effort: "hard" }; } });
  const h = { "x-omniroute-session-id": "s-effort" };
  const msgs = [{ role: "user", content: "go" }];
  const first = await r.onRoute({ model: "paid", headers: h, body: { messages: msgs } });
  assert.deepEqual(first.thinking, { control: "effort", native: "high" });
  const again = await r.onRoute({ model: "paid", headers: h, body: { messages: [...msgs, { role: "assistant", content: "", tool_calls: [{}] }, { role: "tool", content: "ok" }] } });
  assert.equal(calls, 1);
  assert.deepEqual(again.thinking, { control: "effort", native: "high" });
  assert.equal(again.reason, "static:cont");
});
test("free requests never carry a thinking field", async () => {
  const { r } = mk(cfg({ mode: "on" }), stub({ ...hit, effort: "frontier" }));
  const out = await r.onRoute({ model: "free", headers: {}, body: { messages: [{ role: "user", content: "hi" }] } });
  assert.equal(out.thinking, undefined);
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
test("client: failover to the next source, cooldown after three failures, malformed answers rejected", async () => {
  const calls = []; let t = 0;
  const fetchImpl = async (url) => { calls.push(url); if (url.endsWith("/a")) return { ok: false, status: 500 }; return answer("c1", { c1: 0.8, c2: 0.2 }); };
  const jev = createJev({ fetchImpl, now: () => (t += 1) });
  const payload = { ids: ["c1", "c2"], state: {}, questions: {} };
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
  assert.equal(pl.state.needs_tools.startsWith("yes"), true); assert.equal(typeof pl.state.size, "string");
});
test("structured options: good_at/weak_at/cost/thinking become an object without digits; the model name is never sent", () => {
  const d = describeCandidate("ocgoa/x-5.3", { context_length: 1e6 }, { good_at: "Indonesian writing, code 4x", weak_at: "very long math", cost: "included in subscription", thinking });
  assert.deepEqual(Object.keys(d), ["good_at", "weak_at", "cost", "context", "thinking"]);
  assert.ok(!/[0-9]/.test(JSON.stringify(d))); assert.equal(d.context, "huge context window"); assert.equal(d.thinking, "can think harder for difficult tasks");
  const pl = buildPayload({ pool: "free", ask: "halo", req: { tokens: 10, images: 1, usesTools: false }, shown: ["ocgoa/x-5.3", "openrouter/y"], facts: {}, policy: { models: { "ocgoa/x-5.3": { good_at: "chat", cost: "free", thinking } } } });
  const sent = JSON.stringify({ state: pl.state, questions: pl.questions });
  assert.ok(!sent.includes("ocgoa") && !sent.includes("openrouter")); assert.equal(pl.state.has_image, "yes");
  assert.equal(typeof pl.questions.model.criteria.c2, "string"); // no good_at: the one-line fallback
  assert.ok(pl.questions.model.criteria.c2.includes("cannot be adjusted")); // unknown model: omit
});
test("client: the request body carries model, state and questions only (no internal ids)", async () => {
  let sentBody; const jev = createJev({ fetchImpl: async (_u, init) => { sentBody = JSON.parse(init.body); return answer("c1", { c1: 1, c2: 0 }); } });
  await jev.ask(cfg({ sources: [src("a")] }), { ids: ["c1", "c2"], state: { request: "x" }, questions: { model: { type: "choice" } } });
  assert.deepEqual(Object.keys(sentBody).sort(), ["model", "questions", "state"]);
});
