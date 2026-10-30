import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRouter } from "../index.mjs";
import { applyThinkingToList, missingThinking, planThinking, validateThinking } from "../lib/thinking.mjs";
import { buildEffortPolicy, loadEffortData, unknownThinking } from "../ops/apply-effort-policy.mjs";

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
  } };
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
    jev: { mode: "on", threshold: 0.5, deadline_ms: 300, sources: [{ name: "a", url: "http://x", model: "jev" }] },
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
    jev: { mode: "on", threshold: 0.5, deadline_ms: 300, sources: [{ name: "a", url: "http://x", model: "jev" }] },
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
