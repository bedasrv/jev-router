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
  if (p.thinking_aliases !== undefined) {
    const a = p.thinking_aliases;
    if (!a || typeof a !== "object" || Array.isArray(a) || !Object.values(a).every((v) => Array.isArray(v) && v.every((x) => typeof x === "string")))
      throw new Error("thinking_aliases must map a prefix to an array of prefixes");
  }
  const ss = p.jev?.skip_sessions;
  if (ss !== undefined && !(Array.isArray(ss) && ss.every((x) => typeof x === "string" && x))) throw new Error("jev.skip_sessions must be an array of session ids");
  const sh = p.jev?.session_header;
  if (sh !== undefined && !(typeof sh === "string" && sh)) throw new Error("jev.session_header must be a header name");
  const mf = p.jev?.min_fallbacks;
  if (mf !== undefined && !(Number.isInteger(mf) && mf >= 0)) throw new Error("jev.min_fallbacks must be a non-negative integer");
  // Missing thinking is allowed at runtime (unknown = control:none, omit the field); when an
  // entry is present its shape is strict so a typo cannot silently change what goes on the wire.
  for (const [id, m] of Object.entries(p.models ?? {})) {
    if (m?.thinking === undefined) continue;
    const err = validateThinking(m.thinking);
    if (err) throw new Error(`models.${id}.${err}`);
  }
}
