import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ABSTRACT_LEVELS, applyThinkingToList, toHostThinking } from "../lib/thinking.mjs";

// Contract with OmniRoute: the onRoute `thinking` field must survive the host's
// normalizePluginThinking, which silently drops any other shape (0.7.0 sent `native` and every
// effort/toggle selection was dropped). The normalizer is read from the patch that defines it, so a
// change on either side fails here instead of in production. A patch number is not a stable address:
// the v3.8.53 re-author folded the whole series into 0001, so the definition is found by symbol.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCHES = path.join(HERE, "..", "..", "patches");
const policyExample = JSON.parse(fs.readFileSync(path.join(HERE, "..", "policy.example.json"), "utf8"));

/** The text of the patch that defines `symbol`; patches apply in order, so the last one wins. */
function patchDefining(symbol) {
  const files = fs.readdirSync(PATCHES).filter((f) => f.endsWith(".patch")).sort();
  const file = files.filter((f) => fs.readFileSync(path.join(PATCHES, f), "utf8").includes(symbol)).pop();
  assert.ok(file, `no patch defines ${symbol}`);
  return fs.readFileSync(path.join(PATCHES, file), "utf8");
}

function hostNormalizer() {
  const lines = patchDefining("+function normalizePluginThinking(").split("\n");
  const start = lines.findIndex((l) => l.startsWith("+function normalizePluginThinking("));
  assert.ok(start >= 0, "normalizePluginThinking not found in the patch series");
  const end = lines.findIndex((l, i) => i > start && l === "+}");
  const ts = lines.slice(start, end + 1).map((l) => l.slice(1)).join("\n");
  // Strip the only TypeScript in it: the signature types and one `as` cast.
  const js = ts
    .replace("(value: unknown): PluginThinking | null", "(value)")
    .replace(" as Record<string, unknown>", "");
  return new Function(`${js}\nreturn normalizePluginThinking;`)();
}
const normalize = hostNormalizer();

test("host normalizer reads `value`; the 0.7.0 `native` shape is dropped", () => {
  assert.deepEqual(normalize({ control: "effort", value: "high" }), { control: "effort", value: "high" });
  assert.deepEqual(normalize({ control: "toggle", value: "off" }), { control: "toggle", value: "off" });
  assert.deepEqual(normalize({ control: "none" }), { control: "none" });
  assert.equal(normalize({ control: "effort", native: "high" }), null);
});

test("toHostThinking output survives the host normalizer unchanged", () => {
  assert.deepEqual(normalize(toHostThinking(null)), { control: "none" });
  for (const applied of [{ control: "effort", native: "minimal" }, { control: "effort", native: "max" }, { control: "toggle", native: "on" }, { control: "toggle", native: "off" }]) {
    const wire = toHostThinking(applied);
    assert.deepEqual(normalize(wire), wire, JSON.stringify(applied));
  }
});

test("every plan the example policy can produce reaches the wire intact", () => {
  const ids = [...policyExample.order.paid, ...policyExample.order.free];
  let applied = 0;
  for (const head of ids) {
    for (const tier of ABSTRACT_LEVELS) {
      const plan = applyThinkingToList({ models: [head, ...ids.filter((i) => i !== head)], abstract: tier, policy: policyExample });
      const wire = toHostThinking(plan.applied);
      assert.deepEqual(normalize(wire), wire, `${head} ${tier} -> ${JSON.stringify(wire)}`);
      if (plan.applied) applied++;
    }
  }
  assert.ok(applied > 0, "the example policy should apply at least one real control");
});

// The menu's per-route windows go through the same wire shape the host's normalizeWindowsByModel
// (read from the patch that defines it) accepts, or the host drops them silently. The figures must survive
// integer-valued and capped; the host keeps only the dispatched targets.
function hostWindowsNormalizer() {
  const lines = patchDefining("+function normalizeWindowsByModel").split("\n");
  const start = lines.findIndex((l) => l.startsWith("+const MAX_WINDOW_TOKENS"));
  const fn = lines.findIndex((l) => l.startsWith("+function normalizeWindowsByModel"));
  assert.ok(start >= 0 && fn > start, "normalizeWindowsByModel not found in the patch series");
  const end = lines.findIndex((l, i) => i > fn && l === "+}");
  const ts = lines.slice(start, end + 1).map((l) => l.slice(1)).join("\n");
  // Strip the TypeScript: signatures, the two Record<> annotations and the two `as Record<>` casts.
  const js = ts
    .replace("function normalizeWindowFigure(value: unknown): number | null", "function normalizeWindowFigure(value)")
    .replace(/function normalizeWindowsByModel\(\s*value: unknown,\s*models: string\[\]\s*\): Record<string, PluginRouteWindow> \| null/m, "function normalizeWindowsByModel(value, models)")
    .replace("const out: Record<string, PluginRouteWindow> = {}", "const out = {}")
    .replace("const entry: PluginRouteWindow = {}", "const entry = {}")
    .replace(/\(value as Record<string, unknown>\)/g, "value")
    .replace(/\(raw as Record<string, unknown>\)/g, "raw")
    .replace("const record = raw as Record<string, unknown>;", "const record = raw;");
  return new Function(`${js}\nreturn normalizeWindowsByModel;`)();
}

test("UP-13: every window the plugin sends survives the host unchanged; garbage does not", async () => {
  const { windowsFor } = await import("../lib/windows.mjs");
  const normalizeWindowsByModel = hostWindowsNormalizer();
  const DS = "ocpaid/opencode-go/deepseek-v4.1-flash", BEAM = "ocpaid/opencode-go/beam-free", GLM = "ocpaid/opencode-go/glm-5.3-flash";
  const facts = {
    [DS]: { context_length: 1000000, max_output_tokens: 65536 },
    [BEAM]: { context_length: 262144 },
    [GLM]: {},
  };
  const models = [DS, BEAM, GLM];
  const wire = windowsFor(models, facts);
  assert.deepEqual(normalizeWindowsByModel(wire, models), wire);
  assert.equal(normalizeWindowsByModel({ [DS]: { context_length: "128000" } }, models), null); // not finite numbers
  assert.deepEqual(normalizeWindowsByModel({ [GLM]: { context_length: 100 }, "other/z": { context_length: 100 } }, models), { [GLM]: { context_length: 100 } }); // only dispatched targets
});

// The menu's per-attempt values go through the same normalizer, and the item id must match the host's
// ITEM_ID (read from the patch that defines it), or the host drops the map / the x-router-item header silently.
test("UP-10c: every menu pair and item id survives the host unchanged", async () => {
  const { hostThinking } = await import("../lib/menu.mjs");
  const menu = JSON.parse(fs.readFileSync(path.join(HERE, "..", "ops", "menu.example.json"), "utf8"));
  const text = patchDefining("+const ITEM_ID = /");
  const itemId = text.match(/^\+const ITEM_ID = \/(.+)\/;$/m);
  assert.ok(itemId, "ITEM_ID not found in the patch series");
  const re = new RegExp(itemId[1]);
  assert.ok(text.includes("thinking_by_model"), "the menu patch reads thinking_by_model");
  for (const it of menu.items) {
    assert.ok(re.test(it.id), `item id ${it.id}`);
    const wire = hostThinking(it.thinking);
    assert.deepEqual(normalize(wire), wire, `${it.id} ${JSON.stringify(wire)}`);
    for (const b of it.backups ?? []) if (b.model) assert.deepEqual(normalize(hostThinking(b.thinking)), hostThinking(b.thinking));
  }
});
