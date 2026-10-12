# jev-router — a Jev-routed model gateway for Warslop (free + paid pools)

**Status: proposal v1, 2026-10-12. Nothing here is built yet.** This is the project spec and build plan
for `~/src/jev-router` (GitHub `bedasrv/jev-router`). `[owner]` marks a decision the owner already gave;
everything else is a coordinator proposal the owner can veto. Verified facts carry the date they were
checked (all `2026-10-12` unless noted).

Companion material outside this repo (read before implementing):

| Where | What it holds |
|---|---|
| `~/src/warslop/docs/DECISIONS.md` | D47/D48/D49/D55: warslop now talks to **one external OpenAI-style upstream**; the upstream gives one free and one paid model, free is the fallback; the provider's own limit is the only spend cap |
| `~/src/warslop/orchestrate/tasks/47-jev-router.md` | The original in-warslop Jev-delegation design (questions, guard, evidence from 69 real Jev calls, dynamic-menu loop, rate-limit budget rules) — superseded for warslop, adopted here |
| `~/src/warslop/docs/NOTES-61-menu-snapshots.md` | The snapshot + fetch-budget design (windows, reserve, single-flight, 429 pause, staleness alerts) |
| `~/src/warslop/docs/NOTES-62-menu-builder.md` | The matching, filtering, scoring and description rules, with their known gaps |
| `~/src/oc-free-docs/opencode-openai-proxy-findings.md` | oc-free/oc-paid topology, `/v1/systemone` contract, Jev primitives, the OmniRoute build, the mscopilot bridge |
| `~/.config/warslop/dev-secrets.env` | Every credential by name; `~/.Containers/omniroute/config/providers.yaml` holds the OmniRoute upstream entries |

Secrets never enter this repo. Keys stay in `~/.config/warslop/dev-secrets.env` (0600) and
`~/.config/jev-router/env` (0600); the spec refers to variables by name only.

---

## 1. What this is

A small OpenAI-compatible HTTP service that sits between Warslop and OmniRoute. Warslop calls it with
model id `free` or `paid`; inside, it asks **Jev** to classify the turn, consults a **local benchmark
score index** (built from the OpenRouter benchmarks API and the Artificial Analysis API, cached so a new
model never forces a refetch), and dispatches the turn through **OmniRoute** to the specific specialist
model that fits. If the paid side runs out of tokens or is rate-limited, the same turn retries in the
free pool before the caller ever sees an error.

```
warslop ──(OpenAI chat/completions, model=free|paid)──> jev-router ──> omniRoute ──> ocpaid   (opencode Go, paid)
                                                          │      │              ├> ocfree   (Zen free models, free)
                                                          │      │              ├> openrouter (paid + :free variants)
                                                          │      │              └> mscopilot (BizChat, free)
                                                          │      └── Jev: oc-free 1st → oc-paid 2nd → openrouter 3rd   [owner]
                                                          └── index jobs ──> openrouter.ai benchmarks + models, artificialanalysis.ai
```

Contract with Warslop `[owner, D47/D48]`: one upstream, one base URL, one key; exactly two model ids
(`free`, `paid`); the free model serves free guests and is the fallback for paid turns when premium
capacity is gone; provider limits are the only spend cap (D55). This project owns everything behind that
line; Warslop's own F100 repointing is Warslop's work, not this project's.

### Non-goals (v1)

- No guest billing, balances, holds or receipts — Warslop keeps all of that; jev-router reports token
  usage and provenance headers and charges nobody.
- No provider credential management — OmniRoute owns the upstreams; jev-router never sees the Zen or
  OpenRouter keys for chat calls (only for index fetches and direct Jev calls).
- No local quality probes or side-by-side evals — quality is benchmark-driven in v1; the probe gates of
  brief 47 §Dynamic menu step 5 are a later, optional phase.
- No cache-aware pinning across Warslop turns in v1 — that phase needs the `x-jev-conversation` header
  and stays parked (§10 phase 6).

---

## 2. Verified environment (checked 2026-10-12)

| Component | Endpoint / location | State |
|---|---|---|
| oc-free proxy (remote, "the oc-free in OmniRoute") | `http://10.10.100.130:4097` — `/v1/models`, `/v1/chat/completions`, `/v1/systemone` | Up. 9 free models incl. `opencode/jev-1.13-free`, `longcat-2.5-preview-free`, `mimo-v2.6-flash-free`, `muse-spark-1.2/1.3-contributor-free`, `nemotron-3.5-lightning-free`, `space-bunny-free`, `step-5-preview-free`, `ling-3.1-flash-free`. No auth (any key accepted/ignored) |
| oc-free Jev | `POST :4097/v1/systemone`, `model: jev-1.13-free` | **Verified live**: noul 0.73, choice `technical` at confidence 1. Free, WARP-pooled egress, rated with more headroom than Zen direct |
| oc-paid proxy (local) | `http://127.0.0.1:4097` + Tailscale — Bearer `OCPAID_API_KEY` | Up, systemd `oc-paid-proxy`. 87 models (`opencode/…`); Jev `jev-1.13` and `jev-1.13-free` both verified live (noul 0.72 / 0.75, choice conf 1) |
| OpenRouter Jev | `POST https://openrouter.ai/api/v1/systemone` — Bearer `OPENROUTER_API_KEY`, `model: typesafe/jev-1.13` | **Verified live**: resolves to `typesafe/jev-1.13-20260917`; noul 0.74, choice conf 1; `usage.cost` 14.8 µUSD for a 353-in/55-out judgment (input-only billing). Not in the `/v1/models` listing (only `typesafe/jev-router` is listed, pricing masked) but routable |
| OmniRoute | `http://127.0.0.1:20128`, Bearer `OMNIR_API_KEY`, docker at `~/Containers/omniroute` | Up (image 3.8.51, host network). Self-hosted providers file holds three entries: `ocpaid`, `mscopilot`, `ocfree` — **no OpenRouter entry yet** (action in §6.4) |
| OmniRoute routing | live probes through `/v1/chat/completions` | `opencode/deepseek-v4.1-flash` → `pong` (383 in / 18 out, 14 reasoning tokens); `ocfree/space-bunny-free` → `pong` (128 cached in). Confirmed working |
| OmniRoute combos | `GET /api/v1/combos` | `free` (priority, one member `ocfree/space-bunny-free`) and `paid` (priority, one member `opencode/deepseek-v4.1-flash`) already exist; this spec adopts them as pool names and expands their member lists |
| mscopilot (BizChat) bridge | `http://127.0.0.1:8780` — `mscopilot/default`, `mscopilot/reasoning` | Service up **but the refresh token is dead**: `/health` → `tokenFresh:false`; direct call → `refresh token rejected … re-export the HAR`. **Currently unusable**; repair path is in the dev-secrets comment block. The free pool must tolerate one dead source |
| OpenRouter benchmarks API | `GET https://openrouter.ai/api/v1/benchmarks` — Bearer `OPENROUTER_API_KEY` | **Verified**: returns AA rows with `intelligence_index`, `coding_index`, `agentic_index`, plus `gpqa_diamond` / `tau_bench_verified_airline` rows. Limit 30/min, 500/day per account |
| Artificial Analysis API | `GET https://artificialanalysis.ai/api/v2/language/models/free` — header `x-api-key: ARTIFICIALANALYSIS_API_KEY` | **Verified**: paged (200/page; 4 pages seen). Free tier works; Pro endpoint `/api/v2/language/models` → 403; legacy `/api/v2/data/llms/models` → 200 but **retires 2026-11-04** — use the new path. Attribution to artificialanalysis.ai is mandatory wherever its data is shown or shared |
| OpenRouter models listing | `GET https://openrouter.ai/api/v1/models` (public) | 458 models, **15 `:free` variants**; carries price, context, `top_provider.max_completion_tokens`, reasoning profile |
| OpenCode Go plan | `https://opencode.ai/v2/docs/console/go/` (page read today) | Per-model monthly dollar limits; each model's windows are 5-hour = 20 %, weekly = 50 %, monthly = 100 % of its monthly limit. Full table in §6.3. DeepSeek models are peak/off-peak priced (peak: Mon–Fri 01:00–04:00 and 06:00–10:00 UTC) |
| Local tooling | bun 1.3.3, node 26.10, sqlite 3.50, docker | present |
| Warslop context | `~/src/warslop/docs/DECISIONS.md` D47/D48/D49/D55; ROADMAP F34/F50/F51/F61 | Warslop's in-app Jev router was removed (D47); its design material is the source for this project; Warslop now expects one external upstream with free+paid models |

---

## 3. Architecture

Components and who owns what:

| Component | Owns | Does not own |
|---|---|---|
| **jev-router** (this project) | Jev classification, benchmark score index + snapshots, pool building, per-request model choice, within-pool and cross-pool fallback, decision log, provenance headers | Upstream credentials, circuit breaking, retries at the provider level, guest billing |
| **OmniRoute** | Upstream provider registry, request forwarding, circuit breakers, rate limiting, combo evaluation, usage visibility | Task classification, model quality knowledge, free/paid policy |
| **oc-free / oc-paid sidecars** | Zen/free and Go/paid model access, `/v1/systemone` (Jev judgments), WARP pooling (free side) | Routing decisions |
| **Warslop** | Guest sessions, vouchers/billing, the "resting message" UX, calling jev-router with `free`/`paid` | Which model answers, pool policy |

### Request path (a `paid` turn)

1. Warslop `POST /v1/chat/completions` with `model: "paid"`, the full message list, Bearer `JEVR_API_KEY`.
2. jev-router extracts the *current ask* (last user message, capped; never the whole history) and looks up
   the decision cache (hash of ask + pool + index version; TTL 5 min). A hit skips step 3.
3. Jev call: the source pool in priority order (§7.1) — oc-free, then oc-paid, then OpenRouter — with one
   batched question set (§7.2). Overall budget 3 s; failure or timeout → the task default from the index,
   never an error.
4. Local guard (§7.3): confidence thresholds, stakes rule, eligibility (context fits, tools/vision,
   headroom, cooldowns). The guard can downgrade to a safer pick; it never invents a model not in the
   shortlist.
5. Dispatch: `POST {OMNIR_BASE_URL}/v1/chat/completions` with the concrete candidate's OmniRoute id
   (e.g. `opencode/deepseek-v4-pro`), streaming passthrough. First-token deadline 15 s.
6. On a fallback-triggering failure (§8.2): next paid candidate, up to 3 hops; then the free pool's best
   candidates for the same task, up to 2 hops; then `502` with a typed error body.
7. Response headers carry provenance (`x-jev-*`, §9.3); the response body/stream is passed through
   untouched (including the `usage` block — Warslop reconciles provider cost from it).

### Request path (a `free` turn)

Same, but the shortlist is the free pool (oc-free → mscopilot → OpenRouter `:free`, ranked by the index);
Jev still classifies (it is free), the guard applies, fallback stays within the free pool, and a full
failure returns the resting error for Warslop to show.

---

## 4. Decision records

| # | Decision | Rationale / source |
|---|---|---|
| D1 `[owner]` | Two pools, `free` and `paid`. Free is the fallback for paid turns when paid capacity is gone (out of tokens/rate-limited). | User brief; warslop D48c, D55 |
| D2 `[owner]` | Jev judgments use a **source pool**, not only oc-free: `ocfree:jev-1.13-free` → `ocpaid:jev-1.13-free` → `openrouter:typesafe/jev-1.13`, priority failover by default, optional load-balance. All three verified live 2026-10-12. | Owner: "local opencode and openrouter also have jev — use as fallback or loadbalance" |
| D3 `[owner]` | Every chat dispatch goes through **OmniRoute**; pools span opencode (Zen free + Go paid), OpenRouter (free + paid) and BizChat (free). | User brief; OmniRoute already carries all four upstreams except OpenRouter |
| D4 | Quality comes from the **OpenRouter benchmarks API + Artificial Analysis free API**, stored as dated snapshots and scored into a versioned local index. No per-request provider calls; adding a model reuses the stored snapshots. | User brief; warslop F50/F51 (briefs 61/62) |
| D5 | A **canonical model × source offer** model: quality scores attach to the canonical model; price, quota and capabilities attach to each source's offer; routing picks a canonical model, dispatch picks the offer. | brief 47 §Dynamic menu, brief 55 |
| D6 | Go-plan **quota-aware routing**: per-model monthly limits and 5h/weekly windows (20/50/100 %) are part of the index; a model without headroom is skipped before it is drained. Peak/off-peak prices are respected for DeepSeek models. | User brief ("without draining the usage limit"); Go docs |
| D7 | The service exposes exactly `free` and `paid` via OpenAI `/v1/models` and `/v1/chat/completions`, plus a loopback-only admin surface. | warslop D48c; D47 "one upstream" |
| D8 | Stack: **TypeScript on Bun** (bun 1.3.3 present), SQLite via `bun:sqlite`, `fetch` + stream passthrough from the runtime, zero runtime dependencies, systemd `--user` unit, loopback bind `127.0.0.1:4098`. | Matches the house's bun tooling (warslop scripts/bun-pin.sh); the oc-free sidecar is also Node/TS |
| D9 | No request handler ever calls a benchmark provider; fetches run only in the ops job/CLI under a persisted budget. | warslop F50 rule, kept verbatim |
| D10 | Privacy: Jev receives only the bounded ask excerpt + shortlist descriptions (no history, no balances). Attribution text for AA is stored with every snapshot and shown in admin views. | brief 47; AA terms |
| D11 | Matching rule: dated listing ids match dated benchmark rows exactly; undated ids match the **newest** dated row for that model. (This reverses the old "lowest intelligence wins" rule that NOTES-62 flagged as a generation collision.) | NOTES-62 Known gaps, recommendation (2) |
| D12 | Outcomes are logged as **decisions without prompt text** (hashes, features, probabilities, guard action, hops, latency, usage counters). | brief 47 phase 4 |
| D13 | Jev source order stays `ocfree → ocpaid → openrouter`: zero-cost paths first, metered OpenRouter last as the Zen-independent escape hatch. A reorder is one config line if the Go ledger ever shows Jev billing; cooldowns make a dead first source a one-time cost, not a per-turn one. | owner delegated 2026-10-12 ("choose whatever you think is best"); closes the ordering question |
| D14 | Quota soft reserves (defaults, to calibrate after P4): skip a Go model below ~10 typical turns of monthly headroom or at ~80 % of its monthly limit; deprioritise below ~3 turns in the 5 h window; treat OpenRouter paid near `OPENROUTER_MONTHLY_CAP_USD` the same way. | owner delegated; conservative until the decision log says otherwise |
| D15 | Privacy: the paid pool excludes sources that train on prompts (Go's Muse Spark Contributor is the example); the free pool may include them (warslop §1.4 already discloses free-tier training). OpenRouter paid requests set `data_collection: deny` once the passthrough check (§6.4 item 2) confirms it. | owner delegated; mirrors warslop §1.4 |

The three questions this section opened on 2026-10-12 — Jev source order, reserve numbers, free-pool
privacy — were delegated to the coordinator ("choose whatever you think is best") and are closed as
D13–D15. The reserve numbers (D14) are the only part expected to move, once P4 produces decision-log
evidence.

---

## 5. The score index (the heart of the project)

### 5.1 Sources and budgets

| Source | Endpoint | Published limit | Budget this project spends |
|---|---|---|---|
| OpenRouter models listing | `GET https://openrouter.ai/api/v1/models` (public) | none | 1 check/hour; store only when the body hash changes |
| OpenRouter benchmarks | `GET https://openrouter.ai/api/v1/benchmarks` (Bearer) | 30/min, 500/day | 2/day (one pass + one retry); refetch when the listing changed or the snapshot is > 24 h old |
| Artificial Analysis free | `GET https://artificialanalysis.ai/api/v2/language/models/free` (x-api-key), paged | free tier (conservative: 100/day) | 1 full pass/day (4 pages; abort the whole pass if the page count grows), hard ceiling 10 requests/day |
| OpenRouter free-model cap | `GET https://openrouter.ai/api/v1/key` (Bearer) | — | at most every 10 min, ops job only; stop free routing at 20 % of `free_model_daily_requests.remaining` |

Rules (ported from NOTES-61, unchanged in spirit):

- Every fetch is **reserved first** against a persisted counter (`fetch_budget(source, window_start, used)`;
  UTC windows; atomic check-and-increment in `BEGIN IMMEDIATE`). A refused reserve means no call.
- After each response, remember `X-RateLimit-Limit/Remaining` (and `Retry-After` / `X-RateLimit-Reset` on
  429). No call while the provider's remaining is below 20 % of its limit for the current window.
- **Single-flight** across processes: a `fetch_lock` row held in a SQLite transaction for the whole run,
  with a 10-minute stale-takeover rule (warslop used flock; SQLite is the equivalent here since the DB is
  the shared state).
- **429**: honour `Retry-After`/`X-RateLimit-Reset` (later instant wins); no retry inside the window; keep
  serving the last good snapshot. A source with no good snapshot for 48 h raises a notification (the
  ops job prints it and writes an alert row; Telegram wiring is a later phase).
- **Jitter** the daily pass by ±30 min so it does not hammer the APIs on a fixed second.
- Snapshots are stored whole: `fetch_snapshots(source, fetched_at, body_hash, body)`; the AA envelope
  stores the attribution string plus all pages (`{"attribution": "Artificial Analysis", "pages": [...]}`).

### 5.2 Matching (canonical model identification)

1. Normalise: take the tail after the last `/`, lowercase, keep `a-z0-9`. Benchmark permaslugs drop a
   trailing `-YYYYMMDD` first.
2. A dated listing id (`opencode/qwen3.8-max-0902`) matches the dated benchmark row first; an undated id
   matches the **newest** dated row for its normalised key (D11). AA free-tier rows have no
   `openrouter_api_id`, so the same rule is applied to AA `slug` first, then display name with
   parenthesised suffixes removed — only when no slug matched.
3. A model with no AA row falls back to OpenRouter's own benchmark rows (`gpqa_diamond`,
   `tau_bench_verified_airline`); its intelligence index stays `unknown` (never substituted with another
   metric).
4. Aliases are explicit data: `model_alias(canonical_id, aliases_json)` maps each provider's spelling
   (`opencode/glm-5.3-flash`, `z-ai/glm-5.3-flash`, `GLM 5.3 Flash`) to one canonical id. The matcher
   proposes; a mismatch is a data row, not code.
5. Go-catalog models that exist nowhere in the benchmark sources (LongCat, Hy3, Space Bunny, …) enter the
   index with `quality: unknown`; they stay out of the Jev shortlist but remain valid free/zero-burn
   members. (Optional later: the probe gates of brief 47 would measure them.)

### 5.3 Scoring per role

Metrics are integers (indices ×10, accuracies ×1000, tokens/s ×10, TTFT ms), as in NOTES-62. Missing
components take the median of the eligible set, labelled `unknown` — never the intelligence index.

| Role | Components |
|---|---|
| `coding` | AA coding_index + tau-bench accuracy |
| `math` | GPQA-Diamond + intelligence_index |
| `analysis` | intelligence_index |
| `agentic_files` | tau-bench accuracy + AA agentic_index |
| `writing` | speed (median output tokens/s) above a quality floor; price as tiebreak |
| `simple_chat` | speed + burn |
| `health` / `legal` / `money` | AA domain indexes: healthcare-and-medical / legal / finance-and-accounting (stakes roles; used by the high-consequence guard) |

Per role, keep the **Pareto front of (quality, burn)** over the pool's eligible members; the shortlist is,
per role, the cheapest and the strongest point, deduplicated, plus one strong pick per stakes domain, all
ranked in one canonical order (by typical-turn burn; Jev's option order never changes between calls),
capped at 12 entries (8 for the free pool).

`burn` = expected cost of a typical turn (2,500 input + 500 output tokens, warslop's figure) in micro-USD:
- OpenRouter offers: live listing prices (per-token, integer maths — decimal strings parsed without
  floats).
- Go offers: the Go token prices (§6.3), with peak/off-peak resolved at build time for DeepSeek models
  (the builder stamps both; the router picks by clock).
- `:free` / Zen-free / BizChat offers: burn 0.

### 5.4 Eligibility rules (code, not Jev)

- text output only; tools supported (for `agentic_files`); context window ≥ 32k floor or the current ask's
  estimated size, whichever is larger; not expiring within 14 days; no `:batch` variants.
- **Headroom** (D6): skip a Go model when estimated remaining monthly headroom < 10 typical turns or
  estimated monthly usage ≥ 80 % of the limit; deprioritise when the current 5h window's remaining
  allowance < 3 typical turns. OpenRouter paid: skip when the month's burn against `OPENROUTER_MONTHLY_CAP_USD`
  is near the cap. Thresholds are config.
- Health: a candidate with 3 consecutive failures from live traffic goes on a **cooldown** (10 min
  doubling, cap 6 h) and is skipped by fallback chains while cooling. (This is how a dead mscopilot token
  or a refused model is tolerated without manual action.)

### 5.5 Storage schema (SQLite, `~/.local/share/jev-router/jev-router.db`)

```sql
CREATE TABLE fetch_snapshots(source TEXT, fetched_at TEXT, body_hash TEXT, body TEXT,
                             PRIMARY KEY (source, fetched_at));
CREATE TABLE fetch_budget(source TEXT, window_start TEXT, used INTEGER,
                          PRIMARY KEY (source, window_start));
CREATE TABLE fetch_lock(id INTEGER PRIMARY KEY CHECK (id = 1), owner_pid INTEGER, started_at TEXT);

CREATE TABLE index_versions(version INTEGER PRIMARY KEY, built_at TEXT, sources_json TEXT,
                            status TEXT NOT NULL DEFAULT 'current');      -- current | superseded
CREATE TABLE model_index(version INTEGER, canonical_id TEXT, omniroute_id TEXT, source TEXT,
                         quality_json TEXT, price_json TEXT, caps_json TEXT, quota_json TEXT,
                         PRIMARY KEY (version, omniroute_id));
CREATE TABLE model_alias(canonical_id TEXT PRIMARY KEY, aliases_json TEXT);

CREATE TABLE routing_decisions(id TEXT PRIMARY KEY, at TEXT, request_hash TEXT, pool TEXT,
                               canonical_id TEXT, omniroute_id TEXT, jev_json TEXT, guard TEXT,
                               hops_json TEXT, latency_ms INTEGER, outcome TEXT, usage_json TEXT);
CREATE TABLE cooldowns(omniroute_id TEXT PRIMARY KEY, fails INTEGER, until TEXT);
CREATE TABLE quota_usage(omniroute_id TEXT, window_kind TEXT, window_start TEXT, spent_micros INTEGER,
                         PRIMARY KEY (omniroute_id, window_kind, window_start));  -- kind: 5h|week|month
CREATE TABLE conversation_pins(conv_key TEXT PRIMARY KEY, omniroute_id TEXT, pool TEXT, at TEXT);
```

### 5.6 Adding a new model without a refetch

The user-facing requirement: adding a model must not force a full provider fetch.

```
jev-router index add <omniroute_id>     # e.g. opencode/deepseek-v4.1-flash
  → reads the stored snapshots (no network)
  → matches + scores against them, stamps the new row into the current version
  → only if the model matches nothing in any snapshot: prints exactly which source is missing and
    exits non-zero; the operator then runs `jev-router fetch --source openrouter_benchmarks` (budgeted)
```

`jev-router index build` (re)builds a full version from the stored snapshots; `index show <model>` prints
the matched rows and roles (a human-readable report in the NOTES-62 style, including why a model is in or
out); `index diff` shows what a rebuild would change. Fetches happen on their own schedule (§5.1); the
request path and `index add` never fetch.

---

## 6. Model pools

### 6.1 Paid pool (`paid` requests)

| Source | Members | Notes |
|---|---|---|
| opencode Go via `ocpaid` (OmniRoute id `opencode/<id>`) | The 35 Go-catalog models that answered the last sweep (2026-10-10) — e.g. `deepseek-v4.1-flash`, `deepseek-v4-pro`, `glm-5.3-flash`, `glm-5.3`, `glm-5.2`, `gpt-6-luna`, `gpt-5.6-luna`, `minimax-m3`, `minimax-m2.7`, `qwen3.8-flash`, `kimi-k2.6`, `mimo-v2.6-flash/pro`, `muse-spark-1.3`, plus the free-preview pair `longcat-2.5-preview-free` / `step-5-preview-free` (unlimited, burn 0) | Claude/Gemini families are blocked on the chat route (`ModelProtocolUnsupported`); the liveness sweep is re-run monthly by `pool sync` |
| OpenRouter paid via a new `openrouter` provider (OmniRoute id `openrouter/<author>/<slug>`) | The engine's whole eligible set, price-guarded ≤ $5 in / $20 out; today's enabled pair (`google/gemma-4-31b-it`, `deepseek/deepseek-v4-pro`) are pool members | Uses `OPENROUTER_MONTHLY_CAP_USD` as the cap; `:free` variants belong to the free pool |

### 6.2 Free pool (`free` requests, and the paid fallback)

| Source | Members | Notes |
|---|---|---|
| Zen free via `ocfree` | 9 models (verified list in §2); `jev-1.13-free` is judgment-only and never a chat candidate | No key, anonymous free tier; WARP-pooled |
| mscopilot (BizChat) | `mscopilot/default`, `mscopilot/reasoning` | Counted free by the owner. **Currently down (dead refresh token)** — the cooldown/health mechanism excludes it automatically; repair path documented in dev-secrets |
| OpenRouter `:free` | the 15 `:free` variants today; indexed ones enter the shortlist | 20 req/min + 1000/day (with ≥ $10 credit); the ops job watches `free_model_daily_requests.remaining` and stops at a 20 % reserve |

### 6.3 Go-plan quota table (source: Go docs page, 2026-10-12)

Each model's monthly limit below is also its 5-hour (20 %) and weekly (50 %) allowance. Token prices are
per 1M tokens; the router's burn estimate uses these prices (input/output/cached-read; cache-write is
absent for most).

| Model (Go) | In $ | Out $ | Cached $ | Monthly $ |
|---|---|---|---|---|
| GLM-5.3-Flash | 0.15 | 0.50 | 0.03 | 60 |
| GLM-5.3 | 1.40 | 4.40 | 0.26 | 15 |
| GLM-5.2 | 1.40 | 4.40 | 0.26 | 60 |
| Kimi K3 | 3.00 | 15.00 | 0.30 | 15 |
| Kimi K2.7 Code | 0.95 | 4.00 | 0.19 | 60 |
| Kimi K2.6 | 0.95 | 4.00 | 0.16 | 60 |
| LongCat-2.0 | 0.30 | 1.20 | 0.006 | 60 |
| LongCat 2.5 Preview Free | 0 | 0 | 0 | unlimited (limited time) |
| Step 5 Preview Free | 0 | 0 | 0 | unlimited (limited time) |
| MiMo-V2.6-Flash | 0.14 | 0.28 | 0.0028 | 60 |
| MiMo-V2.6-Pro | 0.435 | 0.87 | 0.003625 | 15 |
| MiMo-V2.5 / -Pro | 0.14/0.435 | 0.28/0.87 | … | 60 / 15 |
| MiniMax M3 | 0.30 | 1.20 | 0.06 | 60 |
| MiniMax M2.7 | 0.30 | 1.20 | 0.06 | 60 |
| Muse Spark 1.3 / 1.2 Contributor | 0.10 | 0.20 | 0.002 | 60 |
| Qwen3.8 Max | 2.00 | 6.00 | 0.25 | 15 |
| Qwen3.8 Flash | 0.15 | 0.47 | 0.016 | 30 |
| Qwen3.7 Plus | 0.40 | 1.60 | 0.04 | 60 |
| DeepSeek V4.1 Flash — off-peak / peak | 0.15 / 0.30 | 0.60 / 1.20 | 0.003 / 0.006 | 80 |
| DeepSeek V4 Pro — off-peak / peak | 0.66 / 1.32 | 1.98 / 3.96 | 0.022 / 0.044 | 15 |
| DeepSeek V4 Flash — off-peak / peak | 0.15 / 0.30 | 0.60 / 1.20 | 0.003 / 0.006 | 30 |
| Hy4 preview / Hy3 / Space Bunny | 0.834 / 0.14 / 0.15 | 2.501 / 0.58 / 0.60 | … | 30 / 60 / 30 |
| Grok 4.7 / 4.6 (≤200k) | 2.00 | 6.00 | 0.50 | 15 |
| GPT 6 Luna (≤272k) | 0.10 | 0.50 | 0.01 | 15 |
| GPT 5.6 Luna (≤272k) | 0.20 | 1.20 | 0.02 | 15 |
| Claude Haiku 5.5 (≤100k) | 0.10 | 0.50 | 0.01 | 15 |

Peak hours (DeepSeek): Mon–Fri 01:00–04:00 and 06:00–10:00 UTC; all other hours and weekends are
off-peak. The full table must be transcribed from the live page into `config/go_catalog.ts` at
implementation time, with a source-date note; this excerpt fixes the mechanism, not the final numbers.

The quota ledger is our estimate from response `usage` blocks × these prices; the authoritative limit is
the provider's own (D55 logic: on a quota/billing refusal, stop routing there and let the fallback handle
it). The 5h/week/month windows are rolling where the provider's are, and this is the one place where the
provider is the source of truth — the ledger exists only to avoid *obviously* draining a model.

### 6.4 OmniRoute wiring changes (v1)

1. **Add the OpenRouter provider** to `~/Containers/omniroute/config/providers.yaml` (0600) — append this
   entry to the existing `providers:` list (only the new entry is shown):

   ```yaml
     - id: openrouter
       kind: openai
       baseUrl: https://openrouter.ai/api/v1
       model: deepseek/deepseek-v4-pro        # default; any model id passes through
       apiKey: <OPENROUTER_API_KEY from dev-secrets>
   ```

   Then `cd ~/Containers/omniroute && docker compose up -d` (the file is a read-only mount, read at boot).
   Verify: `openrouter/deepseek/deepseek-v4-pro` answers through `/v1/chat/completions`.
2. **Verify field passthrough** (do this once, record in notes): whether OmniRoute forwards OpenRouter's
   `provider` preferences (`data_collection: deny`, `require_parameters`), `session_id`, and
   arbitrary request headers (`x-opencode-session` for Go). If not, the fallback plan is a direct
   OpenRouter path inside jev-router for the paid OpenRouter offers (an accepted asymmetry, decided by
   evidence, not now).
3. **Expand the `free` and `paid` combos** to mirror the pool ranking (priority strategy, full member
   list in rank order) via `PUT /api/combos/{id}`. They are kept in sync by `pool sync` and serve as a
   manual/last-resort single-call path; the router's primary dispatch is the explicit per-model call.
   (Cloud combos like `auto/*` remain unused — they have no upstream.)

### 6.5 Pool sync

`jev-router pool sync` (daily job + CLI):

1. Read each source's live model listing (oc-paid with `OCPAID_API_KEY`, oc-free, mscopilot, OpenRouter
   public — all cheap reads), diff against the previous membership, and liveness-probe every new member
   with one tiny completion through OmniRoute ("Reply with exactly: pong", 512 max tokens, 60 s timeout).
2. New members: `index add` each (§5.6). Dead or non-chat members: record and skip.
3. Rebuild the shortlists, update the combos, bump the index version, log a one-screen report (added,
   removed, failed, why).

---

## 7. The Jev layer

### 7.1 Sources, failover and balance `[owner: use all three, not only oc-free]`

All three paths were verified live on 2026-10-12 and return the same `answers` shape.

| Order | Source | Endpoint | Model | Cost |
|---|---|---|---|---|
| 1 | oc-free (remote Zen sidecar) | `POST {OCFREE_BASE_URL}/v1/systemone` | `jev-1.13-free` | free (anonymous tier, WARP pool) |
| 2 | oc-paid (local Go sidecar) | `POST {OCPAID_BASE_URL}/v1/systemone` (Bearer) | `jev-1.13-free` (`jev-1.13` selectable) | no cost field returned (subscription) |
| 3 | OpenRouter | `POST https://openrouter.ai/api/v1/systemone` (Bearer) | `typesafe/jev-1.13` | metered, input-only: ~15 µUSD per judgment (measured) |

- **Priority failover (default).** Sources are tried in order; a source is skipped while cooling. Triggers:
  connect error/timeout, 429/`rate_limited`, 5xx, malformed or empty `answers`, auth error. Per-source
  timeout 1.2 s; overall Jev budget 3 s; after that, fail open to the task default (§7.3).
- **Health.** The chat-candidate cooldown table: 3 consecutive failures → 10 min, doubling, cap 6 h; one
  cheap judgment probes the source when a cooldown expires.
- **Load-balance (optional, `JEVR_JEV_BALANCE`).** `off` (default) = strict priority; `round-robin` rotates
  across healthy sources; `weighted` uses configured weights. Only healthy sources participate.
- The decision row records the answering source, latency, and `usage.cost` where the source reports it
  (only OpenRouter does; it also adds a generation `id` and `provider`).
- The call carries only the bounded ask excerpt and the shortlist, never history, balances or guest data.

### 7.2 Questions (one batched call, English, one answer per option)

```json
{
  "state": {
    "ask": "<last user message, first ~1200 chars>",
    "pool": "paid",
    "context": { "chars": 12400, "has_image": false, "uses_tools": true },
    "candidates": [
      { "id": "c1", "description": "budget price; among the strongest at code and tool use; fast to start" },
      { "id": "c2", "description": "premium; the strongest at long documents; slow to start" }
    ]
  },
  "model": "jev-1.13-free",
  "questions": {
    "model": {
      "type": "choice",
      "instructions": "Pick the specialist that can fully complete this request in one pass. Judge the required reasoning, scope, ambiguity, tool use and blast radius, not the requested answer length. If two fit, pick the cheaper one.",
      "criteria": { "c1": "…same text as the candidate description…", "c2": "…" }
    },
    "effort":    { "type": "choice", "instructions": "How much thinking does this turn need?", "criteria": ["low", "medium", "high"] },
    "task":      { "type": "choice", "instructions": "What kind of work is this?", "criteria": { "coding": "…", "analysis": "…", "math": "…", "writing": "…", "agentic_files": "…", "simple_chat": "…" } },
    "high_consequence": { "type": "noul", "instructions": "A wrong answer here could affect health, legal standing, money or safety" },
    "stakes_domain":    { "type": "choice", "instructions": "Which stake is closest, if any?", "criteria": { "health": "…", "legal": "…", "money": "…", "other": "…" } }
  }
}
```

The `model` field carries the first healthy source's model id (§7.1); the payload below is identical across
sources. Rules baked in: criteria for `choice` is a **map**, for `score` a list, `noul` for yes/no (the
oc-free doc pins this shape); descriptions never contain numbers (the describe step emits fixed phrases);
one canonical option order per shortlist version; Jev's weak spots (option-order bias, numbers, irrelevant
context) are respected by keeping the state short, numeric measures out of the words, and the guard
deterministic.

### 7.3 Confidence

Computed in code from the answer's own probabilities: choice confidence = `(pmax − 1/n) / (1 − 1/n)`.
Thresholds (start uncalibrated, then tuned from the decision log):

| Condition | Action |
|---|---|
| `model` confidence ≥ 0.5 | use Jev's pick (after eligibility) |
| `model` confidence < 0.5 | the task default: the shortlist's strongest for Jev's `task` answer |
| `high_consequence` ≥ 0.80 | never below the shortlist's strong pick for `stakes_domain` |
| 0.5 ≤ `high_consequence` < 0.80 | prefer the strong pick unless its burn exceeds ~3× the cheap pick's |
| Jev timeout / error / malformed | task default from the last known task type, else `analysis` strong pick |

The eligibility check (§5.4) runs **after** Jev: an ineligible pick falls to the next favourite by Jev's
own probabilities; every downgrade is recorded with its reason.

### 7.4 Effort

v1 records Jev's `effort` answer and passes it through as `reasoning_effort`/`reasoning.effort` **only if**
the chosen offer's capability record says the model supports it (from the OpenRouter listing's reasoning
profile and the oc-paid listing's `reasoningEfforts`); otherwise the field is dropped. Verify item: how
the oc-paid sidecar accepts effort fields (phase 4).

### 7.5 Decision cache and pins

- Cache key: SHA-256 of (ask excerpt + pool + index version + shortlist hash). TTL 5 min. A hit reuses the
  full decision (probabilities included) — a repeated "hi" never pays twice.
- `x-jev-conversation` (optional header): when present, a pin row keeps the first decision's model for that
  conversation for 30 min, unless the model became ineligible (then the pin moves and the response says so
  via `x-jev-switch: 1`). Without the header, every request routes independently. Warslop can send it
  trivially (its conversation id); it is the hook for the parked cache-aware phase.

---

## 8. Routing policy and fallback semantics

### 8.1 Selection

1. Shortlist for the pool (built from the index, §5.3), each entry with description + burn + headroom.
2. Jev picks (§7); guard adjusts; eligibility filters.
3. Dispatch candidates = the guarded pick, then the pool's next-best *for the same task* (by role quality,
   headroom-aware, cooldowns skipped), at most 3 paid hops.
4. Paid turns that exhaust the paid candidate list continue into the free pool: the free shortlist's best
   for the same task (no second Jev call), at most 2 hops. Free turns never cross into paid.

### 8.2 Fallback triggers (explicit list, never inferred)

| Trigger | Example code/shape |
|---|---|
| Quota / billing | `402`, `billing_error`, `payment_required`, `account_required`, `quota_exhausted` |
| Rate limit | `429`, `rate_limited` (honour `Retry-After` before counting a cooldown) |
| Provider/server fault | `5xx`, `503 circuit_open`, connect timeout, upstream `api_error` |
| Model cannot serve the protocol | `ModelProtocolUnsupported` (record it; never route there again until a sync re-probes) |
| Auth broken for a source | `401 auth_error` after one retry (marks the source unhealthy; other sources continue) |
| Empty answer | stream ends with zero visible content tokens (`finish_reason` absent or `stop` with empty text) — retried once elsewhere, recorded |

Not triggers: content refusals (`content_policy` — that is the answer Warslop shows), `context_too_long`
(a Warslop-side concern; jev-router returns it typed with `x-jev-error: context_too_long`).

Per-attempt deadlines: first byte/first token 15 s (paid) and 20 s (free); total attempt cap 120 s; the
attempt is abandoned and the next candidate starts. Streaming starts as soon as the winning attempt emits
its first chunk; earlier failed attempts are invisible to the caller except in headers/logs.

### 8.3 Failure of everything

`502` with `{"error":{"type":"all_candidates_failed","message":"paid and free pools exhausted","attempts":[{"model":…,"code":…},…]}}`.
Warslop shows its resting message and charges nothing (D55 rule); jev-router records the decision row
either way.

---

## 9. API contract

### 9.1 Public (Warslop-facing)

- `POST /v1/chat/completions` — OpenAI shape. `model: "free" | "paid"` (an exact OmniRoute id also routes,
  for debugging, loopback only). Streaming (`"stream": true`) is passthrough SSE; non-streaming is a
  buffered passthrough. Response body is the upstream body unchanged (including `usage`); extra headers in
  §9.3. Bearer `JEVR_API_KEY`.
- `GET /v1/models` — exactly two entries: `free`, `paid`, each with `context_length` = the max over its
  pool (warslop uses it for its own guards).
- `GET /healthz` — `{"ok":true,"index":<version>,"pools":{"free":n,"paid":n},"jev":"ok|degraded"}` (no auth,
  loopback only).

### 9.2 Admin (loopback + `JEVR_API_KEY`)

- `GET /admin/index` — current version, sources with dates, per-role shortlists, full report text.
- `GET /admin/decisions?since=…&pool=…` — decision rows, aggregated counts; `GET /admin/decisions/{id}`.
- `GET /admin/pools` — members with health, cooldown state, headroom estimate.
- `POST /admin/fetch` — run the ops fetch now (budget still applies).
- `POST /admin/index/build` — rebuild + version bump.
- `POST /admin/pool/sync` — the §6.5 sync.

### 9.3 Provenance headers (always set)

```
x-jev-pool: paid|free
x-jev-model: <canonical id>          x-jev-source: <omniroute id, e.g. opencode/deepseek-v4-pro>
x-jev-decision: <decision id>        x-jev-index: <index version>
x-jev-fallback: 0|1                  x-jev-hops: n
x-jev-effort: low|medium|high|off
x-jev-switch: 0|1                    (pin moved on an x-jev-conversation turn)
```

### 9.4 Config (`~/.config/jev-router/env`, 0600)

```
JEVR_BASE_URL=http://127.0.0.1:4098
JEVR_API_KEY=<generated>
JEVR_DB=~/.local/share/jev-router/jev-router.db
OCFREE_BASE_URL=http://10.10.100.130:4097          # Jev + free pool
OCPAID_BASE_URL=http://127.0.0.1:4097              # paid pool direct (pool sync listing)
OCPAID_API_KEY=<from dev-secrets>
OMNIR_BASE_URL=http://127.0.0.1:20128              # all chat dispatch
OMNIR_API_KEY=<from dev-secrets>
OPENROUTER_API_KEY=<from dev-secrets>              # benchmarks, models, (:free caps)
ARTIFICIALANALYSIS_API_KEY=<from dev-secrets>      # AA free
JEVR_JEV_SOURCES=ocfree:jev-1.13-free,ocpaid:jev-1.13-free,openrouter:typesafe/jev-1.13
JEVR_JEV_DEADLINE_MS=3000
JEVR_JEV_BALANCE=off                               # off|round-robin|weighted (D2)
```

Warslop consumption (its change, for the integration phase): `JEVR_BASE_URL` + `JEVR_API_KEY` added to
`~/.config/warslop/dev-secrets.env`, and its single upstream repointed at jev-router with model `paid`
(and `free` for free guests).

---

## 10. Build plan (phases, each ends usable and green)

**P0 — Scaffold + first snapshots (2–4 focused sessions).**
Repo skeleton (bun, TypeScript strict, `bun test`, `systemd` unit, env file), SQLite schema + migrations,
`fetch` pipeline with the budget/lock/429 rules, `fetch_snapshots` for all three sources. Done when:
`jev-router fetch` stores all three sources within budget; a fake-server test suite counts requests and
proves reserve-before-call, single-flight, 429 pause, and hash-conditional storage. No request path exists
yet.

**P1 — Index builder + matching.**
Matching (§5.2), roles/scoring (§5.3), eligibility (§5.4), versioned `model_index`, the report,
`index add/build/show/diff`. Done when: the builder over real (captured) snapshots produces the same kind
of report as NOTES-62's worked example; `index add` scores a new model from stored snapshots with zero
network calls (asserted by a fake that fails if called); the generation-collision case (two dated AA rows,
undated listing id) resolves to the newest row (D11), with a fixture for it.

**P2 — Pools + OmniRoute.**
Pool sync (§6.5), the OpenRouter provider entry (§6.4), combos mirror, liveness probes, cooldowns, the
Go quota table + ledger, health reporting. Done when: `pool sync` adds and probes a new member from each
source class; a dead source (mscopilot as of today) is excluded automatically; the `paid` combo mirrors
the ranking; `openrouter/<model>` answers through OmniRoute.

**P3 — Jev routing, shadow first.**
Jev client with the source pool (§7.1: oc-free → oc-paid → OpenRouter, failover + cooldowns + optional
balance), questions (§7.2), confidence + guard (§7.3), decision cache, `serve` with `free`/`paid` ids but
a fixed default model (shadow logs the would-be choice). Done when: the 23 cafe-task fixtures from brief 47
(adapted) run through the classifier; injected failures on sources 1 and 2 still yield an answer from 3,
and all-sources-down falls open; decision rows carry features, the answering source and no prompt text;
nothing on the request path calls a benchmark API (fake asserts).

**P4 — Full routing + fallback + streaming.**
Explicit-model dispatch through OmniRoute, the fallback state machine (§8), first-token deadlines, SSE
passthrough, provenance headers, error typing, `route explain` CLI. Done when: a fault-injecting fake
OmniRoute proves every §8.2 trigger hops to the next candidate and a paid turn with a fully failed paid
pool lands on the free pool; a streamed answer reaches the client with correct headers; the empty-answer
case retries once elsewhere.

**P5 — Warslop integration readiness (their F100 repoint).**
Docs + dry-run: a local fake of Warslop's client calling `free`/`paid` under load with a small script;
`JEVR_*` lines for dev-secrets; a one-page integration note. Done when: the contract in §9 is frozen,
versioned and announced; a Warslop dev stack can point at jev-router without code changes on this side.

**P6 (parked) — Cache-aware routing + conversation pins.**
`x-jev-conversation` pins (already specced in §7.5), warm-cache evidence to Jev, switch rules (upgrade /
20 % margin / dwell / budget 3) ported from brief 47 §Cache-aware routing. Trigger: after P5, if Warslop
sends the header and the decision log shows real switch churn.

---

## 11. Ops runbook

- Service: `systemctl --user {status,restart} jev-router` · logs `journalctl --user -u jev-router -f`.
- Fetch/index/sync run inside the service's ops loop (hourly listing check, daily pass with jitter) and
  via CLI by hand; CLI works on the same DB offline.
- Rotating a key: update `~/.config/jev-router/env` (+ dev-secrets where duplicated) and restart.
- Dead upstream playbook: a source's failures show in `/admin/pools` and the cooldown table; mscopilot's
  refresh token is the known example — recovery is the HAR re-export documented in dev-secrets, no
  jev-router change. A model dropped from every source disappears at the next `pool sync`.
- Snapshot staleness > 48 h raises an alert line; index keeps serving the last good version.

## 12. Risks and known gaps

- **Jev routing accuracy is unproven** (madewithjev says so about every Jev router): run shadow first
  (P3), log decisions, compare cost per completed task, not per call. The guard thresholds start
  uncalibrated.
- **Benchmark coverage is partial.** Go-catalog-only models (LongCat, Hy3, Space Bunny) have no scores;
  they stay out of Jev's shortlist until probes exist. AA matching is heuristic (no `openrouter_api_id`
  on the free tier).
- **The quota ledger is an estimate.** The provider's own refusal is the truth signal; the ledger only
  paces.
- **OpenRouter passthrough fields** (`provider`, `session_id`, custom headers) are unverified (§6.4
  item 2); the direct-path fallback is noted but not built.
- **`:free` economics shift.** 15 free variants and their availability can change; the pool sync and the
  20 % reserve handle it, but free capacity is never guaranteed — Warslop's UX must tolerate it.
- **mscopilot is down today**, and the bridge shares one server-side conversation for all callers
  (privacy note for free turns).
- **Two-writer safety**: nothing else may write the DB while the service runs; the CLI takes the same
  SQLite locks.
- **Jev source shapes differ.** OpenRouter's `usage` carries `cost` and its response an `id`/`provider`;
  the sidecars carry neither. The anonymous oc-free tier can throttle at peak — the fallback chain and
  cooldowns exist for that. Fixtures pin each source's shape.

## 13. Acceptance (project done when)

1. `warslop → jev-router (paid) → OmniRoute → a Go model` answers over SSE with correct `x-jev-*`
   headers, and the same call keeps working after the chosen model is made to fail (next paid, then free).
2. `model: "free"` never routes to a paid offer; a paid turn never runs out of tokens without trying the
   free pool first.
3. Adding a model is `index add` + (if unmatched) one budgeted fetch; no request path ever calls the
   benchmark providers (fake-asserted).
4. The decision log explains any turn: pool, candidates, probabilities, guard action, hops, latency,
   usage — with no prompt text stored.
5. The Go subscription is not drained: the ledger and headroom rules appear in `/admin/pools`, and
   refusals fall back cleanly.
6. `bash scripts/verify.sh` equivalent for this repo: `bun test` green, no runtime deps, service survives
   a kill -9 (systemd restart), and the spec's tables match the code's constants (a doc-constants test).
7. Jev failover: with oc-free failing, the turn still routes via oc-paid; with both down, via OpenRouter;
   with every Jev source down, the turn still completes on the task default (fail-open). With
   `JEVR_JEV_BALANCE=round-robin`, the answering source rotates across the healthy set.
