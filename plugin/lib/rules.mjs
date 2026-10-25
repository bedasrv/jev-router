// Routing rules: a request that matches a rule goes to that rule's models first, and Jev is not asked.
// Rules are data in policy.json:
//   "rules": [{ "name": "law-medicine-finance", "pools": ["paid"], "match": ["\\b(hukum|pasal)\\b"], "prefer": ["ocgoa/opencode-go/deepseek-v4.1-flash", "openrouter/deepseek/deepseek-v4.1-flash-1017"] }]
// `match` entries are regular expressions tried case-insensitively on the guest's request (the text after the last assistant
// message, the same text Jev reads). `prefer` is an ordered list of pool ids; those that are eligible for this request (window,
// tools, images, not denylisted, not cooling) lead the list in that order, the rest of the pool follows as usual. If none of them
// is eligible the rule does nothing and the normal choice (Jev, then the static order) applies. A rule can only reorder the models
// the pool already holds; it never adds one.
const MAX_TEXT = 4000;

export function compileRules(policy, log = () => {}) {
  const out = [];
  for (const [n, r] of (Array.isArray(policy?.rules) ? policy.rules : []).entries()) {
    try {
      if (!r || typeof r !== "object") throw new Error("rule must be an object");
      if (typeof r.name !== "string" || !r.name) throw new Error("rule needs a name");
      const pools = r.pools ?? ["paid"];
      if (!Array.isArray(pools) || !pools.every((p) => p === "paid" || p === "free")) throw new Error("pools must be paid and/or free");
      if (!Array.isArray(r.match) || !r.match.length || !r.match.every((m) => typeof m === "string" && m)) throw new Error("match must be a non-empty list of strings");
      if (!Array.isArray(r.prefer) || !r.prefer.length || !r.prefer.every((m) => typeof m === "string")) throw new Error("prefer must be a non-empty list of ids");
      out.push({ name: r.name, pools, prefer: r.prefer, res: r.match.map((m) => new RegExp(m, "i")) });
    } catch (e) {
      log({ event: "rule_error", rule: r?.name ?? n, error: String(e?.message ?? e) }); // a bad rule is skipped; the others and the rest of the policy still work
    }
  }
  return out;
}

/** The first rule that applies to this pool and text, or null. */
export function matchRule(rules, pool, text) {
  const t = String(text ?? "").slice(0, MAX_TEXT);
  if (!t) return null;
  for (const r of rules) if (r.pools.includes(pool) && r.res.some((re) => re.test(t))) return r;
  return null;
}
