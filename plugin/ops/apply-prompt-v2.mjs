// jev-prompt-v2 policy candidate: turns a live policy.json into the v2 one, dry run by default.
//   node plugin/ops/apply-prompt-v2.mjs <policy.json> [--out FILE] [--threshold N] [--keep-qwen]
// - each paid model's good_at/weak_at/cost/measured from ops/model-profiles.json (the old text goes);
// - gpt-6-luna joins jev.hidden: Jev never sees it, it stays in order.paid as a fallback route;
// - qwen3.8-flash leaves order.paid (its hard/frontier tiers were never measured, and at its measured top setting it
//   is below glm, deepseek and mimo on coding and invents facts most); --keep-qwen keeps it and maps hard and
//   frontier to xhigh, the level Artificial Analysis measured it at;
// - --threshold sets jev.threshold (the apply threshold from the ops/jev-eval.mjs run).
// Refuses to write a policy whose shown descriptions break the rules (descriptionProblems). Writes only --out.
import fs from "node:fs";
import { descriptionProblems } from "../lib/jev.mjs";
import { validate } from "../lib/policy.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out" && args[args.indexOf(a) - 1] !== "--threshold");
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
if (!file) { console.error("usage: apply-prompt-v2.mjs <policy.json> [--out FILE] [--threshold N] [--keep-qwen]"); process.exit(2); }
const profiles = JSON.parse(fs.readFileSync(new URL("./model-profiles.json", import.meta.url), "utf8"));
const p = JSON.parse(fs.readFileSync(file, "utf8"));
const changes = [];
const fam = (id) => id.split("/").at(-1);

for (const id of p.order.paid) {
  const prof = profiles[id] ?? Object.entries(profiles).find(([k]) => !k.startsWith("_") && fam(k) === fam(id))?.[1];
  if (!prof) continue;
  const m = (p.models[id] ??= {});
  for (const k of ["good_at", "weak_at", "cost", "measured"]) {
    if (prof[k] === undefined) { if (m[k] !== undefined) { delete m[k]; changes.push(`${id}: ${k} removed`); } continue; }
    if (m[k] !== prof[k]) { m[k] = prof[k]; changes.push(`${id}: ${k} = ${prof[k]}`); }
  }
}
const luna = p.order.paid.filter((id) => fam(id) === "gpt-6-luna");
p.jev ??= {};
const hidden = new Set(p.jev.hidden ?? []);
for (const id of luna) if (!hidden.has(id)) { hidden.add(id); changes.push(`jev.hidden += ${id}`); }
if (hidden.size) p.jev.hidden = [...hidden];
const qwen = p.order.paid.filter((id) => fam(id) === "qwen3.8-flash");
if (args.includes("--keep-qwen")) {
  for (const id of qwen) {
    const map = p.models[id]?.thinking?.map;
    if (map && p.models[id].thinking.values?.includes("xhigh")) for (const t of ["hard", "frontier"]) if (map[t] !== "xhigh") { map[t] = "xhigh"; changes.push(`${id}: thinking.map.${t} = xhigh`); }
  }
} else if (qwen.length) {
  p.order.paid = p.order.paid.filter((id) => !qwen.includes(id));
  changes.push(`order.paid -= ${qwen.join(", ")}`);
}
const thr = opt("--threshold");
if (thr !== undefined) {
  const n = Number(thr);
  if (!(n > 0 && n < 1)) { console.error("--threshold must be between 0 and 1"); process.exit(2); }
  if (p.jev.threshold !== n) { changes.push(`jev.threshold ${p.jev.threshold} -> ${n}`); p.jev.threshold = n; }
}

validate(p);
const shown = p.order.paid.filter((id) => !hidden.has(id));
const bad = shown.flatMap((id) => (p.models[id]?.good_at ? descriptionProblems(p.models[id], shown).map((e) => `${id}: ${e}`) : [`${id}: no good_at`]));
console.log(changes.length ? changes.map((c) => "  " + c).join("\n") : "  (no changes)");
console.log(`shown to Jev (paid): ${shown.map(fam).join(", ")}`);
if (bad.length) { console.error("description problems:\n" + bad.map((b) => "  " + b).join("\n")); process.exit(1); }
const out = opt("--out");
if (out) { fs.writeFileSync(out, JSON.stringify(p, null, 2) + "\n"); console.log(`wrote ${out}`); }
else console.log("dry run: nothing written (--out FILE writes the candidate)");
