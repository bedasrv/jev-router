// Offline evaluation of Jev's model pick, before vs after a payload/policy change, on a mixed set: chat-app requests
// in Indonesian and API-client (coding agent) requests, including follow-up turns. Each case lists the models a
// careful reader of the Artificial Analysis readings would accept (see model-profiles.json). Every call goes to a
// real Jev endpoint; nothing is deployed.
//   node plugin/ops/jev-eval.mjs --before-policy P1 --before-lib DIR --after-policy P2 [--seeds N] [--out FILE]
//     --before-lib  a directory holding the previous lib/ (jev.mjs and what it imports), e.g. from `git show master:...`
//     the Jev source is the after policy's first jev source (url, model, key_file/key_var), as the plugin reads it.
// Prints one row per call, then accuracy by confidence bucket, applied accuracy and coverage per threshold, and the
// served accuracy (Jev's pick when confident, else the default the code keeps) for both payloads.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJev, buildPayload, requestSource } from "../lib/jev.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const before = read(opt("--before-policy")), after = read(opt("--after-policy"));
const oldJev = await import(pathToFileURL(path.resolve(opt("--before-lib"), "jev.mjs")).href);
const SEEDS = Number(opt("--seeds", 3));
const src = { ...after.jev.sources[0] };
const cfg = { sources: [src], deadline_ms: 30000, source_timeout_ms: 25000 };
const jev = createJev();

const fam = (id) => id.split("/").at(-1);
const byFam = (p, f) => p.order.paid.find((id) => fam(id).startsWith(f));
const DEEP = "deepseek", MIMO = "mimo", GLM = "glm", MUSE = "muse";
const quick = [DEEP, GLM], knowledge = [MUSE, DEEP], agentic = [DEEP, MIMO, GLM], coding = [MIMO, GLM, DEEP], hardSwe = [MIMO, GLM], longDoc = [DEEP, MIMO], proof = [MIMO, GLM, DEEP];
const LONG = "Pasal 1. Para pihak sepakat bahwa ... ".repeat(40);
const LOG = "2026-11-02T10:00:01Z ERROR db pool exhausted (max=10)\n2026-11-02T10:00:02Z WARN retry 3/5 upstream timeout\n".repeat(8);

// chat app: our system prompt is present, the agent has a few tools (search, fetch, run code); API: a coding agent
// with many tools and its own system prompt, or a bare SDK call.
const CHAT = { source: "chat app", system: true, tools: 4 }, API_AGENT = { source: "API client", system: true, tools: 24 }, API_BARE = { source: "API client", system: false, tools: 0 };
const cases = [
  { ...CHAT, ask: "Ibu kota Australia apa ya?", ok: quick },
  { ...CHAT, ask: "Berapa kilometer jarak Jakarta ke Bandung?", ok: quick },
  { ...CHAT, ask: "halo kak, apa kabar? lagi rame nggak?", ok: quick },
  { ...CHAT, ask: "Jelaskan unsur-unsur perbuatan melawan hukum menurut Pasal 1365 KUHPerdata dan bedanya dengan wanprestasi, dengan contoh kasus.", ok: knowledge },
  { ...CHAT, ask: "Jelaskan mekanisme kerja metformin dan efek sampingnya untuk ujian farmakologi besok.", ok: knowledge },
  { ...CHAT, ask: "Seorang pasien datang dengan nyeri dada menjalar ke lengan kiri; bagaimana pendekatan diagnosis banding dan pemeriksaan awalnya?", ok: knowledge },
  { ...CHAT, ask: "Jelaskan mekanisme reaksi SN2 versus SN1 untuk mahasiswa kimia organik, lengkap dengan faktor yang menentukan.", ok: knowledge },
  { ...CHAT, ask: "Siapa saja yang menandatangani Perjanjian Linggarjati dan apa isi pokoknya?", ok: knowledge },
  { ...CHAT, ask: "Hitung PPh 21 untuk karyawan dengan gaji 12 juta per bulan, status K/1, dan jelaskan dasar aturannya.", ok: knowledge },
  { ...CHAT, ask: "Buktikan bahwa akar dua adalah bilangan irasional, langkah demi langkah.", ok: proof },
  { ...CHAT, ask: "Ada 5 orang duduk melingkar dengan 4 syarat posisi yang saling bergantung; berapa susunan yang mungkin? Tunjukkan penalarannya.", ok: proof },
  { ...CHAT, ask: `Ini kontrak kerja saya lengkap dengan lampirannya. Cari pasal yang saling bertentangan dan jelaskan risikonya.\n${LONG}`, tokens: 30000, ok: longDoc },
  { ...CHAT, ask: "Ini file Excel penjualan toko saya 3 bulan. Analisis tren per produk, jalankan perhitungannya, dan buatkan grafik.", ok: agentic },
  { ...CHAT, ask: "Cari harga tiket kereta Jakarta-Yogyakarta untuk Sabtu depan di beberapa situs, bandingkan, lalu rekomendasikan yang termurah.", ok: agentic },
  { ...CHAT, ask: "Tolong buatkan script Python untuk membaca CSV dan menghitung rata-rata kolom harga.", ok: coding },
  { ...CHAT, ask: "Kode Python saya error IndexError di loop baris 12, tolong perbaiki dan jalankan tesnya.", ok: coding },
  { ...CHAT, ask: "Oke, terus kalau gajinya 15 juta per bulan berapa?", tokens: 3000, previous: { head: MUSE, effort: "normal" }, ok: [MUSE] },
  { ...CHAT, ask: "Makasih! Satu lagi: ibu kota Selandia Baru apa?", tokens: 2000, previous: { head: DEEP, effort: "trivial" }, ok: [DEEP] },
  { ...API_AGENT, ask: "Refactor the payment module into smaller functions, keep the existing tests passing, and run the test suite.", tokens: 20000, ok: coding },
  { ...API_AGENT, ask: "The CI build fails with a TypeScript error in src/api/routes.ts; find the cause and fix it.", tokens: 20000, ok: coding },
  { ...API_AGENT, ask: "Implement a token-bucket rate limiter middleware for our Express app, with unit tests.", tokens: 20000, ok: coding },
  { ...API_AGENT, ask: "Migrate this repository's 40 test files from Jest to Vitest, fix every failure, and update the CI config.", tokens: 25000, ok: hardSwe },
  { ...API_AGENT, ask: "Users report a race condition where two workers process the same job; trace it through the queue code and fix it with a test that reproduces it.", tokens: 25000, ok: hardSwe },
  { ...API_AGENT, ask: "Find why the Postgres query in reports.sql is slow, propose an index, and verify with EXPLAIN.", tokens: 20000, ok: coding },
  { ...API_AGENT, ask: "Now also update the README to describe the new --dry-run flag.", tokens: 30000, previous: { head: MIMO, effort: "hard" }, ok: [MIMO] },
  { ...API_AGENT, ask: "Run the linter and fix the three warnings it reports.", tokens: 22000, previous: { head: GLM, effort: "normal" }, ok: [GLM] },
  { ...API_BARE, ask: `Summarize this error log and list the likely causes:\n${LOG}`, ok: quick },
  { ...API_BARE, ask: "Translate these product names to Indonesian and return JSON with the same keys: {\"a\":\"iced latte\",\"b\":\"croissant\"}", ok: quick },
  { ...API_BARE, ask: "What is the half-life of carbon-14, and how is radiocarbon dating calibrated?", ok: knowledge },
  { ...API_BARE, ask: "Write a regex that matches Indonesian mobile numbers (+62 or 08 prefixes) and Python tests for it.", ok: coding },
  { ...API_BARE, ask: `List the open questions and contradictions in this specification:\n${LONG}`, tokens: 30000, ok: longDoc },
  { source: "API client", system: false, tools: 3, ask: "Call the weather tool for Jakarta and Bandung and tell me which one is warmer right now.", ok: quick },
];

const shownOf = (p) => p.order.paid.filter((id) => !(p.jev?.hidden ?? []).includes(id)).slice(0, p.jev?.max_shown?.paid ?? 12);
const facts = (p) => Object.fromEntries(p.order.paid.map((id) => [id, p.models[id] ?? {}]));
const rows = [];
let cost = 0;
for (const [ci, c] of cases.entries()) {
  const req = { tokens: c.tokens ?? 300, images: 0, usesTools: c.tools > 0, toolCount: c.tools, system: c.system };
  const ok = (id) => !!id && c.ok.some((f) => fam(id).startsWith(f));
  for (let s = 0; s < SEEDS; s++) {
    const bShown = shownOf(before), aShown = shownOf(after);
    const prevB = c.previous ? { ...c.previous, head: byFam(before, c.previous.head) } : null;
    const prevA = c.previous ? { ...c.previous, head: byFam(after, c.previous.head) } : null;
    const pB = oldJev.buildPayload({ pool: "paid", ask: c.ask, req, shown: bShown, facts: facts(before), policy: before });
    const pA = buildPayload({ ask: c.ask, req, shown: aShown, facts: facts(after), policy: after, seed: `eval-${ci}-${s}`, previous: prevA, source: c.source });
    const [rB, rA] = await Promise.all([jev.ask(cfg, pB), jev.ask(cfg, pA)]);
    for (const r of [rB, rA]) cost += (r.usage?.cost_nusd ?? r.tried?.reduce((a, t) => a + (t.usage?.cost_nusd ?? 0), 0) ?? 0) / 1e9;
    const pickB = rB.ok ? (pB.order ?? bShown)[rB.index] : null, pickA = rA.ok ? pA.order[rA.index] : null;
    // what is served when Jev is not confident: before re-decided every fresh turn (the configured head); after keeps
    // the conversation's previous model, else the configured head
    rows.push({ ci, s, src: c.source, ask: c.ask.slice(0, 44).replace(/\n/g, " "),
      b: { pick: pickB, ok: ok(pickB), conf: rB.ok ? rB.confidence : null, dflt: bShown[0], dok: ok(bShown[0]), err: rB.ok ? null : rB.error },
      a: { pick: pickA, ok: ok(pickA), conf: rA.ok ? rA.confidence : null, dflt: prevA?.head ?? aShown[0], dok: ok(prevA?.head ?? aShown[0]), err: rA.ok ? null : rA.error } });
    const r = rows.at(-1), f = (x) => `${x.ok ? "OK " : "BAD"} ${(x.pick ? fam(x.pick) : "ERR " + x.err).slice(0, 26).padEnd(26)} ${x.conf === null ? "  -  " : x.conf.toFixed(2)}`;
    console.log(`${String(ci).padStart(2)}.${s} ${c.source.padEnd(10)} ${r.ask.padEnd(44)} | before ${f(r.b)} | after ${f(r.a)}`);
  }
}

const buckets = [[0, 0.3], [0.3, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]];
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%`.padStart(4) : "   -");
const report = (k) => {
  const xs = rows.map((r) => r[k]).filter((x) => x.conf !== null);
  console.log(`\n${k === "b" ? "BEFORE (master payload, live policy)" : "AFTER (v2 payload, v2 policy)"}: ${xs.length} answers, pick accuracy ${pct(xs.filter((x) => x.ok).length, xs.length)}`);
  console.log("confidence   n  accuracy");
  for (const [lo, hi] of buckets) { const b = xs.filter((x) => x.conf >= lo && x.conf < hi); console.log(`${lo.toFixed(1)}-${Math.min(hi, 1).toFixed(1)}  ${String(b.length).padStart(4)}  ${pct(b.filter((x) => x.ok).length, b.length)}`); }
  console.log("threshold  applied  accuracy-when-applied  served-accuracy");
  const out = {};
  for (const t of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]) {
    const ap = xs.filter((x) => x.conf >= t);
    const served = xs.filter((x) => (x.conf >= t ? x.ok : x.dok)).length;
    out[t] = { applied: ap.length / xs.length, acc: ap.length ? ap.filter((x) => x.ok).length / ap.length : null, served: served / xs.length, n: ap.length };
    console.log(`   ${t.toFixed(2)}    ${pct(ap.length, xs.length)}    ${pct(ap.filter((x) => x.ok).length, ap.length)} (n=${String(ap.length).padStart(3)})        ${pct(served, xs.length)}`);
  }
  return out;
};
const rb = report("b"), ra = report("a");
// proposal: the lowest threshold whose applied picks are at least 90% right on at least 10 answers
const prop = Object.entries(ra).find(([, v]) => v.acc !== null && v.acc >= 0.9 && v.n >= 10)?.[0] ?? null;
console.log(`\nproposed apply threshold (after): ${prop ?? "none reaches 90% on >= 10 answers"}; Jev ${src.model}; ${rows.length * 2} calls, cost $${cost.toFixed(4)}`);
const out = opt("--out");
if (out) fs.writeFileSync(out, JSON.stringify({ rows, before: rb, after: ra, proposed: prop }, null, 1));
