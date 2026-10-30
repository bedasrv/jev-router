import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRouter } from "../index.mjs";
import { createJev } from "../lib/jev.mjs";
import { normalizeUsage, dailyUsage, outcomeOf, isUnpriced } from "../lib/usage.mjs";

const REPORT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "report.mjs");
const usage = { prompt_tokens: 900, completion_tokens: 12, total_tokens: 912, prompt_tokens_details: { cached_tokens: 640 }, cost: 0.00042, list_cost: 0.0011, note: "text is dropped" };
// The shape a live OpenRouter typesafe/jev-1.13 call returned (rev-1, 2026-10-29).
const LIVE = { model: "typesafe/jev-1.13-20260917", answers: { model: { choice: "c2", probabilities: { c1: 0.1, c2: 0.9 } }, effort: { choice: "normal" } }, usage: { input_tokens: 761, output_tokens: 80, cost: 0.000031962 }, id: "gen-1", provider: "TypeSafe" };
const reply = (body) => ({ ok: true, status: 200, json: async () => body });
const good = (extra = {}) => reply({ model: "typesafe/jev-1.14", answers: { model: { choice: "c2", probabilities: { c1: 0.1, c2: 0.9 } }, effort: { choice: "hard" } }, usage, ...extra });
const src = (name) => ({ name, url: `http://x/${name}`, model: "~typesafe/jev-latest" });
const payload = { ids: ["c1", "c2"], state: {}, questions: {} };

test("normalizeUsage keeps numbers only, maps both naming styles, and turns money into integer nano-USD", () => {
  assert.deepEqual(normalizeUsage(LIVE.usage), { prompt_tokens: 761, completion_tokens: 80, cost_nusd: 31962 });
  assert.deepEqual(normalizeUsage(usage), { prompt_tokens: 900, completion_tokens: 12, cached_tokens: 640, total_tokens: 912, cost_nusd: 420000, list_cost_nusd: 1100000 });
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
  assert.equal(res.served_model, "typesafe/jev-1.14");
  assert.equal(res.requested_model, "~typesafe/jev-latest");
  assert.deepEqual(res.usage, normalizeUsage(usage));
  assert.equal(res.tried[0].error, "malformed model answer");
  assert.deepEqual(res.tried[0].usage, { prompt_tokens: 50, cost_nusd: 100000 });
  assert.equal(res.tried[0].served_model, "typesafe/jev-1.14");
  const live = await createJev({ fetchImpl: async () => reply(LIVE) }).ask({ sources: [src("a")] }, payload);
  assert.equal(live.model, "typesafe/jev-1.13-20260917");
  assert.deepEqual(live.usage, { prompt_tokens: 761, completion_tokens: 80, cost_nusd: 31962 });
  // no usage in the response: the requested model id stands, no usage field
  const bare = await createJev({ fetchImpl: async () => good({ usage: undefined, model: undefined }) }).ask({ sources: [src("a")] }, payload);
  assert.equal(bare.model, "~typesafe/jev-latest");
  assert.equal("served_model" in bare, false); // the alias is not a served id
  assert.equal(bare.requested_model, "~typesafe/jev-latest");
  assert.equal("usage" in bare, false);
  // a failed attempt that named its model but sent no usage still records the served id
  const noUsage = await createJev({ fetchImpl: async () => reply({ model: "typesafe/jev-1.15", answers: {} }) }).ask({ sources: [src("a")] }, payload);
  assert.equal(noUsage.ok, false);
  assert.equal(noUsage.tried[0].served_model, "typesafe/jev-1.15");
  assert.equal(noUsage.tried[0].usage, undefined);
  const down = await createJev({ fetchImpl: async () => ({ ok: false, status: 503 }) }).ask({ sources: [src("a")] }, payload);
  assert.equal(down.ok, false);
  assert.equal(typeof down.latency_ms, "number");
  assert.equal(down.tried[0].usage, undefined);
  assert.equal(down.tried[0].served_model, undefined); // no body, no id
  assert.equal(down.tried[0].timeout, undefined); // an HTTP error is not a timeout
  // aborted by source_timeout_ms after sending: flagged, so the report can say cost is a lower bound
  const slow = createJev({ fetchImpl: (url, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(signal.reason))) });
  const cut = await slow.ask({ deadline_ms: 3000, source_timeout_ms: 30, sources: [src("a")] }, payload);
  assert.equal(cut.tried[0].timeout, true);
  assert.equal(isUnpriced(cut.tried[0]), true);
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
const hit = (confidence, extra = {}) => ({ ok: true, source: "a", model: "typesafe/jev-1.14", served_model: "typesafe/jev-1.14", requested_model: "~typesafe/jev-latest", latency_ms: 7, usage: { prompt_tokens: 900, completion_tokens: 12, cost_nusd: 400000 }, index: 1, choice: "c2", probabilities: { c1: 0.1, c2: 0.9 }, confidence, effort: "hard", tried: [], ...extra });

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
      assert.equal(j.served_model, "typesafe/jev-1.14");
      assert.equal(j.requested_model, "~typesafe/jev-latest");
      assert.deepEqual(j.usage, { prompt_tokens: 900, completion_tokens: 12, cost_nusd: 400000 });
    }
    assert.equal(raw().includes(SECRET), false);
  }
});

test("dailyUsage sums integer nano-USD, outcomes and tokens per UTC day, and counts unpriced timeouts", () => {
  const rows = [
    { t: "2026-10-28T23:59:00.000Z", event: "jev", ok: true, outcome: "applied", jev_model: "m1", usage: { prompt_tokens: 100, completion_tokens: 5, cached_tokens: 60, cost_nusd: 1000000, list_cost_nusd: 2000000 } },
    { t: "2026-10-28T10:00:00.000Z", event: "jev", ok: true, outcome: "unconfident", jev_model: "m1", usage: { prompt_tokens: 50, completion_tokens: 3 }, tried: [{ source: "a", error: "malformed model answer", usage: { prompt_tokens: 40, cost_nusd: 500000 } }] },
    { t: "2026-10-29T01:00:00.000Z", event: "jev", ok: false, outcome: "unavailable", tried: [{ source: "a", error: "HTTP 503" }, { source: "b", error: "The operation was aborted due to timeout", timeout: true }, { source: "c", error: "cooling" }] },
    { t: "2026-10-29T01:30:00.000Z", event: "jev", ok: true, outcome: "applied", usage: { cost_nusd: 31962 }, tried: [{ source: "a", error: "The operation was aborted due to timeout" }] }, // pre-flag row
    { t: "2026-10-29T02:00:00.000Z", event: "jev", ok: true, mode: "shadow" }, // pre-usage row
    { t: "2026-10-29T02:00:00.000Z", event: "decision" },
  ];
  const d = dailyUsage(rows);
  assert.deepEqual(Object.keys(d), ["2026-10-28", "2026-10-29"]);
  assert.deepEqual(d["2026-10-28"], { calls: 2, answered: 2, outcomes: { applied: 1, unconfident: 1 }, prompt_tokens: 190, completion_tokens: 8, cached_tokens: 60, cost_nusd: 1500000, list_cost_nusd: 2000000, priced: 2, list_priced: 1, unpriced_attempts: 0, served: { m1: 2 } });
  assert.deepEqual(d["2026-10-29"].outcomes, { unavailable: 1, applied: 1, answered: 1 });
  assert.equal(d["2026-10-29"].priced, 1);
  assert.equal(d["2026-10-29"].list_priced, 0);
  assert.equal(d["2026-10-29"].unpriced_attempts, 2);
  // served ids: the answer's served_model and failed attempts that named one; the alias fallback never counts
  const s = dailyUsage([
    { t: "2026-10-30T01:00:00Z", event: "jev", ok: true, jev_model: "jev-1.15", served_model: "jev-1.15", requested_model: "~jev-latest", tried: [{ source: "a", error: "malformed model answer", served_model: "jev-1.14" }] },
    { t: "2026-10-30T02:00:00Z", event: "jev", ok: true, jev_model: "~jev-latest", requested_model: "~jev-latest" },
    { t: "2026-10-30T03:00:00Z", event: "jev", ok: false, tried: [{ source: "a", error: "malformed effort answer", served_model: "jev-1.15" }, { source: "b", error: "HTTP 503" }] },
  ]);
  assert.deepEqual(s["2026-10-30"].served, { "jev-1.15": 2, "jev-1.14": 1 });
  // 10,000 live-size calls sum exactly (floats gave 4.200000000000621 for 10,000 x 0.00042)
  const many = dailyUsage(Array.from({ length: 10000 }, () => ({ t: "2026-10-30T00:00:00Z", event: "jev", ok: true, usage: normalizeUsage({ cost: 0.00042 }) })));
  assert.equal(many["2026-10-30"].cost_nusd, 4200000000);
  assert.equal(outcomeOf({ ok: false }), "unavailable");
});

test("report prints the per-day Jev usage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevr-")); const file = path.join(dir, "d.jsonl");
  fs.writeFileSync(file, [
    { t: "2026-10-29T01:00:00.000Z", event: "jev", ok: true, outcome: "applied", source: "a", latency_ms: 9, confidence: 0.8, pool: "paid", pick: "a/p1", jev_model: "m1", usage: { prompt_tokens: 100, completion_tokens: 5, cached_tokens: 60, cost_nusd: 31962 } },
    { t: "2026-10-29T01:30:00.000Z", event: "jev", ok: false, outcome: "unavailable", tried: [{ source: "a", error: "timeout", timeout: true }] },
    { t: "2026-10-29T02:00:00.000Z", event: "decision" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = execFileSync(process.execPath, [REPORT, file], { encoding: "utf8" });
  assert.match(out, /jev usage per day \(UTC\):/);
  assert.match(out, /2026-10-29: 2 calls \(applied=1 unavailable=1\), tokens in 100 \(cached 60\) out 5, cost \$0\.000031962 list n\/a \(lower bound: 1 timed-out attempts without usage\), served m1=1/);
  assert.doesNotMatch(out, /served Jev model changed/);
});

test("report flags the day the served Jev model changes (alias moved)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevr-")); const file = path.join(dir, "d.jsonl");
  const row = (t, served) => ({ t, event: "jev", ok: true, outcome: "unconfident", requested_model: "~typesafe/jev-latest", jev_model: served ?? "~typesafe/jev-latest", ...(served ? { served_model: served } : {}) });
  fs.writeFileSync(file, [
    row("2026-10-28T10:00:00Z", "typesafe/jev-1.13-20260917"),
    row("2026-10-29T10:00:00Z", null), // no served id that day: not a change
    row("2026-10-30T10:00:00Z", "typesafe/jev-1.14-20261014"),
    row("2026-10-30T11:00:00Z", "typesafe/jev-1.14-20261014"),
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = execFileSync(process.execPath, [REPORT, file], { encoding: "utf8" });
  assert.match(out, /2026-10-29: 1 calls .*served n\/a/);
  assert.match(out, /2026-10-30: 2 calls .*served typesafe\/jev-1\.14-20261014=2/);
  assert.match(out, /served Jev model changed on 2026-10-30: typesafe\/jev-1\.13-20260917 -> typesafe\/jev-1\.14-20261014/);
  assert.equal(out.match(/served Jev model changed/g).length, 1);
});
