// UP-16 (warslop SPEC, owner delegation 2026-11-07): no Jev routing call on the free pool. A free fresh turn serves
// F2 (beam-free at the provider default) without asking Jev; the UP-2a small-talk list may still lower the effort to
// F1; Jev stays on paid fresh turns. x-router-reason says static:skip when no choice call was made, so warslop's
// LIM-8 upper bound can tell "Jev was asked and unconfident" (static, a real call) from "Jev skipped" (no call).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRouter } from "../index.mjs";
import { validate } from "../lib/policy.mjs";
import { isSmallTalk } from "../lib/easy.mjs";

const MENU = JSON.parse(fs.readFileSync(new URL("../ops/menu.example.json", import.meta.url)));
delete MENU._comment;
const DS = "ocpaid/opencode-go/deepseek-v4.1-flash", MUSE = "ocpaid/opencode-go/muse-spark-1.3-contributor",
  GLM = "ocpaid/opencode-go/glm-5.3-flash", BEAM = "ocpaid/opencode-go/beam-free";
const facts = {
  [DS]: { context_length: 1000000, tools: true, vision: true },
  [MUSE]: { context_length: 1000000, tools: true, vision: true },
  [GLM]: { context_length: 200000, tools: true, vision: false },
  [BEAM]: { context_length: 262144, tools: true, vision: false },
};
const policy = (jev = {}) => ({
  log_file: "log.jsonl",
  order: { paid: [DS, MUSE, GLM], free: [BEAM] },
  models: facts,
  jev: { mode: "on", threshold: 0.6, session_header: "x-opencode-session", skip_sessions: ["canary"], pools: ["paid"], ...jev },
  menu: structuredClone(MENU),
});

// A fake Jev that answers with a chosen item id (by reading the shuffled order) at a given confidence.
function fakeJev() {
  const calls = [];
  let next = null;
  return {
    calls,
    answer(item, confidence = 0.95) { next = { item, confidence }; },
    unavailable() { next = { down: true }; },
    async ask(cfg, payload) {
      calls.push(payload);
      if (!next || next.down) return { ok: false, error: "no source answered", tried: [{ source: "x", error: "HTTP 503" }] };
      const index = payload.order.indexOf(next.item);
      if (index < 0) throw new Error(`item ${next.item} was not offered: ${payload.order}`);
      const n = payload.order.length, c = next.confidence;
      const top = c * (1 - 1 / n) + 1 / n; // inverse of confidence()
      const probabilities = Object.fromEntries(payload.ids.map((id, k) => [id, k === index ? top : (1 - top) / (n - 1)]));
      return { ok: true, index, confidence: c, probabilities, source: "fake", model: "jev", latency_ms: 5, tried: [] };
    },
  };
}

function mk(p = policy()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev16-"));
  const file = path.join(dir, "policy.json");
  fs.writeFileSync(file, JSON.stringify(p));
  const jev = fakeJev();
  const r = createRouter({ policyFile: file, jev, facts: { get: (pp) => ({ ...pp.models }) } });
  const logs = () => fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { r, jev, logs };
}

let seq = 0;
const turn = (pool, text, { conv = "conv-1", history = [], extra = {}, headers = {} } = {}) => ({
  model: pool, requestId: `u16-${++seq}`,
  headers: { "x-opencode-session": conv, ...headers },
  body: { messages: [{ role: "system", content: "sys" }, ...history, { role: "user", content: text }], ...extra },
});

test("UP-16: a free fresh turn makes no Jev call and is served by F2's model at the provider default", async () => {
  const { r, jev, logs } = mk();
  jev.answer("F3"); // if the router asked, it would apply this
  const out = await r.onRoute(turn("free", "apa itu fotosintesis?", { conv: "f2" }));
  assert.equal(jev.calls.length, 0, "no choice call on the free pool");
  assert.equal(out.item, "F2");
  assert.deepEqual(out.models, [BEAM]);
  assert.deepEqual(out.thinking_by_model, { [BEAM]: { control: "none" } });
  assert.deepEqual(out.thinking, { control: "none" }); // the provider default, no effort field
  assert.equal(out.reason, "static:skip");
  const d = logs().find((l) => l.event === "decision");
  assert.equal(d.pool, "free");
  assert.equal(d.item, "F2");
  assert.equal(d.source, "default");
  assert.equal(d.jev_skipped, true);
  assert.equal(d.jev, undefined); // no Jev answer to log: nothing was asked
});

test("UP-16: the UP-2a small-talk list still lowers the free turn's effort (F1, low) without a Jev call", async () => {
  const { r, jev } = mk();
  for (const [conv, text] of [["e1", "halo kak"], ["e2", "makasih ya"], ["e3", "selamat malam!"], ["e4", "apa kabar?"], ["e5", "who are you"]]) {
    const out = await r.onRoute(turn("free", text, { conv }));
    assert.equal(out.item, "F1", text);
    assert.deepEqual(out.thinking_by_model, { [BEAM]: { control: "effort", value: "low" } }, text);
    assert.equal(out.reason, "static:skip");
  }
  assert.equal(jev.calls.length, 0);
  // an everyday or hard ask keeps F2 (the provider default): small talk is the only lowered case
  for (const [conv, text] of [["e6", "ringkas teks berikut: " + "x".repeat(300)], ["e7", "jelaskan fotosintesis"], ["e8", "buat rencana usaha kopi"]]) {
    const out = await r.onRoute(turn("free", text, { conv }));
    assert.equal(out.item, "F2", text);
    assert.deepEqual(out.thinking_by_model, { [BEAM]: { control: "none" } }, text);
  }
});

test("UP-16: the UP-2a lowering is not applied to a stateless API call (the app never tiers one)", async () => {
  const { r, jev } = mk();
  const out = await r.onRoute(turn("free", "halo kak", { conv: "v12" }));
  assert.equal(out.item, "F2");
  assert.deepEqual(out.thinking_by_model, { [BEAM]: { control: "none" } });
  assert.equal(out.reason, "static:skip");
  assert.equal(jev.calls.length, 0);
});

test("UP-16: a paid fresh turn is unchanged: Jev is asked and its pick stands", async () => {
  const { r, jev, logs } = mk();
  jev.answer("P3");
  const out = await r.onRoute(turn("paid", "pasal berapa", { conv: "p1" }));
  assert.equal(jev.calls.length, 1);
  assert.equal(out.item, "P3");
  assert.equal(out.reason, "jev");
  assert.equal(out.confidence, 0.95);
  assert.equal(logs().at(-1).jev.outcome, "applied");
});

test("UP-16: the skip is per pool, not per session: one session id still reaches Jev on paid", async () => {
  const { r, jev } = mk();
  const free = await r.onRoute(turn("free", "halo", { conv: "shared" }));
  assert.equal(free.item, "F1");
  assert.equal(jev.calls.length, 0);
  jev.answer("P2");
  const paid = await r.onRoute(turn("paid", "halo", { conv: "shared" }));
  assert.equal(paid.item, "P2");
  assert.equal(jev.calls.length, 1);
});

test("UP-16: a free continuation keeps the turn's item without a call, and says static:cont", async () => {
  const { r, jev } = mk();
  const t = turn("free", "halo", { conv: "fc" });
  assert.equal((await r.onRoute(t)).item, "F1");
  const cont = await r.onRoute({ ...t, requestId: "u16-cont", body: { messages: [...t.body.messages, { role: "assistant", content: "", tool_calls: [{ id: "t" }] }, { role: "tool", content: "ok" }] } });
  assert.equal(cont.item, "F1");
  assert.deepEqual(cont.thinking_by_model, { [BEAM]: { control: "effort", value: "low" } });
  assert.equal(cont.reason, "static:cont");
  assert.equal(jev.calls.length, 0);
});

test("UP-16: without jev.pools the free pool still asks Jev (the old behaviour is the default)", async () => {
  const p = policy();
  delete p.jev.pools;
  const { r, jev } = mk(p);
  jev.answer("F3");
  const out = await r.onRoute(turn("free", "x", { conv: "old" }));
  assert.equal(jev.calls.length, 1);
  assert.equal(out.item, "F3");
  assert.equal(out.reason, "jev");
});

test("UP-16: x-router-reason says static:skip when no choice call was made, static when Jev answered and did not apply", async () => {
  const { r, jev, logs } = mk();
  // asked and unconfident: a call was made (and billed), so the upper bound must still draw
  jev.answer("P3", 0.2);
  const unconfident = await r.onRoute(turn("paid", "a", { conv: "r1" }));
  assert.equal(unconfident.reason, "static");
  assert.equal(logs().at(-1).jev.outcome, "unconfident");
  assert.equal(logs().at(-1).jev_skipped, undefined);
  // asked and unavailable: also a call was attempted
  jev.unavailable();
  assert.equal((await r.onRoute(turn("paid", "b", { conv: "r2" }))).reason, "static");
  // not asked: a skip-listed session
  const calls = jev.calls.length;
  const canary = await r.onRoute(turn("paid", "c", { conv: "canary" }));
  assert.equal(canary.reason, "static:skip");
  assert.equal(jev.calls.length, calls);
  assert.equal(logs().at(-1).jev_skipped, true);
  // not asked: mode off
  const { r: off, jev: joff } = mk(policy({ mode: "off" }));
  assert.equal((await off.onRoute(turn("paid", "d", { conv: "r3" }))).reason, "static:skip");
  assert.equal(joff.calls.length, 0);
});

test("UP-16: jev.pools is policy data, validated when the policy loads", () => {
  validate(policy());
  validate(policy({ pools: ["free"] }));
  const bad = (pools) => assert.throws(() => validate(policy({ pools })), /jev\.pools/);
  bad([]);
  bad("paid");
  bad(["paid", "paid"]);
  bad(["premium"]);
});

test("UP-16: the UP-2a small-talk classifier is conservative, like the app's", () => {
  for (const yes of ["halo", "Hai!", "makasih kak", "terima kasih", "ok sip", "selamat pagi", "siapa kamu", "hello how are you", "👍 ok", "tes"]) assert.equal(isSmallTalk(yes), true, yes);
  for (const no of ["", "👍", "jelaskan fotosintesis", "apa itu fotosintesis?", "halo, jelaskan fotosintesis", "buat kode python", "x".repeat(200), "ringkas teks berikut: " + "y".repeat(300)]) assert.equal(isSmallTalk(no), false, no);
});
