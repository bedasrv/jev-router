import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPolicyLoader } from "./lib/policy.mjs";
import { createFacts } from "./lib/facts.mjs";
import { inspectRequest } from "./lib/eligibility.mjs";
import { buildList } from "./lib/builder.mjs";
import { conversationKey, isFresh, createSessions, hash } from "./lib/sessions.mjs";
import { createLog } from "./lib/decision-log.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DEADLINE_MS = 3500; // OmniRoute kills the child at 5 s and never respawns it
const POOLS = new Set(["free", "paid"]);

export function createRouter({ policyFile = process.env.JEV_POLICY_FILE ?? path.join(DIR, "policy.json"), facts, now = Date.now } = {}) {
  let log = () => {};
  const loadPolicy = createPolicyLoader(policyFile, (r) => log(r));
  const f = facts ?? createFacts({ log: (r) => log(r) });
  const sessions = createSessions();

  function decide(ctx) {
    const pool = ctx.model;
    if (!POOLS.has(pool)) return undefined;
    const policy = loadPolicy();
    if (!policy) return undefined;
    log = createLog(policy.log_file ? path.resolve(path.dirname(policyFile), policy.log_file) : null);
    const body = ctx.body ?? {};
    const req = inspectRequest(body);
    const key = conversationKey(ctx.headers, body);
    const fresh = isFresh(body);
    const prev = fresh ? null : sessions.get(key, now());
    const { models, excluded, nofit } = buildList({ pool, policy, facts: f.get(policy), req, preferred: prev?.head ?? null });
    if (!models.length) return undefined;
    sessions.set(key, { head: models[0] }, now());
    log({
      event: "decision", id: ctx.requestId ?? null, pool, conv: hash(key), fresh, est_tokens: req.tokens, reserve: req.reserve,
      tools: req.usesTools, images: req.images, nofit, excluded: excluded.length ? excluded : undefined, models,
    });
    return { models, reason: `static:${pool}${fresh ? "" : ":cont"}` };
  }

  // Fail-open with a hard deadline: return nothing rather than reach OmniRoute's kill path.
  async function onRoute(ctx) {
    try {
      return await Promise.race([
        Promise.resolve().then(() => decide(ctx)),
        new Promise((res) => setTimeout(() => res(undefined), DEADLINE_MS).unref?.()),
      ]);
    } catch (e) {
      log({ event: "error", error: String(e?.message ?? e) });
      return undefined;
    }
  }
  return { onRoute, decide };
}

const router = createRouter();
export const onRoute = router.onRoute;
