// UP-10c: the (model + thinking) menu. Jev picks one pair per turn in both pools; stickiness; per-attempt thinking;
// eligibility (images, the cost-ratio cutoff); Jev unavailable; the decision and result logs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRouter } from "../index.mjs";
import { validate } from "../lib/policy.mjs";
import { buildMenuPayload, createJev } from "../lib/jev.mjs";
import { cachedShare, cachedShareCutoff, costRatio, stickyChoice, attemptsFor, DEFAULT_STICKY } from "../lib/menu.mjs";
import { inspectRequest } from "../lib/eligibility.mjs";

const MENU = JSON.parse(fs.readFileSync(new URL("../ops/menu.example.json", import.meta.url)));
delete MENU._comment;
const DS = "ocpaid/opencode-go/deepseek-v4.1-flash", MUSE = "ocpaid/opencode-go/muse-spark-1.3-contributor",
  MIMO = "ocpaid/opencode-go/mimo-v2.6-flash", GLM = "ocpaid/opencode-go/glm-5.3-flash", BEAM = "ocpaid/opencode-go/beam-free",
  KIMI = "ocpaid/opencode-go/kimi-k3.1-pro", GLMB = "ocpaid/opencode-go/glm-5.3", MIMOP = "ocpaid/opencode-go/mimo-v2.6-pro",
  MMX = "ocpaid/opencode-go/minimax-m3.1-flash", LUNA = "ocpaid/opencode-go/gpt-6-luna";
const facts = {
  [DS]: { context_length: 1000000, tools: true, vision: true },
  [MUSE]: { context_length: 1000000, tools: true, vision: true },
  [MIMO]: { context_length: 262144, tools: true, vision: false },
  [GLM]: { context_length: 200000, tools: true, vision: false },
  [BEAM]: { context_length: 262144, tools: true, vision: false },
  [KIMI]: { context_length: 1048576, tools: true, vision: true },
  [GLMB]: { context_length: 1000000, tools: true, vision: false },
  [MIMOP]: { context_length: 1048576, tools: true, vision: true },
  [MMX]: { context_length: 1000000, tools: true, vision: false },
  [LUNA]: { context_length: 1050000, tools: true, vision: true },
};
const STANDARD = MENU.items.filter((i) => !i.specialist), SPECIALISTS = MENU.items.filter((i) => i.specialist);
const metered = () => ({ ...structuredClone(MENU), metering: true });
const policy = (menu = MENU, jev = {}) => ({
  log_file: "log.jsonl",
  order: { paid: [DS, MUSE, GLM], free: [BEAM] },
  models: facts,
  jev: { mode: "on", threshold: 0.85, session_header: "x-opencode-session", skip_sessions: ["canary"], ...jev },
  menu: structuredClone(menu),
});

// A fake Jev that answers with a chosen item id (by reading the shuffled order) at a given confidence.
function fakeJev() {
  const calls = [];
  let next = null;
  return {
    calls,
    answer(item, confidence = 0.95, kind = null, kindConfidence = 0.95) { next = { item, confidence, kind, kindConfidence }; },
    unavailable() { next = { down: true }; },
    async ask(cfg, payload) {
      calls.push(payload);
      if (!next || next.down) return { ok: false, error: "no source answered", tried: [{ source: "x", error: "HTTP 503" }] };
      const index = payload.order.indexOf(next.item);
      if (index < 0) throw new Error(`item ${next.item} was not offered: ${payload.order}`);
      const n = payload.order.length, c = next.confidence;
      const top = c * (1 - 1 / n) + 1 / n; // inverse of confidence()
      const probabilities = Object.fromEntries(payload.ids.map((id, k) => [id, k === index ? top : (1 - top) / (n - 1)]));
      const kindQ = payload.questions.kind ? { kind: next.kind ?? "general", kind_confidence: next.kindConfidence } : {};
      return { ok: true, index, confidence: c, probabilities, ...kindQ, source: "fake", model: "jev", latency_ms: 5, tried: [] };
    },
  };
}

function mk(p = policy()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevm-"));
  const file = path.join(dir, "policy.json");
  fs.writeFileSync(file, JSON.stringify(p));
  const jev = fakeJev();
  const r = createRouter({ policyFile: file, jev, facts: { get: (pp) => ({ ...pp.models }) } });
  const logs = () => fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { r, jev, logs, dir, file };
}

let seq = 0;
const turn = (pool, text, { conv = "conv-1", history = [], extra = {}, headers = {} } = {}) => ({
  model: pool, requestId: `r${++seq}`,
  headers: { "x-opencode-session": conv, ...headers },
  body: { messages: [{ role: "system", content: "sys" }, ...history, { role: "user", content: text }], ...extra },
});
const followUp = (n) => Array.from({ length: n }, (_, i) => [{ role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}` }]).flat();
const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };

test("UP-10c: the example menu is valid policy data, and a broken menu is refused", () => {
  validate(policy());
  const bad = (mut, re) => { const p = policy(); mut(p.menu); assert.throws(() => validate(p), re); };
  bad((m) => { m.items[0].thinking = { control: "effort", value: "" }; }, /thinking.value/);
  bad((m) => { m.items[0].id = "P 1"; }, /id must match/);
  bad((m) => { m.items.push({ ...m.items[0] }); }, /repeated/);
  bad((m) => { m.defaults.paid = "F2"; }, /defaults.paid/);
  bad((m) => { m.items[0].backups = [{ item: "F2" }]; }, /another pool/);
  bad((m) => { delete m.cost_basis; }, /cost_basis is required/);
  bad((m) => { delete m.items[5].prices; }, /needs .*prices/);
  bad((m) => { m.items[0].thinking = { control: "toggle", value: "high" }; }, /on\|off/);
  bad((m) => { m.sticky.downgrade_after = 0; }, /downgrade_after/);
  bad((m) => { m.items.find((i) => i.id === "S3").kinds = ["poetry"]; }, /not in menu.kinds/);
  bad((m) => { delete m.items.find((i) => i.id === "S3").kinds; }, /must list the task kinds/);
  bad((m) => { m.metering = "yes"; }, /metering must be/);
});

for (const item of STANDARD) {
  test(`UP-10c: ${item.pool} item ${item.id} (${item.label}) is applied as its own pair, head thinking per attempt`, async () => {
    const { r, jev, logs } = mk();
    jev.answer(item.id);
    const out = await r.onRoute(turn(item.pool, "anything", { conv: `each-${item.id}` }));
    assert.equal(out.item, item.id);
    assert.equal(out.models[0], item.model);
    assert.deepEqual(out.thinking_by_model[item.model], item.thinking ? { control: item.thinking.control, value: item.thinking.value } : { control: "none" });
    assert.equal(out.reason, "jev");
    assert.equal(out.confidence, 0.95);
    // every attempt has its own entry, and no target repeats
    assert.deepEqual(Object.keys(out.thinking_by_model).sort(), [...out.models].sort());
    assert.equal(new Set(out.models).size, out.models.length);
    const d = logs().find((l) => l.event === "decision");
    assert.equal(d.item, item.id);
    assert.equal(d.source, "jev");
    assert.equal(d.thinking, item.thinking ? item.thinking.value : "default");
    assert.equal(d.attempts[0].m, item.model);
    // Jev was asked one question over the pool's items (pairs), with the owner's descriptions
    const asked = jev.calls[0];
    assert.deepEqual(Object.keys(asked.questions), ["model"]);
    assert.equal(asked.order.length, STANDARD.filter((i) => i.pool === item.pool).length); // specialists off: metering is false
    assert.equal(asked.questions.kind, undefined); // no specialist offered -> no task-kind question
    assert.equal(out.specialist, false);
    assert.ok(Object.values(asked.questions.model.criteria).some((c) => c === item.description.replace(/\s+/g, " ")));
  });
}

test("UP-10c: per attempt thinking: a backup keeps its own value and never forces the head's off (no 'floor')", async () => {
  const { r, jev } = mk();
  jev.answer("P1");
  const out = await r.onRoute(turn("paid", "halo", { conv: "pa" }));
  // P1 = deepseek low; its backup P2 is the same target (kept once, the head's pair wins); the floor fills glm (P6)
  assert.deepEqual(out.models, [DS, GLM]);
  assert.deepEqual(out.thinking_by_model, { [DS]: { control: "effort", value: "low" }, [GLM]: { control: "none" } });
  // a host without patch 0010 gets no shared value when attempts differ (it would send low to glm)
  assert.deepEqual(out.thinking, { control: "none" });
  jev.answer("P3");
  const p3 = await r.onRoute(turn("paid", "pasal berapa", { conv: "pb" }));
  assert.deepEqual(p3.models, [MUSE, DS]);
  assert.deepEqual(p3.thinking_by_model, { [MUSE]: { control: "effort", value: "high" }, [DS]: { control: "none" } });
});

test("UP-10c: the floor keeps at least two attempts while more are eligible; the free pool has one model and says short", async () => {
  const { r, jev, logs } = mk();
  jev.answer("P2");
  const out = await r.onRoute(turn("paid", "x", { conv: "fl" }));
  assert.ok(out.models.length >= 2);
  jev.answer("F3");
  const free = await r.onRoute(turn("free", "x", { conv: "ff" }));
  assert.deepEqual(free.models, [BEAM]);
  assert.deepEqual(free.thinking_by_model, { [BEAM]: { control: "effort", value: "high" } });
  assert.deepEqual(free.thinking, { control: "effort", value: "high" }); // one attempt: an old host may apply it
  assert.equal(logs().filter((l) => l.event === "decision").at(-1).short, true);
});

test("UP-10c: a backup on another provider for the same model goes first, with the same thinking; unlisted targets are skipped", () => {
  const menu = structuredClone(MENU);
  const ALT = "orx/deepseek/deepseek-v4.1-flash";
  menu.items[0].backups = [{ model: ALT, thinking: { control: "effort", value: "low" } }, { model: "gone/x", thinking: null }, { item: "P2" }];
  const f = { ...facts, [ALT]: { context_length: 1000000, tools: true, vision: true }, "gone/x": { unlisted: true } };
  const { attempts, skipped } = attemptsFor(menu.items[0], { menu, facts: f, req: inspectRequest({ messages: [{ role: "user", content: "x" }] }) });
  assert.deepEqual(attempts.map((a) => [a.model, a.thinking?.value ?? "default"]), [[DS, "low"], [ALT, "low"]]);
  assert.deepEqual(skipped, [{ model: "gone/x", reason: "not_listed", from: "backup" }]);
});

test("UP-10c sticky: a continuation is locked to the turn's item without asking Jev", async () => {
  const { r, jev, logs } = mk();
  jev.answer("P4");
  const first = turn("paid", "buktikan", { conv: "lock" });
  await r.onRoute(first);
  const calls = jev.calls.length;
  jev.answer("P1");
  const cont = await r.onRoute({ ...first, requestId: "cont", body: { messages: [...first.body.messages, { role: "assistant", content: "", tool_calls: [{ id: "t" }] }, { role: "tool", content: "ok" }] } });
  assert.equal(cont.item, "P4");
  assert.equal(cont.reason, "static:cont");
  assert.deepEqual(cont.thinking_by_model[DS], { control: "effort", value: "max" });
  assert.equal(jev.calls.length, calls);
  assert.equal(logs().at(-1).sticky, "continuation");
});

test("UP-10c sticky: a heavier task switches at once; a simpler one only after two turns in a row; effort moves freely within a model", async () => {
  const { r, jev, logs } = mk();
  const conv = "st";
  const at = (n) => ({ conv, history: followUp(n) });
  jev.answer("P2"); assert.equal((await r.onRoute(turn("paid", "a", { conv }))).item, "P2");
  jev.answer("P3"); assert.equal((await r.onRoute(turn("paid", "b", at(1)))).item, "P3"); // heavier: task changed
  assert.equal(logs().at(-1).sticky, "task_changed");
  jev.answer("P2"); assert.equal((await r.onRoute(turn("paid", "c", at(2)))).item, "P3"); // simpler once: wait
  assert.equal(logs().at(-1).sticky, "simpler_wait");
  jev.answer("P2"); assert.equal((await r.onRoute(turn("paid", "d", at(3)))).item, "P2"); // simpler twice: switch
  assert.equal(logs().at(-1).sticky, "simpler_confirmed");
  jev.answer("P4"); assert.equal((await r.onRoute(turn("paid", "e", at(4)))).item, "P4"); // same model, more effort
  jev.answer("P1"); assert.equal((await r.onRoute(turn("paid", "f", at(5)))).item, "P1"); // same model, less effort: at once
  assert.equal(logs().at(-1).sticky, "effort_change");
});

test("UP-10c sticky: an unconfident turn in between resets the simpler count; not confident keeps the last item", async () => {
  const { r, jev, logs } = mk();
  const conv = "reset";
  jev.answer("P3"); await r.onRoute(turn("paid", "a", { conv }));
  jev.answer("P2"); assert.equal((await r.onRoute(turn("paid", "b", { conv, history: followUp(1) }))).item, "P3");
  jev.answer("P1", 0.4); const u = await r.onRoute(turn("paid", "c", { conv, history: followUp(2) }));
  assert.equal(u.item, "P3");
  assert.equal(u.reason, "static");
  assert.equal(logs().at(-1).sticky, "unconfident");
  jev.answer("P2"); assert.equal((await r.onRoute(turn("paid", "d", { conv, history: followUp(3) }))).item, "P3"); // count restarted
});

test("UP-10c sticky: effort_change_is_switch treats a same-model effort change like a model switch", () => {
  const items = Object.fromEntries(MENU.items.map((i) => [i.id, i]));
  const ok = new Set(Object.keys(items));
  const cfg = { ...DEFAULT_STICKY, effort_change_is_switch: true };
  assert.equal(stickyChoice({ last: items.P4, pick: items.P1, ok, fallback: items.P2, cfg }).reason, "simpler_wait");
  assert.equal(stickyChoice({ last: items.P1, pick: items.P4, ok, fallback: items.P2, cfg }).reason, "task_changed");
});

test("UP-10c: Jev unavailable keeps the conversation's item, else the pool default; a new conversation gets the default", async () => {
  const { r, jev, logs } = mk();
  jev.unavailable();
  const n = await r.onRoute(turn("paid", "a", { conv: "down" }));
  assert.equal(n.item, "P2");
  assert.equal(logs().at(-1).source, "default");
  const free = await r.onRoute(turn("free", "a", { conv: "down-f" }));
  assert.equal(free.item, "F2");
  assert.deepEqual(free.thinking_by_model, { [BEAM]: { control: "none" } });
  jev.answer("P3"); await r.onRoute(turn("paid", "b", { conv: "down2" }));
  jev.unavailable();
  const kept = await r.onRoute(turn("paid", "c", { conv: "down2", history: followUp(1) }));
  assert.equal(kept.item, "P3");
  assert.equal(logs().at(-1).sticky, "jev_unavailable");
  assert.equal(logs().at(-1).source, "session");
});

test("UP-10c: API calls (session v<voucher>) are never sticky; canary sessions are never sent to Jev", async () => {
  const { r, jev } = mk();
  jev.answer("P3"); assert.equal((await r.onRoute(turn("paid", "a", { conv: "v42" }))).item, "P3");
  jev.answer("P2", 0.3); assert.equal((await r.onRoute(turn("paid", "b", { conv: "v42", history: followUp(1) }))).item, "P2");
  const calls = jev.calls.length;
  assert.equal((await r.onRoute(turn("paid", "ping", { conv: "canary" }))).item, "P2");
  assert.equal(jev.calls.length, calls);
});

test("UP-10c eligibility: an image turn offers only vision-capable items; a last item without vision falls back", async () => {
  const { r, jev, logs } = mk();
  jev.answer("P5"); await r.onRoute(turn("paid", "build it", { conv: "img" })); // mimo: no vision
  jev.answer("P3");
  const out = await r.onRoute({ ...turn("paid", "", { conv: "img", history: followUp(1) }), body: { messages: [{ role: "system", content: "s" }, ...followUp(1), { role: "user", content: [{ type: "text", text: "apa ini" }, image] }] } });
  assert.equal(out.item, "P3");
  assert.ok(!out.models.includes(MIMO) && !out.models.includes(GLM));
  const offered = jev.calls.at(-1).order;
  assert.deepEqual(offered.sort(), ["P1", "P2", "P3", "P4"]);
  const d = logs().at(-1);
  assert.equal(d.sticky, "last_ineligible");
  assert.ok(d.excluded.some((e) => e.item === "P5" && e.reason === "vision"));
  // free pool: no vision route at all -> the router steps aside (OmniRoute's own combo answers)
  jev.answer("F2");
  assert.equal(await r.onRoute({ ...turn("free", "", { conv: "img-f" }), body: { messages: [{ role: "user", content: [image] }] } }), undefined);
});

test("UP-10c eligibility: glm stays on the menu only while the conversation's cached share keeps it at or under 1.00x", async () => {
  const P = MENU.items.find((i) => i.id === "P6");
  const basis = MENU.cost_basis;
  // the brief's two cases: a fresh chat is cheap; a 98%-cached long chat with a little output is 1.57x
  assert.ok(Math.abs(costRatio(P.prices, basis, { input: 100000, share: 0.98, output: 993 }) - 1.57) < 0.01);
  assert.ok(costRatio(P.prices, basis, { input: 3000, share: 0, output: 600 }) < 0.5);
  // cutoff for a 3k-token turn with 600 output tokens, and for a 100k one
  const short = cachedShareCutoff(P.prices, basis, 1, { input: 3000, output: 600 });
  const long = cachedShareCutoff(P.prices, basis, 1, { input: 100000, output: 600 });
  assert.equal(short, null); // fits at every share
  assert.ok(long > 0.88 && long < 0.89, String(long)); // (0.15 + 0.7 * 600/100000) / 0.174 = 0.886
  assert.ok(costRatio(P.prices, basis, { input: 100000, share: long - 0.01, output: 600 }) <= 1);
  assert.ok(costRatio(P.prices, basis, { input: 100000, share: long + 0.01, output: 600 }) > 1);

  const { r, jev, logs } = mk();
  jev.answer("P6");
  assert.equal((await r.onRoute(turn("paid", "buat rumus excel", { conv: "g1" }))).item, "P6");
  // a long chat whose earlier turns are ~95% of the input: glm is not offered
  const longHistory = [{ role: "user", content: "x".repeat(400000) }, { role: "assistant", content: "ok" }];
  jev.answer("P2");
  const out = await r.onRoute(turn("paid", "lanjut", { conv: "g2", history: longHistory }));
  assert.ok(!jev.calls.at(-1).order.includes("P6"));
  const ex = logs().at(-1).excluded.find((e) => e.item === "P6");
  assert.equal(ex.reason, "cost_ratio");
  assert.ok(ex.ratio > 1 && ex.share > 0.9);
  assert.equal(out.item, "P2");
});

test("UP-10c: cachedShare counts everything before the new user turn", () => {
  assert.equal(cachedShare({ messages: [{ role: "user", content: "hello" }] }), 0);
  const s = cachedShare({ messages: [{ role: "system", content: "s".repeat(300) }, { role: "user", content: "q".repeat(300) }, { role: "assistant", content: "a".repeat(300) }, { role: "user", content: "n".repeat(100) }] });
  assert.ok(Math.abs(s - 0.9) < 0.001, String(s));
});

test("UP-10c: shadow mode asks Jev and logs the pick but applies the sticky/default item", async () => {
  const { r, jev, logs } = mk(policy(MENU, { mode: "shadow" }));
  jev.answer("P4");
  const out = await r.onRoute(turn("paid", "x", { conv: "sh" }));
  assert.equal(out.item, "P2");
  assert.equal(logs().at(-1).jev.outcome, "shadow");
  assert.equal(logs().at(-1).jev.pick, "P4");
});

test("UP-10c: the result log names the item, the attempt that answered and whether a backup was used", async () => {
  const { r, jev, logs } = mk();
  jev.answer("P3");
  const t = turn("paid", "x", { conv: "res" });
  await r.onRoute(t);
  r.onRouteResult({ requestId: t.requestId, model: "paid", status: 200, attempts: [{ model: MUSE, ok: false, status: 503 }, { model: DS, ok: true, status: 200 }] });
  const res = logs().at(-1);
  assert.equal(res.event, "result");
  assert.equal(res.item, "P3");
  assert.equal(res.answered_by, DS);
  assert.equal(res.backup_used, true);
  assert.equal(res.thinking, "default");
});

test("UP-10c: without policy.menu the router keeps the old model + effort behaviour", async () => {
  const p = policy(); delete p.menu;
  const { r, jev } = mk(p);
  jev.answer("x");
  const out = await r.onRoute({ ...turn("paid", "x", { conv: "old" }), headers: { "x-opencode-session": "old" } });
  assert.equal(out.item, undefined);
  assert.equal(out.thinking_by_model, undefined);
});

test("UP-10c: Jev's menu answer parses with no effort question", async () => {
  const items = MENU.items.filter((i) => i.pool === "free");
  const payload = buildMenuPayload({ ask: "hi", req: inspectRequest({ messages: [{ role: "user", content: "hi" }] }), items, seed: "s1" });
  assert.equal(payload.questions.effort, undefined);
  const jev = createJev({ fetchImpl: async () => ({ ok: true, json: async () => ({ answers: { model: { choice: "c2", probabilities: { c1: 0.05, c2: 0.9, c3: 0.05 } } } }) }) });
  const res = await jev.ask({ sources: [{ name: "a", url: "http://x" }] }, payload);
  assert.equal(res.ok, true);
  assert.equal(res.index, 1);
  assert.equal(res.effort, undefined);
});

// ── Addendum (owner 2026-11-04): specialists behind requires_metering, the cutoff as a flag, specialist in log/return ──

test("UP-10c addendum: specialists stay off while menu.metering is false, and are logged as excluded for that reason", async () => {
  const { r, jev, logs } = mk();
  jev.answer("P2");
  await r.onRoute(turn("paid", "buat aplikasi kasir lengkap", { conv: "sp-off" }));
  assert.ok(SPECIALISTS.every((s) => !jev.calls.at(-1).order.includes(s.id)));
  const ex = logs().at(-1).excluded;
  for (const s of SPECIALISTS) assert.ok(ex.some((e) => e.item === s.id && e.reason === "requires_metering"), s.id);
});

for (const item of SPECIALISTS) {
  test(`UP-10c addendum: with metering on, specialist ${item.id} (${item.label}) is applied when Jev is confident about it and its kind`, async () => {
    const { r, jev, logs } = mk(policy(metered()));
    jev.answer(item.id, 0.95, item.kinds[0], 0.95);
    const out = await r.onRoute(turn("paid", "x", { conv: `sp-${item.id}` }));
    assert.equal(out.item, item.id);
    assert.equal(out.specialist, true);
    assert.equal(out.models[0], item.model);
    assert.ok(out.models.length >= 2, "a specialist keeps a backup");
    const d = logs().at(-1);
    assert.equal(d.specialist, true);
    assert.equal(typeof d.cost_ratio, "number");
    assert.ok(jev.calls.at(-1).questions.kind, "the kind question is asked while a specialist is on offer");
  });
}

test("UP-10c addendum: a confident specialist pick of the wrong kind, or with an unsure kind, does not stand", async () => {
  const { r, jev, logs } = mk(policy(metered()));
  jev.answer("S3", 0.95, "general", 0.95);
  const wrong = await r.onRoute(turn("paid", "halo", { conv: "sk1" }));
  assert.equal(wrong.item, "P2");
  assert.equal(wrong.specialist, false);
  assert.equal(logs().at(-1).jev.outcome, "specialist_kind");
  jev.answer("S3", 0.95, "big_coding", 0.5);
  assert.equal((await r.onRoute(turn("paid", "x", { conv: "sk2" }))).item, "P2");
  jev.answer("S3", 0.95, "big_coding", 0.95);
  assert.equal((await r.onRoute(turn("paid", "x", { conv: "sk3" }))).item, "S3");
  // a standard pick never depends on the kind answer
  jev.answer("P4", 0.95, "vision", 0.1);
  assert.equal((await r.onRoute(turn("paid", "x", { conv: "sk4" }))).item, "P4");
});

test("UP-10c addendum: the glm cutoff is a flag: it applies while metering is off and drops once metering is on", async () => {
  const longHistory = [{ role: "user", content: "x".repeat(400000) }, { role: "assistant", content: "ok" }];
  const off = mk();
  off.jev.answer("P2");
  await off.r.onRoute(turn("paid", "lanjut", { conv: "cut1", history: longHistory }));
  assert.ok(!off.jev.calls.at(-1).order.includes("P6"));
  const on = mk(policy(metered()));
  on.jev.answer("P6");
  const out = await on.r.onRoute(turn("paid", "lanjut", { conv: "cut2", history: longHistory }));
  assert.equal(out.item, "P6");
  assert.ok(on.logs().at(-1).cost_ratio > 1, "the ratio is still logged");
});

test("UP-10c addendum: the result log says whether the answering item was a specialist", async () => {
  const { r, jev, logs } = mk(policy(metered()));
  jev.answer("S6", 0.95, "data_analysis", 0.95);
  const t = turn("paid", "x", { conv: "sres" });
  await r.onRoute(t);
  r.onRouteResult({ requestId: t.requestId, model: "paid", status: 200, attempts: [{ model: LUNA, ok: true, status: 200 }] });
  const res = logs().at(-1);
  assert.equal(res.item, "S6");
  assert.equal(res.specialist, true);
  assert.equal(res.backup_used, false);
});

test("UP-10c addendum: Jev's kind answer is parsed when asked; a malformed kind makes the answer unusable", async () => {
  const items = MENU.items.filter((i) => i.pool === "paid").slice(0, 2);
  const payload = buildMenuPayload({ ask: "x", req: inspectRequest({ messages: [{ role: "user", content: "x" }] }), items, seed: "k", kinds: MENU.kinds });
  assert.deepEqual(Object.keys(payload.questions), ["model", "kind"]);
  const ok = createJev({ fetchImpl: async () => ({ ok: true, json: async () => ({ answers: { model: { choice: "c1", probabilities: { c1: 0.9, c2: 0.1 } }, kind: { choice: "big_coding", probabilities: { big_coding: 0.95, general: 0.05 } } } }) }) });
  const r1 = await ok.ask({ sources: [{ name: "a", url: "http://x" }] }, payload);
  assert.equal(r1.kind, "big_coding");
  assert.ok(r1.kind_confidence > 0.8);
  const bad = createJev({ fetchImpl: async () => ({ ok: true, json: async () => ({ answers: { model: { choice: "c1", probabilities: { c1: 0.9, c2: 0.1 } }, kind: { choice: "poetry" } } }) }) });
  assert.equal((await bad.ask({ sources: [{ name: "a", url: "http://x" }] }, payload)).ok, false);
});

// ── Addendum 2 (item 13): a Go model whose own allowance is spent is skipped so the item's backup serves ──
import { createHealth } from "../lib/health.mjs";

test("UP-10c item 13: a usage-limit failure cools that model 30 min, doubling to 5 h, and never the whole connection", () => {
  let t = 0; const logged = [];
  const h = createHealth({ now: () => t, log: (r) => logged.push(r) });
  h.record({ attempts: [{ model: MUSE, ok: false, status: 429, kind: "rate_limit", limit: true }] });
  assert.equal(h.isLimited(MUSE), true);
  assert.equal(h.snapshot()[MUSE].secs, 1800);
  assert.equal(h.snapshot()[MUSE].limit, true);
  assert.equal(h.isCooling(DS), false, "another model on the same connection stays usable");
  h.record({ attempts: [{ model: GLM, ok: false, status: 429, kind: "rate_limit", limit: true }] });
  assert.equal(h.isCooling(DS), false, "two limited models are two per-model limits, not a connection failure");
  t = 1800001; h.record({ attempts: [{ model: MUSE, ok: false, status: 429, kind: "rate_limit", limit: true }] });
  assert.equal(h.snapshot()[MUSE].secs, 3600);
  for (let i = 0; i < 6; i++) { t += 10 ** 8; h.record({ attempts: [{ model: MUSE, ok: false, status: 429, kind: "rate_limit", limit: true }] }); }
  assert.equal(h.snapshot()[MUSE].secs, 18000);
  assert.ok(logged.some((l) => l.event === "usage_limit" && l.model === MUSE && l.secs === 1800));
  h.record({ attempts: [{ model: MUSE, ok: true, status: 200 }] });
  assert.equal(h.isLimited(MUSE), false, "a success clears it");
  // a short 429 without the limit flag keeps the old, short cooldown
  const s = createHealth({ now: () => 0 });
  s.record({ attempts: [{ model: MUSE, ok: false, status: 429, kind: "rate_limit" }] });
  assert.equal(s.isLimited(MUSE), false);
  assert.equal(s.snapshot()[MUSE].secs, 30);
});

test("UP-10c item 13: the item stays, its spent head model is skipped, and the backup serves; the skip is logged", async () => {
  const { r, jev, logs } = mk();
  jev.answer("P3");
  const first = turn("paid", "pasal", { conv: "lim0" });
  await r.onRoute(first); // the log opens on the first decision, as in production
  r.onRouteResult({ requestId: first.requestId, model: "paid", status: 200, attempts: [{ model: MUSE, ok: false, status: 429, kind: "rate_limit", limit: true }, { model: DS, ok: true, status: 200 }] });
  const out = await r.onRoute(turn("paid", "pasal berapa", { conv: "lim" }));
  assert.equal(out.item, "P3");
  assert.ok(!out.models.includes(MUSE));
  assert.equal(out.models[0], DS);
  assert.deepEqual(out.thinking_by_model[DS], { control: "none" }, "the backup keeps its own value");
  const d = logs().filter((l) => l.event === "decision").at(-1);
  assert.ok(d.skipped.some((s) => s.model === MUSE && s.reason === "usage_limit"));
  assert.ok(logs().some((l) => l.event === "usage_limit" && l.model === MUSE));
});

test("UP-10c item 13: when every attempt is limit-spent they are all kept, so the turn fails honestly", () => {
  const h = createHealth({ now: () => 0 });
  h.record({ attempts: [{ model: BEAM, ok: false, status: 429, kind: "rate_limit", limit: true }] });
  const f3 = MENU.items.find((i) => i.id === "F3");
  const { attempts } = attemptsFor(f3, { menu: MENU, facts, req: inspectRequest({ messages: [{ role: "user", content: "x" }] }), health: h });
  assert.deepEqual(attempts.map((a) => a.model), [BEAM]);
});

test("UP-10c: a session that carries both pools keeps each pool's own last item (the canary shape)", async () => {
  const { r, jev, logs } = mk();
  jev.answer("P4"); await r.onRoute(turn("paid", "x", { conv: "both" }));
  jev.answer("F3"); const f = await r.onRoute(turn("free", "x", { conv: "both", history: followUp(1) }));
  assert.equal(f.item, "F3");
  assert.equal(logs().at(-1).sticky, "new");
});
