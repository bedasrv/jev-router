#!/usr/bin/env node
// jev-router report [decisions.jsonl]: shadow-mode evaluation. Kill criterion (spec §9): keep Jev only if it
// differs from the static order on >= 15% of turns after >= 200 shadow decisions AND wins a hand-labelled sample.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dailyUsage } from "./lib/usage.mjs";

const file = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "decisions.jsonl");
const rows = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const jev = rows.filter((r) => r.event === "jev");
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + "%" : "n/a");
const q = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
const ok = jev.filter((r) => r.ok), differ = ok.filter((r) => r.differs), apply = ok.filter((r) => r.would_apply);
console.log(`decisions: ${rows.filter((r) => r.event === "decision").length}   jev calls: ${jev.length}   answered: ${ok.length} (${pct(ok.length, jev.length)})`);
const bySrc = {}; for (const r of ok) (bySrc[r.source] ??= []).push(r.latency_ms);
for (const [s, l] of Object.entries(bySrc)) console.log(`  source ${s}: ${l.length} answers, latency p50 ${q(l, 0.5)} ms, p95 ${q(l, 0.95)} ms`);
const fails = jev.filter((r) => !r.ok); if (fails.length) console.log(`  failures: ${fails.length} (e.g. ${JSON.stringify(fails[0].tried)?.slice(0, 160)})`);
console.log(`differs from static head: ${differ.length}/${ok.length} = ${pct(differ.length, ok.length)}   would apply (conf >= threshold): ${apply.length} = ${pct(apply.length, ok.length)}`);
for (const pool of ["paid", "free"]) { const o = ok.filter((r) => r.pool === pool); if (o.length) console.log(`  ${pool}: ${o.length} answered, ${pct(o.filter((r) => r.differs).length, o.length)} differ, mean confidence ${(o.reduce((s, r) => s + r.confidence, 0) / o.length).toFixed(2)}`); }
const picks = {}; for (const r of ok) picks[r.pick] = (picks[r.pick] ?? 0) + 1;
console.log("pick distribution:", Object.entries(picks).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k.split("/").pop()}=${v}`).join(", "));
const enough = ok.length >= 200, big = ok.length && differ.length / ok.length >= 0.15;
console.log(`\nkill criterion: ${enough ? "enough data" : `need ${200 - ok.length} more answered shadow decisions`}; differs >= 15%: ${big ? "yes" : "no"}; hand-label 50 from shadow-samples.jsonl (set jev.sample_file) before enabling mode "on".`);
const days = Object.entries(dailyUsage(rows));
if (days.length) {
  console.log("\njev usage per day (UTC):");
  // integer nano-USD -> "$0.000031962"; integer arithmetic, no float rounding
  const $ = (n) => "$" + Math.trunc(n / 1e9) + "." + String(n % 1e9).padStart(9, "0");
  for (const [day, d] of days) {
    const oc = Object.entries(d.outcomes).map(([k, v]) => `${k}=${v}`).join(" ");
    const priced = `cost ${d.priced ? $(d.cost_nusd) : "n/a"} list ${d.list_priced ? $(d.list_cost_nusd) : "n/a"}`;
    const lower = d.unpriced_attempts ? ` (lower bound: ${d.unpriced_attempts} timed-out attempts without usage)` : "";
    console.log(`  ${day}: ${d.calls} calls (${oc}), tokens in ${d.prompt_tokens} (cached ${d.cached_tokens}) out ${d.completion_tokens}, ${priced}${lower}, models ${Object.keys(d.models).join(",") || "n/a"}`);
  }
}
