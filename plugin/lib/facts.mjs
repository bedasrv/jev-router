import fs from "node:fs";

// Facts per dispatch id = listing-source data (windows) overlaid by policy.models overrides.
// Listing sources refresh in the background; the hook path only reads the cache.
export function createFacts({ fetchImpl = fetch, readFile = (f) => fs.readFileSync(f, "utf8"), log = () => {}, refreshMs = 300000 } = {}) {
  const listed = new Map(); // dispatch id -> {context_length,max_input_tokens,tools,vision}
  let timer = null, sourcesKey = "";

  async function refreshOne(src) {
    const headers = {};
    if (src.key_file) {
      let key = readFile(src.key_file).trim();
      if (src.key_var) key = (key.match(new RegExp(`^\\s*${src.key_var}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
      if (key) headers.authorization = "Bearer " + key;
    }
    const r = await fetchImpl(src.list_url, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    for (const m of d.data ?? []) {
      listed.set(`${src.prefix}/${m.id}`, {
        context_length: m.context_length ?? undefined,
        max_input_tokens: m.max_input_tokens ?? undefined,
        tools: m.capabilities?.tool_calling ?? undefined,
        vision: Array.isArray(m.input_modalities) ? m.input_modalities.includes("image") : undefined,
      });
    }
  }
  async function refresh(policy) {
    for (const src of policy?.sources ?? []) {
      try { await refreshOne(src); } catch (e) { log({ event: "source_error", prefix: src.prefix, error: String(e.message) }); }
    }
  }
  function ensure(policy) {
    const key = JSON.stringify(policy?.sources ?? []);
    if (key === sourcesKey) return;
    sourcesKey = key;
    if (timer) clearInterval(timer);
    refresh(policy);
    timer = setInterval(() => refresh(policy), refreshMs);
    timer.unref?.();
  }
  function get(policy) {
    ensure(policy);
    const out = {};
    const ids = new Set([...policy.order.paid, ...policy.order.free]);
    const loaded = new Set([...listed.keys()].map((k) => k.split("/")[0]));
    for (const id of [...ids, ...Object.values(policy.last_resort ?? {})]) {
      const prefix = id.split("/")[0];
      const isSource = (policy.sources ?? []).some((x) => x.prefix === prefix);
      // a source whose listing has loaded is authoritative: an id it lacks is not dispatchable
      out[id] = { ...(listed.get(id) ?? {}), ...(policy.models?.[id] ?? {}), ...(isSource && loaded.has(prefix) && !listed.has(id) ? { unlisted: true } : {}) };
    }
    return out;
  }
  return { get, refresh, listed };
}
