// Abstract thinking need and the per-model native capability that implements it.
// Jev chooses trivial|normal|hard|frontier; policy.models[id].thinking is generated from
// infra/omniroute/effort/effort-table.json + effort-policy-draft.json:
//   { control: "none"|"effort"|"toggle", values, default, budget, map }
// A missing entry is an unknown model: control "none", so OmniRoute omits the field (the
// model's own default) until someone probes it. check.mjs reports missing entries.

export const ABSTRACT_LEVELS = ["trivial", "normal", "hard", "frontier"];
export const THINKING_CONTROLS = ["none", "effort", "budget", "toggle"];

const EFFORT_RANK = { none: 0, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
const EMPTY = Object.freeze({ control: "none", values: [], default: null, budget: null, map: {} });

export function normalizeThinking(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return { ...EMPTY };
  const control = THINKING_CONTROLS.includes(t.control) ? t.control : "none";
  return {
    control,
    values: Array.isArray(t.values) ? t.values.filter((v) => typeof v === "string" || typeof v === "number") : [],
    default: typeof t.default === "string" || typeof t.default === "number" ? t.default : null,
    budget: t.budget && typeof t.budget === "object" ? t.budget : typeof t.budget === "number" ? t.budget : null,
    map: t.map && typeof t.map === "object" && !Array.isArray(t.map) ? t.map : {},
  };
}

export function thinkingFor(id, policy) {
  return normalizeThinking(policy?.models?.[id]?.thinking);
}

export function validateThinking(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return "thinking must be an object";
  if (!THINKING_CONTROLS.includes(t.control)) return `thinking.control must be one of ${THINKING_CONTROLS.join("|")}`;
  if (t.values !== undefined) {
    if (!Array.isArray(t.values) || !t.values.every((v) => typeof v === "string" || typeof v === "number")) return "thinking.values must be an array of strings or numbers";
  }
  if (t.default !== undefined && t.default !== null && typeof t.default !== "string" && typeof t.default !== "number") return "thinking.default must be a string, number or null";
  if (t.budget !== undefined && t.budget !== null) {
    const b = t.budget;
    const ok = typeof b === "number" || (b && typeof b === "object" && !Array.isArray(b) && Number.isFinite(Number(b.min)) && Number.isFinite(Number(b.max)));
    if (!ok) return "thinking.budget must be a number or {min,max}";
  }
  if (t.map !== undefined) {
    if (!t.map || typeof t.map !== "object" || Array.isArray(t.map)) return "thinking.map must be an object";
    for (const [k, v] of Object.entries(t.map)) {
      if (!ABSTRACT_LEVELS.includes(k)) return `thinking.map has unknown level ${k}`;
      if (v !== null && typeof v !== "string" && typeof v !== "number") return `thinking.map.${k} must be a string, number or null`;
    }
  }
  return null;
}

function effortLevels(values) {
  return values
    .filter((v) => typeof v === "string" && Object.hasOwn(EFFORT_RANK, v))
    .sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
}

function genericEffort(abstract, values) {
  const levels = effortLevels(values);
  if (!levels.length) return null;
  if (abstract === "trivial") return levels[0];
  if (abstract === "normal") return null; // provider default, never the lowest tier
  const target = abstract === "hard" ? EFFORT_RANK.high : EFFORT_RANK.max;
  return levels.find((v) => EFFORT_RANK[v] >= target) ?? levels.at(-1);
}

function toggleValue(abstract, values) {
  const vals = values.length ? values.map(String) : ["off", "on"];
  if (abstract === "trivial") return vals.find((v) => v === "off" || v === "disabled" || v === "none") ?? null;
  if (abstract === "normal") return null; // provider default
  return vals.find((v) => v === "on" || v === "enabled") ?? null;
}

function nativeValue(t, abstract) {
  if (Object.hasOwn(t.map, abstract)) return { explicit: true, value: t.map[abstract] };
  if (t.control === "effort") return { explicit: false, value: genericEffort(abstract, t.values) };
  if (t.control === "toggle") return { explicit: false, value: toggleValue(abstract, t.values) };
  return { explicit: false, value: null };
}

function exactNative(control, abstract, native) {
  if (control === "toggle") return abstract === "trivial" ? native === "off" : abstract !== "normal" && native === "on";
  if (abstract === "trivial") return true; // lowest measured level is the intended trivial mapping
  if (abstract === "normal") return true; // null is the intended default path
  if (abstract === "hard") return native === "high";
  return native === "max";
}

/**
 * Plan one model. `native` is the value OmniRoute must put on the wire, or null to omit the
 * field (the normal/default path included). `omitted` is true for control:none, an unknown
 * model, a budget-only model (no verified v1 contract), or a need the route cannot express.
 */
export function planThinking(id, abstract, policy) {
  const t = thinkingFor(id, policy);
  if (!ABSTRACT_LEVELS.includes(abstract)) return { id, control: t.control, abstract, native: null, omitted: true, reason: "invalid", clamped: false };
  if (t.control === "none") return { id, control: t.control, abstract, native: null, omitted: true, reason: "no_control", clamped: false };
  // v1 only writes discrete reasoning_effort / toggle fields. A token-budget-only route stays
  // omitted until a verified contract exists; never simulate it by capping max_tokens/output.
  if (t.control === "budget") return { id, control: t.control, abstract, native: null, omitted: true, reason: "budget_unsupported", clamped: false };

  const picked = nativeValue(t, abstract);
  if (picked.value === null || picked.value === undefined) {
    const reason = picked.explicit ? (abstract === "normal" ? "default" : "unmeasured") : "cannot_map";
    return { id, control: t.control, abstract, native: null, omitted: true, reason, clamped: false };
  }
  const native = String(picked.value);
  return {
    id,
    control: t.control,
    abstract,
    native,
    omitted: false,
    reason: null,
    // An explicit draft/table mapping is the measured answer. A generic clamp is logged as clamped.
    clamped: picked.explicit ? false : !exactNative(t.control, abstract, native),
    default: t.default,
  };
}

/**
 * Apply one abstract need to an ordered model list. The head model decides the native value;
 * fallbacks are kept only when the exact same control+value works for them, because the request
 * body carries one thinking shape for every attempt. Normal (and any unmapped need) omits the
 * field and keeps the full list; never fail the turn.
 */
export function applyThinkingToList({ models, abstract, policy }) {
  if (!models?.length) return { models: models ?? [], applied: null, omitted: true, reason: "empty", dropped: [] };
  const head = models[0];
  const headPlan = planThinking(head, abstract, policy);
  if (headPlan.omitted) {
    return { models, applied: null, omitted: true, reason: headPlan.reason, head, headPlan, dropped: [] };
  }
  const kept = models.filter((id, i) => {
    if (i === 0) return true;
    const p = planThinking(id, abstract, policy);
    return !p.omitted && p.control === headPlan.control && p.native === headPlan.native;
  });
  const dropped = models.filter((id) => !kept.includes(id));
  return {
    models: kept,
    applied: { control: headPlan.control, native: headPlan.native },
    omitted: false,
    abstract,
    head,
    headPlan,
    clamped: headPlan.clamped,
    dropped,
  };
}

/**
 * The onRoute `thinking` field in OmniRoute's shape (patch 0008 normalizePluginThinking):
 * {control:"effort"|"toggle", value} or {control:"none"}. The host drops any other shape
 * silently, so the plan's `native` must travel as `value`. No plan = clear the client's effort.
 */
export function toHostThinking(applied) {
  return applied ? { control: applied.control, value: String(applied.native) } : { control: "none" };
}

/** A no-number phrase for Jev's candidate descriptions, so hard turns can prefer a model that can think more. */
export function thinkingPhrase(t) {
  const n = normalizeThinking(t);
  if (n.control === "none") return "thinking level cannot be adjusted";
  if (n.control === "budget") return "thinking budget control is unverified";
  if (n.control === "toggle") return "thinking can be turned off or on, not graded";
  const values = n.values.map(String);
  if (values.some((v) => v === "high" || v === "xhigh" || v === "max")) return "can think harder for difficult tasks";
  if (values.includes("medium")) return "can think a little harder for difficult tasks";
  return "thinking level is limited";
}

/** Ids that are dispatched but have no per-model thinking entry (check/test only; runtime omits). */
export function missingThinking(policy) {
  const ids = new Set([
    ...(policy?.order?.paid ?? []),
    ...(policy?.order?.free ?? []),
    ...Object.values(policy?.last_resort ?? {}),
    ...Object.keys(policy?.models ?? {}),
  ]);
  return [...ids].filter((id) => !policy?.models?.[id]?.thinking);
}
