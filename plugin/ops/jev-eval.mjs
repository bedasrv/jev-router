// Offline evaluation of Jev's model pick: representative cafe requests, each with the options a
// careful human would accept, run against a real SystemOne endpoint with the CURRENT payload
// (structured profiles) and the PREVIOUS one (one-line traits + the old instruction).
//   OPENROUTER_API_KEY=... node ops/jev-eval.mjs <policy.json> [model-profiles.json] [jev model]
import fs from "node:fs";
import { buildPayload, confidence } from "../lib/jev.mjs";

const [policyFile, profilesFile, jevModel = "~typesafe/jev-latest"] = process.argv.slice(2);
const policy = JSON.parse(fs.readFileSync(policyFile, "utf8"));
const profiles = profilesFile ? JSON.parse(fs.readFileSync(profilesFile, "utf8")) : {};
const URL_ = "https://openrouter.ai/api/v1/systemone";
const KEY = process.env.OPENROUTER_API_KEY;

const P = policy.order.paid, F = policy.order.free;
// Acceptable picks per task, from the Artificial Analysis per-task columns (see model-profiles.json). Haiku and Luna are never acceptable for these:
// at the effort they run here they are the weakest on terminal-task and hard-reasoning benchmarks. Writing and small talk are not paid-pool tasks.
const GLM = ["ocgob/opencode-go/glm-5.3-flash", "openrouter/z-ai/glm-5.3-flash"];
const DEEP = "ocgoa/opencode-go/deepseek-v4.1-flash", D1017 = "openrouter/deepseek/deepseek-v4.1-flash-1017", LING = "openrouter/inclusionai/ling-3.1-flash", QWEN = "ocgoa/opencode-go/qwen3.8-flash";
const agentic = [...GLM, D1017, LING, DEEP];
const coder = [...GLM, QWEN, D1017];
const hardReasoning = [D1017, ...GLM, DEEP, LING];
const longDoc = [DEEP, D1017, LING, ...GLM];
const quick = P.filter((m) => !m.includes("gpt-6-luna") && !m.includes("haiku"));
const freeEasy = ["ocpv/opencode-go/beam-free", "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", "ocpv/opencode-go/minimax-m3.1-flash-free", "openrouter/minimax/minimax-m3.1-flash:free"];
const freeSummary = freeEasy;
const freeHard = ["ocpv/opencode-go/minimax-m3.1-flash-free", "openrouter/minimax/minimax-m3.1-flash:free"];
const freeCode = [...freeHard, "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"];
const T = { tokens: 300, images: 0, usesTools: true };

const cases = [
  { pool: "paid", ask: "Ibu kota Australia apa ya?", ok: quick },
  { pool: "paid", ask: "Tolong perbaiki kode Python ini, error IndexError di loop baris 12, lalu jalankan tesnya.", ok: coder },
  { pool: "paid", ask: "Tulis fungsi TypeScript untuk parse CSV dengan kutip ganda dan buat unit test-nya.", ok: coder },
  { pool: "paid", ask: "Ini file Excel penjualan toko saya 3 bulan. Analisis tren per produk, jalankan perhitungannya, dan buatkan grafik.", ok: agentic },
  { pool: "paid", ask: "Jalankan skrip ini di terminal, baca lognya, cari penyebab crash, lalu perbaiki konfigurasinya.", ok: agentic },
  { pool: "paid", ask: "Buktikan bahwa akar dua adalah bilangan irasional, langkah demi langkah.", ok: hardReasoning },
  { pool: "paid", ask: "Ada 5 orang duduk melingkar dengan 4 syarat posisi yang saling bergantung; berapa susunan yang mungkin? Tunjukkan penalarannya.", ok: hardReasoning },
  { pool: "paid", ask: "Ini kontrak kerja 40 halaman dan 3 lampirannya. Cari pasal yang saling bertentangan dan jelaskan risikonya.", ok: longDoc },
  { pool: "paid", ask: "Baca seluruh riwayat percakapan panjang kita dan jawab: apa tiga keputusan yang sudah kita ambil dan mana yang belum?", ok: longDoc },
  { pool: "paid", ask: "Berapa kilometer jarak Jakarta ke Bandung?", ok: quick },
  { pool: "free", ask: "halo kak", ok: ["ocpv/opencode-go/beam-free"] },
  { pool: "free", ask: "makasih ya!", ok: ["ocpv/opencode-go/beam-free"] },
  { pool: "free", ask: "Ringkas artikel berita ini jadi 3 poin.", ok: freeSummary },
  { pool: "free", ask: "Rangkum catatan rapat ini dalam lima kalimat.", ok: freeSummary },
  { pool: "free", ask: "Kerjakan soal ini: sebuah mobil melaju 60 km/jam selama 2,5 jam, berapa jarak tempuhnya? Jelaskan caranya.", ok: freeEasy },
  { pool: "free", ask: "Tolong buatkan script Python untuk membaca CSV dan menghitung rata-rata kolom harga.", ok: freeCode },
  { pool: "free", ask: "Selesaikan teka-teki logika ini yang butuh beberapa langkah penalaran berantai.", ok: freeHard },
];

// The previous payload, kept here only to compare against.
function oldPayload(pool, ask, req, shown) {
  const wc = (c) => (c >= 700000 ? "huge context window" : c >= 300000 ? "large context window" : "standard context window");
  const criteria = Object.fromEntries(shown.map((id, n) => [`c${n + 1}`, `${String(policy.models[id]?.traits ?? "general purpose model").replace(/[0-9]/g, "").replace(/\s+/g, " ").trim()}; ${wc(policy.models[id]?.context_length ?? 0)}`]));
  return { ids: shown.map((_, n) => `c${n + 1}`), state: { ask, pool, context: { chars: req.tokens * 4, has_image: false, uses_tools: req.usesTools }, candidates: Object.entries(criteria).map(([id, description]) => ({ id, description })) },
    questions: { model: { type: "choice", instructions: "Pick the specialist that can fully complete this request in one pass. Judge required reasoning, scope, ambiguity, tool use and blast radius, not requested answer length. If two fit, pick the cheaper one.", criteria } } };
}

async function ask(payload) {
  const t0 = Date.now();
  const r = await fetch(URL_, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: jevModel, state: payload.state, questions: payload.questions }), signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  const a = j.answers?.model;
  if (!a) return { err: `${r.status} ${JSON.stringify(j).slice(0, 120)}`, ms: Date.now() - t0 };
  return { choice: a.choice, conf: confidence(a.probabilities), ms: Date.now() - t0, cost: j.usage?.cost ?? 0 };
}

const withProfiles = { ...policy, models: Object.fromEntries(Object.entries(policy.models).map(([k, v]) => [k, { ...v, ...(profiles[k] ?? {}) }])) };
const score = { old: 0, new: 0 }; let cost = 0; const ms = [];
for (const c of cases) {
  const shown = c.pool === "paid" ? P : F;
  const facts = Object.fromEntries(shown.map((id) => [id, policy.models[id] ?? {}]));
  const req = { ...T };
  const pNew = buildPayload({ pool: c.pool, ask: c.ask, req, shown, facts, policy: withProfiles });
  const pOld = oldPayload(c.pool, c.ask, req, shown);
  const [rn, ro] = await Promise.all([ask(pNew), ask(pOld)]);
  const pick = (r, p) => (r.choice ? shown[p.ids.indexOf(r.choice)] : `ERR ${r.err}`);
  const n = pick(rn, pNew), o = pick(ro, pOld);
  const okN = c.ok.includes(n), okO = c.ok.includes(o);
  score.new += okN ? 1 : 0; score.old += okO ? 1 : 0; cost += (rn.cost || 0) + (ro.cost || 0); if (rn.ms) ms.push(rn.ms);
  console.log(`${c.pool.padEnd(4)} ${c.ask.slice(0, 48).padEnd(48)} | new ${okN ? "OK " : "BAD"} ${n.split("/").slice(1).join("/").padEnd(34)} ${rn.conf?.toFixed(2) ?? ""} | old ${okO ? "OK " : "BAD"} ${o.split("/").slice(1).join("/")}`);
}
ms.sort((a, b) => a - b);
console.log(`\nscore: new ${score.new}/${cases.length}, old ${score.old}/${cases.length}; jev ${jevModel}; new-payload latency p50 ${ms[Math.floor(ms.length / 2)]} ms, max ${ms.at(-1)} ms; cost $${cost.toFixed(5)}`);
