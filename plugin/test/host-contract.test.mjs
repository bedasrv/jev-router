import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ABSTRACT_LEVELS, applyThinkingToList, toHostThinking } from "../lib/thinking.mjs";

// Contract with OmniRoute: the onRoute `thinking` field must survive patch 0008's
// normalizePluginThinking, which silently drops any other shape (0.7.0 sent `native` and every
// effort/toggle selection was dropped). The normalizer is read from the patch itself, so a change
// on either side fails here instead of in production.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCHES = path.join(HERE, "..", "..", "patches");
const policyExample = JSON.parse(fs.readFileSync(path.join(HERE, "..", "policy.example.json"), "utf8"));

function hostNormalizer() {
  const file = fs.readdirSync(PATCHES).find((f) => f.startsWith("0008-"));
  assert.ok(file, "patch 0008 not found");
  const lines = fs.readFileSync(path.join(PATCHES, file), "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("+function normalizePluginThinking("));
  assert.ok(start >= 0, "normalizePluginThinking not found in patch 0008");
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
