#!/usr/bin/env node
// jev-router check [policy.json]: prints each pool, window/flag facts (listing + overrides) and every excluded id with its reason.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPolicyLoader } from "./lib/policy.mjs";
import { createFacts } from "./lib/facts.mjs";
import { inspectRequest, usableWindow } from "./lib/eligibility.mjs";
import { buildList } from "./lib/builder.mjs";
import { missingThinking, thinkingFor } from "./lib/thinking.mjs";
import { loadEffortData, measuredKey } from "./ops/apply-effort-policy.mjs";

const file = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "policy.json");
const policy = createPolicyLoader(file, (r) => console.error(JSON.stringify(r)))();
if (!policy) { console.error("policy invalid"); process.exit(1); }
const facts = createFacts({ log: (r) => console.error(JSON.stringify(r)) });
await facts.refresh(policy);
const f = facts.get(policy);
const req = inspectRequest({ messages: [{ role: "user", content: "x" }], tools: [{}] });
for (const pool of ["paid", "free"]) {
  console.log(`\n== ${pool}`);
  for (const id of policy.order[pool]) {
    const x = f[id], listed = facts.listed.has(id), th = thinkingFor(id, policy);
    const dn = (policy.denylist ?? []).includes(id) ? " DENY" : "";
    console.log(`${id.padEnd(58)} win=${String(usableWindow(x, req.reserve)).padStart(8)} tools=${x.tools} vision=${x.vision} thinking=${th.control}${th.values.length ? `[${th.values.join("|")}]` : ""} listed=${listed}${dn}`);
  }
  const { models, excluded } = buildList({ pool, policy, facts: f, req });
  console.log("-> list for a plain tools request:", models.join(", "));
  if (excluded.length) console.log("   excluded:", excluded.map((e) => `${e.id} (${e.reason})`).join(", "));
}
const missing = [...policy.order.paid, ...policy.order.free].filter((i) => !facts.listed.has(i) && !i.startsWith("mscopilot/"));
if (missing.length) console.log("\nNOT in any live listing (would 400 or hit a retired model):", missing.join(", "));
const noThinking = missingThinking(policy);
if (noThinking.length) console.log("\nNO thinking entry (unknown -> control none, field omitted until probed):", noThinking.join(", "));
const { table, draft } = loadEffortData();
const dead = [...policy.order.paid, ...policy.order.free, ...Object.values(policy.last_resort ?? {})].filter((id) => {
  const key = measuredKey(id, policy, table);
  return key && (table[key]?.dead || draft[key]?.skip);
});
if (dead.length) console.log("\nDEAD in effort data (remove with ops/apply-effort-policy.mjs):", [...new Set(dead)].join(", "));
process.exit(0);
