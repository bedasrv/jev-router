// The menu (UP-10c, owner go 2026-11-04): Jev picks one (model + thinking) PAIR per turn from an owner-editable list in
// policy.menu, for both pools. Everything here is pure: the router (index.mjs) feeds it the policy, the facts, the
// request and the conversation's last decision.
//
// policy.menu = {
//   threshold?: 0.85,                       // confidence Jev needs (defaults to jev.threshold)
//   defaults: { paid: "P2", free: "F2" },   // the item when Jev is not confident and the conversation has none
//   min_attempts?: 2,                       // floor: head + backups, never fewer while more are eligible
//   sticky?: { downgrade_after: 2, effort_change_is_switch: false },
//   cost_basis?: { in, cached, out },       // the guest's charge basis per 1M tokens (UP-2c), for max_cost_ratio items
//   output_tokens?: 600,                    // the output a turn is assumed to produce when the ratio is computed
//   floor_fill?: { paid: [itemId...], free: [...] },   // items whose pairs top a too-short attempt list up
//   metering?: false,                       // true once warslop meters each pack per model (pack-metering-per-model)
//   kinds?: { general: "...", big_coding: "...", ... },  // task kinds Jev rates when a specialist is on offer
//   items: [{ id, pool, label, model, thinking, description, rank, prices?, eligibility?, backups?,
//             specialist?, kinds?, requires_metering? }]
// }
// Addendum (owner 2026-11-04): a specialist item (specialist: true) has kinds: [...] from menu.kinds; Jev may pick it only
// when confident about the item AND confident that the turn is one of its kinds. requires_metering: true keeps an item
// off until menu.metering is true; eligibility.until_metering: true drops its cost-ratio cutoff at that point. Flipping
// menu.metering is a policy edit, never a code change.
// item.thinking is the model's NATIVE value: null = the provider default (no field), {control:"effort", value:"low"},
// {control:"toggle", value:"on"|"off"}. backups: [{model, thinking} | {item: "P2"}], tried in order after the head.
import { eligible } from "./eligibility.mjs";

export const MENU_POOLS = ["paid", "free"];
const ID = /^[A-Za-z0-9_-]{1,16}$/;
const CONTROLS = new Set(["effort", "toggle"]);

export const DEFAULT_STICKY = Object.freeze({ downgrade_after: 2, effort_change_is_switch: false });
export const DEFAULT_MIN_ATTEMPTS = 2;
export const DEFAULT_OUTPUT_TOKENS = 600;

function thinkingProblem(t) {
  if (t === null || t === undefined) return null;
  if (!t || typeof t !== "object" || Array.isArray(t)) return "thinking must be null or {control, value}";
  if (t.control === "none") return null;
  if (!CONTROLS.has(t.control)) return "thinking.control must be effort|toggle|none";
  if (typeof t.value !== "string" || !t.value.trim() || t.value.length > 32 || /[\r\n]/.test(t.value)) return "thinking.value must be a short string";
  if (t.control === "toggle" && t.value !== "on" && t.value !== "off") return "toggle thinking.value must be on|off";
  return null;
}

const priceProblem = (p, name) => {
  if (!p || typeof p !== "object") return `${name} must be {in, cached, out}`;
  for (const k of ["in", "cached", "out"]) if (!(Number.isFinite(p[k]) && p[k] >= 0)) return `${name}.${k} must be a non-negative number`;
  return null;
};

/** Throws on the first problem; the policy loader then keeps the last good policy. */
export function validateMenu(menu) {
  if (!menu || typeof menu !== "object" || Array.isArray(menu)) throw new Error("menu must be an object");
  if (!Array.isArray(menu.items) || !menu.items.length) throw new Error("menu.items must be a non-empty array");
  const ids = new Set();
  for (const [n, it] of menu.items.entries()) {
    const at = `menu.items[${n}]`;
    if (!it || typeof it !== "object") throw new Error(`${at} must be an object`);
    if (!ID.test(it.id ?? "")) throw new Error(`${at}.id must match ${ID}`);
    if (ids.has(it.id)) throw new Error(`${at}.id ${it.id} is repeated`);
    ids.add(it.id);
    if (!MENU_POOLS.includes(it.pool)) throw new Error(`${at}.pool must be paid|free`);
    if (typeof it.model !== "string" || !it.model.includes("/")) throw new Error(`${at}.model must be a dispatch id`);
    if (typeof it.description !== "string" || !it.description.trim()) throw new Error(`${at}.description is required (Jev reads it)`);
    if (!Number.isFinite(it.rank)) throw new Error(`${at}.rank must be a number (higher = heavier/costlier)`);
    const tp = thinkingProblem(it.thinking); if (tp) throw new Error(`${at}.${tp}`);
    if (it.prices !== undefined) { const pp = priceProblem(it.prices, `${at}.prices`); if (pp) throw new Error(pp); }
    const mr = it.eligibility?.max_cost_ratio;
    if (mr !== undefined && !(Number.isFinite(mr) && mr > 0)) throw new Error(`${at}.eligibility.max_cost_ratio must be a positive number`);
    if (mr !== undefined && !it.prices) throw new Error(`${at}.eligibility.max_cost_ratio needs ${at}.prices`);
    if (it.backups !== undefined && !Array.isArray(it.backups)) throw new Error(`${at}.backups must be an array`);
    if (it.specialist !== undefined && typeof it.specialist !== "boolean") throw new Error(`${at}.specialist must be true or false`);
    if (it.requires_metering !== undefined && typeof it.requires_metering !== "boolean") throw new Error(`${at}.requires_metering must be true or false`);
    if (it.specialist) {
      if (!Array.isArray(it.kinds) || !it.kinds.length) throw new Error(`${at}.kinds must list the task kinds this specialist is for`);
      for (const k of it.kinds) if (!Object.hasOwn(menu.kinds ?? {}, k)) throw new Error(`${at}.kinds: ${k} is not in menu.kinds`);
    }
    for (const [k, b] of (it.backups ?? []).entries()) {
      if (b?.item !== undefined) { if (typeof b.item !== "string") throw new Error(`${at}.backups[${k}].item must be an item id`); continue; }
      if (typeof b?.model !== "string" || !b.model.includes("/")) throw new Error(`${at}.backups[${k}] must be {model, thinking} or {item}`);
      const bp = thinkingProblem(b.thinking); if (bp) throw new Error(`${at}.backups[${k}].${bp}`);
    }
  }
  const byId = new Map(menu.items.map((i) => [i.id, i]));
  for (const it of menu.items) for (const b of it.backups ?? []) {
    if (b.item !== undefined && !byId.has(b.item)) throw new Error(`menu item ${it.id}: backup item ${b.item} does not exist`);
    if (b.item !== undefined && byId.get(b.item).pool !== it.pool) throw new Error(`menu item ${it.id}: backup item ${b.item} is in another pool`);
  }
  for (const pool of MENU_POOLS) {
    const d = menu.defaults?.[pool];
    if (!menu.items.some((i) => i.pool === pool)) continue;
    if (!byId.has(d) || byId.get(d).pool !== pool) throw new Error(`menu.defaults.${pool} must name a ${pool} item`);
    for (const f of menu.floor_fill?.[pool] ?? []) if (!byId.has(f) || byId.get(f).pool !== pool) throw new Error(`menu.floor_fill.${pool}: ${f} is not a ${pool} item`);
  }
  if (menu.cost_basis !== undefined) { const pp = priceProblem(menu.cost_basis, "menu.cost_basis"); if (pp) throw new Error(pp); }
  if (menu.items.some((i) => i.eligibility?.max_cost_ratio !== undefined) && !menu.cost_basis) throw new Error("menu.cost_basis is required when an item has max_cost_ratio");
  if (menu.metering !== undefined && typeof menu.metering !== "boolean") throw new Error("menu.metering must be true or false");
  if (menu.kinds !== undefined) {
    if (!menu.kinds || typeof menu.kinds !== "object" || Array.isArray(menu.kinds)) throw new Error("menu.kinds must map a kind id to its description");
    for (const [k, v] of Object.entries(menu.kinds)) if (!ID.test(k.replace(/_/g, "-")) || typeof v !== "string" || !v.trim()) throw new Error(`menu.kinds.${k} must be a short id with a description`);
    if (Object.keys(menu.kinds).length < 2) throw new Error("menu.kinds needs at least two kinds (one of them for ordinary turns)");
  }
  const th = menu.threshold;
  if (th !== undefined && !(Number.isFinite(th) && th >= 0 && th <= 1)) throw new Error("menu.threshold must be 0..1");
  const ma = menu.min_attempts;
  if (ma !== undefined && !(Number.isInteger(ma) && ma >= 1)) throw new Error("menu.min_attempts must be a positive integer");
  const da = menu.sticky?.downgrade_after;
  if (da !== undefined && !(Number.isInteger(da) && da >= 1)) throw new Error("menu.sticky.downgrade_after must be a positive integer");
  const ot = menu.output_tokens;
  if (ot !== undefined && !(Number.isFinite(ot) && ot >= 0)) throw new Error("menu.output_tokens must be a non-negative number");
}

export const itemsOf = (menu, pool) => (menu?.items ?? []).filter((i) => i.pool === pool);
export const itemById = (menu, id) => (menu?.items ?? []).find((i) => i.id === id) ?? null;
export const stickyCfg = (menu) => ({ ...DEFAULT_STICKY, ...(menu?.sticky ?? {}) });
export const minAttempts = (menu) => menu?.min_attempts ?? DEFAULT_MIN_ATTEMPTS;

/** Every dispatch id the menu can send to (heads and backups), so facts cover them. */
export function menuTargets(menu) {
  const out = new Set();
  for (const it of menu?.items ?? []) {
    out.add(it.model);
    for (const b of it.backups ?? []) if (b.model) out.add(b.model);
  }
  return [...out];
}

/**
 * The part of this turn's input that a provider prompt cache can serve: everything before the new user turn (the
 * system prompt, the earlier turns, tool definitions), as a share of the whole input. Same token estimate as
 * inspectRequest (4 ASCII chars or 2 other chars per token). A first turn has no prefix, so its share is 0.
 */
export function cachedShare(body) {
  const msgs = body?.messages ?? [];
  let last = msgs.length - 1;
  while (last >= 0 && msgs[last]?.role !== "assistant") last--;
  const cost = (v) => {
    const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
    let ascii = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
    return ascii / 4 + (s.length - ascii) / 2;
  };
  let prefix = body?.tools ? cost(body.tools) : 0, total = prefix;
  msgs.forEach((m, i) => {
    const n = cost(m?.content) + (m?.tool_calls ? cost(m.tool_calls) : 0);
    total += n;
    if (i <= last) prefix += n;
  });
  return total > 0 ? prefix / total : 0;
}

/**
 * UP-2c: what a turn costs on this item's route against what the guest is charged for it (the basis), at the same
 * token mix. `input` tokens of which `share` is served from the cache, plus `output` tokens. 1.00 = break even.
 */
export function costRatio(prices, basis, { input, share, output }) {
  const c = (p) => input * (1 - share) * p.in + input * share * p.cached + output * p.out;
  const b = c(basis);
  return b > 0 ? c(prices) / b : Infinity;
}

/**
 * The cached share above which an item stops fitting max_cost_ratio, for `input` and `output` tokens (null = it fits
 * at every share, or at none). Solves ratio(share) = max for share; used by tests and check.mjs to show the cutoff.
 */
export function cachedShareCutoff(prices, basis, max, { input, output }) {
  // cost(s) - max*basis(s) is linear in s: a + b*s
  const a = input * prices.in + output * prices.out - max * (input * basis.in + output * basis.out);
  const b = input * (prices.cached - prices.in) - max * input * (basis.cached - basis.in);
  if (b === 0) return a <= 0 ? null : 0;
  const s = -a / b;
  return s <= 0 || s >= 1 ? null : s;
}

/** Can this item answer this request? Images need a vision route, tools a tool route, the text must fit, and an item
 * with max_cost_ratio must stay at or under it for this conversation's cached share. */
export function itemEligible(item, { facts, req, body, menu, health = null }) {
  if (item.requires_metering && menu.metering !== true) return { ok: false, reason: "requires_metering" };
  const f = facts?.[item.model];
  const r = eligible(f, req);
  if (!r.ok) return r;
  if (health?.isCooling?.(item.model)) return { ok: false, reason: "cooling" };
  const max = item.eligibility?.max_cost_ratio;
  // until_metering: once each pack is metered per model, the pack's budget carries a costlier turn (addendum item 10).
  const capped = max !== undefined && !(item.eligibility?.until_metering && menu.metering === true);
  if (capped) {
    const share = cachedShare(body);
    const ratio = costRatio(item.prices, menu.cost_basis, { input: req.tokens, share, output: menu.output_tokens ?? DEFAULT_OUTPUT_TOKENS });
    if (ratio > max) return { ok: false, reason: "cost_ratio", ratio: Math.round(ratio * 1000) / 1000, share: Math.round(share * 1000) / 1000 };
  }
  return { ok: true };
}

/** The pool's items that can answer this request, in menu order, plus why the others cannot. */
export function eligibleItems({ menu, pool, facts, req, body, health = null, deny = [] }) {
  const denied = new Set(deny);
  const ok = [], excluded = [];
  for (const it of itemsOf(menu, pool)) {
    if (denied.has(it.model)) { excluded.push({ item: it.id, reason: "denylist" }); continue; }
    const r = itemEligible(it, { facts, req, body, menu, health });
    if (r.ok) ok.push(it); else excluded.push({ item: it.id, reason: r.reason, ...(r.ratio !== undefined ? { ratio: r.ratio, share: r.share } : {}) });
  }
  return { items: ok, excluded };
}

const pair = (model, thinking) => ({ model, thinking: thinking && thinking.control !== "none" ? { control: thinking.control, value: String(thinking.value) } : null });

/**
 * The attempts for one item: the head pair, then its backups in order, each with ITS OWN native thinking, so a backup
 * never changes or drops the head's value. A target appears once (the first pair for it wins: the host keys thinking
 * by target), an ineligible or unlisted target is skipped, and when fewer than min_attempts remain while
 * menu.floor_fill offers more, those pairs top the list up. Cooling targets move to the end (never removed).
 */
export function attemptsFor(item, { menu, facts, req, deny = [], health = null }) {
  const denied = new Set(deny);
  const out = [], skipped = [];
  const add = (model, thinking, from) => {
    if (out.some((a) => a.model === model)) return;
    if (denied.has(model)) { skipped.push({ model, reason: "denylist", from }); return; }
    const r = eligible(facts?.[model], req);
    if (!r.ok) { skipped.push({ model, reason: r.reason, from }); return; }
    out.push({ ...pair(model, thinking), from });
  };
  add(item.model, item.thinking, item.id);
  for (const b of item.backups ?? []) {
    if (b.item !== undefined) { const it = itemById(menu, b.item); if (it) add(it.model, it.thinking, it.id); }
    else add(b.model, b.thinking, "backup");
  }
  const floor = minAttempts(menu);
  for (const id of menu?.floor_fill?.[item.pool] ?? []) {
    if (out.length >= floor) break;
    const it = itemById(menu, id); if (it) add(it.model, it.thinking, it.id);
  }
  if (health?.demote) {
    const order = health.demote(out.map((a) => a.model));
    out.sort((a, b) => order.indexOf(a.model) - order.indexOf(b.model));
  }
  return { attempts: out, skipped, short: out.length < floor };
}

/**
 * Stickiness across the turns of one conversation (UP-10c). `last` is the conversation's previous item (or null),
 * `pick` Jev's item when confident (or null), `ok` the ids eligible now, `fallback` the item to use when nothing else
 * applies (the pool default, or the first eligible item). `streak` counts consecutive turns Jev rated simpler.
 * Returns {item, source, reason, streak}.
 */
export function stickyChoice({ last, pick, ok, fallback, streak = 0, cfg = DEFAULT_STICKY }) {
  const can = (it) => !!it && ok.has(it.id);
  if (!can(last)) {
    if (pick) return { item: pick, source: "jev", reason: last ? "last_ineligible" : "new", streak: 0 };
    return { item: fallback, source: "default", reason: last ? "last_ineligible" : "new", streak: 0 };
  }
  if (!pick) return { item: last, source: "session", reason: "unconfident", streak: 0 };
  if (pick.id === last.id) return { item: last, source: "jev", reason: "same", streak: 0 };
  if (pick.model === last.model && !cfg.effort_change_is_switch) return { item: pick, source: "jev", reason: "effort_change", streak: 0 };
  if (pick.rank >= last.rank) return { item: pick, source: "jev", reason: "task_changed", streak: 0 };
  const n = streak + 1;
  if (n >= cfg.downgrade_after) return { item: pick, source: "jev", reason: "simpler_confirmed", streak: 0 };
  return { item: last, source: "session", reason: "simpler_wait", streak: n };
}

/** The cost ratio of one turn on this item (null without prices): logged so the owner can see each pair against 1.00x. */
export function turnCostRatio(item, { menu, req, body }) {
  if (!item.prices || !menu.cost_basis) return null;
  const r = costRatio(item.prices, menu.cost_basis, { input: req.tokens, share: cachedShare(body), output: menu.output_tokens ?? DEFAULT_OUTPUT_TOKENS });
  return Math.round(r * 1000) / 1000;
}

/** Ids of the specialists among `items`, and whether a kind answer lets `pick` stand (addendum item 9). */
export const specialistsIn = (items) => items.filter((i) => i.specialist);
export function kindAllows(pick, kind, kindConfident) {
  if (!pick?.specialist) return true;
  return !!kindConfident && (pick.kinds ?? []).includes(kind);
}

/** OmniRoute's wire shape (patches 0008/0010): {control:"effort"|"toggle", value} or {control:"none"}. */
export const hostThinking = (t) => (t ? { control: t.control, value: String(t.value) } : { control: "none" });
/** The header/log word for a native value: "low", "on", or "default" for the provider default. */
export const thinkingWord = (t) => (t ? String(t.value) : "default");
