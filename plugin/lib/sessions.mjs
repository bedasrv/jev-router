import crypto from "node:crypto";

export const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

// The value of a request header, by case-insensitive name (first value if repeated).
export const headerValue = (headers, name) => {
  const n = String(name).toLowerCase();
  const v = [Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === n)?.[1]].flat()[0];
  return typeof v === "string" && v ? v : null;
};

// The key a conversation's stickiness and continuation state live under, in order:
// 1. the configured session header (jev.session_header, default x-opencode-session): Warslop sends its conversation
//    id there on every call (src/upstream.ts). Stateless API calls carry `v<voucher>` (jev.api_session_pattern) for
//    every call of one voucher, so for those the session id is mixed with the content hash: one call's tool loop
//    keeps its key, two separate calls do not share one just because they come from the same voucher;
// 2. x-omniroute-session-id;
// 3. a hash of the system prompt and the first user message (clients that name no session; new conversations with
//    the same system text and the same opening share this key).
export function conversationKey(headers, body, cfg) {
  const msgs = body?.messages ?? [];
  const sys = msgs.find((m) => m.role === "system" || m.role === "developer");
  const first = msgs.find((m) => m.role === "user");
  const t = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
  const content = () => t(sys) + "\u0000" + t(first);
  const sid = headerValue(headers, cfg?.session_header ?? "x-opencode-session");
  if (sid) return isApiSession(sid, cfg) ? "a:" + hash(sid + "\u0000" + content()) : "c:" + hash(sid);
  const h = headerValue(headers, "x-omniroute-session-id");
  if (h) return "s:" + hash(h);
  return "h:" + hash(content());
}

// A stateless API call of the app: its session id is `v<voucher>` (jev.api_session_pattern).
export function isApiSession(sid, cfg) {
  let re; try { re = new RegExp(cfg?.api_session_pattern ?? "^v[0-9]+$"); } catch { re = /^v[0-9]+$/; }
  return typeof sid === "string" && re.test(sid);
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
