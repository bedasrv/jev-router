#!/usr/bin/env node
// UP-10c: put the menu into a live policy.json. Dry run by default (prints what changes); --write replaces the file
// (keep a backup first). The menu file is the owner-editable data (plugin/ops/menu.example.json shape); the result is
// validated with the same rules the plugin loads it with, so a bad menu never reaches the router.
//   node plugin/ops/apply-menu.mjs <policy.json> [--menu FILE] [--out FILE] [--write]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../lib/policy.mjs";
import { menuTargets } from "../lib/menu.mjs";

const args = process.argv.slice(2);
const policyFile = args.find((a) => !a.startsWith("--"));
if (!policyFile) { console.error("usage: apply-menu.mjs <policy.json> [--menu FILE] [--out FILE] [--write]"); process.exit(2); }
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const menuFile = opt("--menu") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "menu.example.json");
const policy = JSON.parse(fs.readFileSync(policyFile, "utf8"));
const { _comment, ...menu } = JSON.parse(fs.readFileSync(menuFile, "utf8"));
const next = { ...policy, menu };
validate(next);
const listedHint = menuTargets(menu).filter((id) => !(policy.order?.paid ?? []).includes(id) && !(policy.order?.free ?? []).includes(id));
console.log(`menu: ${menu.items.length} items (${menu.items.map((i) => `${i.id}=${i.model.split("/").at(-1)}:${i.thinking ? i.thinking.value : "default"}`).join(", ")})`);
if (listedHint.length) console.log(`targets not in order.*: ${listedHint.join(", ")} (facts still load them; check the listing has them)`);
console.log(policy.menu ? "replaces the existing menu" : "adds a menu (the router switches to menu mode)");
const out = opt("--out") ?? (args.includes("--write") ? policyFile : null);
if (out) { fs.writeFileSync(out, JSON.stringify(next, null, 1) + "\n"); console.log(`wrote ${out}`); }
else console.log("dry run: pass --write or --out FILE");
