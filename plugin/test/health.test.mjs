import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHealth, domainOf } from "../lib/health.mjs";
import { createRouter } from "../index.mjs";

const clock = () => { let t = 1_000_000; const f = () => t; f.adv = (ms) => { t += ms; }; return f; };
const att = (model, ok, status, kind = null) => ({ model, ok, status, kind, latencyMs: 10 });

test("a failing model cools with exponential backoff and recovers after its cooldown or a success", () => {
  const now = clock(), h = createHealth({ now });
  h.record({ attempts: [att("a/x", false, 502, "provider")] });
  assert.equal(h.isCooling("a/x"), true);
  now.adv(31_000); assert.equal(h.isCooling("a/x"), false); // 30 s base elapsed
  h.record({ attempts: [att("a/x", false, 502, "provider")] }); // second failure doubles it
  now.adv(31_000); assert.equal(h.isCooling("a/x"), true);
  now.adv(30_000); assert.equal(h.isCooling("a/x"), false);
  h.record({ attempts: [att("a/x", false, 502, "provider")] }); h.record({ attempts: [att("a/x", true, 200)] });
  assert.equal(h.isCooling("a/x"), false); // success resets
});

test("auth-like failures cool longer than transient ones; request-scoped 4xx never cool", () => {
  const now = clock(), h = createHealth({ now });
  h.record({ attempts: [att("a/auth", false, 403, "auth"), att("b/rate", false, 429, "rate_limit")] });
  now.adv(40_000);
  assert.equal(h.isCooling("a/auth"), true); // 60 s base
  assert.equal(h.isCooling("b/rate"), false); // 30 s base
  for (const st of [400, 404, 413, 422]) { h.record({ attempts: [att(`c/m${st}`, false, st, "model")] }); assert.equal(h.isCooling(`c/m${st}`), false, `status ${st}`); }
});

test("the same failure on two models of one connection cools the whole connection", () => {
  const now = clock(), h = createHealth({ now });
  h.record({ attempts: [att("ocfree/a", false, 403, "auth")] });
  assert.equal(h.isCooling("ocfree/never-tried"), false); // one model is not yet a connection problem
  h.record({ attempts: [att("ocfree/b", false, 403, "auth")] });
  assert.equal(h.isCooling("ocfree/never-tried"), true);
  assert.equal(h.isCooling("other/x"), false);
  h.record({ attempts: [att("ocfree/a", true, 200)] }); // any success clears the connection
  assert.equal(h.isCooling("ocfree/never-tried"), false);
});

test("OmniRoute's own pre-dispatch skips are followed briefly; demote keeps order inside each group", () => {
  const now = clock(), h = createHealth({ now });
  h.record({ attempts: [], skipped: [{ model: "a/2", reason: "provider_cooldown" }] });
  assert.deepEqual(h.demote(["a/1", "a/2", "a/3"]), ["a/1", "a/3", "a/2"]);
  now.adv(31_000); assert.deepEqual(h.demote(["a/1", "a/2", "a/3"]), ["a/1", "a/2", "a/3"]);
  assert.equal(domainOf("ocgoa/opencode-go/x"), "ocgoa");
});

function mk(jevClient) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevh-")), file = path.join(dir, "policy.json");
  const p = { limits: { max_main: 3, max_main_free: 3, max_spill: 2 }, log_file: "log.jsonl", jev: jevClient ? { mode: "shadow", sources: [] } : undefined,
    order: { paid: ["a/p1", "b/p2", "a/p3"], free: ["f/dead", "g/live", "f/dead2"] },
    models: Object.fromEntries(["a/p1", "b/p2", "a/p3", "f/dead", "g/live", "f/dead2"].map((i) => [i, { context_length: 1e6, tools: true, vision: true }])) };
  fs.writeFileSync(file, JSON.stringify(p));
  const now = clock();
  const r = createRouter({ policyFile: file, now, jev: jevClient, facts: { get: (pol) => Object.fromEntries([...pol.order.paid, ...pol.order.free].map((i) => [i, pol.models[i]])) } });
  return { r, now, logs: () => fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}
const free = (t = "hi") => ({ model: "free", requestId: "q", headers: {}, body: { messages: [{ role: "user", content: t }] } });

test("router: after the dead members fail, the next free list leads with the live one; recovery restores the order", async () => {
  const { r, now, logs } = mk();
  assert.equal((await r.onRoute(free())).models[0], "f/dead");
  r.onRouteResult({ requestId: "q", model: "free", status: 200, listed: [], attempts: [att("f/dead", false, 403, "auth"), att("f/dead2", false, 403, "auth"), att("g/live", true, 200)], skipped: [] });
  const out = await r.onRoute(free());
  assert.equal(out.models[0], "g/live");
  assert.deepEqual(out.models.slice(1).sort(), ["f/dead", "f/dead2"]); // demoted, not removed
  assert.deepEqual(logs().filter((l) => l.event === "decision").at(-1).demoted.sort(), ["f/dead", "f/dead2"]);
  assert.equal(logs().find((l) => l.event === "result").attempts.length, 3);
  now.adv(11 * 60_000); // cooldown over
  assert.equal((await r.onRoute(free())).models[0], "f/dead");
});

test("router: a continuation does not pin a member that is failing now", async () => {
  const { r } = mk();
  const h = { "x-omniroute-session-id": "s" };
  const first = await r.onRoute({ ...free(), headers: h });
  assert.equal(first.models[0], "f/dead");
  r.onRouteResult({ requestId: "q", model: "free", status: 200, attempts: [att("f/dead", false, 403, "auth"), att("f/dead2", false, 403, "auth"), att("g/live", true, 200)], skipped: [] });
  const msgs = [{ role: "user", content: "go" }, { role: "assistant", content: "", tool_calls: [{}] }, { role: "tool", content: "ok" }];
  const cont = await r.onRoute({ model: "free", headers: h, body: { messages: msgs } });
  assert.equal(cont.models[0], "g/live");
});

test("router: onRouteResult never throws on junk; Jev menu skips cooling candidates", async () => {
  const seen = [];
  const jev = { ask: async (_cfg, payload) => { seen.push(payload.ids.length); return { ok: false, error: "x", tried: [] }; } };
  const { r } = mk(jev);
  assert.doesNotThrow(() => { r.onRouteResult(null); r.onRouteResult({}); r.onRouteResult({ attempts: "no" }); });
  await r.onRoute({ model: "paid", requestId: "p", headers: {}, body: { messages: [{ role: "user", content: "hi" }] } });
  r.onRouteResult({ requestId: "p", model: "paid", status: 200, attempts: [att("a/p1", false, 502, "provider"), att("b/p2", true, 200)], skipped: [] });
  await r.onRoute({ model: "paid", requestId: "p2", headers: {}, body: { messages: [{ role: "user", content: "again" }] } });
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(seen, [3, 2]); // a/p1 is cooling, so Jev is offered two candidates
});

test("repeated auth failures back off to 30 minutes, transient ones cap at 10", () => {
  const now = clock(), h = createHealth({ now });
  for (let i = 0; i < 8; i++) { h.record({ attempts: [att("a/auth", false, 403, "auth"), att("b/prov", false, 502, "provider")] }); now.adv(1); }
  const snap = h.snapshot();
  assert.ok(snap["a/auth"].secs > 600 && snap["a/auth"].secs <= 1800, `auth secs ${snap["a/auth"].secs}`);
  assert.ok(snap["b/prov"].secs <= 600, `provider secs ${snap["b/prov"].secs}`);
});
