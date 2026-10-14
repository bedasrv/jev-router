import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRouter } from "../index.mjs";
import { inspectRequest, eligible } from "../lib/eligibility.mjs";
import { alternate } from "../lib/builder.mjs";
import { validate } from "../lib/policy.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevr-"));
const basePolicy = () => ({
  limits: { max_main: 3, max_spill: 2 },
  order: { paid: ["a/p1", "b/p2", "a/p3", "c/p4"], free: ["f/x", "g/y"] },
  denylist: ["a/p3"],
  models: {
    "a/p1": { context_length: 1000000, tools: true, vision: true },
    "b/p2": { context_length: 200000, tools: true, vision: false },
    "a/p3": { context_length: 1000000, tools: true, vision: true },
    "c/p4": { context_length: 1000000, tools: true, vision: true },
    "f/x": { context_length: 262144, tools: true, vision: null },
    "g/y": { tools: null },
  },
});
function mk(policy = basePolicy()) {
  const dir = tmp(); const file = path.join(dir, "policy.json");
  policy.log_file = "log.jsonl";
  fs.writeFileSync(file, JSON.stringify(policy));
  const r = createRouter({ policyFile: file, facts: { get: (p) => Object.fromEntries([...p.order.paid, ...p.order.free].map((i) => [i, p.models[i] ?? {}])) } });
  return { r, dir, file };
}
const user = (t, extra = {}) => ({ model: "paid", body: { messages: [{ role: "user", content: t }], ...extra }, headers: {} });

test("passes other models untouched", async () => {
  const { r } = mk();
  assert.equal(await r.onRoute({ model: "gpt-4o", body: { messages: [] } }), undefined);
});
test("paid: denylist dropped, domains alternate, then free spill", async () => {
  const { r } = mk();
  const out = await r.onRoute(user("hi"));
  assert.deepEqual(out.models, ["a/p1", "b/p2", "c/p4", "f/x", "g/y"]);
});
test("tools request excludes tools:null", async () => {
  const { r } = mk();
  const out = await r.onRoute(user("hi", { tools: [{ type: "function", function: { name: "t" } }] }));
  assert.ok(!out.models.includes("g/y"));
});
test("image request needs vision:true", async () => {
  const { r } = mk();
  const out = await r.onRoute({ model: "paid", headers: {}, body: { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] } });
  assert.ok(!out.models.includes("b/p2") && !out.models.includes("f/x"));
});
test("window: large input drops small-window members", async () => {
  const { r } = mk();
  const out = await r.onRoute(user("x".repeat(4 * 300000)));
  assert.ok(!out.models.includes("b/p2") && !out.models.includes("f/x"));
  assert.equal(out.models[0], "a/p1");
});
test("no fit returns widest windows instead of nothing", async () => {
  const { r } = mk();
  const out = await r.onRoute(user("x".repeat(4 * 5000000)));
  assert.ok(out.models.length > 0);
});
test("free pool never crosses into paid", async () => {
  const { r } = mk();
  const out = await r.onRoute({ ...user("hi"), model: "free" });
  assert.deepEqual(out.models, ["f/x", "g/y"]);
});
test("continuation reuse (tool result turn)", async () => {
  const { r, file } = mk();
  const h = { "x-omniroute-session-id": "s2" };
  const msgs = [{ role: "user", content: "go" }];
  const first = await r.onRoute({ model: "paid", headers: h, body: { messages: msgs } });
  const pol = JSON.parse(fs.readFileSync(file, "utf8"));
  pol.order.paid = ["c/p4", "a/p1", "b/p2"]; fs.writeFileSync(file, JSON.stringify(pol));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const cont = await r.onRoute({ model: "paid", headers: h, body: { messages: [...msgs, { role: "assistant", content: "", tool_calls: [{}] }, { role: "tool", content: "ok" }] } });
  assert.equal(cont.models[0], first.models[0]);
  const fresh = await r.onRoute({ model: "paid", headers: h, body: { messages: [...msgs, { role: "assistant", content: "done" }, { role: "user", content: "next" }] } });
  assert.equal(fresh.models[0], "c/p4");
});
test("invalid policy keeps last good one; garbage at start fails open", async () => {
  const { r, file } = mk();
  assert.ok((await r.onRoute(user("hi"))).models.length);
  fs.writeFileSync(file, "{not json"); fs.utimesSync(file, new Date(), new Date(Date.now() + 9000));
  assert.ok((await r.onRoute(user("hi"))).models.length);
  const { r: r2, file: f2 } = mk(); fs.writeFileSync(f2, "{nope");
  assert.equal(await r2.onRoute(user("hi")), undefined);
});
test("decision log has hashes, never prompt text", async () => {
  const { r, dir } = mk();
  await r.onRoute(user("SECRET-PROMPT-TEXT"));
  const log = fs.readFileSync(path.join(dir, "log.jsonl"), "utf8");
  assert.ok(log.includes('"event":"decision"') && !log.includes("SECRET-PROMPT-TEXT"));
});
test("an id present in both pools appears once", async () => {
  const p = basePolicy(); p.order.free = ["a/p1", "f/x"]; p.models["a/p1"].tools = true;
  const { r } = mk(p);
  const out = await r.onRoute(user("hi"));
  assert.equal(new Set(out.models).size, out.models.length);
});
test("helpers", () => {
  assert.throws(() => validate({ order: { paid: [1], free: [] } }));
  assert.equal(eligible({ tools: true, context_length: 100000 }, inspectRequest({ messages: [{ role: "user", content: "x" }] })).ok, true);
  assert.deepEqual(alternate(["a/1", "a/2", "b/1"], {}), ["a/1", "b/1", "a/2"]);
});
test("last_resort is appended after the cap, once, and only if eligible", async () => {
  const p = basePolicy(); p.last_resort = { free: "l/last", paid: "l/last" }; p.models["l/last"] = { tools: null };
  const { r } = mk(p);
  let out = await r.onRoute({ ...user("hi"), model: "free" });
  assert.equal(out.models.at(-1), "l/last");
  out = await r.onRoute({ ...user("hi", { tools: [{}] }), model: "free" });
  assert.ok(!out.models.includes("l/last")); // tools unknown -> ineligible
});
test("an id missing from a loaded listing is excluded as not_listed", async () => {
  const p = basePolicy(); p.models["a/p1"].unlisted = true;
  const { r } = mk(p);
  const out = await r.onRoute(user("hi"));
  assert.ok(!out.models.includes("a/p1"));
});
test("isFresh: tool result followed by a synthetic user message is a continuation", async () => {
  const { isFresh } = await import("../lib/sessions.mjs");
  const u = (c) => ({ role: "user", content: c }), a = { role: "assistant", content: "", tool_calls: [{}] }, tl = { role: "tool", content: "ok" };
  assert.equal(isFresh({ messages: [u("go")] }), true);
  assert.equal(isFresh({ messages: [u("go"), a, tl] }), false);
  assert.equal(isFresh({ messages: [u("go"), a, tl, u("reminder")] }), false);
  assert.equal(isFresh({ messages: [u("go"), a, tl, { role: "assistant", content: "done" }, u("next"), u("extra")] }), true);
  assert.equal(isFresh({ messages: [] }), false);
});
