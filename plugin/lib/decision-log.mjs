import fs from "node:fs";

// JSONL, hashes only, never prompt text. Logging must never break routing.
export function createLog(file) {
  return (rec) => {
    if (!file) return;
    try { fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n"); } catch {}
  };
}
