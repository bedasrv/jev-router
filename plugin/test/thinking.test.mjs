import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRouter } from "../index.mjs";
import { applyThinkingToList, missingThinking, planThinking, validateThinking } from "../lib/thinking.mjs";
import { buildEffortPolicy, loadEffortData, measuredKey, unknownThinking } from "../ops/apply-effort-policy.mjs";

const effort = (values, map = {}) => ({ control: "effort", values, default: null, budget: null, map });
const toggle = { control: "toggle", values: ["off", "on"], default: null, budget: null, map: { trivial: "off", normal: null, hard: null, frontier: null } };
const { table, draft } = loadEffortData();

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevth-"));
function writePolicy(p) {
  const dir = tmp(); const file = path.join(dir, "policy.json");
  p.log_file = "log.jsonl"; fs.writeFileSync(file, JSON.stringify(p));
  return { file, dir };
}
function mk(policy, jevClient) {
  const { file, dir } = writePolicy(policy);
  const r = createRouter({ policyFile: file, jev: jevClient, facts: { get: (p) => Object.fromEntries([...p.order.paid, ...p.order.free].map((id) => [id, p.models[id] ?? {}])) } });
  return {
    r,
    logs: () => fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)),
  };
}
const user = (t = "hello") => ({ model: "paid", requestId: "req", headers: {}, body: { messages: [{ role: "user", content: t }] } });
const answer = (pick, effortLevel) => ({ ask: async () => ({ ok: true, source: "a", latency_ms: 1, index: 0, choice: pick, probabilities: { c1: 0.95, c2: 0.05 }, confidence: 0.9, effort: effortLevel, tried: [] }) });

test("generator imports the measured table/draft for every shape and skips the dead route", () => {
  const routes = Object.keys(table);
  const p = { order: { paid: routes, free: [] }, models: Object.fromEntries(routes.map((id) => [id, {}])) };
  const out = buildEffortPolicy(p, { table, draft });
  assert.deepEqual(out.dead, ["ocpv/opencode-go/longcat-2.5-preview-free"]);
  assert.ok(!p.order.paid.includes("ocpv/opencode-go/longcat-2.5-preview-free"));
  assert.deepEqual(missingThinking(p), []);

  const beam = p.models["ocpv/opencode-go/beam-free"].thinking;
  assert.equal(beam.control, "effort");
  assert.deepEqual(beam.values, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(beam.map, { trivial: "low", normal: null, hard: "high", frontier: "high" });

  const deep = p.models["ocgoa/opencode-go/deepseek-v4.1-flash"].thinking;
  assert.deepEqual(deep.values, ["low", "high", "max"]);
  assert.deepEqual(deep.map, { trivial: "low", normal: null, hard: "high", frontier: "high" });

  const nemotron = p.models["openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"].thinking;
  assert.deepEqual(nemotron.values, ["none", "medium", "high"]);
  assert.deepEqual(nemotron.map, { trivial: "none", normal: null, hard: "high", frontier: "high" });

  const ling = p.models["openrouter/inclusionai/ling-3.1-flash"].thinking;
  assert.equal(ling.control, "toggle");
  assert.deepEqual(ling.map, { trivial: "off", normal: null, hard: null, frontier: null });

  const mimo = p.models["ocgob/opencode-go/mimo-v2.6-flash"].thinking;
  assert.equal(mimo.control, "effort");
  assert.deepEqual(mimo.values, ["none"]);
  assert.deepEqual(mimo.map, { trivial: "none", normal: null, hard: null, frontier: null });

  const minimax = p.models["ocpv/opencode-go/minimax-m3.1-flash-free"].thinking;
  assert.equal(table["ocpv/opencode-go/minimax-m3.1-flash-free"].mandatory, true);
  assert.deepEqual(minimax.map, { trivial: "low", normal: null, hard: "high", frontier: "high" });
});

test("planThinking follows the draft: normal is the null/default path, never the lowest tier", () => {
  const p = { models: {
    "deep": { thinking: { control: "effort", values: ["low", "high", "max"], map: { trivial: "low", normal: null, hard: "high", frontier: "high" } } },
    "mid": { thinking: { control: "effort", values: ["low", "medium", "high"], map: { trivial: "low", normal: null, hard: "high", frontier: "high" } } },
    "toggle": { thinking: toggle },
    "offonly": { thinking: effort(["none"], { trivial: "none", normal: null, hard: null, frontier: null }) },
    "budget": { thinking: { control: "budget", values: [], default: null, budget: { min: 1, max: 2 }, map: {} } },
  } };
  for (const id of ["deep", "mid", "toggle", "offonly"]) {
    const normal = planThinking(id, "normal", p);
    assert.equal(normal.omitted, true);
    assert.equal(normal.reason, "default");
  }
  assert.deepEqual(["trivial", "hard", "frontier"].map((t) => planThinking("deep", t, p).native), ["low", "high", "high"]);
  assert.deepEqual(["trivial", "hard", "frontier"].map((t) => planThinking("mid", t, p).native), ["low", "high", "high"]);
  assert.equal(planThinking("toggle", "trivial", p).native, "off");
  assert.equal(planThinking("toggle", "hard", p).omitted, true);
  assert.equal(planThinking("offonly", "trivial", p).native, "none");
  assert.equal(planThinking("offonly", "hard", p).omitted, true);
  assert.equal(planThinking("budget", "hard", p).reason, "budget_unsupported");
  assert.equal(planThinking("unknown", "hard", p).reason, "no_control");
});

test("applyThinkingToList omits normal/unknown and filters fallbacks to the same native value", () => {
  const p = { models: {
    "a/deep": { thinking: { control: "effort", values: ["low", "high", "max"], map: { trivial: "low", normal: null, hard: "high", frontier: "high" } } },
    "b/high": { thinking: { control: "effort", values: ["high"], map: { trivial: null, normal: null, hard: "high", frontier: "high" } } },
    "c/low": { thinking: { control: "effort", values: ["low"], map: { trivial: "low", normal: null, hard: null, frontier: null } } },
    "d/none": { thinking: unknownThinking() },
  }, jev: { min_fallbacks: 0 } }; // the filter itself; the floor has its own test
  const normal = applyThinkingToList({ models: ["a/deep", "b/high", "c/low", "d/none"], abstract: "normal", policy: p });
  assert.deepEqual(normal.models, ["a/deep", "b/high", "c/low", "d/none"]);
  assert.equal(normal.omitted, true);
  assert.equal(normal.applied, null);

  const hard = applyThinkingToList({ models: ["a/deep", "b/high", "c/low", "d/none"], abstract: "hard", policy: p });
  assert.deepEqual(hard.models, ["a/deep", "b/high"]);
  assert.deepEqual(hard.applied, { control: "effort", native: "high" });
  assert.deepEqual(hard.dropped, ["c/low", "d/none"]);

  const trivial = applyThinkingToList({ models: ["a/deep", "c/low"], abstract: "trivial", policy: p });
  assert.deepEqual(trivial.models, ["a/deep", "c/low"]);
  assert.deepEqual(trivial.applied, { control: "effort", native: "low" });
});

test("validateThinking rejects bad shapes and missingThinking finds uncovered ids", () => {
  assert.match(validateThinking({ control: "loud" }), /control/);
  assert.match(validateThinking({ control: "effort", values: [null] }), /values/);
  assert.match(validateThinking({ control: "effort", map: { quick: "low" } }), /unknown level/);
  assert.equal(validateThinking(effort(["low"])), null);
  const p = { order: { paid: ["a/1", "a/2"], free: ["f/1"] }, last_resort: { paid: "m/last" }, models: { "a/1": { thinking: effort(["low"]) }, "a/2": {}, "f/1": { thinking: toggle } } };
  assert.deepEqual(missingThinking(p), ["a/2", "m/last"]);
});

test("policy.example is exactly what the bundled effort data generates", () => {
  const p = JSON.parse(fs.readFileSync(new URL("../policy.example.json", import.meta.url), "utf8"));
  const copy = structuredClone(p);
  buildEffortPolicy(copy, { table, draft });
  assert.deepEqual(copy, p);
});

test("router applies the chosen tier, filters fallbacks, and logs need/native/model", async () => {
  const p = {
    order: { paid: ["a/head", "b/high", "c/low"], free: [] },
    models: {
      "a/head": { thinking: { control: "effort", values: ["low", "high", "max"], map: { trivial: "low", normal: null, hard: "high", frontier: "high" } } },
      "b/high": { thinking: { control: "effort", values: ["high"], map: { trivial: null, normal: null, hard: "high", frontier: "high" } } },
      "c/low": { thinking: { control: "effort", values: ["low"], map: { trivial: "low", normal: null, hard: null, frontier: null } } },
    },
    jev: { mode: "on", threshold: 0.5, deadline_ms: 300, min_fallbacks: 0, sources: [{ name: "a", url: "http://x", model: "jev" }] },
  };
  const { r, logs } = mk(p, answer("c1", "hard"));
  const out = await r.onRoute(user());
  assert.deepEqual(out.models, ["a/head", "b/high"]);
  assert.deepEqual(out.thinking, { control: "effort", value: "high" });
  const d = logs().find((l) => l.event === "decision");
  assert.deepEqual(d.effort, {
    source: "jev", need: "hard", abstract: "hard", model: "a/head",
    applied: { control: "effort", native: "high" }, control: "effort", native: "high", native_tier: "high",
    clamped: false, omitted: false, dropped: ["c/low"],
  });
});

test("router normal path omits the field; frontier takes the draft max when it says so", async () => {
  const p = {
    order: { paid: ["a/head", "b/low"], free: [] },
    models: {
      "a/head": { thinking: { control: "effort", values: ["low", "high", "max"], map: { trivial: "low", normal: null, hard: "high", frontier: "max" } } },
      "b/low": { thinking: { control: "effort", values: ["low"], map: { trivial: "low", normal: null, hard: null, frontier: null } } },
    },
    jev: { mode: "on", threshold: 0.5, deadline_ms: 300, min_fallbacks: 0, sources: [{ name: "a", url: "http://x", model: "jev" }] },
  };
  let { r, logs } = mk(p, answer("c1", "normal"));
  let out = await r.onRoute(user());
  assert.deepEqual(out.thinking, { control: "none" });
  assert.deepEqual(out.models, ["a/head", "b/low"]);
  let e = logs().find((l) => l.event === "decision").effort;
  assert.equal(e.omitted, true); assert.equal(e.reason, "default");

  ({ r, logs } = mk(p, answer("c1", "frontier")));
  out = await r.onRoute(user());
  assert.deepEqual(out.thinking, { control: "effort", value: "max" });
  assert.deepEqual(out.models, ["a/head"]); // b/low cannot take max
});

test("fail-open applies normal (omit/default) for paid; free never gets effort", async () => {
  const p = {
    order: { paid: ["a/head"], free: ["f/x"] },
    models: { "a/head": { thinking: effort(["low", "high"], { trivial: "low", normal: null, hard: "high", frontier: "high" }) }, "f/x": { thinking: effort(["low", "high"]) } },
    jev: { mode: "on", threshold: 0.5, deadline_ms: 300, sources: [{ name: "a", url: "http://x", model: "jev" }] },
  };
  const { r, logs } = mk(p, { ask: async () => ({ ok: false, error: "down", tried: [] }) });
  const paid = await r.onRoute(user());
  assert.deepEqual(paid.thinking, { control: "none" });
  const e = logs().find((l) => l.event === "decision").effort;
  assert.equal(e.source, "default"); assert.equal(e.need, "normal"); assert.equal(e.omitted, true);
  const free = await r.onRoute({ model: "free", headers: {}, body: { messages: [{ role: "user", content: "hi" }] } });
  assert.deepEqual(free.thinking, { control: "none" });
  assert.equal(logs().filter((l) => l.event === "decision").at(-1).effort.reason, "free_pool");
});

// The 2026-10-30 production map (ocpaid ids, measured data via thinking_aliases): glm-5.3-flash at frontier takes max and
// muse-spark at trivial takes minimal, and no other paid model shares either value.
const live = () => {
  const p = {
    order: { paid: ["ocpaid/opencode-go/deepseek-v4.1-flash", "ocpaid/opencode-go/mimo-v2.6-pro", "ocpaid/opencode-go/muse-spark-1.3-contributor", "ocpaid/opencode-go/qwen3.8-flash", "ocpaid/opencode-go/glm-5.3-flash", "ocpaid/opencode-go/gpt-6-luna"], free: ["ocpaid/opencode-go/beam-free"] },
    models: {}, last_resort: {}, thinking_aliases: { ocpaid: ["ocgoa", "ocgob", "ocpv"] },
  };
  buildEffortPolicy(p, { table, draft });
  return p;
};

test("fallback floor: a tier that would keep fewer than 2 fallbacks sends no effort and keeps the list", () => {
  const p = live();
  const [deep, , muse, qwen, glm] = p.order.paid;
  const rot = (head) => [head, ...p.order.paid.filter((m) => m !== head)];
  for (const [head, tier] of [[glm, "frontier"], [muse, "trivial"], [deep, "trivial"], [qwen, "trivial"]]) {
    const r = applyThinkingToList({ models: rot(head), abstract: tier, policy: p });
    assert.equal(r.floor, true, `${head} ${tier}`);
    assert.equal(r.applied, null);
    assert.equal(r.reason, "floor");
    assert.deepEqual(r.models, rot(head)); // nothing dropped
    assert.ok(r.wouldKeep < 3);
  }
  // hard keeps 3 fallbacks (deepseek, muse, glm, luna share high): above the floor, the effort applies
  const hard = applyThinkingToList({ models: rot(deep), abstract: "hard", policy: p });
  assert.deepEqual(hard.applied, { control: "effort", native: "high" });
  assert.equal(hard.models.length, 4);
  assert.equal(hard.floor, undefined);
  // min_fallbacks is configurable: 1 lets deepseek trivial (1 fallback: glm) apply, 0 turns the floor off
  const one = applyThinkingToList({ models: rot(deep), abstract: "trivial", policy: { ...p, jev: { min_fallbacks: 1 } } });
  assert.deepEqual(one.applied, { control: "effort", native: "low" });
  assert.deepEqual(one.models, [deep, glm]);
  const off = applyThinkingToList({ models: rot(glm), abstract: "frontier", policy: { ...p, jev: { min_fallbacks: 0 } } });
  assert.deepEqual(off.models, [glm]);
});

test("fallback floor never fires when filtering dropped nothing, however short the list", () => {
  const p = live();
  const glm = "ocpaid/opencode-go/glm-5.3-flash";
  const solo = applyThinkingToList({ models: [glm], abstract: "frontier", policy: p });
  assert.deepEqual(solo.applied, { control: "effort", native: "max" });
  const pair = applyThinkingToList({ models: [glm, "ocpaid/opencode-go/deepseek-v4.1-flash"], abstract: "hard", policy: p });
  assert.deepEqual(pair.applied, { control: "effort", native: "high" }); // both take high: 1 fallback is the whole list
  assert.equal(pair.models.length, 2);
});

test("router logs effort.floor and sends {control:none} when the floor wins", async () => {
  const p = live();
  p.jev = { mode: "on", threshold: 0.5, deadline_ms: 300, sources: [{ name: "a", url: "http://x", model: "jev" }] };
  p.order.paid = ["ocpaid/opencode-go/glm-5.3-flash", ...p.order.paid.filter((m) => !m.endsWith("glm-5.3-flash"))];
  for (const id of p.order.paid) Object.assign(p.models[id], { context_length: 1000000, tools: true, vision: true });
  const { r, logs } = mk(p, answer("c1", "frontier"));
  const out = await r.onRoute(user());
  assert.deepEqual(out.thinking, { control: "none" });
  const d = logs().find((l) => l.event === "decision"), e = d.effort;
  assert.deepEqual(out.models, d.models); assert.ok(out.models.length >= 3); assert.equal(e.dropped, undefined); // the full built list
  assert.equal(e.floor, true); assert.equal(e.reason, "floor"); assert.equal(e.would_keep, 1); assert.equal(e.min_fallbacks, 2);
  assert.equal(e.need, "frontier"); assert.equal(e.applied, null);
});

test("thinking_aliases: ocpaid ids take the measured ocgoa/ocgob/ocpv rows; without aliases they stay unknown", () => {
  const p = live();
  assert.equal(measuredKey("ocpaid/opencode-go/glm-5.3-flash", p, table), "ocgob/opencode-go/glm-5.3-flash");
  assert.equal(measuredKey("ocgoa/opencode-go/deepseek-v4.1-flash", p, table), "ocgoa/opencode-go/deepseek-v4.1-flash"); // own row first
  assert.equal(measuredKey("ocpaid/opencode-go/mimo-v2.6-pro", p, table), null); // never measured
  assert.equal(p.models["ocpaid/opencode-go/deepseek-v4.1-flash"].thinking.map.hard, "high");
  assert.equal(p.models["ocpaid/opencode-go/muse-spark-1.3-contributor"].thinking.map.trivial, "minimal");
  assert.equal(p.models["ocpaid/opencode-go/mimo-v2.6-pro"].thinking.control, "none");
  const res = buildEffortPolicy(structuredClone({ ...live(), models: {} }), { table, draft });
  assert.equal(res.known.length, 6); assert.deepEqual(res.unknown, ["ocpaid/opencode-go/mimo-v2.6-pro"]);
  assert.ok(res.aliased.includes("ocpaid/opencode-go/beam-free <- ocpv/opencode-go/beam-free"));
  const bare = { order: { paid: ["ocpaid/opencode-go/glm-5.3-flash"], free: [] }, models: {} };
  assert.deepEqual(buildEffortPolicy(bare, { table, draft }).unknown, ["ocpaid/opencode-go/glm-5.3-flash"]);
  // a dead measured route is dead for its alias too
  const dead = { order: { paid: [], free: ["ocpaid/opencode-go/longcat-2.5-preview-free", "ocpaid/opencode-go/beam-free"] }, models: {}, thinking_aliases: { ocpaid: ["ocpv"] } };
  const d = buildEffortPolicy(dead, { table, draft });
  assert.deepEqual(d.dead, ["ocpaid/opencode-go/longcat-2.5-preview-free"]);
  assert.deepEqual(dead.order.free, ["ocpaid/opencode-go/beam-free"]);
});

test("policy validation: min_fallbacks and thinking_aliases shapes", async () => {
  const { validate } = await import("../lib/policy.mjs");
  const base = { order: { paid: [], free: [] } };
  assert.doesNotThrow(() => validate({ ...base, jev: { min_fallbacks: 0 }, thinking_aliases: { ocpaid: ["ocgoa"] } }));
  assert.throws(() => validate({ ...base, jev: { min_fallbacks: -1 } }), /min_fallbacks/);
  assert.throws(() => validate({ ...base, jev: { min_fallbacks: 1.5 } }), /min_fallbacks/);
  assert.throws(() => validate({ ...base, thinking_aliases: { ocpaid: "ocgoa" } }), /thinking_aliases/);
});
