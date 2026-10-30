#!/usr/bin/env node
// Generate policy.models[*].thinking from the measured effort data in warslop:
//   infra/omniroute/effort/effort-table.json      (native tiers/control per route)
//   infra/omniroute/effort/effort-policy-draft.json (trivial/normal/hard/frontier -> native or null)
// The two JSON files are bundled under plugin/ops/effort/; pass --data-dir to read the live copies.
//
// Usage: node ops/apply-effort-policy.mjs <policy.json> [--data-dir DIR] [--keep-dead] [--check]
// Default: writes the policy. --check only prints/exit 1 when something would change.
// Dead routes (table dead or draft skip) are removed from order/last_resort/models unless --keep-dead.
// policy.thinking_aliases maps a connection prefix to the prefixes the data was measured under, e.g.
// {"ocpaid": ["ocgoa", "ocgob", "ocpv"]} (all four reach the same sidecar): an id without its own row
// takes the row of the same provider path under the first alias that has one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const TIERS = ["trivial", "normal", "hard", "frontier"];

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const cleanValues = (values) => [...new Set(values)].filter((v) => typeof v === "string");

export function thinkingFromRoute(route, table, draft) {
  const row = table[route];
  const d = draft[route] ?? {};
  if (!row) return null; // not measured: unknown -> control none/omit
  if (row.dead || d.skip) return { dead: true };
  const control = row.control;
  if (control === "none") {
    return { control: "none", values: [], default: null, budget: null, map: Object.fromEntries(TIERS.map((t) => [t, null])) };
  }
  if (control === "off-only") {
    // Only the discrete "none" value works; keep it as an effort control with one native value.
    const map = Object.fromEntries(TIERS.map((t) => [t, d[t] === "none" ? "none" : null]));
    return { control: "effort", values: ["none"], default: null, budget: null, map };
  }
  if (control === "toggle") {
    const values = row.off ? ["off", "on"] : ["on"];
    const map = Object.fromEntries(TIERS.map((t) => [t, d[t] === "none" ? (values.includes("off") ? "off" : null) : d[t] === "on" ? "on" : null]));
    return { control: "toggle", values, default: null, budget: null, map };
  }
  // effort
  const values = cleanValues([...(row.off ? ["none"] : []), ...(row.levels ?? [])]).sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b));
  const map = Object.fromEntries(TIERS.map((t) => {
    const v = d[t];
    if (v === null || v === undefined || v === "skip") return [t, null];
    if (v === "none" && !values.includes("none")) return [t, null];
    if (!values.includes(v)) return [t, null];
    return [t, v];
  }));
  return { control: "effort", values, default: null, budget: null, map };
}

/** The effort-data key that describes `id`: its own row, else the first thinking_aliases match (or null). */
export function measuredKey(id, policy, table) {
  if (table[id]) return id;
  const slash = id.indexOf("/");
  if (slash < 0) return null;
  for (const alias of policy?.thinking_aliases?.[id.slice(0, slash)] ?? []) {
    const key = `${alias}${id.slice(slash)}`;
    if (table[key]) return key;
  }
  return null;
}

export function unknownThinking() {
  return { control: "none", values: [], default: null, budget: null, map: Object.fromEntries(TIERS.map((t) => [t, null])) };
}

/**
 * Apply the bundled effort data to a policy object in place and return the counts. Dead routes
 * are removed unless keepDead (then they get a control:none entry with dead:true). Every other
 * dispatched id gets an entry; unknown ids get control:none/omit.
 */
export function buildEffortPolicy(policy, { table, draft, keepDead = false } = {}) {
  const removed = [];
  const dropDead = (id) => {
    if (!removed.includes(id)) removed.push(id);
    for (const pool of ["paid", "free"]) {
      if (Array.isArray(policy.order?.[pool])) policy.order[pool] = policy.order[pool].filter((x) => x !== id);
    }
    for (const [pool, value] of Object.entries(policy.last_resort ?? {})) {
      if (value === id) delete policy.last_resort[pool];
    }
    delete policy.models?.[id];
  };

  const ids = new Set([
    ...(policy.order?.paid ?? []),
    ...(policy.order?.free ?? []),
    ...Object.values(policy.last_resort ?? {}),
    ...Object.keys(policy.models ?? {}),
  ]);
  policy.models ??= {};
  const known = [], unknown = [], dead = [], aliased = [];
  for (const id of ids) {
    const key = measuredKey(id, policy, table);
    if (key && key !== id) aliased.push(`${id} <- ${key}`);
    const result = key ? thinkingFromRoute(key, table, draft) : null;
    if (!result) {
      unknown.push(id);
      policy.models[id] = { ...(policy.models[id] ?? {}), thinking: unknownThinking() };
      continue;
    }
    if (result.dead) {
      dead.push(id);
      if (keepDead) policy.models[id] = { ...(policy.models[id] ?? {}), thinking: { ...unknownThinking(), dead: true } };
      else dropDead(id);
      continue;
    }
    known.push(id);
    policy.models[id] = { ...(policy.models[id] ?? {}), thinking: result };
  }
  return { policy, known, unknown, dead, aliased };
}

export function loadEffortData(dataDir = path.join(HERE, "effort")) {
  return {
    table: readJson(path.join(dataDir, "effort-table.json")),
    draft: readJson(path.join(dataDir, "effort-policy-draft.json")),
  };
}

function main() {
  const args = process.argv.slice(2);
  const policyFile = args.find((a) => !a.startsWith("--"));
  if (!policyFile) {
    console.error("usage: apply-effort-policy.mjs <policy.json> [--data-dir DIR] [--keep-dead] [--check]");
    process.exit(2);
  }
  const dataDirArg = args.indexOf("--data-dir");
  const dataDir = dataDirArg >= 0 ? args[dataDirArg + 1] : path.join(HERE, "effort");
  const keepDead = args.includes("--keep-dead");
  const checkOnly = args.includes("--check");
  const policy = readJson(policyFile);
  const before = JSON.stringify(policy);
  const { table, draft } = loadEffortData(dataDir);
  const { known, unknown, dead, aliased } = buildEffortPolicy(policy, { table, draft, keepDead });

  if (checkOnly) {
    if (before !== JSON.stringify(policy)) {
      console.error(`policy would change: known=${known.length} unknown=${unknown.length} dead=${dead.length}`);
      if (dead.length && !keepDead) console.error(`dead routes to remove: ${dead.join(", ")}`);
      process.exit(1);
    }
    console.log(`effort policy current: known=${known.length} unknown=${unknown.length} dead=${dead.length}`);
    return;
  }

  fs.writeFileSync(policyFile, JSON.stringify(policy, null, 1) + "\n");
  console.log(`wrote ${policyFile}: known=${known.length} unknown=${unknown.length} dead=${dead.length}`);
  if (aliased.length) console.log(`via thinking_aliases: ${aliased.join(", ")}`);
  if (unknown.length) console.log(`unknown (control none, omit): ${unknown.join(", ")}`);
  if (dead.length) console.log(`${keepDead ? "kept dead" : "removed dead"}: ${dead.join(", ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
