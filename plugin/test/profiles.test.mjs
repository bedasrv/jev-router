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
