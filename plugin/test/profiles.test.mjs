import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { descriptionProblems, describeCandidate } from "../lib/jev.mjs";

// ops/model-profiles.json is what Jev reads about each paid option: every entry must pass the description rules.
const profiles = JSON.parse(fs.readFileSync(new URL("../ops/model-profiles.json", import.meta.url), "utf8"));
const ids = Object.keys(profiles).filter((k) => !k.startsWith("_"));

test("model profiles follow the description rules", () => {
  assert.ok(ids.length >= 5);
  for (const id of ids) assert.deepEqual(descriptionProblems(profiles[id], ids), [], id);
});
test("a profile becomes an option without digits or names", () => {
  for (const id of ids) {
    const d = JSON.stringify(describeCandidate(id, { context_length: 1048576 }, profiles[id]));
    assert.ok(!/[0-9]/.test(d), d);
    assert.equal(descriptionProblems({ good_at: d, cost: "standard" }, ids).filter((p) => p.includes("names")).length, 0, d);
  }
});
test("UP-10c item 12: every menu item's description follows the same rules (no names, digits, negations or other options)", async () => {
  const menu = JSON.parse(fs.readFileSync(new URL("../ops/menu.example.json", import.meta.url), "utf8"));
  for (const it of menu.items) assert.deepEqual(descriptionProblems({ good_at: it.description, cost: "standard" }, menu.items.map((i) => i.model)), [], it.id);
});
test("UP-10c item 12: every model the menu dispatches has a profile from the benchmark table", async () => {
  const menu = JSON.parse(fs.readFileSync(new URL("../ops/menu.example.json", import.meta.url), "utf8"));
  for (const it of menu.items) assert.ok(profiles[it.model], it.model);
  // the data-backed corrections the brief names
  assert.match(profiles["ocpaid/opencode-go/muse-spark-1.3-contributor"].good_at, /coding/);
  assert.match(profiles["ocpaid/opencode-go/deepseek-v4.1-flash"].weak_at, /invent/);
});
