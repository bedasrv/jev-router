const FLOOR = 32768;
const RESERVE_DEFAULT = 16384;
const IMAGE_CHARS = 4000; // fixed allowance per image, charged as chars

export function inspectRequest(body) {
  let chars = 0, ascii = 0, images = 0;
  const add = (s) => { if (typeof s !== "string") return; chars += s.length; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++; };
  for (const m of body?.messages ?? []) {
    if (typeof m?.content === "string") add(m.content);
    else if (Array.isArray(m?.content)) for (const p of m.content) {
      if (p?.type === "text") add(p.text);
      else if (p?.type === "image_url" || p?.type === "image") images++;
      else add(JSON.stringify(p));
    }
    if (m?.tool_calls) add(JSON.stringify(m.tool_calls));
  }
  if (body?.tools) add(JSON.stringify(body.tools));
  const nonAscii = chars - ascii;
  const tokens = Math.ceil(ascii / 4 + nonAscii / 2) + images * Math.ceil(IMAGE_CHARS / 4);
  const reserve = Number.isFinite(body?.max_tokens) ? body.max_tokens
    : Number.isFinite(body?.max_completion_tokens) ? Math.min(body.max_completion_tokens, RESERVE_DEFAULT) : RESERVE_DEFAULT;
  return { tokens, reserve, images, usesTools: Array.isArray(body?.tools) && body.tools.length > 0 };
}

export function usableWindow(f, reserve) {
  const ctx = Number.isFinite(f?.context_length) ? f.context_length : FLOOR;
  let w = ctx - reserve;
  if (Number.isFinite(f?.max_input_tokens)) w = Math.min(w, f.max_input_tokens);
  return w;
}

// Returns {ok, reason}. A null/absent flag is ineligible only when the request needs it.
export function eligible(f, req) {
  if (f?.unlisted === true) return { ok: false, reason: "not_listed" };
  if (req.usesTools && f?.tools !== true) return { ok: false, reason: "tools" };
  if (req.images > 0 && f?.vision !== true) return { ok: false, reason: "vision" };
  if (req.tokens > usableWindow(f, req.reserve)) return { ok: false, reason: "window" };
  return { ok: true };
}
