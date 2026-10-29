import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRouter } from "../index.mjs";
import { createJev } from "../lib/jev.mjs";
import { normalizeUsage, dailyUsage, outcomeOf } from "../lib/usage.mjs";

const REPORT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "report.mjs");
const usage = { prompt_tokens: 900, completion_tokens: 12, total_tokens: 912, prompt_tokens_details: { cached_tokens: 640 }, cost: 0.00042, list_cost: 0.0011, note: "text is dropped" };
const reply = (body) => ({ ok: true, status: 200, json: async () => body });
const good = (extra = {}) => reply({ model: "typesafe/jev-1.14", answers: { model: { choice: "c2", probabilities: { c1: 0.1, c2: 0.9 } }, effort: { choice: "hard" } }, usage, ...extra });
const src = (name) => ({ name, url: `http://x/${name}`, model: "~typesafe/jev-latest" });
const payload = { ids: ["c1", "c2"], state: {}, questions: {} };

test("normalizeUsage keeps numbers only and maps both naming styles to one shape", () => {
  assert.deepEqual(normalizeUsage(usage), { prompt_tokens: 900, completion_tokens: 12, cached_tokens: 640, total_tokens: 912, cost: 0.00042, list_cost: 0.0011 });
  assert.deepEqual(normalizeUsage({ input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 3 }), { prompt_tokens: 5, completion_tokens: 2, cached_tokens: 3 });
  assert.equal(normalizeUsage({ cost: "0.1", note: "x" }), undefined);
  assert.equal(normalizeUsage(null), undefined);
  assert.equal(normalizeUsage([1]), undefined);
});

test("client returns Jev's usage and served model id; a malformed answer still records what it billed", async () => {
  let n = 0;
  const jev = createJev({ fetchImpl: async () => (n++ ? good() : reply({ model: "typesafe/jev-1.14", answers: {}, usage: { prompt_tokens: 50, cost: 0.0001 } })) });
  const res = await jev.ask({ deadline_ms: 3000, sources: [src("a"), src("b")] }, payload);
  assert.equal(res.ok, true);
  assert.equal(res.model, "typesafe/jev-1.14");
  assert.deepEqual(res.usage, normalizeUsage(usage));
  assert.equal(res.tried[0].error, "malformed model answer");
  assert.deepEqual(res.tried[0].usage, { prompt_tokens: 50, cost: 0.0001 });
  // no usage in the response: the requested model id stands, no usage field
  const bare = await createJev({ fetchImpl: async () => good({ usage: undefined, model: undefined }) }).ask({ sources: [src("a")] }, payload);
  assert.equal(bare.model, "~typesafe/jev-latest");
  assert.equal("usage" in bare, false);
  const down = await createJev({ fetchImpl: async () => ({ ok: false, status: 503 }) }).ask({ sources: [src("a")] }, payload);
  assert.equal(down.ok, false);
  assert.equal(typeof down.latency_ms, "number");
  assert.equal(down.tried[0].usage, undefined);
});

function mk(mode, jevClient) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevu-")); const file = path.join(dir, "policy.json");
  const ids = ["a/p1", "b/p2", "c/p3"];
  fs.writeFileSync(file, JSON.stringify({
    limits: { max_main: 3, max_spill: 2 }, order: { paid: ids, free: ["f/x"] }, log_file: "log.jsonl",
    models: Object.fromEntries([...ids, "f/x"].map((i) => [i, { context_length: 1000000, tools: true, vision: true, traits: "general" }])),
    jev: { mode, threshold: 0.5, sources: [src("a")] },
  }));
  const r = createRouter({ policyFile: file, jev: jevClient, facts: { get: (pol) => Object.fromEntries([...pol.order.paid, ...pol.order.free].map((i) => [i, pol.models[i]])) } });
  return { r, raw: () => fs.readFileSync(path.join(dir, "log.jsonl"), "utf8"), jevRow: () => fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.event === "jev") };
}
const SECRET = "tolong rahasiakan kalimat unik ini";
const turn = { model: "paid", requestId: "r1", headers: {}, body: { messages: [{ role: "user", content: SECRET }] } };
const settle = () => new Promise((res) => setTimeout(res, 20));
const hit = (confidence, extra = {}) => ({ ok: true, source: "a", model: "typesafe/jev-1.14", latency_ms: 7, usage: { prompt_tokens: 900, completion_tokens: 12, cost: 0.0004 }, index: 1, choice: "c2", probabilities: { c1: 0.1, c2: 0.9 }, confidence, effort: "hard", tried: [], ...extra });

test("the jev log entry carries usage, latency, model id and outcome, never the prompt text", async () => {
  for (const [mode, res, outcome] of [
    ["on", hit(0.85), "applied"],
    ["on", hit(0.2), "unconfident"],
    ["shadow", hit(0.85), "shadow"],
    ["on", { ok: false, error: "no source answered", latency_ms: 1200, tried: [{ source: "a", error: "HTTP 503", latency_ms: 1200 }] }, "unavailable"],
  ]) {
    const { r, raw, jevRow } = mk(mode, { ask: async () => res });
    await r.onRoute(turn); await settle();
    const j = jevRow();
    assert.equal(j.outcome, outcome, `${mode} ${outcome}`);
    assert.equal(typeof j.latency_ms, "number");
    if (res.ok) {
      assert.equal(j.jev_model, "typesafe/jev-1.14");
      assert.deepEqual(j.usage, { prompt_tokens: 900, completion_tokens: 12, cost: 0.0004 });
    }
    assert.equal(raw().includes(SECRET), false);
  }
});

test("dailyUsage sums calls, outcomes, tokens and cost per UTC day, counting billed failed attempts", () => {
  const rows = [
    { t: "2026-10-28T23:59:00.000Z", event: "jev", ok: true, outcome: "applied", jev_model: "m1", usage: { prompt_tokens: 100, completion_tokens: 5, cached_tokens: 60, cost: 0.001, list_cost: 0.002 } },
    { t: "2026-10-28T10:00:00.000Z", event: "jev", ok: true, outcome: "unconfident", jev_model: "m1", usage: { prompt_tokens: 50, completion_tokens: 3 }, tried: [{ source: "a", error: "malformed model answer", usage: { prompt_tokens: 40, cost: 0.0005 } }] },
    { t: "2026-10-29T01:00:00.000Z", event: "jev", ok: false, outcome: "unavailable", tried: [{ source: "a", error: "HTTP 503" }] },
    { t: "2026-10-29T02:00:00.000Z", event: "jev", ok: true, mode: "shadow" }, // pre-usage row
    { t: "2026-10-29T02:00:00.000Z", event: "decision" },
  ];
  const d = dailyUsage(rows);
  assert.deepEqual(Object.keys(d), ["2026-10-28", "2026-10-29"]);
  assert.deepEqual(d["2026-10-28"], { calls: 2, answered: 2, outcomes: { applied: 1, unconfident: 1 }, prompt_tokens: 190, completion_tokens: 8, cached_tokens: 60, cost: 0.0015, list_cost: 0.002, priced: 2, models: { m1: 2 } });
  assert.deepEqual(d["2026-10-29"].outcomes, { unavailable: 1, answered: 1 });
  assert.equal(d["2026-10-29"].priced, 0);
  assert.equal(outcomeOf({ ok: false }), "unavailable");
});

test("report prints the per-day Jev usage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevr-")); const file = path.join(dir, "d.jsonl");
  fs.writeFileSync(file, [
    { t: "2026-10-29T01:00:00.000Z", event: "jev", ok: true, outcome: "applied", source: "a", latency_ms: 9, confidence: 0.8, pool: "paid", pick: "a/p1", jev_model: "m1", usage: { prompt_tokens: 100, completion_tokens: 5, cached_tokens: 60, cost: 0.001, list_cost: 0.002 } },
    { t: "2026-10-29T02:00:00.000Z", event: "decision" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = execFileSync(process.execPath, [REPORT, file], { encoding: "utf8" });
  assert.match(out, /jev usage per day \(UTC\):/);
  assert.match(out, /2026-10-29: 1 calls \(applied=1\), tokens in 100 \(cached 60\) out 5, cost \$0\.00100 list \$0\.00200, models m1/);
});
