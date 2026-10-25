import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRouter } from "../index.mjs";
import { compileRules, matchRule } from "../lib/rules.mjs";
import { buildList } from "../lib/builder.mjs";
import { validate } from "../lib/policy.mjs";

const RULE = { name: "domain", pools: ["paid"], match: ["\\b(hukum|pasal|kuhperdata)\\b", "\\b(obat|dosis|pasien)\\b", "\\b(pajak|akuntansi|pph)\\b", "\\blawsuit\\b"], prefer: ["go1/ds", "or1/ds"] };
const policy = (extra = {}) => ({
  limits: { max_main: 6, max_spill: 0 },
  order: { paid: ["x/a", "go1/ds", "y/b", "or1/ds", "z/c"], free: ["f/x"] },
  models: Object.fromEntries(["x/a", "go1/ds", "y/b", "or1/ds", "z/c", "f/x"].map((i) => [i, { context_length: 1000000, tools: true, vision: true }])),
  rules: [RULE],
  ...extra,
});
function mk(p = policy(), jev = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevr-")); const file = path.join(dir, "policy.json");
  p.log_file = "log.jsonl";
  fs.writeFileSync(file, JSON.stringify(p));
  const asked = [];
  const j = jev ?? { ask: async (cfg, payload) => { asked.push(payload); return { ok: false, tried: [] }; } };
  const r = createRouter({ policyFile: file, jev: j, facts: { get: (pp) => Object.fromEntries([...pp.order.paid, ...pp.order.free].map((i) => [i, pp.models[i] ?? {}])) } });
  return { r, dir, file, asked };
}
const user = (t, extra = {}) => ({ model: "paid", body: { messages: [{ role: "user", content: t }], ...extra }, headers: {} });
const tool = { tools: [{ type: "function", function: { name: "t" } }] };

test("a matching request leads with the rule's models in the rule's order, then the rest of the pool", async () => {
  const { r } = mk();
  const out = await r.onRoute(user("Jelaskan pasal 1365 KUHPerdata"));
  assert.deepEqual(out.models.slice(0, 2).sort(), ["go1/ds", "or1/ds"]);
  assert.equal(out.models[0], "go1/ds");
  assert.equal(out.reason, "rule:domain:paid");
  assert.equal(out.models.length, 5);
});
test("matching is case-insensitive and on whole words; an unrelated request is not touched", async () => {
  const { r } = mk();
  assert.equal((await r.onRoute(user("DOSIS parasetamol untuk anak?"))).reason, "rule:domain:paid");
  assert.equal((await r.onRoute(user("Hitung PPh 21 karyawan"))).reason, "rule:domain:paid");
  const plain = await r.onRoute(user("halo, apa kabar?"));
  assert.equal(plain.reason, "static:paid");
  assert.equal(plain.models[0], "x/a");
  assert.equal((await r.onRoute(user("tolong buat hukumannya lebih ringan di game saya"))).reason, "static:paid", "hukumannya is not the word hukum");
});
test("Jev is not asked when a rule decides", async () => {
  const p = policy({ jev: { mode: "on", threshold: 0.5, sources: [] } });
  const { r, asked } = mk(p);
  await r.onRoute(user("apa itu wanprestasi menurut pasal 1243"));
  assert.equal(asked.length, 0);
  await r.onRoute(user("halo kak apa kabar"));
  assert.equal(asked.length, 1, "a request no rule matches still goes to Jev");
});
test("the rule needs its models to be eligible: tools, window and a cooling member are respected", async () => {
  const p = policy();
  p.models["go1/ds"].tools = false;
  const { r } = mk(p);
  const out = await r.onRoute(user("pasal berapa yang mengatur ini?", tool));
  assert.equal(out.models[0], "or1/ds", "the first rule model cannot take tools, the second leads");
  assert.ok(!out.models.includes("go1/ds"));
  const none = policy();
  none.models["go1/ds"].tools = false; none.models["or1/ds"].tools = false;
  const m = mk(none);
  const o2 = await m.r.onRoute(user("pasal berapa yang mengatur ini?", tool));
  assert.equal(o2.reason, "static:paid", "no rule model is eligible: the normal choice applies");
});
test("a continuing request (a tool result is waiting) keeps its head and is not re-ruled", async () => {
  const { r } = mk();
  const first = await r.onRoute(user("tolong cek pasal 1365", tool));
  assert.equal(first.models[0], "go1/ds");
  const cont = await r.onRoute({ model: "paid", headers: {}, body: { ...tool, messages: [{ role: "user", content: "tolong cek pasal 1365" }, { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "t", arguments: "{}" } }] }, { role: "tool", tool_call_id: "1", content: "hasil" }] } });
  assert.equal(cont.models[0], "go1/ds");
  assert.match(cont.reason, /:cont$/);
});
test("a rule for the paid pool does not touch the free pool", async () => {
  const { r } = mk();
  const out = await r.onRoute({ model: "free", headers: {}, body: { messages: [{ role: "user", content: "pasal 1365 kuhperdata" }] } });
  assert.deepEqual(out.models, ["f/x"]);
});
test("only the text after the last assistant message is matched, so an old law question does not capture a later greeting", async () => {
  const { r } = mk();
  const out = await r.onRoute({ model: "paid", headers: {}, body: { messages: [{ role: "user", content: "pasal 1365?" }, { role: "assistant", content: "..." }, { role: "user", content: "terima kasih, halo juga" }] } });
  assert.equal(out.reason, "static:paid");
});
test("a bad rule is skipped and logged; good rules and the rest of the policy still work", async () => {
  const logs = [];
  const rules = compileRules({ rules: [{ name: "bad", match: ["("], prefer: ["a"] }, { name: "nomatch", prefer: ["a"] }, null, RULE] }, (r) => logs.push(r));
  assert.deepEqual(rules.map((x) => x.name), ["domain"]);
  assert.equal(logs.filter((l) => l.event === "rule_error").length, 3);
  assert.equal(matchRule(rules, "paid", "pasal 1")?.name, "domain");
  assert.equal(matchRule(rules, "free", "pasal 1"), null);
  assert.equal(matchRule(rules, "paid", ""), null);
  assert.throws(() => validate({ order: { paid: [], free: [] }, rules: "x" }), /rules must be an array/);
});
test("buildList takes one id or an ordered list as preferred", () => {
  const p = policy(); const facts = p.models;
  const req = { tokens: 10, reserve: 0, usesTools: false, images: 0 };
  const a = buildList({ pool: "paid", policy: p, facts, req, preferred: "y/b" });
  assert.equal(a.models[0], "y/b");
  const b = buildList({ pool: "paid", policy: p, facts, req, preferred: ["z/c", "y/b", "nope/x"] });
  assert.deepEqual(b.models.slice(0, 2), ["z/c", "y/b"]);
});
