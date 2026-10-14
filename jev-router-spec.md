# jev-router — a Jev-driven routing plugin for OmniRoute

**Status: rewrite (v2.0 draft), 2026-10-14. Nothing is built.** Replaces the standalone-gateway spec v1.25 (kept whole at `docs/archive/spec-v1.25.md`; `§N` below with the prefix `A§` points into it). `[owner]` = decision already given. `[confirm]` = overturns an earlier owner decision or needs a new owner call. Verified facts carry their check date (2026-10-14 unless noted). Secrets never enter this repo; variables are referred to by name only (`~/.config/warslop/dev-secrets.env`).

## 1. What this is

Warslop calls **OmniRoute** with model `free` or `paid`. A jev-router **plugin inside OmniRoute** asks **Jev** which specialist fits the turn, and hands OmniRoute an **ordered list of explicit model ids**; OmniRoute executes them as a priority fallback and owns everything else (accounts, cooldowns, breakers, usage). jev-router is *only* the choice: it does not proxy, buffer, rewrite responses, keep billing state, translate reasoning effort or run a harness `[owner, A§1 scope rule]`.

```
warslop ──(model=free|paid)──> OmniRoute ──onRoute hook──> jev-router plugin ──> Jev (ocfree → ocpaid → openrouter)
                                  │  <── ordered ids [paid…, free…] ──────────┘
                                  └──> ephemeral priority combo ──> ocpaid | ocfree | openrouter | mscopilot
```

Shape learned from `thinkany-ai/autojev` (hand-listed candidate routes, Jev decides once per fresh user task on a bounded excerpt, confidence < 0.5 falls back to a fixed order, session stickiness). Not copied: `gargpratyush/jev-router` (a CLI wrapper, no gateway). The v1 score index (AA + OpenRouter benchmarks, SQLite, Pareto fronts, scoring weights, pool-sync daemon, Go quota ledger, admin API, Rust service) is **dropped**: the real pool is ~21 paid and ~12 free ids, hand-listed in §4.

**Fail-open by design.** If the plugin errors, times out or is absent, OmniRoute falls through to the existing `free`/`paid` priority combos (`ocfree/space-bunny-free`, `ocpaid/opencode/deepseek-v4.1-flash`). Those combos stay and are the degraded mode, not an accident.

### Owner decisions this overturns `[confirm]`
- **D8 (Rust/axum/distroless service, A§4)** — superseded: a plugin runs as a Node child process of OmniRoute; the deployable image is **patched OmniRoute**, not a Rust binary.
- **A§6.4 item 3 "combos are not on the request path"** — reversed: the returned list becomes a temporary priority combo (OmniRoute does the hops). Consequence: `comboCooldownWait` (currently `enabled:true`) must be turned off (§5).
- **D1 (paid→free spill) is kept**: the paid list is `[paid candidates…, free candidates…]`.
- Plugin form itself is a proposal: the v1.25 standalone gateway is the documented fallback (§9).

## 2. The patch (the only change to OmniRoute)

OmniRoute v3.8.51 (`c1e30b7`, `src/sse/handlers/chat.ts`) has no hook that can both reach the network and choose the model. T09 pre-request hooks run before resolution but in a no-network vm sandbox; plugin `onRequest` has network but runs inside `handleChatCore` (`chatCore.ts:657`) after the model/provider are resolved. The patch adds **`onRoute`**:

- `src/lib/plugins/hooks.ts`: `"onRoute"` in `BUILTIN_EVENTS` + `runOnRoute(ctx)` (blocking, like `runOnRequest`).
- `manifest.ts` / `sdk.ts`: `onRoute` in `HooksSchema` and types. `loader.ts`: wire like `onRequest`.
- `chat.ts`: one call placed **before** `getComboForModel`/the `auto/` handling (before T05 task routing at the latest), receiving `{requestId, body, model, apiKeyInfo, headers}`. Result `{models: string[]}` (≥1 id) or nothing. One id → set `modelStr`; several → build an in-memory priority combo object for the existing combo path.
- The override **must pass `reconcileGuardrailReroute`** (it takes `isModelAllowedForKey`), **not** `reconcileModelOverride` (T09's, no allowlist re-check — copying it would let Warslop's key reach any model).
- Size estimate (by reading, not built): 70–110 lines, 4 source files + tests. Open an upstream issue/PR in parallel; if merged the patch drops out (§8).

## 3. Routing logic (all of it lives in the plugin)

1. **When it acts.** Only for requested model `free` or `paid`; any other model passes untouched (no latency added). Hook budget: OmniRoute kills a plugin after the 10 s hook timeout (SIGTERM→SIGKILL), so the plugin enforces its **own hard deadline of 3.5 s** (Jev 3 s + overhead) and returns nothing (fail-open) rather than reach the kill path.
2. **Fresh task vs continuation.** If the last message is a user message (not a tool result) it is a fresh task: ask Jev. Otherwise reuse the conversation's previous pick, re-checking eligibility (a grown context may no longer fit). Conversation key = `x-omniroute-session-id` header, else hash(system + first user message); in-memory map, TTL 1 h; lost on plugin restart (accepted).
3. **Eligibility (code, not Jev), applied to the candidate set before Jev sees it:**
   - **Full window:** `estimated_input + reserve ≤ usable_window`, `usable_window = min(context_length − reserve, max_input_tokens)` when `max_input_tokens` exists (it is often smaller: `gpt-5` 400k context / 272k input; `space-bunny-free` 1,048,576 / **524,288**). `reserve` = Warslop's `max_tokens` if sent, else `min(max_completion_tokens, 16k)`. No comfort cut below the window. Unknown window = 32k floor, never assumed large. Estimate = message chars ÷ 4 (÷ 2 for the non-ASCII share), images excluded and charged a fixed allowance.
   - **Tools:** request carries `tools` → candidate `tools` must be `true`. **Vision:** request has an image → `vision` must be `true`. `null` flag = ineligible when needed.
   - **Not checked here:** account health, cooldowns, breakers, quota — OmniRoute's (A§5.4 chat-health bullet). The Go ledger is dropped; the provider's refusal is the truth and OmniRoute's cooldown handles it.
   - **No fit at all:** return the widest-window candidates and let the upstream's own size error be the answer (no synthetic `context_too_long` in v1).
4. **Jev call** (one batched call, English): `state = {ask (last user message, first 2000 chars), pool, context:{chars, has_image, uses_tools}, candidates:[{id:"c1", description}]}`, one question `model` of type `choice` (criteria = a **map** `{c1: description}`; arrays fail validation). Instruction: "Pick the specialist that can fully complete this request in one pass. Judge required reasoning, scope, ambiguity, tool use and blast radius, not requested answer length. If two fit, pick the cheaper one." Descriptions are fixed phrases with **no numbers** (price class, strengths, speed, window class `standard|large|huge context window`); one canonical option order per pool version; ≤ 12 candidates shown for paid, ≤ 8 for free (option-order bias). The effort / task / stakes questions of v1 are dropped (effort was recorded but never applied; stakes handling parked, §9).
5. **Sources** (all verified live; same `answers` shape): `ocfree` `POST {OCFREE_BASE_URL}/v1/systemone` model `jev-1.13-free` (free); `ocpaid` `POST {OCPAID_BASE_URL}/v1/systemone` Bearer `OCPAID_API_KEY` (`jev-1.13-free`); OpenRouter `POST https://openrouter.ai/api/v1/systemone` (or `/api/alpha/decisions`) Bearer `OPENROUTER_API_KEY`, `~typesafe/jev-latest` or pinned `typesafe/jev-1.13` (~15 µUSD per judgment; the tilde alias must be re-verified live in P2). Priority failover per source timeout 1.2 s; a source with 3 consecutive failures cools 10 min × 2^(n−3), cap 6 h (in-memory). Jev input limit 64k total / 32k state + longest question (docs.typesafe.ai/models) — the 2000-char excerpt stays far below; trim client-side.
6. **Confidence** from the answer's own probabilities: `(pmax − 1/n) / (1 − 1/n)` (published exact, docs.typesafe.ai/confidence). ≥ 0.5 → use Jev's pick first; < 0.5, timeout, error or malformed → configured order (§4). 0.5 is ours, uncalibrated; tune on the decision log, not vendor example numbers. Pin the Jev version once tuned (the `latest` alias shifts distributions).
7. **Output list.** `paid`: `[Jev pick, then eligible paid candidates in configured order]` capped at 3 paid, then up to 2 eligible free candidates (D1 spill). `free`: pick + up to 2 more free. Jev picks only inside the pool; free turns never cross into paid. mscopilot is always last in the free order (§4).
8. **Decision log** (JSONL via `file-write`, no prompt text, hashes only): time, request id, pool, ask hash, fresh/continuation, shown candidates, Jev source + latency + probabilities + confidence, guard action, returned list. Served model/provider/cost come from OmniRoute's own response headers (`x-omniroute-model`, `-provider`, `-selected-connection-id`, `-decision`, `-cost`). `x-jev-*` response headers only if `onResponse` can add them (P0 check 6).

## 4. Candidate pools (hand-listed `pools.json`, owner-editable)

Config shape: `configSchema` allows only string/number/boolean/select, so the tables are a **JSON file read with `file-read`** (path in a string config field; P0 check 5 confirms). Each entry: `id` (dispatch id), `pool`, `order`, `description`, `context_length`, `max_input_tokens`, `max_output_tokens`, `tools`, `vision`, `caps_source`, `price` (in/out/cached, tiers by size), `notes`. Seed values below; the plugin never auto-discovers.

**Dispatch id shapes (verified):** `<prefix>/<upstream id>`; the sidecars' ids already start with `opencode/`, so `ocpaid/opencode/deepseek-v4.1-flash`, `ocfree/opencode/space-bunny-free`, `openrouter/<author>/<slug>[:free]` (built-in provider; `openrouter` is a reserved custom-node prefix → 400), `mscopilot/default`. A bare `opencode/<id>` resolves to the built-in `opencode-zen`, never `ocpaid`. For custom nodes `x-omniroute-provider` is the **node id** (`openai-compatible-chat-<uuid>`), not the prefix — keep a node-id→prefix map. Custom nodes expose no models in OmniRoute's `/v1/models`; ids come from the sidecars' own `GET /v1/models` (`ocpaid` needs Bearer).

**Hard rule `[owner]`: the OpenCode Zen credit balance is empty.** Route only to ids that are covered by the Go subscription or are free: **allowed = sidecar `/v1/models` ∩ (Go page "Endpoints → Model ID" table ∪ ids Zen prices as `Free`)**. No opt-in flag. Go "Use balance" must stay off/zero so a Go-limit hit is a real refusal OmniRoute hops on.

**Paid pool = the 21 Go-catalog ids served by the sidecar (`ocpaid/opencode/…`):** `grok-4.7`, `grok-4.6`, `gpt-6-luna`, `gpt-5.6-luna`, `claude-haiku-5-5`, `glm-5.3-flash`, `glm-5.3`, `glm-5.2`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, `deepseek-v4.1-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `minimax-m3`, `minimax-m2.7`, `qwen3.8-max`, `qwen3.8-flash`, and the unlimited free previews `longcat-2.5-preview-free`, `step-5-preview-free`, `cat-jam-free`. Everything else the sidecar lists (`gpt-5*`, `gpt-6-sol/-astra`, other `claude-*`, `gemini-*`, `glm-5/5.1`, `kimi-k2.5`, `minimax-m2.5`, `qwen3.5/3.6-plus`, `mistral-large-4`, `muse-spark-1.2/1.3`, `grok-4.5`, `big-pickle` as paid, …) is out of the paid pool. Go-catalog rows the sidecar does not list (`mimo-*`, `qwen3.7-plus`, `hy3/hy4`, `longcat-2.0`, `deepseek-v4-flash-vision-exp`, `space-bunny`, `muse-spark-*-contributor`) are not routable. **Expected to fail on the chat route** (wrong wire: Go routes them via `/v1/responses` or `/v1/messages`; error text `ModelProtocolUnsupported`): `claude-haiku-5-5`, `gpt-6-luna`, `gpt-5.6-luna`, `grok-*`; the Go page also lists MiniMax and Qwen under `/v1/messages` — **unprobed, confirm in P0**. Membership by Go catalog is necessary, not sufficient: probe each once (§6 rule) and drop what fails.

**Free pool (zero credit):** `ocfree/opencode/…-free`: `cat-jam`, `ling-3.1-flash`, `longcat-2.5-preview`, `mimo-v2.6-flash`, `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor`, `nemotron-3.5-lightning`, `space-bunny`, `step-5-preview`; `ocpaid/opencode/big-pickle` (free for a limited time, answered `pong`); `openrouter/…:free` ids (20 req/min; 50/day under 10 credits, 1000/day from 10; 402 if balance negative); `mscopilot/default` (+`reasoning`), **last**. `jev-1.13[-free]` is judgment-only, never a chat candidate. **Not served — never probe:** `mimo-v2.5-free` (410 deprecated → use `mimo-v2.6-flash-free`), `exo-free`, `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`. OpenRouter `:free` variants get retired (`404 "This model is unavailable for free…"` seen on `nvidia/nemotron-3.5-lightning:free`, `google/gemma-4-26b-a4b-it:free`): never auto-swap to the paid slug (that would bill).

**mscopilot (BizChat) caveats:** dead refresh token earlier; revived 2026-10-14 from a HAR (new token in the bridge's `refresh.state`, which wins over `.env`; `/health` `tokenFresh`), `200` in 8.7 s, ~30 s per attempt while dead; one shared server-side conversation for all callers (answers can be contaminated, probes pollute it, thread reset via `MS_Q_ConversationId`); no usage block, no window info (32k floor); `valid:true` on the connection is not a health signal — only a real tiny completion is.

**Prices — authority is the Go page only** (`https://opencode.ai/v2/docs/console/go/`): the **first** table (Go $10/month); the second block is Go Plus and is never used. Each model's monthly limit is also its 5 h (20 %) / weekly (50 %) / monthly (100 %) allowance; DeepSeek rows are peak/off-peak (peak Mon–Fri 01:00–04:00 and 06:00–10:00 UTC). The per-model price/limit table and tier splits are in `A§6.3` and seed `pools.json`; Zen-table and OpenRouter prices are never used for a pool member (an agent-built OpenRouter price table was wrong on 12 of 53 ids, A§6.1 audit). Price is only a tie-break/description input now; there is no quota ledger.

**Windows (seed; sidecar listing beats OpenRouter, `max_input_tokens` caps both):** `deepseek-v4.1-flash` 1,048,576; `qwen3.8-flash` 1,000,000; `qwen3.8-max` 1,000,000 (vendor-confirmed, **not** confirmed as the Go-served window); `grok-4.7` 500,000; `gpt-6-luna` 1,050,000; `claude-haiku-5-5` 1,000,000; free side from the `ocfree` listing: `ling-3.1-flash-free` 262,144, `cat-jam-free` 262,144, `mimo-v2.6-flash-free` **200,000** (the paid namesake is 1.05M), `step-5-preview-free` 1,000,000, `longcat-2.5-preview-free` 1,000,000, `space-bunny-free` 1,048,576 (input 524,288). The other paid ids come from the `ocpaid` listing (64 of 86 report `context_length`/`max_input_tokens`/`max_output_tokens`). Unknown (32k floor): `mscopilot`, `big-pickle`, `jev-*`. OpenRouter windows are upper bounds for Go-served models (tiered prices, serving limits below vendor windows): one billed over-length probe per model confirms (P2 spend, e.g. ~$2 visible / ~$8 quota for 1M on Qwen3.8 Max).

**Tool/vision flags (84 sidecar chat ids researched):** sources `or_exact` (exact normalised OpenRouter match → trusted), `vendor` (doc URL → trusted), `or_family` (loose match, e.g. a `-free` suffix or dated snapshot → used but flagged, confirm with one tiny tool-call and one tiny image request), `aggregator` (untrusted → `null`), `unknown` (`null`). 65 of 84 `or_exact`; tools true for 82 of 84 (so the tools rule costs almost nothing); **vision is the discriminator** — false for `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.2`, `glm-5.3`, `minimax-m2.7` among the paid ids. Stored `null`: `cat-jam-free`, `big-pickle`, `space-bunny-free` vision, `gpt-5.3-codex-spark`, `claude-opus-5-5-backup` (identity unproven), `test`.

**Configured order (the deterministic default and the fallback list):** hand-ranked strongest-first per pool by the owner; P1 seeds it from the cheapest-capable heuristic (`deepseek-v4.1-flash`, `glm-5.3`, `kimi-k3`, `deepseek-v4-pro`, … ) and the owner edits it. Order is data, not code.

## 5. OmniRoute facts and settings (3.8.51, verified live)

- **Registered upstreams (done 2026-10-14, divert retired):** custom nodes + connections `ocpaid` (`http://127.0.0.1:4097/v1`, `OCPAID_API_KEY`), `ocfree` (`http://OCFREE_HOST:4097/v1`, dummy key `none`), `mscopilot` (`http://127.0.0.1:8780/v1`), plus built-in `openrouter`. Create: `POST /api/provider-nodes {"type":"openai-compatible","name":N,"prefix":N,"baseUrl":U,"apiType":"chat"}`; connection `POST /api/providers {"provider":<node id|built-in id>,"name":N,"apiKey":K}` (created inactive until `POST /api/providers/<id>/test`). Private/LAN base URLs are allowed by default (`OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS`). Compose edits: divert env var and `providers.yaml` mount removed, `OMNIROUTE_EMERGENCY_FALLBACK=false` added (backups `docker-compose.yml.bak-before-b5`, `config/providers.yaml.bak-before-b5`).
- **Connections are the unit of account rotation**; one per node today — adding the owner's further accounts per provider gives rotation before jev-router ever matters (open).
- **Settings (live):** `waitForCooldown` **disabled** (applied 2026-10-14; was a 90 s stall; previous values in the session scratchpad); **`comboCooldownWait {enabled:true}` must be switched off before combos carry traffic** `[confirm]`; `requestQueue {requestsPerMinute:60, minTimeBetweenRequestsMs:350, concurrentRequests:6, maxWaitMs:30000}` is a global throttle — measure under Warslop load, raise if it queues; fine: `providerBreaker.apikey {failureThreshold:12, resetTimeoutMs:30000}`, `connectionCooldown.apikey {baseCooldownMs:3000, useUpstreamRetryHints:true, maxBackoffSteps:5}`, `quotaPreflight.enabled:false`, `sessionAffinityTtlMs:0`, no `globalFallbackModel`/task-aware routing. Endpoints: `/api/provider-metrics`, `/api/providers/quota-windows` exist; `/api/quota`, `/api/providers/metrics` are 404. `X-OmniRoute-Fallback-Attempts` is optional.
- **Passthrough:** `reasoning: {effort}` and `reasoning_effort` are forwarded (verified by token counts and an upstream validation error); `provider` prefs appear forwarded (inconclusive); **untested:** `data_collection`/`require_parameters`, `session_id`, `prompt_cache_key`, Go's `x-opencode-session` (the Go page wants a stable one per conversation). The plugin never injects fields; Warslop's pass through unchanged.
- **Go plan accounting:** per-model dollar limits; OmniRoute's quota fetcher exists only for built-in `opencode-go`, so custom `ocpaid` has no quota source. Acceptable: no ledger; Go refusals are the signal.

## 6. Errors and the connection-wide cooldown hazard

**Never probe or dispatch an id that is not in the sidecar's current listing.** One `410 "Model mimo-v2.5-free has been deprecated"` made OmniRoute set `rateLimitedUntil=+24 h` on the **entire connection**; every model of `ocfree` and `ocpaid` then failed in ~13 ms with the deprecated model's message. Repair: `PUT /api/providers/<connection id> {"rateLimitedUntil":null,"testStatus":"active","errorCode":null,"lastError":null}` (done, chat resumed). A `410` naming a *different* model than requested, or an instant failure with a `reset after …h` suffix, means a connection-wide cooldown — alert, do not denylist the requested id. Probes use 8192 `max_tokens` ("Reply with exactly: pong"; a 16-token budget produced a false 502 "empty response" on reasoning models).

With combos doing the hops, the plugin does not classify errors; OmniRoute's combo fallback does. The shapes still matter for P0/P1 tests and for the hand `denylist` in `pools.json`:

| Shape | Meaning / handling |
|---|---|
| `402`, `billing_error`, `payment_required`, `account_required`, `quota_exhausted`, `openrouter_credits`, budget `403` (`openrouter_*_budget`/`key_limit`) | quota/billing → next member |
| `429`, `rate_limited`, `429 model_cooldown` (`reset_seconds`, `retry_after`) | hop at once; OmniRoute skips that model until its `Retry-After`; never wait |
| `404 "unavailable for free…"` (OpenRouter) | retired `:free` variant → remove from `pools.json`; OmniRoute adds a 2 min `model_cooldown` |
| `5xx`, `503 provider_circuit_open`, `503 no_eligible_providers`, upstream `api_error`, `502 empty response` | provider/server fault → next member; `provider_circuit_open` skips every model of that provider |
| `ModelProtocolUnsupported` / `does not support this protocol` / `not supported for format` (400 today, 401 on older paths — match the string, not the status) | model cannot serve the chat wire → drop from `pools.json` until re-probed; not a timed cooldown |
| `401 auth_error` | OmniRoute key suspect (first hop) or a provider's accounts all dead → skip provider |
| `mscopilot` `503 refresh token rejected` (~30 s) | dead token → exclude `mscopilot/*` (HAR re-export, A§6.4) |

Not failures: content refusals; a `ocpaid/does-not-exist` returns `400 "Model is unavailable."` with **no** fall-through to another provider.

## 7. Warslop contract

- Base URL and key become **OmniRoute's** (`http://127.0.0.1:20128`, an OmniRoute API key), models `free` / `paid`; Warslop's F100 repoint is Warslop's work. `x-jev-conversation` is gone: send `x-omniroute-session-id` (stable per conversation) for stickiness and, once probed, `x-opencode-session` for Go.
- **B1 timeouts still apply** (Jev + OmniRoute hops now precede the first byte): Warslop's `PAID_TIMEOUT_SECS` (default 8, `crates/gateway/src/config.rs`) → **160** and `UPSTREAM_READ_TIMEOUT_MS` (default 120000) → **170000**, so Warslop's own paid→free fallback is a last-resort backstop behind the combo spill. Re-derive after P0 measures OmniRoute's per-hop first-byte limits.
- Warslop's provider limit remains the only spend cap (D55); the plugin charges nothing and keeps no balances.

## 8. Patch repo and image (GHCR)

Repo layout: `patches/*.patch` (from a fork branch via `git format-patch`), `plugin/` (TypeScript, tests with the OmniRoute plugin test runner or `node:test`), `pools.json`, `scripts/`, `.github/workflows/`. Daily + manual workflow:
1. Resolve the latest upstream release tag (releases are ~monthly: 3.8.50 Aug 26, 3.8.51 Sep 30); skip if `ghcr.io/bedasrv/omniroute:<ver>-jev<N>` already exists.
2. Check out upstream at the tag, `git am --3way patches/*`. On failure: open an issue, stop; the previous image stays live.
3. If `git apply --reverse --check` succeeds, upstream merged it — drop the patch.
4. Run `tests/unit/plugins-*` plus our hook test; build upstream's `Dockerfile` target `runner-web`, **amd64 only** (build needs ~6 GB: fine on public-repo runners, tight on private ones); push `ghcr.io/bedasrv/omniroute:<ver>-jev<N>` with provenance attestation.
5. Deploy pins the **digest** in `~/Containers/omniroute/docker-compose.yml`; upgrades are manual (`docker compose pull && up -d`), rollback = previous digest. No `latest` in prod. Upstream is MIT; keep its LICENSE in the image.

## 9. Gates, phases, evaluation

**P0 — feasibility gate (before any other work). Answer each with a test against v3.8.51:**
1. `onRoute` runs before `getComboForModel` and `auto/` handling; `free`/`paid` are rewritten before resolution, and an unknown requested id does not fail earlier.
2. The override goes through the allowlist re-check (a key restricted to `free`/`paid` cannot be steered to a forbidden model).
3. Timeout kill: blocking hooks get SIGTERM → SIGKILL at 10 s; does the plugin respawn? Either way the 3.5 s self-deadline keeps it out of that path; a dead plugin means silent fail-open to the static combos (alert on it).
4. Fail-open: plugin error / absent / skipped → request lands on the existing combo and answers.
5. Plugin config: `file-read` of `pools.json` works; the plugin child sees the container env (`env` permission) for `OCFREE_BASE_URL`, `OCPAID_*`, `OPENROUTER_API_KEY`, else keys go in `configSchema` strings.
6. Provenance: can `onResponse` add `x-jev-*` headers? If not, Warslop reads `x-omniroute-model` and the log lives in the plugin (`file-write`).
7. An in-memory combo from a returned list runs priority fallback with `comboCooldownWait` off, and a model that errors is skipped to the next member without a wait.
8. MiniMax/Qwen/Grok/Luna/Haiku chat-route behaviour (§4) and the `requestQueue` ceiling.
If 1, 2 or 7 fails and the patch is not small, fall back to the **standalone gateway**: the same `route(request, pools, jev) → ordered ids` function (kept pure and dependency-free for this reason) behind a thin proxy that dispatches explicit ids and does the hops itself (A§3, A§8).

**P1 — static plugin** (no Jev): `pools.json`, eligibility, list builder, fresh-task stickiness, decision log, fail-open; apply the §5 settings. **P2 — Jev in shadow mode**: compute Jev's pick and log it but return the static order; then enable. Spend the over-length probes here. **P3 — patch repo + CI + GHCR**, upstream issue/PR. **P4 — Warslop cutover** (§7 values, drill: first two paid members forced to hang, answer still arrives without Warslop's fallback firing). **Parked:** effort advice from Jev, stakes question, quota pacing, `x-jev-*` headers, extra OmniRoute accounts.

**Evaluation and kill criterion.** The baseline is the static configured order (which is just an OmniRoute combo — no plugin needed). Jev earns its place only if, after ≥ 200 shadow decisions, (a) it picks something other than the static head on a meaningful share of turns (≥ 15 %), and (b) on a hand-labelled sample of 50 differing turns Jev's pick is preferred or cheaper at equal quality more often than not. Otherwise delete the Jev call and ship the static combos. Thresholds are proposals the owner can change.

## 10. Risks and open items

- Jev routing accuracy is unproven (the vendor says so); confidence is a peak-probability summary, not calibrated correctness.
- Patch drift: the `chat.ts` hunk sits in a 2,585-line file; CI fails loudly, never auto-merges; the image is only as fresh as the last green build.
- Plugin memory (stickiness, source cooldowns) is lost on restart; acceptable.
- Free capacity is never guaranteed (`:free` retirements, OpenRouter daily caps, WARP-pooled `ocfree` throttling at peak); mscopilot is slow (~9 s) and shared.
- Go limits are per-model monthly dollars; the first table only; a Go-limit hit is a refusal that OmniRoute hops on; watch for community-derived normalisation claims (`anomalyco/opencode` #41391) if pacing is ever revived (A§5.4 headroom).
- Open: `~/.config/warslop/dev-secrets.env` line 75 unquoted value (parse error when sourced); one connection per node (no account rotation yet); passthrough fields in §5; the owner's ranked order (§4); ephemeral combo needs P0 check 7 to pass; AA/OpenRouter-benchmark scoring (A§5) is parked, revive only if the static order stops being good enough.
- Archive: price table A§6.3; Go endpoint-protocol table A§6.3; AA free-API live capture A§12 (B3); error-shape provenance A§8.2; OmniRoute source-read notes A§6.4/A§12; CI/GHCR/Rust details A§11/A§14 (only the image/CI pattern is reused, §8).
