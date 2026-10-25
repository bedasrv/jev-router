// node ops/rules-check.mjs policy.json: runs sample requests through the real router with the policy's own facts and prints which rule (if any) took each.
import fs from "node:fs";
import { createRouter } from "../index.mjs";
const file = process.argv[2];
const policy = JSON.parse(fs.readFileSync(file, "utf8"));
const r = createRouter({ policyFile: file, jev: { ask: async () => ({ ok: false, tried: [] }) }, facts: { get: (p) => Object.fromEntries([...p.order.paid, ...p.order.free].map((i) => [i, p.models[i] ?? {}])) } });
const cases = [
  ["Jelaskan unsur perbuatan melawan hukum menurut Pasal 1365 KUHPerdata", true], ["Sah atau tidak perjanjian jual beli tanah lisan? apa dasar hukumnya", true], ["Apa perbedaan pidana dan perdata pada kasus penipuan?", true], ["Explain the elements of a tort claim and the defendant's liability", true],
  ["Apa dosis parasetamol yang aman untuk anak 15 kg?", true], ["Efek samping dan kontraindikasi metformin untuk pasien gagal ginjal", true], ["Jelaskan patofisiologi gagal jantung", true], ["What are the symptoms and treatment of type 2 diabetes?", true],
  ["Hitung PPh 21 gaji 12 juta K/1 dan buat jurnal", true], ["Buat laporan laba rugi dan neraca dari transaksi ini", true], ["Cara menghitung depresiasi garis lurus", true], ["Build a DCF valuation and a balance sheet for this startup", true],
  ["halo kak, apa kabar?", false], ["Ibu kota Australia apa?", false], ["Tolong perbaiki kode Python ini, IndexError di baris 12", false], ["Bikin caption Instagram lucu buat jualan kopi", false], ["Buktikan akar dua irasional", false], ["Ayo main peran jadi barista", false], ["tolong buat hukumannya di game saya lebih ringan", false],
];
let bad = 0;
for (const [t, want] of cases) {
  const out = await r.onRoute({ model: "paid", headers: {}, body: { messages: [{ role: "user", content: t }] } });
  const got = out.reason.startsWith("rule:");
  if (got !== want) bad++;
  console.log(`${got === want ? "ok " : "BAD"} ${got ? "rule  " : "other "} ${out.models[0].split("/").slice(1).join("/").padEnd(30)} ${t.slice(0, 70)}`);
}
console.log(bad ? `${bad} wrong` : "all as expected");
process.exit(bad ? 1 : 0);
