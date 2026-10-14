import { eligible, usableWindow } from "./eligibility.mjs";

const domainOf = (id, facts) => facts[id]?.domain ?? id.split("/")[0];

// Greedy: next candidate must sit on a different connection (failure domain)
// than the previous member; otherwise take the first remaining one.
export function alternate(ids, facts, lastDomain = null) {
  const rest = [...ids], out = [];
  let last = lastDomain;
  while (rest.length) {
    let i = rest.findIndex((id) => domainOf(id, facts) !== last);
    if (i < 0) i = 0;
    const [id] = rest.splice(i, 1);
    out.push(id);
    last = domainOf(id, facts);
  }
  return out;
}

export function eligibleIds({ pool, policy, facts, req, health = null }) {
  const deny = new Set(policy.denylist ?? []);
  const excluded = [];
  const pick = (ids) => ids.filter((id) => {
    if (deny.has(id)) { excluded.push({ id, reason: "denylist" }); return false; }
    const r = eligible(facts[id], req);
    if (!r.ok) { excluded.push({ id, reason: r.reason }); return false; }
    return true;
  });
  let main = pick(policy.order[pool]);
  let spill = pool === "paid" ? pick(policy.order.free).filter((id) => !main.includes(id)) : [];
  // learned failures: cooling members go to the end (kept as a last chance, never offered to Jev)
  const cooling = [];
  if (health) { for (const id of [...main, ...spill]) if (health.isCooling(id)) cooling.push(id); main = health.demote(main); spill = health.demote(spill); }
  return { main, spill, excluded, cooling };
}

export function buildList({ pool, policy, facts, req, preferred = null, health = null, now = Date.now() }) {
  const deny = new Set(policy.denylist ?? []);
  const lim = policy.limits ?? {};
  const maxMain = (pool === "free" ? lim.max_main_free : null) ?? lim.max_main ?? 3, maxSpill = lim.max_spill ?? 2;
  const { main, spill, excluded, cooling } = eligibleIds({ pool, policy, facts, req, health });
  // a sticky/Jev preference never outranks a member we know is failing right now
  if (preferred && main.includes(preferred) && !cooling.includes(preferred)) main.splice(0, main.length, preferred, ...main.filter((x) => x !== preferred));

  let models;
  if (!main.length && !spill.length) {
    // nothing fits: widest windows first, let the upstream's own size error answer
    const all = [...policy.order[pool], ...(pool === "paid" ? policy.order.free : [])].filter((id) => !deny.has(id));
    models = all.sort((a, b) => usableWindow(facts[b], req.reserve) - usableWindow(facts[a], req.reserve)).slice(0, maxMain);
    return { models, excluded, nofit: true, cooling };
  }
  const head = alternate(main.slice(0, maxMain), facts);
  const tail = alternate(spill.slice(0, pool === "paid" ? maxSpill : 0), facts, head.length ? domainOf(head.at(-1), facts) : null);
  models = [...new Set([...head, ...tail])];
  if (pool === "free") models = alternate(main.slice(0, maxMain), facts);
  // last resort (e.g. mscopilot): appended after the cap, only if eligible and not already listed
  const last = policy.last_resort?.[pool];
  if (last && !models.includes(last) && !deny.has(last) && eligible(facts[last], req).ok) models.push(last);
  return { models, excluded, nofit: false, cooling };
}
