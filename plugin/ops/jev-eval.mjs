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
const sub = P.filter((m) => !m.startsWith("openrouter/")); // included in the subscription
const cheap = [...sub, "openrouter/inclusionai/ling-3.1-flash"]; // plus the very cheap pay-per-use one
const strong = ["openrouter/deepseek/deepseek-v4.1-flash-1017", "openrouter/anthropic/claude-haiku-5.5", "ocgob/opencode-go/gpt-6-luna", "openrouter/openai/gpt-6-luna", "ocgob/opencode-go/glm-5.3-flash", "openrouter/z-ai/glm-5.3-flash", "ocgoa/opencode-go/deepseek-v4.1-flash"];
const coder = ["openrouter/deepseek/deepseek-v4.1-flash-1017", "ocgob/opencode-go/glm-5.3-flash", "openrouter/z-ai/glm-5.3-flash", "ocgoa/opencode-go/deepseek-v4.1-flash", "openrouter/anthropic/claude-haiku-5.5"];
const freeClean = ["ocpv/opencode-go/beam-free", "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"];
const freeStrong = [...freeClean, "ocpv/opencode-go/minimax-m3.1-flash-free", "openrouter/minimax/minimax-m3.1-flash:free"];
const T = { tokens: 300, images: 0, usesTools: true };

const cases = [
  { pool: "paid", ask: "halo, apa kabar? lagi ngapain?", ok: cheap.filter((m) => !m.includes("gpt-6-luna")) },
  { pool: "paid", ask: "Ibu kota Australia apa ya?", ok: cheap },
  { pool: "paid", ask: "Buatkan CV dalam bahasa Inggris dari data ini: nama Rina, lulusan SMK akuntansi 2024, magang 6 bulan di koperasi, bisa Excel.", ok: [...cheap, "openrouter/openai/gpt-6-luna"] },
  { pool: "paid", ask: "Tolong tulis surat lamaran kerja formal untuk posisi kasir di minimarket.", ok: [...cheap, "openrouter/openai/gpt-6-luna"] },
  { pool: "paid", ask: "Tolong perbaiki kode Python ini, error IndexError di loop baris 12, lalu jalankan tesnya.", ok: coder },
  { pool: "paid", ask: "Ini file Excel penjualan toko saya 3 bulan. Analisis tren per produk dan buatkan grafik serta ringkasan.", ok: strong },
  { pool: "paid", ask: "Saya dapat surat perjanjian kontrak kerja ini. Apakah ada pasal yang merugikan saya? Jelaskan risikonya.", ok: ["openrouter/anthropic/claude-haiku-5.5", "ocgob/opencode-go/gpt-6-luna", "openrouter/openai/gpt-6-luna"] },
  { pool: "paid", ask: "Buktikan bahwa akar dua adalah bilangan irasional, langkah demi langkah.", ok: strong },
  { pool: "paid", ask: "Ringkas artikel berita ini jadi 3 poin.", ok: cheap },
  { pool: "paid", ask: "Bikin caption Instagram lucu buat jualan kopi susu gula aren.", ok: cheap },
  { pool: "free", ask: "halo kak", ok: freeClean },
  { pool: "free", ask: "Jelaskan proses fotosintesis untuk anak SMP dalam bahasa Indonesia.", ok: freeClean },
  { pool: "free", ask: "Kerjakan soal ini: sebuah mobil melaju 60 km/jam selama 2,5 jam, berapa jarak tempuhnya? Jelaskan caranya.", ok: freeStrong },
  { pool: "free", ask: "Tolong buatkan script Python untuk membaca CSV dan menghitung rata-rata kolom harga.", ok: freeStrong },
  { pool: "free", ask: "Terjemahkan paragraf ini ke bahasa Indonesia yang baku dan enak dibaca.", ok: freeClean },
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
