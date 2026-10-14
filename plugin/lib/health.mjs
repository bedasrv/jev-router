// Failure memory learned from OmniRoute's onRouteResult: which of our picks failed, and for how long
// to demote them. Cooling members are DEMOTED (moved to the end of the list), never removed, so the last
// resort stays reachable and a recovered member is found again after its cooldown.

const DEFAULTS = { base_ms: 30000, auth_base_ms: 60000, max_ms: 600000, domain_window_ms: 60000, omni_skip_ms: 30000 };

// Statuses that say something about the model/connection. Other 4xx (400, 404, 413, 422 ...) are about
// the request (e.g. "Image too small", context too long, bad parameter) and must not punish the model.
const AUTHLIKE = new Set([401, 402, 403]);
const isHealthFailure = (a) => !a.ok && (AUTHLIKE.has(a.status) || a.status === 408 || a.status === 429 || a.status >= 500 || a.status === null || a.kind === "timeout");

export const domainOf = (id) => String(id).split("/")[0];

export function createHealth({ now = Date.now, cfg = {}, log = () => {}, prev = null } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const models = prev?._models ?? new Map(); // id -> {fails, until, status, kind}
  const domains = prev?._domains ?? new Map(); // prefix -> {until, status, recent: Map<id, ts>}

  const dur = (fails, status) => Math.min(c.max_ms, (AUTHLIKE.has(status) ? c.auth_base_ms : c.base_ms) * 2 ** Math.max(0, fails - 1));

  function fail(a) {
    const t = now();
    const m = models.get(a.model) ?? { fails: 0, until: 0 };
    m.fails += 1; m.status = a.status; m.kind = a.kind; m.until = t + dur(m.fails, a.status);
    models.set(a.model, m);
    // the same failure across two different models of one connection = a connection-level problem
    const d = domainOf(a.model);
    const dm = domains.get(d) ?? { until: 0, recent: new Map() };
    dm.recent.set(a.model, t);
    for (const [id, ts] of dm.recent) if (t - ts > c.domain_window_ms) dm.recent.delete(id);
    if (dm.recent.size >= 2) { dm.until = Math.max(dm.until, t + dur(m.fails, a.status)); dm.status = a.status; }
    domains.set(d, dm);
  }

  function succeed(id) {
    models.delete(id);
    const dm = domains.get(domainOf(id));
    if (dm) { dm.until = 0; dm.recent.clear(); }
  }

  // payload = onRouteResult: {attempts:[{model,ok,status,kind}], skipped:[{model,reason}]}
  function record(p) {
    const t = now();
    for (const a of p?.attempts ?? []) {
      if (a.ok) succeed(a.model);
      else if (isHealthFailure(a)) fail(a);
    }
    for (const s of p?.skipped ?? []) {
      // OmniRoute itself is skipping this one (cooldown, lockout, breaker): follow it for a short while
      const m = models.get(s.model) ?? { fails: 0, until: 0 };
      m.until = Math.max(m.until, t + c.omni_skip_ms); m.kind = s.reason; models.set(s.model, m);
    }
  }

  const isCooling = (id) => (models.get(id)?.until ?? 0) > now() || (domains.get(domainOf(id))?.until ?? 0) > now();
  const demote = (ids) => [...ids.filter((i) => !isCooling(i)), ...ids.filter(isCooling)];
  const snapshot = () => {
    const t = now(), out = {};
    for (const [id, m] of models) if (m.until > t) out[id] = { fails: m.fails, status: m.status, kind: m.kind, secs: Math.round((m.until - t) / 1000) };
    for (const [d, m] of domains) if (m.until > t) out[`${d}/*`] = { status: m.status, secs: Math.round((m.until - t) / 1000) };
    return out;
  };
  return { record, isCooling, demote, snapshot, _models: models, _domains: domains };
}
