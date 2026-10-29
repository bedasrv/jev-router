import fs from "node:fs";
import { validateThinking } from "./thinking.mjs";

// policy.json is data: pool order, per-id facts, denylist, listing sources.
// Hot-reloaded on mtime; an invalid file keeps the last good one.
export function createPolicyLoader(file, log = () => {}) {
  let good = null, mtime = 0;
  return function load() {
    try {
      const m = fs.statSync(file).mtimeMs;
      if (m !== mtime || !good) {
        const p = JSON.parse(fs.readFileSync(file, "utf8"));
        validate(p);
        good = p; mtime = m;
      }
    } catch (e) {
      mtime = 0;
      log({ event: "policy_error", error: String(e.message) });
    }
    return good;
  };
}

export function validate(p) {
  if (!p || typeof p !== "object") throw new Error("policy must be an object");
  for (const pool of ["paid", "free"]) {
    if (!Array.isArray(p.order?.[pool])) throw new Error(`order.${pool} must be an array`);
    if (!p.order[pool].every((x) => typeof x === "string")) throw new Error(`order.${pool} must hold strings`);
  }
  if (p.models && typeof p.models !== "object") throw new Error("models must be an object");
  if (p.denylist && !Array.isArray(p.denylist)) throw new Error("denylist must be an array");
  // Missing thinking is allowed at runtime (unknown = control:none, omit the field); when an
  // entry is present its shape is strict so a typo cannot silently change what goes on the wire.
  for (const [id, m] of Object.entries(p.models ?? {})) {
    if (m?.thinking === undefined) continue;
    const err = validateThinking(m.thinking);
    if (err) throw new Error(`models.${id}.${err}`);
  }
}
