// Patch 0011: per-route windows on the response head. The onRoute result carries each dispatch id's own
// context_length and max_output_tokens (figures the plugin already reads for eligibility); OmniRoute echoes
// the ANSWERING attempt's figures. Windows the plugin does not know are absent — never guessed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowsFor } from "../lib/windows.mjs";
import { createRouter } from "../index.mjs";
import { createFacts } from "../lib/facts.mjs";

const MENU = JSON.parse(fs.readFileSync(new URL("../ops/menu.example.json", import.meta.url)));
delete MENU._comment;
const DS = "ocpaid/opencode-go/deepseek-v4.1-flash", BEAM = "ocpaid/opencode-go/beam-free",
  GLM = "ocpaid/opencode-go/glm-5.3-flash";

test("windowsFor sends each dispatch id's own figures, keeps integers, omits the unknown", () => {
  const f = {
    [DS]: { context_length: 1000000, max_output_tokens: 65536 },
    [BEAM]: { context_length: 262144 },          // no max_output_tokens: only the known half is sent
    "ocpaid/opencode-go/mystery": {},             // nothing known: the id is absent, never guessed
    "ocpaid/opencode-go/float": { context_length: 128000.5, max_output_tokens: NaN }, // no usable figure
  };
  assert.deepEqual(windowsFor([DS, BEAM, "ocpaid/opencode-go/mystery", "ocpaid/opencode-go/float"], f), {
    [DS]: { context_length: 1000000, max_output_tokens: 65536 },
    [BEAM]: { context_length: 262144 },
  });
  assert.equal(windowsFor([], f), undefined);
  assert.equal(windowsFor([DS], undefined), undefined);
});

test("the menu path returns windows_by_model for the dispatched attempts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-router-win-"));
  const policyFile = path.join(dir, "policy.json");
  const facts = {
    [DS]: { context_length: 1000000, max_output_tokens: 65536, tools: true },
    [BEAM]: { context_length: 262144, tools: true },
  };
  fs.writeFileSync(policyFile, JSON.stringify({
    log_file: "log.jsonl",
    order: { paid: [DS], free: [BEAM] },
    models: facts,
    jev: { mode: "off", session_header: "x-opencode-session" },
    menu: structuredClone(MENU),
  }));
  const router = createRouter({ policyFile });
  const out = await router.onRoute({ requestId: "win-1", model: "paid", body: { messages: [{ role: "user", content: "hi" }] }, headers: {} });
  // The menu's floor_fill tops the attempt list up to P6 (glm); glm has no facts in this policy, so its window is
  // absent — never guessed.
  assert.deepEqual(out?.models, [DS, GLM]);
  assert.deepEqual(out?.windows_by_model, { [DS]: { context_length: 1000000, max_output_tokens: 65536 } });
});

test("the plain-order path returns windows_by_model too", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-router-win-"));
  const policyFile = path.join(dir, "policy.json");
  const facts = {
    [DS]: { context_length: 1000000, max_output_tokens: 40000, tools: true },
  };
  fs.writeFileSync(policyFile, JSON.stringify({
    log_file: "log.jsonl",
    order: { paid: [DS], free: [] },
    models: facts,
    jev: { mode: "off", session_header: "x-opencode-session" },
  }));
  const router = createRouter({ policyFile });
  const out = await router.onRoute({ requestId: "win-2", model: "paid", body: { messages: [{ role: "user", content: "hi" }] }, headers: {} });
  assert.deepEqual(out?.windows_by_model, { [DS]: { context_length: 1000000, max_output_tokens: 40000 } });
});

test("the listing source is authoritative for max_output_tokens as for the rest", async () => {
  // facts.get() overlays policy.models onto the listing; both paths must carry max_output_tokens through.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-router-facts-"));
  const listFile = path.join(dir, "list.json");
  fs.writeFileSync(listFile, JSON.stringify({
    data: [{ id: "deepseek-v4.1-flash", context_length: 128000, max_output_tokens: 8192, capabilities: { tool_calling: true }, input_modalities: ["text"] }],
  }));
  const facts = createFacts({ fetchImpl: async () => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(listFile, "utf8")) }), log: () => {} });
  await facts.refresh({ sources: [{ prefix: "ocpaid/opencode-go", list_url: "https://example.invalid/v1/models" }], order: { paid: [DS], free: [] }, models: {} });
  const got = facts.get({ sources: [{ prefix: "ocpaid/opencode-go", list_url: "https://example.invalid/v1/models" }], order: { paid: [DS], free: [] }, models: {} });
  assert.equal(got[DS].max_output_tokens, 8192);
  assert.equal(got[DS].context_length, 128000);
});
