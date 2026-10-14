import crypto from "node:crypto";

export const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

export function conversationKey(headers, body) {
  const h = headers?.["x-omniroute-session-id"] ?? headers?.["X-OmniRoute-Session-Id"];
  if (h) return "s:" + hash(String(h));
  const msgs = body?.messages ?? [];
  const sys = msgs.find((m) => m.role === "system" || m.role === "developer");
  const first = msgs.find((m) => m.role === "user");
  const t = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
  return "h:" + hash(t(sys) + "\u0000" + t(first));
}

// Fresh task = no tool result is waiting for the model's reply. Some clients (opencode) append a
// synthetic trailing user message after the tool result, so "last message is user" is not enough:
// look at what follows the last assistant message instead.
export function isFresh(body) {
  const msgs = body?.messages ?? [];
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i]?.role !== "assistant") i--;
  const tail = msgs.slice(i + 1);
  if (tail.some((m) => m?.role === "tool" || m?.role === "function")) return false;
  return msgs.at(-1)?.role === "user";
}

export function createSessions(ttlMs = 3600000, max = 5000) {
  const m = new Map();
  return {
    get(k, now = Date.now()) { const v = m.get(k); if (!v) return null; if (now - v.ts > ttlMs) { m.delete(k); return null; } return v; },
    set(k, v, now = Date.now()) {
      if (m.size >= max) for (const [kk, vv] of m) { if (now - vv.ts > ttlMs || m.size >= max) m.delete(kk); if (m.size < max) break; }
      m.set(k, { ...v, ts: now });
    },
    size: () => m.size,
  };
}
