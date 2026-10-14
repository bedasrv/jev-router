# jev-router — a Jev-routed model gateway for Warslop (free + paid pools)

**Status: proposal v1.24, 2026-10-14 (blockers: B1 resolved as Warslop env values, B3 resolved by live AA capture, B4 partly resolved by live probe, OmniRoute settings read live; v1.23: free ids stay allowed regardless of Go catalog: `big-pickle` joins the free pool; connection-wide 24 h cooldown from one 410 documented with the repair call and probe rules; v1.22: owner: Zen credit empty — paid pool = sidecar ∩ Go catalog only (21 ids), no opt-in; v1.21: owner plan = Go $10/month, first table only, Go Plus excluded; Cat Jam Free row added; v1.20: owner: ocpaid uses the Go subscription — Go page is the pricing authority; Zen-billing exposure downgraded to unverified, 'Use balance' toggle noted; v1.19: price research audited against the Zen table: 12 of 53 wrong; v1.18: price research reviewed: Zen table is the billing authority, Zen pay-as-you-go exposure found; §6.1 member list corrected; v1.17: tool/vision flag provenance + results for the 84 sidecar chat models; v1.16: qwen3.8-max / mistral-large-4 windows vendor-confirmed via OpenRouter pages, Mistral absent from Go page; v1.15: unknown `ocpaid` windows filled from the OpenRouter listing + ocfree, §5.4; v1.14: context-window sources verified live against the sidecars; usable input = min(context − reserve, max_input_tokens); v1.13: full-context-capability pass: long-context shortlist pick, output reserve, widen-before-`context_too_long`, context bucket in the decision-cache key, size-aware headroom, window class in Jev's candidate descriptions; v1.12: B5 executed 2026-10-14: divert retired, provider nodes + connections live, id shapes and headers pinned in §6.4 item 1; v1.11: owner chose B5 option (a): the four upstreams become real OmniRoute provider nodes + connections, the self-hosted `providers.yaml` divert is retired; §6.4 item 1 rewritten as the registration procedure, option (b) deleted; v1.10: OmniRoute layering pass from a v3.8.51 source read: new BLOCKER B5 (self-hosted divert), account-level failover/health/cooldowns delegated to OmniRoute, jev-router owns model- and pool-level hops only, dispatch-id and error-mapping fixes; v1.9: scope pass: jev-router is a router on top of OmniRoute, not an agent harness — §1 scope rule; pins, response rewriting, empty-answer judging, effort translation and chat-health duplication removed; v1.8: review pass: internal contradictions fixed in place — §5.2/5.4/5.5, §7.3, §7.4, §8.1/8.2, §9.1/9.2/9.4, §11, §14.1/14.3 — and the open owner calls collected in new §15; v1.7 text follows) (v1.7: owner direction: Rust + containers for external deployment — D8 flipped to Rust/axum/distroless with image-size gate; verification round 4 fixes applied: RUSTSEC id struck, distroless debian13, tower-http 0.6.x pin, OmniRoute 20-strategy + affinity + combo-path corrections, AA new-path downgraded to provisional, Go-page + OpenRouter-limits + confidence facts re-pinned; GHCR deployment + versioning specified (§14.3 rewritten, §9.1/§10–§11/§13 touched, Docker/GH action versions re-pinned live 2026-10-13). Nothing here is built yet).** This is the project spec and build plan
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
| `~/.config/warslop/dev-secrets.env` | Every credential by name; OmniRoute's upstreams are provider nodes + connections in its own DB (§6.4 item 1; the old `~/Containers/omniroute/config/providers.yaml` divert is retired by B5) |

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

### Scope rule: a router on top of OmniRoute, not a harness

jev-router does exactly one thing per request: **choose which OmniRoute model id should serve it, forward the request there, and report the choice.** OmniRoute is the model source and owns execution concerns (provider auth, circuit breakers, lockouts, provider-level retries, reasoning/parameter handling, usage visibility). jev-router therefore does **not**: keep conversation state or pin models; rewrite, strip, buffer or judge responses (no reasoning stripping, no empty-answer retries, no `stream_options` injection); translate or clamp reasoning effort/token budgets; re-implement provider health tracking beyond a per-request tried-list; or run an agent loop of any kind. Request fields from Warslop pass through unchanged except `model`. Anything that looks like harness behaviour belongs in Warslop or OmniRoute, or is parked (P6).

### Non-goals (v1)

- No guest billing, balances, holds or receipts — Warslop keeps all of that; jev-router reports token
  usage and provenance headers and charges nobody.
- No provider credential management — OmniRoute owns the upstreams; jev-router never sees the Zen or
  OpenRouter keys for chat calls (only for index fetches and direct Jev calls).
- No local quality probes or side-by-side evals — quality is benchmark-driven in v1; the probe gates of
  brief 47 §Dynamic menu step 5 are a later, optional phase.
- No cache-aware economics across Warslop turns in v1 — warm-cache evidence, the 20 % margin, dwell and switch-budget rules stay parked (§10 phase 6). Stickiness/pinning is not in v1 at all (scope rule above).

---

## 2. Verified environment (checked 2026-10-12)

| Component | Endpoint / location | State |
|---|---|---|
| oc-free proxy (remote, "the oc-free in OmniRoute") | `http://OCFREE_HOST:4097` — `/v1/models`, `/v1/chat/completions`, `/v1/systemone` | Up. 9 free models incl. `opencode/jev-1.13-free`, `longcat-2.5-preview-free`, `mimo-v2.6-flash-free`, `muse-spark-1.2/1.3-contributor-free`, `nemotron-3.5-lightning-free`, `space-bunny-free`, `step-5-preview-free`, `ling-3.1-flash-free`. No auth (any key accepted/ignored) |
| oc-free Jev | `POST :4097/v1/systemone`, `model: jev-1.13-free` | **Verified live**: noul 0.73, choice `technical` at confidence 1. Free, WARP-pooled egress, rated with more headroom than Zen direct |
| oc-paid proxy (local) | `http://127.0.0.1:4097` + Tailscale — Bearer `OCPAID_API_KEY` | Up, systemd `oc-paid-proxy`. 87 models (`opencode/…`); Jev `jev-1.13` and `jev-1.13-free` both verified live (noul 0.72 / 0.75, choice conf 1) |
| OpenRouter Jev | `POST https://openrouter.ai/api/v1/systemone` (TypeSafe-SDK surface; equivalent Decisions surface `POST https://openrouter.ai/api/alpha/decisions`) — Bearer `OPENROUTER_API_KEY`, `model: ~typesafe/jev-latest` (tilde form per OpenRouter tutorial; bare `typesafe/jev-latest` "does not exist"/404 is community-reported per warslop D32, not vendor-stated; pinned request id `typesafe/jev-1.13`) | **Verified live** via `typesafe/jev-1.13`: noul 0.73-class judgments, choice conf ~1; `usage.cost` ~14.8 µUSD for a 353-in/55-out judgment (input-only billing at $0.042/M in, $0 out — the measured cost matches the price exactly). Context is 64k total with a 32k state-plus-longest-question ceiling on the TypeSafe models page (verified 2026-10-13 via webfetch; the OpenRouter guide hub still states 32k state+questions — treat TypeSafe as truth, guide as stale) (`max_tokens_exceeded` is the OpenRouter typed error code for overflow — TypeSafe's own error table is silent on overflow/truncation, so trim-client-side is project policy, never an assumed vendor guarantee). Response adds `id` + `provider` and `model` names the dated build (`typesafe/jev-1.13-20260917`, created 2026-09-18) — the dated string is the recorded resolve, not the request pin. Default `GET /v1/models` (text-only) omits Jev: it lists only `typesafe/jev-router` (a separate router product); Jev appears with `?output_modalities=decisions` (`typesafe/jev-1.13` + `~typesafe/jev-latest`, 64k, $0.042/M). P2 must still re-verify the `~typesafe/jev-latest` alias form live before launch (D32 says dated ids go unreachable; whether the dated build name is accepted as a *request* id is unstated — send the minor version) |
| OmniRoute | `http://127.0.0.1:20128`, Bearer `OMNIR_API_KEY`, docker at `~/Containers/omniroute` | Up (image 3.8.51, host network). Today the self-hosted providers file (`ocpaid`, `mscopilot`, `ocfree`, no OpenRouter) diverts every chat request around OmniRoute's real pipeline — to be retired and replaced by real provider nodes + connections (B5, §6.4 item 1) |
| OmniRoute routing | live probes through `/v1/chat/completions` | `opencode/deepseek-v4.1-flash` → `pong` (383 in / 18 out, 14 reasoning tokens); `ocfree/space-bunny-free` → `pong` (128 cached in). Confirmed working |
| OmniRoute combos | `POST /api/combos` (manage scope; list shape pinned in P2) | `free` (priority, one member `ocfree/space-bunny-free`) and `paid` (priority, one member `opencode/deepseek-v4.1-flash`) already exist; this spec adopts them as pool names and expands their member lists |
| mscopilot (BizChat) bridge | `http://127.0.0.1:8780` — `mscopilot/default`, `mscopilot/reasoning` | Service up **but the refresh token is dead**: `/health` → `tokenFresh:false`; direct call → `refresh token rejected … re-export the HAR`. **Currently unusable**; repair path is in the dev-secrets comment block. The free pool must tolerate one dead source |
| OpenRouter benchmarks API | `GET https://openrouter.ai/api/v1/benchmarks` — Bearer `OPENROUTER_API_KEY` | **Verified**: returns AA rows with `intelligence_index`, `coding_index`, `agentic_index`, plus `gpqa_diamond` / `tau_bench_verified_airline` rows. Limit 30/min, 500/day per account |
| Artificial Analysis API | `GET https://artificialanalysis.ai/api/v2/language/models/free` — header `x-api-key: ARTIFICIALANALYSIS_API_KEY` | **Provisional, re-verify live in P0 with a real key before freezing schema (2026-10-13):** route exists (bad key → `401 Invalid API key`, not 404; `x-matched-path` confirms the path). Pagination/quotas/shape below are per the partner/V2-Free source, NOT the public api-reference page (public page today documents only legacy `GET /api/v2/data/llms/models` at 1000/day, stable ids, mandatory attribution, `x-api-key`, 401/429/500 — no retirement notice, no new-path fields): paged (`page` 1-indexed, `page_size` is a response pagination field, `total_pages`, `has_more`; 2–4 pages observed — page count drifts, hence the 10/day ceiling). Free tier 100 req/24h fixed window (first request starts window — partner source). Legacy `GET /api/v2/data/llms/models` (1000/day on the public page) migrates to the new path (retirement `410 Gone` per the migrate-v2-data note — no date pinned here until the citable source lands; P0 records the URL). Pro list/detail `/api/v2/language/models[/{slug}]` → 403 on Free keys (partner source). Free shape excludes `context_window_tokens`, `modalities`, `openrouter_api_id`, `providers` (Pro/Commercial only — partner source) — hence slug/name heuristic matching. Rate-limit headers `X-RateLimit-Limit/Remaining/Reset`, `X-AA-Tier`, `Retry-After` on 429 are CritPt-documented; on the Free language path they are partner-stated, not public-page-verified — P0 records the live headers. IDs are stable, slugs/names change — match on slug first, keep the stable `id` in the snapshot. Attribution to artificialanalysis.ai is mandatory wherever its data is shown or shared |
| OpenRouter models listing | `GET https://openrouter.ai/api/v1/models` (public) | Snapshot 2026-10-12: 458 models, **15 `:free` variants** (counts drift — pool sync is truth); carries price, context, `top_provider.max_completion_tokens`, reasoning profile |
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
<!-- ownership below holds once B5 is resolved (§12): account rotation, connection cooldowns, breakers and model lockouts are OmniRoute's; model- and pool-level fallback is jev-router's -->
| **oc-free / oc-paid sidecars** | Zen/free and Go/paid model access, `/v1/systemone` (Jev judgments), WARP pooling (free side) | Routing decisions |
| **Warslop** | Guest sessions, vouchers/billing, the "resting message" UX, calling jev-router with `free`/`paid` | Which model answers, pool policy |

### Request path (a `paid` turn)

1. Warslop `POST /v1/chat/completions` with `model: "paid"`, the full message list, Bearer `JEVR_API_KEY`.
2. jev-router extracts the *current ask* (last user message, capped; never the whole history) and looks up
   the decision cache (SHA-256 of ask excerpt + pool + index version + shortlist hash per §7.5; TTL 5 min, eligibility rechecked). A hit skips step 3.
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
| D2 `[owner]` | Jev judgments use a **source pool**, not only oc-free: `ocfree:jev-1.13-free` → `ocpaid:jev-1.13-free` → `openrouter:~typesafe/jev-latest`, priority failover by default, optional load-balance. All three verified live 2026-10-12 (OpenRouter via the dated resolve; alias form per D32). | Owner: "local opencode and openrouter also have jev — use as fallback or loadbalance" |
| D3 `[owner]` | Every chat dispatch goes through **OmniRoute** by default; pools span opencode (Zen free + Go paid), OpenRouter (free + paid) and BizChat (free). A direct OpenRouter chat path is **not** in v1: if §6.4 item 2 shows OmniRoute drops `provider`/`session_id`/headers, the fix is an OmniRoute change or a config flag, not a silent bypass — a bypass would need an owner decision and would lift the §1 non-goal that jev-router never holds chat keys. | User brief; OmniRoute already carries all four upstreams except OpenRouter |
| D4 | Quality comes from the **OpenRouter benchmarks API + Artificial Analysis free API**, stored as dated snapshots and scored into a versioned local index. No per-request provider calls; adding a model reuses the stored snapshots. | User brief; warslop F50/F51 (briefs 61/62) |
| D5 | A **canonical model × source offer** model: quality scores attach to the canonical model; price, quota and capabilities attach to each source's offer; routing picks a canonical model, dispatch picks the offer. | brief 47 §Dynamic menu, brief 55 |
| D6 | Go-plan **quota-aware routing**: per-model monthly limits and 5h/weekly windows (20/50/100 % per the live Go page, verified 2026-10-13) are part of the index; a model without headroom is skipped before it is drained. Peak/off-peak prices are respected for DeepSeek models. This pacing ledger lives in jev-router only — warslop D55 ("no spending counters in the app") binds Warslop, not this service; it is pacing, not billing: it never charges, never caps Warslop guests, and never replaces the provider's refusal, which stays the source of truth (§6.3). Thresholds stay env-configurable (D14) so a wrong estimate fails open to refusal, never to a hard block. | User brief ("without draining the usage limit"); Go docs |
| D7 | The service exposes exactly `free` and `paid` via OpenAI `/v1/models` and `/v1/chat/completions`, plus a loopback-only admin surface. The `JEVR_DEBUG_IDS=1` exact-OmniRoute-id path (§9.1) is debugging only, default off, never part of the Warslop prod contract. | warslop D48c; D47 "one upstream" |
| D8 `[owner]` | Stack: **Rust** (stable, `axum 0.8` (max 0.8.9) + `tokio 1` + `reqwest 0.13` (max 0.13.5) + `rusqlite 0.40` (max 0.40.2, bundled SQLite 3.53.2) — pinned minimal features, researched 2026-10-13; server `axum {default-features=false, features=[http1,json,query,tokio,tracing]}` on `hyper 1.x` + `tower 0.5` native — actix/poem/rocket rejected: actix SSE needs extra `actix-web-lab` + non-tower stack, poem stalled (last release 3.1.12 on 2025-07-28 — no RUSTSEC for poem; the earlier RUSTSEC-2025-0134 citation is struck, that id is `rustls-pemfile`-unmaintained), rocket on the pre-1.x `hyper 0.14` generation; runtime `tokio {macros,rt-multi-thread,net,time,signal,io-util}` — axum requires Tokio, `full` rejected; client `reqwest {default-features=false, features=[rustls,json,stream,http2,charset]}` — `bytes_stream()` needs `stream`, old 0.12 `rustls-tls*` flags are gone in 0.13 (renamed to `rustls`; roots features removed, `rustls-platform-verifier` default, crypto default `aws-lc-rs`), `query`/`form` are opt-in crate features since 0.13 (add only if client code calls `.query()`/`.form()`; server query parsing is axum's `Query`, unaffected), `system-proxy`/compression/cookies dropped (must not decompress SSE); TLS `rustls` (default `aws-lc-rs` + platform-verifier) — no OpenSSL in image; DB `rusqlite {bundled}` sync + `spawn_blocking` (sqlx ~174-crate tree and diesel DSL rejected for a single-file WAL index) + `nix {fs}` `Flock` (`nix::fcntl::Flock`) for the ops lock (`fs2` 0.4.3/2018 and `fslock` 0.2.1/2021 stale); `serde/serde_json`, `tower 0.5` / `tower-http 0.6.x {trace,timeout,cors,limit}` (never `full`, never `0.7` — axum 0.8 requires `tower-http ^0.6.8`, `^0.6.8` does not admit 0.7), `tracing` + `tracing-subscriber {env-filter,fmt}` (features belong on `tracing-subscriber`), `futures-util`, `bytes`. Static musl binary on distroless (`x86_64-unknown-linux-musl` + `musl-tools`, `rusqlite bundled` builds under musl; runtime `gcr.io/distroless/static-debian13:nonroot` digest-pinned — certs/tzdata/nonroot built in; debian12 tags still resolve but are unsupported per distroless support policy, so debian13 is the pin; `scratch` fallback only if every MB is load-bearing; `cc-debian13` fallback if musl FFI pains). `clippy -D warnings` + `fmt --check` + `cargo deny check bans licenses sources` on PRs; `cargo audit --deny warnings` / `deny advisories` only as the scheduled non-blocking jobs of §14.2 (a new RUSTSEC must not red-flag every open PR); release via `cargo auditable build`. The compiler is the correctness gate: unmatched types, unhandled `Result`, non-exhaustive matches do not ship. | Owner direction 2026-10-13 (Rust for compile-time enforcement + smallest image); stack researched 2026-10-13 (axum docs, reqwest 0.13.5/CHANGELOG, tower-http features, rusqlite 0.40.2/SQLite 3.53.2 docs, nix Flock, distroless docs); aligns with Warslop's Rust gateway crates |
| D9 | No request handler ever calls a benchmark provider; fetches run only in the ops job/CLI under a persisted budget. | warslop F50 rule, kept verbatim |
| D10 | Jev receives only the bounded ask excerpt + shortlist descriptions (no history, no balances — keeps the call small and inside Jev's input budget, not a privacy control). Attribution text for AA is stored with every snapshot and shown in admin views. | brief 47; AA terms |
| D11 | Matching rule: dated listing ids match dated benchmark rows exactly; undated ids match the **newest** dated row for that model. (This reverses the old "lowest intelligence wins" rule that NOTES-62 flagged as a generation collision.) | NOTES-62 Known gaps, recommendation (2) |
| D12 | Outcomes are logged as **decisions without prompt text** (hashes, features, probabilities, guard action, hops, latency, usage counters). | brief 47 phase 4 |
| D13 | Jev source order stays `ocfree → ocpaid → openrouter`: zero-cost paths first, metered OpenRouter last as the Zen-independent escape hatch. This supersedes warslop D27/D29/D32 (`paid Jev only, never free`) for this service — those bound Warslop's in-app router, which D47 removed; the owner directed all three sources here (D2). OpenRouter request id is `typesafe/jev-1.13` pinned or `~typesafe/jev-latest` for tracking-latest (tilde form per OpenRouter tutorial; bare-form 404 is community-reported, not vendor-stated); the dated `typesafe/jev-1.13-20260917` is the recorded resolve from the response `model` field, never the request pin (corrected 2026-10-13: whether the dated build name is accepted as a request id is unstated). A reorder is one config line if the Go ledger ever shows Jev billing; cooldowns make a dead first source a one-time cost, not a per-turn one. | owner delegated 2026-10-12 ("choose whatever you think is best"); request-id correction 2026-10-13; closes the ordering question |
| D14 | Quota soft reserves (defaults, to calibrate after P4): skip a Go model below ~10 typical turns of monthly headroom or at ~80 % of its monthly limit; deprioritise below ~3 turns in the 5 h window; treat OpenRouter paid near `OPENROUTER_MONTHLY_CAP_USD` the same way. | owner delegated; conservative until the decision log says otherwise |
| D15 | No privacy/training filtering in v1: the owner does not offer private models, so no pool excludes an offer for training or data-retention reasons, and Warslop's `private`/`trains`/`unknown` class stays removed (warslop D31). OpenRouter paid requests omit `provider.data_collection` / `session_id` in v1 because no OmniRoute client→upstream forwarder for those fields has been found (allowlist-style executor header construction; operator `customHeaders`/`upstreamHeaders`/`x-omniroute-*` are operator-side, not client passthrough — container docs + `opencode.ts` imports verified 2026-10-13; `DefaultExecutor`/`executorClientHeaders` bodies are not shipped in the image so the negative rests on docs + the required P2 live probe, not on source): only Go's `x-opencode-session` is known to pass. `data_collection: deny`, `require_parameters`, `max_price`, and `session_id`/`prompt_cache_key` are enabled only after the §6.4 item 2 probe shows them passing; until then the fields are omitted, never silently assumed. | owner direction 2026-10-14 (privacy not a concern) |

The three questions this section opened on 2026-10-12 — Jev source order, reserve numbers, free-pool
training/data policy (none) — were delegated to the coordinator ("choose whatever you think is best") and are closed as
D13–D15. The reserve numbers (D14) are the only part expected to move, once P4 produces decision-log
evidence.

---

## 5. The score index (the heart of the project)

### 5.1 Sources and budgets

| Source | Endpoint | Published limit | Budget this project spends |
|---|---|---|---|
| OpenRouter models listing | `GET https://openrouter.ai/api/v1/models` (public) | none | 1 GET/hour (cheap change detector); store a new `fetch_snapshots` row only when the body hash changes |
| OpenRouter benchmarks | `GET https://openrouter.ai/api/v1/benchmarks` (Bearer) | 30/min per key, 500/day per account (verified 2026-10-13) | max 2/day (one pass + one retry); refetch when the listing hash changed or the snapshot is > 24 h old; listing changes beyond the 2/day budget queue to the next UTC day, never exceed |
| Artificial Analysis free | `GET https://artificialanalysis.ai/api/v2/language/models/free?page=N` (x-api-key; only query param is 1-indexed `page`, default 1 — `page_size` is a response pagination field, not a request param) | Provisional Free 100/24h fixed window (first request starts window — partner source, not the public page; P0 re-verifies live headers before freezing backoff) | 1 full pass/day (2–4 pages observed; `page` 1-indexed, `total_pages`, `has_more`); if the page count grows, fetch up to the hard ceiling of 10/day and alert; hard ceiling 10/day. `X-RateLimit-*`/`X-AA-Tier`/`Retry-After` handling is coded defensively (honour when present; never assume names until P0 records them). Free shape excludes `context_window_tokens`, `modalities`, `openrouter_api_id`, `providers` (Pro/Commercial only — partner source) — hence slug/name heuristic matching. Attribution mandatory |
| OpenRouter free-model cap | `GET https://openrouter.ai/api/v1/key` (Bearer) | — | at most every 10 min, ops job only (never the request path); stop free routing at 20 % of `free_model_daily_requests.remaining`. The request path additionally enforces a local 20 req/min token bucket for `:free` offers (brief 47 easy-turn rule) so bursts never 429 the account. Verified 2026-10-13 via limits docs + live refetch: 20/min always; 50/day (<10 credits all-time) or 1000/day (≥10, higher tier granted from 9 credits to absorb top-up fees); per-minute limit not reported in `/key`; `is_free_tier` is independent of the credit-count tier; negative balance 402-blocks even `:free`; paid variants have no platform request cap. OpenRouter 402s carry `error.metadata.limit_source` (`openrouter_in_flight_budget` with `Retry-After` = transient, wait and retry; `weight_exceeds_budget`/`openrouter_credits` = lower `max_tokens`/prompt or add credits) and 403s carry budget `limit_source` (`openrouter_guardrail_budget`/`openrouter_workspace_budget`/`openrouter_key_limit`, no `Retry-After`, wait for `resets_at`) — both count as quota/billing fallback triggers in §8.2, never retried on the same model |

Rules (ported from NOTES-61, unchanged in spirit):

- Every fetch is **reserved first** against a persisted counter (`fetch_budget(source, window_start, used)`;
  UTC windows; `window_kind` = `hour` (`YYYY-MM-DDTHH`) for the models check, `day` (`YYYY-MM-DD`) for the rest; atomic check-and-increment in `BEGIN IMMEDIATE`). A refused reserve means no call.
- After each response, persist the provider reading in `rate_limit_state(source, window_start, limit, remaining, reset_at)` and remember `Retry-After` / `X-RateLimit-Reset` on
429. No call while the provider's remaining is below 20 % of its limit for the current window (this is the provider's limit, not our small allowance — our 2–4/day never nears it, it guards manual/dev use).
- **Single-flight** across processes: an OS file lock (`<DB>.fetch.lock` via flock, as warslop did — not a long SQLite write transaction, which would block `routing_decisions`/`quota_usage` writes for the whole multi-minute AA pass), plus the `fetch_lock` row as a stale-takeover record (10-minute rule: `UPDATE fetch_lock SET owner_pid, started_at WHERE started_at < now-10min`). The file lock is held for the whole run; the DB row is touched with short transactions only (claim/heartbeat/release). SQLite runs in WAL mode with `busy_timeout=5000`.
- **429**: honour `Retry-After`/`X-RateLimit-Reset` (later instant wins); no retry inside the window; keep
serving the last good snapshot. A source with no good snapshot for 48 h writes an `alerts(source, first_seen, last_seen, kind)` row and prints a line (Telegram wiring is a later phase; schema §5.5 owns the table).
- **Jitter** the daily pass by ±30 min so it does not hammer the APIs on a fixed second.
- Snapshots are stored whole: `fetch_snapshots(source, fetched_at, body_hash, body)`; the AA envelope
  stores the attribution string plus all pages (`{"attribution": "Artificial Analysis", "pages": [...]}`).

### 5.2 Matching (canonical model identification)

1. Normalise: take the tail after the last `/`, lowercase, keep `a-z0-9`. Benchmark permaslugs drop a
   trailing `-YYYYMMDD` first (guard: non-ASCII slugs never panic via byte-split).
2. A dated listing id (`opencode/qwen3.8-max-0902`) matches the dated benchmark row first; an undated id
   matches the **newest** dated row for its normalised key (D11 — this implements warslop D34 "use only the latest, 0813 over 0424" for dated generations). "Newest" = largest `YYYYMMDD` suffix; rows without a date suffix sort last. For AA free-tier rows (no `openrouter_api_id`, no permaslug dates): apply the same rule to AA `slug` first (exact normalised match), then display name with
   parenthesised suffixes removed — only when no slug matched. When several AA rows share a key (e.g. DeepSeek 0424 vs 0813), the newest dated display-name variant wins; fully undated ties go to payload order and the report names the chosen variant.
3. A model with no AA row falls back to OpenRouter's own benchmark rows (`gpqa_diamond`,
   `tau_bench_verified_airline`); its intelligence index stays `unknown` (never substituted with another
   metric).
4. Aliases are explicit data: `model_alias(canonical_id, aliases_json)` maps each provider's spelling
   (`opencode/glm-5.3-flash`, `z-ai/glm-5.3-flash`, `GLM 5.3 Flash`) to one canonical id. Lookup order is alias-first, then normalised match; the matcher
   proposes, a mismatch is a data row (edited via `index alias add/del`, versioned with the index), not code.
5. Go-catalog models that exist nowhere in the benchmark sources (LongCat, Hy3, Space Bunny, …) enter the
   index with `quality: unknown` — they have Go prices but no benchmark scores, so they are excluded from Jev's shortlist *before* scoring (median substitution in §5.3 applies only to partially-missing components among benchmarked models, never to fully-unscored models). They remain valid fallback members (§6.1/8.1) — zero-burn only for the free-preview pair; LongCat-2.0, Hy3 and Space Bunny are priced (§6.3) and keep their real burn and headroom gates. Having no role quality, they are appended **after** all scored candidates in a dispatch chain, ordered by ascending burn. (Optional later: the probe gates of brief 47 would measure them.)

### 5.3 Scoring per role

Metrics are integers (indices ×10, accuracies ×1000, tokens/s ×10, TTFT ms), as in NOTES-62. Missing
components among benchmarked models take the median of the eligible set, labelled `unknown` — never the intelligence index. Fully-unscored models (§5.2 step 5) never reach this step.

| Role | Components |
|---|---|
| `coding` | AA coding_index + tau-bench accuracy |
| `math` | GPQA-Diamond + intelligence_index |
| `analysis` | intelligence_index |
| `agentic_files` | tau-bench accuracy + AA agentic_index |
| `writing` | speed (median output tokens/s) above a quality floor; price as tiebreak |
| `simple_chat` | speed + burn |
| `health` / `legal` / `money` | AA domain indexes: healthcare-and-medical / legal / finance-and-accounting (stakes roles; used by the high-consequence guard) |

Per role, keep the **Pareto front of (quality, burn)** over the pool's eligible scored members; the pool shortlist is the union across roles of (cheapest + strongest per role, deduplicated, plus one strong pick per stakes domain), in one canonical order (by typical-turn burn; Jev's option order never changes between calls for the same index version), capped at 12 entries total (8 for the free pool). **Long-context picks (never dropped by the cap, so a huge turn always has a fitting candidate):** per pool, the largest-window scored eligible member of each window class (`standard` < 200k, `large` 200k–<500k, `huge` ≥ 500k) is always kept, in addition to the role picks (a model already kept counts as its class's pick). Drop order when over cap: stakes picks first, then per-role strong picks, cheap picks last to go, long-context picks never; every drop is listed in `index show`. `quality: unknown` models never enter the Pareto set.

`burn` = expected cold cost of a typical turn (2,500 input + 500 output tokens, warslop's figure) in micro-USD, cache ignored in v1 (parked phase 6), reasoning tokens billed as output where the provider does so. Note: Go's own request estimates assume heavy cache reuse (32,500–88,900 cached tokens/req depending on model, live page refetched 2026-10-13), so our cold burn is deliberately conservative — headroom undercounts turns vs Go's dashboard, never overcounts:
- OpenRouter offers: live listing prices (per-token, integer maths — decimal strings parsed without
  floats).
- Go offers: the Go token prices (§6.3), with peak/off-peak resolved at dispatch time by clock (the builder stamps both into `price_json` as `{burn_offpeak_micros, burn_peak_micros, peak_windows}`; the router picks by UTC clock).
- `:free` / Zen-free / BizChat offers: burn 0.

### 5.4 Eligibility rules (code, not Jev)

- text output only (`architecture.output_modalities` includes `text` in `GET /api/v1/models` — verified 2026-10-13; default listing is text-only so `decisions`-modality models like Jev are omitted unless `?output_modalities=decisions|all` is passed; unknown modalities = ineligible, never assumed); vision: if `context.has_image` the candidate must list image in `architecture.input_modalities`, else skipped (same endpoint; sources with no vision flag = text-only). Tools: `supported_parameters` includes `tools` (same endpoint; `tools`/`tool_choice`/`max_tokens`/`temperature`/`reasoning` etc. are the documented values; `require_parameters` filtering is an OpenRouter request-time feature, not a listing field). Native window: `top_provider.max_completion_tokens` (a ceiling — effective max output is context remaining after input); context: `context_length`; deprecation: `expiration_date` only (`expires_at` is an API-key object field, never a model field — verified 2026-10-13); id stability: `canonical_slug` (permanent slug). `per_request_limits` (`{prompt_tokens, completion_tokens}|null`) is recorded, never gated in v1. `reasoning` object is omitted entirely for non-reasoning and dynamic-router models — absence means no effort field, never assumed.
- tools: required by the **request**, not the role: if the incoming payload carries `tools` (`context.uses_tools`), every candidate must list tool support, whatever Jev's `task` answer says (dispatching tools to a model without them breaks the call). `agentic_files` additionally requires it for scoring. With no `tools` in the request, an absent tools flag (`tools unknown`) is in for every role except `agentic_files`.
- **Full-window rule (the goal is to use each model's whole window, not a conservative slice):** context window ≥ 32k floor or the current turn's estimated size, whichever is larger, **plus an output reserve**: `estimated_input + reserve ≤ window`, where `reserve` = Warslop's own `max_tokens` when sent, else `min(candidate's max_completion_tokens, 16k)` (the request itself still carries no `max_tokens` unless Warslop set one — D40; the reserve is only for the fit check). There is no "comfort" cut below the window: a turn that fits is eligible, whatever fraction of the window it uses. A candidate whose window is unknown is treated as exactly the 32k floor (eligible only for turns that fit it) until a listing or the Go page supplies the number — never assumed large. Window sources, in precedence order, **verified live 2026-10-14** (`GET /v1/models` on each sidecar and on OmniRoute): (1) the sidecar listing's `context_length` (aliases `context_window`/`contextWindow`), `max_input_tokens` and `max_output_tokens` — `ocpaid` 64 of 86 models report them, `ocfree` 9 of 10 (the one without is `jev-1.13-free`, judgment-only), `mscopilot` reports **none** (`id`/`owned_by` only); (2) OpenRouter's listing `context_length` via the alias match (§5.2); (3) the Go page tiers (§6.3). **Usable input window = `min(context_length − reserve, max_input_tokens)` when `max_input_tokens` is present** — it is often smaller than the context window (21 of the 22 `ocpaid` models that report it: e.g. `gpt-5` 400k context but 272k max input; `space-bunny-free` 1,048,576 context, 524,288 max input), so fitting against `context_length` alone would dispatch turns the model rejects. **Known gaps (22 `ocpaid` models report no window):** `deepseek-v4.1-flash`, `qwen3.8-flash`, `qwen3.8-max`, `gpt-6-sol`/`gpt-6.1-sol`/`gpt-6-luna`, `grok-4.7`, `mistral-large-4`, `gemini-4-argon`, the `claude-*` entries, and the free previews (`cat-jam`, `mimo-v2.6-flash-free`, `step-5-preview-free`, `longcat-2.5-preview-free`, `ling-3.1-flash-free`, `space-bunny-free` on the paid side) — these must be filled from source (2)/(3) at `index build`, and a member still unknown after that stays at the 32k floor and is listed in `index show` as `window: unknown` so the owner can pin it by hand (`index alias`-style override). `mscopilot` stays at the 32k floor until the owner supplies its real limit. OmniRoute's own `/v1/models` does **not** list custom-node models (`ocpaid/*`, `ocfree/*`, `mscopilot/*` absent) but does list built-in `openrouter/*` with `context_length`/`max_input_tokens`/`max_output_tokens` — so sidecar windows must be read from the sidecars directly in `pool sync` (§6.5), as already specified.
- **Window fill-in for the 22 unreported `ocpaid` models (OpenRouter listing, 462 models, fetched 2026-10-14; the index builder reproduces this by the §5.4 precedence, this table is the expected result and the seed for hand overrides).** Match = §5.2 normalised tail, ignoring `:batch`/`:free` suffixes.
  | `ocpaid` id | window | source |
  |---|---|---|
  | `opencode/claude-haiku-5-5`, `-opus-5-5`, `-sonnet-5-5` | 1,000,000 (out 128k) | OpenRouter `anthropic/claude-*-5.5` exact (chat route blocks them anyway — `ModelProtocolUnsupported`) |
  | `opencode/deepseek-v4.1-flash` | 1,048,576 (out 943,718) | `deepseek/deepseek-v4.1-flash` exact |
  | `opencode/gemini-4-argon` | 1,048,576 (out 65,536) | `google/gemini-4-argon` exact (also protocol-blocked) |
  | `opencode/gpt-6-sol`, `gpt-6.1-sol`, `gpt-6-luna` | 1,050,000 (out 128k) | `openai/gpt-6*` exact |
  | `opencode/grok-4.7` | 500,000 (out 450k) | `x-ai/grok-4.7` exact |
  | `opencode/qwen3.8-flash` | 1,000,000 (out 131,072) | `qwen/qwen3.8-flash` exact |
  | `opencode/qwen3.8-max` | 1,000,000 (out 131,072) | `qwen/qwen3.8-max-0902` (dated row, newest per D11); **OpenRouter page confirms the vendor window: 1M context, text+image+video in** (browser-read 2026-10-14). Not confirmed as the Go-served window; the Go page lists Qwen3.8 Max at one flat price with no `>` tier (unlike Qwen3.7 Plus ≤/>256K), consistent with whole-window serving but not proof |
  | `opencode/mistral-large-4` | 1,048,576 (out 262,144) | `mistralai/mistral-large-4-0`; **OpenRouter page confirms 1M context with up to 256K output** (browser-read 2026-10-14; the older `mistralai/mistral-large` at 128k is a different model, so the loose match is right). **Mistral Large 4 is not on the Go page at all** (no price or quota row in §6.3): it has no Go burn/quota-ledger entry, so it is priced from OpenRouter's list price (promo shown 2026-10-14: $0.68/$2.09 per M at 50 % off, list $1.36/$4.18 — use list) and is not Go-paced |
  | `opencode/ling-3.1-flash-free` | 262,144 | **ocfree listing** (same id) |
  | `opencode/cat-jam-free` | 262,144 | ocfree listing |
  | `opencode/mimo-v2.6-flash-free` | **200,000** | ocfree listing (OpenRouter's paid `xiaomi/mimo-v2.6-flash` says 1,050,000 — the free variant is smaller) |
  | `opencode/step-5-preview-free` | 1,000,000 (input 1,000,000) | ocfree listing |
  | `opencode/longcat-2.5-preview-free` | 1,000,000 | ocfree listing |
  | `opencode/space-bunny-free` | 1,048,576 (**input 524,288**) | ocfree listing |
  | `opencode/test`, `opencode/jev-1.13[-free]`, `opencode/claude-opus-5-5-backup` | unknown | no match anywhere (the Jev ids are judgment-only; `-backup` is not assumed equal to `claude-opus-5-5`) — stay at the 32k floor or are out of the pools |

  Rules this table implies: (1) a **sidecar's own listing beats OpenRouter** for the same id (the free variants are smaller than their paid namesakes); (2) OpenRouter windows are **upper bounds** for Go-served models — Go's page prices by tier (Grok ≤/>200k, Luna ≤/>272k, Haiku ≤/>100k, §6.3) and the sidecar already shows serving limits below the vendor window (`gpt-5` 400k context / 272k input), so a Go-served window taken from OpenRouter must be confirmed by one over-length probe in P2 (send an input just over the suspected limit; a size rejection pins the real `max_input_tokens`) before the router trusts the full 1M; (3) a loose match must be confirmed against the model's own page before use — done 2026-10-14 for `qwen3.8-max` and `mistral-large-4` (both vendor-confirmed 1M); a cheap `max_tokens` validation probe is useless here (both models accepted `max_tokens: 5,000,000` on a tiny prompt, so the sidecar/provider does not validate it) and a true over-length probe is billed if accepted (~$2 visible, ~$8 quota for 1M on Qwen3.8 Max), so the Go-served-window probe stays a deliberate P2 spend, not a default.
 Estimated size = total `messages` text chars ÷ 4 (tokenizer margin per brief 47; use ÷ 2 for the non-ASCII share, since CJK/emoji run near 1 token per char and ÷ 4 would underestimate), using the full Warslop message list (`context.chars`), not the 1200-char Jev excerpt. Image parts (base64 `data:` URIs) are excluded from the char count and charged a fixed per-image token allowance instead, so one photo cannot fake `context_too_long`. A turn that fits no pool member ends `context_too_long` (§8.2), never as a switch.
- **Tool and vision flags for sidecar models (the sidecar listings carry none; researched 2026-10-14 over the 84 chat ids of `ocpaid`/`ocfree`, then re-checked by recomputation from the OpenRouter listing).** Source states stored in `caps_json.caps_source`: `or_exact` (exact normalised OpenRouter match: `tools` ∈ `supported_parameters`, `image` ∈ `architecture.input_modalities`) → trusted; `vendor` (a vendor/provider doc URL) → trusted; `or_family` (OpenRouter row of the same family reached through a loose match: the sidecar's `-free` suffix, a `-preview`/dated snapshot, a `-0` suffix) → used, but flagged in `index show` and confirmed in P2 by one tiny tool-call request and one tiny image request per model; `aggregator` (third-party directory only) → **not trusted**, stored as `null`; `unknown` → `null`. A `null` flag means ineligible for requests that need it (§5.4 tools rule, vision rule).
  - **Result:** 65 of 84 are `or_exact` (all 65 tools=true; vision true 57, false 8: `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5`, `glm-5.1`, `glm-5.2`, `glm-5.3`, `minimax-m2.5`, `minimax-m2.7`); 12 are loose `or_family` (the `-free` variants of `ling-3.1-flash`, `mimo-v2.6-flash`, `muse-spark-1.2/1.3-contributor`, `nemotron-3.5-lightning`, `step-5-preview`; `gemini-3-flash`/`gemini-3.1-pro` ↔ their `-preview` rows; `mistral-large-4` ↔ `…-4-0` and `qwen3.8-max` ↔ `…-0902`, both page-confirmed; `qwen3.5-plus` ↔ the dated `-20260420` row); the rest are web-only. **Tools are supported by essentially every chat model (82 of 84 reported true)**, so the §5.4 tools rule costs almost nothing once the flag is populated; vision is the real discriminator (70 true, 11 false).
  - **Rejected during review (stored as `null`, not trusted):** `claude-opus-5-5-backup` (was mapped to `claude-opus-5.5` by assumption — identity is unproven); `space-bunny-free` vision (sources conflict: one catalog says image, another says not listed; tools rests on a single catalog); `big-pickle` (an aggregator page only); `gpt-5.3-codex-spark` (aggregator-backed tools); `cat-jam-free` and `test` (nothing found). `gpt-5-codex` is accepted (OpenAI model page, `developers.openai.com/api/docs/models/gpt-5-codex`); `longcat-2.5-preview-free` is accepted at `vendor` level only for vision (opencode.ai compare data), tools stays `or_family`-grade until probed.
  - **Method caveat:** the research agent's web-search quota ran out partway, so web-only rows are thin and are re-probed in P2; a `-free` variant can differ from its paid namesake (the context window already does for `mimo-v2.6-flash-free`, 200k vs 1.05M), so `or_family` is a starting point, not a verdict.
- price guardrail (warslop $5 in / $20 out, exact integer compare, ceiling rounding so truncation never admits): paid offers above it are out; `:free`/zero-burn offers bypass it. Not expiring within 14 days (`expiration_date` only; unreadable or missing date on a source that documents expiry = out, conservative per NOTES-62; sources with no expiry concept = not expiring).
- no `:batch` variants.
- **Headroom** (D6): Go quota is normalized — `quota_spent = visible_cost × (60 / monthly_limit)` per the community-derived accounting (`anomalyco/opencode` issue #41391 — not `sst/opencode`: `Usage` = the monthly-limit column, so $15 → 4×, $30 → 2×, $60 → 1×, $80 → 0.75×; verified 2026-10-13 via webfetch — the Go docs page itself states only the 20/50/100 % windows, not the formula; the `round(cost × multiplier)` backend-recording detail is a single comment in that thread (PARTIAL/unverified), so the ledger rounds half-up and treats the result as an estimate). Ledger stores both `spent_visible_micros` and `spent_quota_micros` in `quota_events`; gates use quota units: `headroom_turns = (limit_micros - spent_quota_micros) / burn_quota_micros` (for a turn larger than the typical one, `burn` is recomputed from the estimated input size — a 300k-token turn must not pass a gate sized for 2,500 tokens, and the tier row (>256k etc.) is picked by that size) where `burn_quota = burn_visible × (60 / monthly_limit)`. Caveat, same issue: per-model dashboards have disagreed with the formula (Luna window implying 2× against a $15 row; Muse Spark rows implying ~1.52× on a $60 row — window-alignment and historical multipliers suspected). The ledger is an estimate; refusal is truth. Skip a Go model when `headroom_turns < 10` or `spent_quota_month >= 80 %` of its monthly limit; deprioritise (move to end of role ranking, still eligible) when the current 5h bucket's remaining < 3 typical turns. Weekly bucket is tracked for `/admin/pools` display only in v1 (no gate). OpenRouter paid: same 80 % rule against `OPENROUTER_MONTHLY_CAP_USD` (no multiplier — OpenRouter bills raw cost). Thresholds are env config (`JEVR_HEADROOM_MONTH_TURNS=10`, `JEVR_HEADROOM_MONTH_PCT=80`, `JEVR_HEADROOM_5H_TURNS=3`). The ledger is an estimate; refusal is truth.
- Chat-model health is OmniRoute's job, **after B5 is resolved** (§12): account/connection rotation, connection cooldowns, circuit breakers and model lockouts all live there, and an error returned by OmniRoute means every account for that model is already exhausted. jev-router keeps **no persisted chat cooldown**: within one request it tracks a tried-list and skips a model until the `Retry-After` OmniRoute returned (`429 model_cooldown`/`Retry-After`), skips every model of a provider on `503 provider_circuit_open`, and applies the quota-refusal rule on `402`; it never re-sends to a model that already errored in this request, and never sends `x-omniroute-connection` (that would disable OmniRoute's account rotation).
- Health of Jev's own endpoints (OmniRoute does not front them): a `jev:<source>` with 3 consecutive failures goes on **cooldown** (10 min × 2^(fails-3), cap 6 h; success resets `fails=0`; `until = now + backoff`) and is skipped while `now < until`. This persisted backoff exists only for the `jev:` keyspace. `ModelProtocolUnsupported` is not a cooldown: it is a persistent denylist until the next `pool sync` re-probe passes (`denylist(omniroute_id, reason, since)`).

### 5.5 Storage schema (SQLite, `/app/data/jev-router.db` on the compose `./data` volume)

```sql
-- WAL mode, busy_timeout 5000, 0600 files. fetched_at/millis ISO-8601 UTC (ms precision so two stores in one second cannot collide).
CREATE TABLE fetch_snapshots(source TEXT, fetched_at TEXT, body_hash TEXT, body TEXT,
                             PRIMARY KEY (source, fetched_at));
CREATE TABLE fetch_budget(source TEXT, window_kind TEXT, window_start TEXT, used INTEGER,
                          PRIMARY KEY (source, window_kind, window_start)); -- kind: hour|day; hour key YYYY-MM-DDTHH, day key YYYY-MM-DD
CREATE TABLE rate_limit_state(source TEXT, window_start TEXT, lim INTEGER, remaining INTEGER, reset_at TEXT,
                              PRIMARY KEY (source, window_start));
CREATE TABLE fetch_lock(id INTEGER PRIMARY KEY CHECK (id = 1), owner_pid INTEGER, started_at TEXT);
CREATE TABLE alerts(source TEXT, kind TEXT, first_seen TEXT, last_seen TEXT,
                    PRIMARY KEY (source, kind)); -- kind: staleness_48h|pages_grew|quota_near …

CREATE TABLE index_versions(version INTEGER PRIMARY KEY, built_at TEXT, sources_json TEXT,
                            status TEXT NOT NULL DEFAULT 'current');      -- exactly one 'current' (code invariant, doc-constants test); rest 'superseded'
CREATE TABLE model_index(version INTEGER, canonical_id TEXT, omniroute_id TEXT, tier TEXT NOT NULL DEFAULT '', source TEXT,
                         quality_json TEXT, price_json TEXT, caps_json TEXT, quota_json TEXT,
                         PRIMARY KEY (version, omniroute_id, tier)); -- tier = '' or the context split (e.g. 'le256k'|'gt256k'); tiers share one omniroute_id, so it cannot be the key alone
CREATE INDEX idx_model_index_version_canonical ON model_index(version, canonical_id);
CREATE TABLE model_alias(canonical_id TEXT PRIMARY KEY, aliases_json TEXT);
-- price_json: {in_per_m_tok_usd_nano, out_per_m_tok_usd_nano, cached_per_m_tok_usd_nano, burn_offpeak_micros, burn_peak_micros} -- cache-write prices exist on the Go page (MiniMax M2.7, Qwen3.8 Max/Flash, Qwen3.7 Plus, GPT Luna pair, Haiku 5.5) but are stored nowhere in v1 (burn is cold, cache ignored; P6 may use them); tiered (>256k/>200k/>272k/>100k) rows are separate model_index rows per tier (distinguished by `model_index.tier`; the dispatcher picks the tier from the estimated context size)
-- caps_json: {context_window, supports_tools BOOLEAN|null, supports_vision BOOLEAN|null, max_completion_tokens, reasoning_efforts[], expiration_date}  -- from `expiration_date` (internal name `expiration_date`, not vendor `expires_at`)
-- quality_json: {role: {quality INT, unknown BOOLEAN}…, quality_unknown BOOLEAN}
-- quota_json: {monthly_limit_usd, quota_multiplier: 60/monthly_limit (Go only, verified 2026-10-13), headroom_turns, window_5h_limit_usd, weekly_limit_usd}

CREATE TABLE routing_decisions(id TEXT PRIMARY KEY, at TEXT, request_hash TEXT, pool TEXT,
                               canonical_id TEXT, omniroute_id TEXT, jev_json TEXT, guard TEXT,
                               hops_json TEXT, latency_ms INTEGER, outcome TEXT, usage_json TEXT,
                               index_version INTEGER, jev_source TEXT, shortlist_hash TEXT);
CREATE INDEX idx_decisions_at_pool ON routing_decisions(at, pool);
-- jev_json: {answering_source, latency_ms, cost_micros|null, task, effort, high_consequence, stakes_domain, model_probs{}}
-- request_hash = SHA-256(ask_excerpt + pool + index_version + shortlist_hash); no prompt text ever stored. Retention: 90 days (nightly delete).
CREATE TABLE cooldowns(key TEXT PRIMARY KEY, fails INTEGER, until TEXT); -- key jev:<source> only (chat health lives in OmniRoute, §5.4)
CREATE TABLE denylist(omniroute_id TEXT PRIMARY KEY, reason TEXT, since TEXT); -- ModelProtocolUnsupported until pool sync passes
CREATE TABLE quota_events(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, omniroute_id TEXT, spent_visible_micros INTEGER, spent_quota_micros INTEGER, tokens_in INTEGER, tokens_out INTEGER, cached_tokens INTEGER);
CREATE INDEX idx_quota_events_id_time ON quota_events(omniroute_id, at); -- rolling 5h/week/month sums via range query; fixed buckets removed (rolling provider windows cannot use fixed PK buckets). Events are the ledger truth; refusal stays the source of truth.
CREATE TABLE quota_usage(omniroute_id TEXT, window_kind TEXT, window_start TEXT, spent_quota_micros INTEGER,
                         PRIMARY KEY (omniroute_id, window_kind, window_start));  -- materialized compat view in quota units, rebuilt from quota_events by the ops loop (never written by the request path); kind: 5h|week|month. `/admin/pools` may read either; gates read the rolling sums, not this table, so drift here never blocks routing.
```

### 5.6 Adding a new model without a refetch

The user-facing requirement: adding a model must not force a full provider fetch.

```
jev-router index add <omniroute_id>     # e.g. opencode/deepseek-v4.1-flash
  → reads the stored snapshots (no network): `openrouter_models`, `openrouter_benchmarks`, `aa_language_free` (the `:free` cap endpoint is not a snapshot)
  → matches + scores against them, writes a **new index version** (copy current + one row; never mutates a released version)
  → only if the model matches nothing in any snapshot (including no listing row for pricing/caps): prints exactly which source is missing and
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
| opencode Go via `ocpaid` (OmniRoute id `opencode/<id>`) | The 35 Go-catalog models that answered the last sweep (2026-10-10) — e.g. `deepseek-v4.1-flash`, `deepseek-v4-pro`, `glm-5.3-flash`, `glm-5.3`, `glm-5.2`, `gpt-6-luna`, `gpt-5.6-luna`, `minimax-m3`, `minimax-m2.7`, `qwen3.8-flash`, `kimi-k2.6`, `mimo-v2.6-flash/pro`, plus the free-preview pair `longcat-2.5-preview-free` / `step-5-preview-free` (unlimited, burn 0, valid fallback members but never Jev-shortlisted per §5.2 step 5). Sweep exclusions are point-in-time (that sweep 410'd `kimi-k2.5/k2.6/k2.7-code`, `deepseek-v4-flash`/`-vision-exp`, `exo-free`, `ling-3.0-flash-fin-free` while the Go page still lists them priced — monthly re-sweep re-probes; pool sync is truth). The Go `muse-spark` family is an ordinary paid member (no training exclusion). Claude/Gemini families are blocked on the chat route (`ModelProtocolUnsupported` → `denylist`, not cooldown); the full liveness sweep is re-run monthly, membership diff is daily (`pool sync`) |
| OpenRouter paid via a new `openrouter` provider (OmniRoute id shape verified in P2 — expected `openrouter/<author>/<slug>` but the `ocpaid` precedent (`opencode/<id>` without provider prefix) means the real shape must be probed; spec accepts either once pinned) | The eligible set filtered by the $5 in / $20 out guardrail; `google/gemma-4-31b-it` + `deepseek/deepseek-v4-pro` are examples from the fixture world (NOTES-62 worked example), not a pinned member list — `pool sync` is the source of truth | Uses `OPENROUTER_MONTHLY_CAP_USD` as the cap (config §9.4); `:free` variants belong to the free pool |

**Hard rule (owner, 2026-10-14): the OpenCode Zen credit balance is empty, so jev-router never routes to a model that would need credit — i.e. one that is neither covered by the Go subscription nor free.** `ocpaid` is the Go subscription ($10/month plan, §6.3); anything outside the Go catalog would bill Zen credits that do not exist, so it can only fail. **Allowed ids = the sidecar's `/v1/models` ∩ (the Go page's "Endpoints → Model ID" table ∪ the ids Zen prices as `Free`)** — free models cost no credit, so they stay usable whatever the balance; the paid pool takes the Go-catalog part (below), the free pool takes the Free part (list after). **Paid-pool membership** (`https://opencode.ai/v2/docs/console/go/`, matched on the bare id after `opencode/`), recomputed by every `pool sync`. As of 2026-10-14 that is 21 ids: `grok-4.7`, `grok-4.6`, `gpt-6-luna`, `gpt-5.6-luna`, `claude-haiku-5-5`, `glm-5.3-flash`, `glm-5.3`, `glm-5.2`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, `deepseek-v4.1-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `minimax-m3`, `minimax-m2.7`, `qwen3.8-max`, `qwen3.8-flash`, and the unlimited free previews `longcat-2.5-preview-free`, `step-5-preview-free`, `cat-jam-free`. The other ~64 sidecar ids (`gpt-5*`, `gpt-6-sol`/`-astra`, `claude-*` except Haiku 5.5, `gemini-*`, `glm-5/5.1`, `kimi-k2.5`, `minimax-m2.5`, `qwen3.5/3.6-plus`, `mistral-large-4`, `muse-spark-1.2/1.3`, `grok-4.5`, …) are **out of every pool**, with reason `not_in_go_catalog` in `index show`; there is **no opt-in flag** (`JEVR_ALLOW_ZEN_PAYG`/`JEVR_ZEN_MONTHLY_CAP_USD` from v1.18–1.20 are deleted). Go-catalog rows the sidecar does not list (`mimo-v2.6-flash/-pro`, `mimo-v2.5(-pro)`, `qwen3.7-plus`, `hy3`, `hy4-preview`, `longcat-2.0`, `deepseek-v4-flash-vision-exp`, `space-bunny`, the `muse-spark-*-contributor` rows) are simply not routable until the sidecar lists them. `claude-haiku-5-5`, `gpt-6-luna`, `gpt-5.6-luna`, `grok-*` use `/v1/responses` or `/v1/messages` (§6.3 endpoint table), so on the chat route they are expected to land in the `denylist` (`ModelProtocolUnsupported`) at the first probe — membership by the Go catalog is necessary, not sufficient. **Free ids (zero credit, checked 2026-10-14 against the Zen table's `Free` rows, the sidecar listings and live probes):** Zen lists 13 free chat ids — `big-pickle`, `cat-jam-free`, `exo-free`, `ling-3.0-flash-fin-free`, `ling-3.1-flash-free`, `longcat-2.5-preview-free`, `mimo-v2.5-free`, `mimo-v2.6-flash-free`, `muse-spark-1.3-contributor-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `space-bunny-free`, `step-5-preview-free` (plus `jev-1.13` judgment-only). Served today: the 8 listed by `ocfree` (`cat-jam`, `ling-3.1-flash`, `longcat-2.5-preview`, `mimo-v2.6-flash`, `muse-spark-1.3-contributor`, `nemotron-3.5-lightning`, `space-bunny`, `step-5-preview`, all `-free`), `muse-spark-1.2-contributor-free` (listed by `ocfree`, not in the Zen table) and **`ocpaid/opencode/big-pickle`** (free "for a limited time", answered `pong` 2026-10-14 — it belongs in the free pool). Not served: `mimo-v2.5-free` (live `410 deprecated, use mimo-v2.6-flash-free`), `exo-free`, `ling-3.0-flash-fin-free` (the earlier sweep also saw 410), `nemotron-3-ultra-free` (in neither sidecar listing; not independently probed — see the cooldown warning in §6.5). **Pricing authority is the Go page only** (first table, §6.3); the Zen table and OpenRouter prices are never used to price a pool member. Go's "Use balance" option (fall back to pay-as-you-go credit after the limits) is moot with an empty balance — a Go-limit hit is a real refusal the router can hop on; keep the balance at zero or the toggle off so that stays true.
**Price-research audit (2026-10-14, historical: the research covered non-Go ids that are now out of scope, kept as the reason no agent-built price table is trusted):** of 53 priced ids, 41 matched Zen on input/output; **12 did not because the researcher used OpenRouter as primary** — `gemini-3.6/3.7/3.8-flash` (OpenRouter $0.75/$3.75 vs Zen $1.50/$7.50, a 2x undercount), `gpt-5.6-sol` ($2/$10 vs $4/$20, 2x), `glm-5`, `glm-5.1`, `gpt-5`, `gpt-5.1`, `gpt-5.1-codex`, `kimi-k2.5`, `minimax-m2.5`, `qwen3.6-plus`; plus cached-read mismatches on `gpt-5.1-codex-mini`, `gpt-6.1-sol`, `claude-sonnet-5-5`. Its Zen-sourced rows (`gpt-5-codex`, `gpt-5.3-codex-spark`, `qwen3.5-plus`, `mistral-large-4`, `gemini-3-flash`, `gemini-3.1-pro`, `big-pickle`) and `gpt-6-astra` ($10/$50/$1.00) were correct; `claude-opus-5-5-backup` has no price anywhere. It also stored only the low tier for tiered ids: Zen, like Go, has higher tiers above 100k/200k/272k (e.g. `gpt-6-astra` >272K $20/$75/$2.00, `gpt-6-sol` >272K $4/$15), so the §5.5 tier rule applies to Zen rows too. Consequence: no research-agent price table goes into the spec or the index; the builder parses the Zen table (`https://opencode.ai/docs/zen`, "Pricing" section) directly and the doc-constants test pins its `source_date`.
**Member-list correction:** the sidecar listing has **no** `mimo-v2.6-flash` (paid), `mimo-v2.6-pro`, `mimo-v2.5(-pro)`, `qwen3.7-plus`, `deepseek-v4-flash-vision-exp`, `hy3` or `longcat-2.0` — the §6.1 list above that names `mimo-v2.6-flash/pro` is stale; membership comes from `pool sync`, and Go-catalog rows with no listed id are simply absent from the paid pool.

### 6.2 Free pool (`free` requests, and the paid fallback)

| Source | Members | Notes |
|---|---|---|
| Zen free via `ocfree` | 9 models as of 2026-10-12 (verified list in §2 incl. `muse-spark-*-free` — ordinary members; pool sync is source of truth, drift expected); `jev-1.13-free` is judgment-only and never a chat candidate | No key, anonymous free tier; WARP-pooled |
| mscopilot (BizChat) | `mscopilot/default`, `mscopilot/reasoning` | Counted free by the owner. **Currently down (dead refresh token)** — the cooldown/health mechanism excludes it automatically; repair path documented in dev-secrets. Probes use one tiny completion; note the bridge keeps one shared server-side conversation for all callers, so probes pollute that thread — keep probes minimal and document the thread reset (`MS_Q_ConversationId`) in the sync report |
| OpenRouter `:free` | the `:free` variants at sync time (15 on 2026-10-12; count drifts — pool sync is truth); indexed ones enter the shortlist | 20 req/min always; 50/day (<10 credits all-time) or 1000/day (≥10, granted from 9 — OpenRouter limits docs, verified 2026-10-13 via live refetch; `is_free_tier` is independent of the credit-count tier); negative balance 402-blocks even free; `GET /api/v1/key → free_model_daily_requests` reports the daily counter only (per-minute not reported; exempt/BYOK accounts report the tier policy, not an enforced ceiling). P2 verifies this account's own credit status and `remaining`. Ops job watches `remaining` every 10 min, stops at 20 % reserve, plus the request-path 20/min bucket (§5.1); honor `Retry-After` on 429; mid-stream 429s arrive as SSE `finish_reason: "error"` events, not HTTP 429s |

### 6.3 Go-plan quota table (source: Go docs page, source_date 2026-10-13; re-read 2026-10-14)

**Plan: Go at $10/month — owner-confirmed 2026-10-14; Go Plus is NOT used.** The Go page prints two near-identical tables back to back: the **first** is Go ($10), the **second** is Go Plus with 3–4x larger monthly limits for the same prices (e.g. Qwen3.8 Max $15 vs $60, GLM-5.3 $15 vs $120, MiniMax M2.7 $60 vs $240). Token prices are identical in both; only the "Monthly limit" column differs, and it drives every headroom number (§5.4, the `60 / monthly_limit` multiplier). The `src/go_catalog.rs` parser must take the table that follows "Go Go Plus Model Input Output Cached Read Cached Write Monthly limit" up to the repeated header, never the second block, and the doc-constants test pins that the parsed first-table limits equal the values below. Re-verified 2026-10-14: every monthly limit in the table below equals the page's first table.


Each model's monthly limit below is also its 5-hour (20 %) and weekly (50 %) allowance. Token prices are
per 1M tokens; the router's burn estimate uses these prices (input/output/cached-read; cache-write is
absent for most).

| Model (Go $10 plan, source_date 2026-10-13 — Go Plus limits differ, this service paces Go) | In $ | Out $ | Cached $ | Monthly $ |
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
| Cat Jam Free | 0 | 0 | 0 | unlimited (limited time) |
| MiMo-V2.6-Flash | 0.14 | 0.28 | 0.0028 | 60 |
| MiMo-V2.6-Pro | 0.435 | 0.87 | 0.003625 | 15 |
| MiMo-V2.5 | 0.14 | 0.28 | 0.0028 | 60 |
| MiMo-V2.5-Pro | 0.435 | 0.87 | 0.003625 | 15 |
| MiniMax M3 | 0.30 | 1.20 | 0.06 | 60 |
| MiniMax M2.7 | 0.30 | 1.20 | 0.06 (+write 0.375) | 60 |
| Muse Spark 1.3 / 1.2 Contributor | 0.10 | 0.20 | 0.002 | 60 |
| Qwen3.8 Max | 2.00 | 6.00 | 0.25 | 15 |
| Qwen3.8 Flash | 0.15 | 0.47 | 0.016 | 30 |
| Qwen3.7 Plus (≤256k) | 0.40 | 1.60 | 0.04 | 60 |
| Qwen3.7 Plus (>256k) | 1.20 | 4.80 | 0.12 | 60 |
| DeepSeek V4.1 Flash — off-peak / peak | 0.15 / 0.30 | 0.60 / 1.20 | 0.003 / 0.006 | 80 |
| DeepSeek V4 Pro — off-peak / peak | 0.66 / 1.32 | 1.98 / 3.96 | 0.022 / 0.044 | 15 |
| DeepSeek V4 Flash — off-peak / peak | 0.15 / 0.30 | 0.60 / 1.20 | 0.003 / 0.006 | 30 |
| DeepSeek V4 Flash Vision Exp — off-peak / peak | 0.15 / 0.30 | 0.60 / 1.20 | 0.003 / 0.006 | 15 |
| Hy4 preview | 0.834 | 2.501 | 0.042 | 30 |
| Hy3 | 0.14 | 0.58 | 0.035 | 60 |
| Space Bunny | 0.15 | 0.60 | 0.03 | 30 |
| Grok 4.7 / 4.6 (≤200k) | 2.00 | 6.00 | 0.50 | 15 |
| GPT 6 Luna (≤272k) | 0.10 | 0.50 | 0.01 | 15 |
| GPT 5.6 Luna (≤272k) | 0.20 | 1.20 | 0.02 | 15 |
| Claude Haiku 5.5 (≤100k) | 0.10 | 0.50 | 0.01 | 15 |

Peak hours (DeepSeek V4.1 Flash / V4 Pro / V4 Flash / Vision Exp): Mon–Fri 01:00–04:00 and 06:00–10:00 UTC; all other hours and weekends are
off-peak (live Go page refetched 2026-10-13: `browser-harness new_tab https://opencode.ai/docs/go` lands on `/v2/docs/console/go/`; webfetch returns identical markdown for both URLs. Docs endpoint base shows `https://opencode.ai/inference/go/v1/...` while live-tested clients use `https://opencode.ai/zen/go/v1/...` — treat the Zen-tested base as truth for sidecars until P2 re-pins). The full table below is transcribed from that page (Go $10 plan; Go Plus differs — this service paces Go only); `src/go_catalog.rs` stamps `source_date: 2026-10-13` at implementation time. Tiered rows split by context: Qwen3.8 Max $2.00/$6.00/0.25+write 2.50 $15 (no split); Qwen3.8 Flash $0.15/$0.47/0.016+0.20 $30; Qwen3.7 Plus ≤256k $0.40/$1.60/0.04+0.50 $60, >256k $1.20/$4.80/0.12+1.50 $60; Grok ≤200k $2.00/$6.00/0.50 $15, >200k $4.00/$12.00/1.00 $15; GPT 6 Luna ≤272k $0.10/$0.50/0.01+0.125 $15, >272k $0.20/$0.75/0.02+0.25 $15; GPT 5.6 Luna ≤272k $0.20/$1.20/0.02+0.25 $15, >272k $0.40/$1.80/0.04+0.50 $15; Haiku ≤100k $0.10/$0.50/0.01+0.125 $15, >100k $0.50/$2.50/0.05+0.625 $15. Parenthesised caps (`≤200k`, `≤272k`, `≤100k`, `≤256k`) are context windows and belong in `caps_json`, not in prices. Endpoint protocol (same page, endpoints table; live base `https://opencode.ai/inference/go/v1/...` — the `zen/go` base is sidecar-local, treat the Zen-tested base as truth for sidecars until P2 re-pins): Grok/GPT-Luna/Muse-Spark via `/v1/responses`, Claude-Haiku/MiniMax/Qwen via `/v1/messages` (Anthropic), rest via `/v1/chat/completions` — hence `ModelProtocolUnsupported` for wrong-wire models on the chat route is expected, not a bug (the string itself appears nowhere on the Go page; attribution is the oc-free findings sweep — all 22 `claude-*`/`gemini-*` blocked this way — plus code history showing the same string as 400 today and 401 on older paths — match case-insensitively, never by status alone). Go data-use terms are not a routing input. DeepSeek rows carry a ZDR agreement renewed monthly (current one valid through 2026-10-31 — re-check in `pool sync`). Client rule (same page): send a stable `x-opencode-session` per conversation for routing/cache; Go falls back to free models at the limit ("If you reach the usage limit, you can continue using the free models" — the provider-side analogue of D1; jev-router still implements the paid→free spill itself). Go's request-count estimates assume heavy cache reuse (per-request token table on the same page: 390–1100 input, 32,500–88,900 cached, 120–310 output per req depending on model — our cold burn (§5.3) deliberately undercounts turns vs Go's dashboard, never overcounts).

The quota ledger (`quota_events` + `quota_usage` view) is our estimate from response `usage` blocks × these prices; where `usage` is absent (mscopilot/BizChat today) the turn is logged with `usage_json=null` and contributes 0 to the ledger (never estimated from chars — pacing only, refusal is truth). The 5h/week/month windows are rolling where the provider's are, computed as rolling sums over `quota_events` — the ledger exists only to avoid *obviously* draining a model.

### 6.4 OmniRoute wiring changes (v1)

1. **Register the four upstreams as real OmniRoute providers** (replaces the self-hosted `providers.yaml` route; B5/B2). Source-verified at v3.8.51 (`src/app/api/provider-nodes/route.ts`, `…/urlGuard.ts`, `src/shared/network/outboundUrlGuardPolicy.ts`); exact bodies are pinned live in P2:
   - **Provider nodes** via `POST /api/provider-nodes` (manage scope): `{type: "openai-compatible", name, prefix, baseUrl, apiType: "chat", chatPath?, modelsPath?}` — `prefix` becomes the model-id prefix (`<prefix>/<model>`), so use `ocpaid`, `ocfree`, `mscopilot`, `openrouter` as prefixes. `baseUrl`: `ocpaid` → `http://127.0.0.1:4097/v1`, `ocfree` → `http://OCFREE_HOST:4097/v1`, `mscopilot` → `http://127.0.0.1:8780/v1`, `openrouter` → `https://openrouter.ai/api/v1` (check each sidecar's real path root; `chatPath`/`modelsPath` overrides exist if it is not `/v1`).
   - **Private/LAN base URLs:** OmniRoute's outbound guard allows local/private provider URLs by default (`OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS` defaults ON; `OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS`/the dashboard toggle widen it) while cloud-metadata hosts stay blocked — confirm a 127.0.0.1 and a 10.10.x.x node validate (a 400 `baseUrl` error means flip the flag, never disable the SSRF guard wholesale).
   - **Connections** (the unit of account rotation): one connection per key/account under each node (`POST /api/providers` — body shape pinned in P2; `ocpaid` with `OCPAID_API_KEY`, `openrouter` with `OPENROUTER_API_KEY`, `ocfree`/`mscopilot` keyless or dummy key). Add every extra account the owner has as a further connection of the same node — that is what makes OmniRoute rotate accounts before jev-router ever sees a failure. Native built-ins (`opencode-go`/`opencode-zen`) are the alternative for Go if its account-level quota fetcher is wanted (§12 quota note); the choice changes the dispatch id prefix (`opencode-go/…` vs `ocpaid/…`) and must be made once in P2, then frozen in `model_index.omniroute_id`.
   - **Retire the divert:** remove `OMNIROUTE_SELF_HOSTED_PROVIDERS_FILE` (and the `providers.yaml` mount) from `~/Containers/omniroute/docker-compose.yml`, `docker compose up -d`, and delete the `free`/`paid` single-member combos' reliance on it. Verify per B5 closing criteria.
   - **Record** the real id shape per provider (`<prefix>/<model>`; for OpenRouter `openrouter/<author>/<slug>` vs bare) and that `jev-1.13-free`-style judgment-only ids stay out of chat pools.
   - **Executed 2026-10-14 (results, §6.4 is now partly measured, not proposed).** Compose edited (divert env var + `providers.yaml` mount removed, `OMNIROUTE_EMERGENCY_FALLBACK=false` added; backups `docker-compose.yml.bak-before-b5`, `config/providers.yaml.bak-before-b5`); container healthy in ~50 s.
     - Bodies that worked: node `POST /api/provider-nodes` `{"type":"openai-compatible","name":N,"prefix":N,"baseUrl":U,"apiType":"chat"}` (201); connection `POST /api/providers` `{"provider":<node id or built-in id>,"name":N,"apiKey":K}` (201, created **inactive**; `POST /api/providers/<id>/test` activates it). `ocfree`/`mscopilot` use a dummy key `none`.
     - **`openrouter` is a reserved prefix (400)**: OpenRouter is OmniRoute's **built-in** provider — connection body `{"provider":"openrouter","name":"openrouter","apiKey":…}`; no custom node.
     - **Dispatch id shape (pinned):** `<prefix>/<upstream id>` where the sidecars' own ids already begin with `opencode/` — so `ocpaid/opencode/deepseek-v4.1-flash` and `ocfree/opencode/space-bunny-free`, and `openrouter/<author>/<slug>[:free]` (e.g. `openrouter/nvidia/nemotron-3.5-lightning:free`). Every `opencode/<id>` example elsewhere in this spec means `ocpaid/opencode/<id>` (a bare `opencode/<id>` resolves to the built-in `opencode-zen` provider, never `ocpaid`). Custom nodes expose **no** model catalog in OmniRoute's `/v1/models`, so pool membership keeps coming from the §6.5 direct sidecar listing reads, with the prefix added in code.
     - Served-provider headers on success: `x-omniroute-provider` (for custom nodes this is the **node id** `openai-compatible-chat-<uuid>`, not the prefix — keep a node-id→prefix map; built-in shows `openrouter`), `x-omniroute-model`, `x-omniroute-selected-connection-id`, `x-omniroute-decision` (`strategy=single; provider=…`), `x-omniroute-request-id`, `x-omniroute-cost`, `x-omniroute-version`. **`X-OmniRoute-Fallback-Attempts` was not present** on single-model success or on a 502 — treat it as optional.
     - Fall-through check passed: `ocpaid/does-not-exist` → `400 "Upstream request failed: Model is unavailable."` on the `ocpaid` connection, **no** fall-through to another provider.
     - Endpoints in this build: `/api/provider-metrics` and `/api/providers/quota-windows` exist; `/api/providers/metrics` and `/api/quota` are **404** (the skill pages are stale) — §12 quota wording follows.
     - **Re-probed 2026-10-14 at `max_tokens: 8192`:** `ocfree/opencode/space-bunny-free` → `200` in 1.2 s, content `pong` (so the earlier 502 "empty response" at 16 tokens was the tiny budget, not a dead model — probes must use the §6.5 budget, and an `upstream_response_error` empty-output 502 is a real-pipeline shape to expect from reasoning models on small budgets). `mscopilot/default` → `503 "refresh token rejected …"` after **31.7 s** (dead token; a dead source costs ~30 s per attempt, far over the 15 s first-byte deadline). **Revived the same day** from a fresh HAR export (new refresh token written to the bridge's `refresh.state` — which takes precedence over `.env` — and `.env`, service restarted): `mscopilot/default` → `200` in 8.7 s, `pong`, `/health` `tokenFresh:true`. Consequences: the connection `valid:true` test stays a non-signal (use a real tiny completion, §6.5); ~9 s for a trivial reply means `mscopilot` is a poor first-byte-15 s candidate — keep it last in free-pool order; the token can die again (rotation elsewhere invalidates it), so `pool sync` liveness must catch `503 refresh token rejected` and the `denylist`/`JEVR_EXCLUDED_IDS` path (`mscopilot/default,mscopilot/reasoning`) is the stop-gap; the shared-server-side-conversation caveat of §6.2 still applies.
     - **Still open:** (1) a stray `line 75` parse error when sourcing `~/.config/warslop/dev-secrets.env` (unquoted value) — quote it; (2) connections are one per node — add the owner's further accounts per provider as extra connections to get account rotation; (3) the remaining §12 OmniRoute settings are unverified.
2. **Verify field passthrough** (do this once in P2, record in notes — P2 gate, never inferred): Go's `x-opencode-session` header is the only field known to pass — OmniRoute has an OpenCode session-identity resolver (`open-sse/utils/opencodeSessionIdentity.ts` + `opencodeHeaders.ts` + `executorClientHeaders.ts`; paths verified 2026-10-13 via container docs + `opencode.ts` imports/callsite, bodies not shipped in the image so allowlist contents are unverified) and the Go page itself requires a stable `x-opencode-session` per conversation for routing/cache. There is NO `x-session-affinity` → `x-opencode-session` mapping in the 3.8.51 image (zero hits — the earlier issue-#4022 claim is struck). Session affinity (`X-Session-Id` / `x-codex-session-id` / `x-omniroute-session`, `extractSessionAffinityKey`, affinity headers never forwarded upstream) is already generalized to any provider once the TTL is set above 0 (RESILIENCE_GUIDE #7274 — the earlier "Codex-only backlog" claim is struck; corrected 2026-10-13). OpenRouter `provider` preferences (`{data_collection: "deny", require_parameters: true, max_price: {prompt: 5, completion: 20}}` — USD/M; prose examples use numbers, the OpenAPI schema types `max_price` subfields as strings — send strings, confirm numbers in the P2 probe; verified 2026-10-13 via provider-routing docs; defaults are `data_collection: "allow"`, `require_parameters: false`), top-level `session_id` / `prompt_cache_key` (chat routing keys; on the Decisions/SystemOne schema `session_id` is observability-only, never sent to the provider), and arbitrary custom headers have NO OmniRoute client→upstream forwarding feature found (operator `customHeaders`/`upstreamHeaders`/`x-omniroute-*` are operator-side, not client passthrough — container-docs verified 2026-10-13). So v1 sends `x-opencode-session` per conversation and omits `provider`/`session_id`/`prompt_cache_key` until the probe shows them passing. No direct-path build in v1 (D3): if fields do not pass, file the OmniRoute change and omit the fields until it lands.
3. **Combos are not on the request path.** jev-router dispatches explicit provider/model ids only (a combo's targets run in a stored order with no per-request override, and OmniRoute's own combo fallback + cooldown-wait would stack on ours). The existing `free`/`paid` combos stay as a manual convenience; `pool sync` no longer rewrites them (optional, off by default).
   manual/last-resort single-call path; the router's primary dispatch is the explicit per-model call.
   (Cloud `auto`/`auto/*` remain unused — they build a zero-config pool per request and never use persisted combos unless a combo is literally named `auto`, which is not recommended.)

### 6.5 Pool sync

**Never probe or dispatch an id that is not in the sidecar's current listing — one deprecated id can take a whole connection down (observed 2026-10-14, self-inflicted).** A single `410 "Model mimo-v2.5-free has been deprecated"` made OmniRoute set `rateLimitedUntil = +24 h`, `errorCode 410`, `testStatus unavailable` on the **entire connection**; every later request to *any* model of that connection (`ocfree` and `ocpaid` both) failed instantly (~13 ms) with the *deprecated model's* message ("reset after 23h 59m …") even for models that had just answered. Repair: `PUT /api/providers/<connection id>` with `{"rateLimitedUntil":null,"testStatus":"active","errorCode":null,"lastError":null}` (done; chat resumed at once). Consequences: (1) `pool sync` probes only ids present in the live listing and treats the `ocfree`/`ocpaid` connections as shared fate; (2) in §8.2, a `410` whose message names a **different model than requested**, or any instant failure carrying a `reset after …h` suffix, means a connection-wide cooldown: skip every model of that connection for the request and raise an alert, don't denylist the requested model; a `410 … deprecated` for the requested model denylists that model and (if still listed upstream) triggers the repair `PUT` above through the admin path; (3) liveness probes for ids the docs list but the sidecar does not serve (`exo-free`, `nemotron-3-ultra-free`, `ling-3.0-flash-fin-free`) are forbidden.


`jev-router pool sync` (daily membership-diff job + CLI; full liveness re-sweep monthly):

1. Read each source's live model listing (oc-paid with `OCPAID_API_KEY`, oc-free, mscopilot, OpenRouter
   public — all cheap direct reads, never via OmniRoute), diff against the previous membership, and liveness-probe every new member
   with one tiny completion through OmniRoute ("Reply with exactly: pong", 512 max tokens, 60 s timeout). Monthly job re-probes every member, not just new ones.
2. New members: `index add` each (§5.6). Dead (`ModelProtocolUnsupported`, empty text, 4xx/5xx), expired, or non-chat members: `denylist` or skip with reason; a dead mscopilot token is the expected case, not an error.
3. Rebuild the shortlists, update the combos, bump the index version, log a one-screen report (added,
   removed, failed, why — including BizChat thread resets).

---

## 7. The Jev layer

### 7.1 Sources, failover and balance `[owner: use all three, not only oc-free]`

All three paths were verified live on 2026-10-12 and return the same `answers` shape.

| Order | Source | Endpoint (input budget: 64k total; 32k state + longest single question — TypeSafe models page, verified 2026-10-13 via webfetch; OpenRouter guide hub still states 32k state+questions — treat TypeSafe page as truth, guide as stale. Overflow surfaces as `max_tokens_exceeded` on the OpenRouter typed-error surface; TypeSafe states no overflow policy, so the router trims client-side by project policy, never expecting truncation. Input-only billing at $0.042/M in, $0 out — the 14.8 µUSD / 353-token measurement matches the price) | Model | Cost |
|---|---|---|---|---|
| 1 | oc-free (remote Zen sidecar) | `POST {OCFREE_BASE_URL}/v1/systemone` | `jev-1.13-free` | free (anonymous tier, WARP pool) |
| 2 | oc-paid (local Go sidecar) | `POST {OCPAID_BASE_URL}/v1/systemone` (Bearer) | `jev-1.13-free` (`jev-1.13` selectable) | no cost field returned (subscription) |
| 3 | OpenRouter | `POST https://openrouter.ai/api/v1/systemone` (TypeSafe-SDK surface; or `POST https://openrouter.ai/api/alpha/decisions` Decisions surface — same key, same billing, verified 2026-10-13) (Bearer) | pinned request id `typesafe/jev-1.13`, alias `~typesafe/jev-latest` for tracking-latest (tilde form per OpenRouter tutorial; bare `typesafe/jev-latest` 404 is community-reported, not vendor-stated — P2 re-verifies the alias live; records resolved dated build e.g. `typesafe/jev-1.13-20260917` per call from the response `model` field; whether the dated build name is accepted as a *request* id is unstated — send the minor version) | metered, input-only: ~15 µUSD per judgment (measured; matches $0.042/M) |

- **Priority failover (default).** Sources are tried in order; a source is skipped while `jev:<source>` is cooling. Triggers:
  connect error/timeout, 429/`rate_limited`, 5xx, malformed or empty `answers`, auth error. Per-source
  timeout `min(1.2 s, remaining overall budget)`; overall Jev budget 3 s (`JEVR_JEV_DEADLINE_MS`); after that, fail open to the task default (§7.3). Source→endpoint/key map: `ocfree`→`OCFREE_BASE_URL` (no key), `ocpaid`→`OCPAID_BASE_URL`+`OCPAID_API_KEY`, `openrouter`→`https://openrouter.ai/api/v1/systemone`+`OPENROUTER_API_KEY`.
- **Health.** Separate `jev:<source>` keyspace in `cooldowns` (never shared with `chat:<id>`): 3 consecutive failures → 10 min × 2^(fails-3), cap 6 h; success resets. When a cooldown expires the next request-path turn probes it with the normal batched call under the same deadlines (no background prober in v1).
- **Load-balance (optional, `JEVR_JEV_BALANCE`).** `off` (default) = strict priority; `round-robin` rotates
  across healthy sources; `weighted` uses `JEVR_JEV_WEIGHTS` (e.g. `ocfree=3,ocpaid=2,openrouter=1`; required when `weighted`). Only healthy sources participate.
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
  "model": "jev-1.13-free",  // example assumes ocfree healthy; use first healthy source's id per §7.1
  "questions": {
    "model": {
      "type": "choice",
      "instructions": "Pick the specialist that can fully complete this request in one pass. Judge the required reasoning, scope, ambiguity, tool use and blast radius, not the requested answer length. If two fit, pick the cheaper one.",
      "criteria": { "c1": "…same text as the candidate description…", "c2": "…" }
    },
    "effort":    { "type": "choice", "instructions": "How much thinking does this turn need?", "criteria": { "low": "quick answer, little reasoning", "medium": "some reasoning", "high": "deep reasoning" } },
    "task":      { "type": "choice", "instructions": "What kind of work is this?", "criteria": { "coding": "…", "analysis": "…", "math": "…", "writing": "…", "agentic_files": "…", "simple_chat": "…" } },
    "high_consequence": { "type": "noul", "instructions": "A wrong answer here could affect health, legal standing, money or safety" },
    "stakes_domain":    { "type": "choice", "instructions": "Which stake is closest, if any?", "criteria": { "health": "…", "legal": "…", "money": "…", "other": "…" } }
  }
}
```

The `model` field carries the first healthy source's model id (§7.1); the payload below is identical across
sources. Rules baked in: criteria for `choice` is a **map** (max 255 options per Choice — verified 2026-10-13 via `docs.typesafe.ai`; a 2-option minimum is not vendor-stated — third-party hosts enforce 2–8 on their own surface, not TypeSafe's), for `score` an ordered **array** (2–10 levels, low→high, verified same date), `noul` for yes/no with optional `{true,false}` criteria (verified same date; sending an array to `choice` fails schema validation — 422 is the documented validation code for body errors, the array-mistake case itself is inferred, which is why `effort` above is a map,
not a list); up to 255 options per `choice` is the documented TypeSafe limit (verified 2026-10-13 via webfetch of `docs.typesafe.ai/primitives/choice`) — the 255-char per-description cap is **our own convention, not a vendor limit** (no vendor page states it; TypeSafe says only "keep question instructions and criteria tight" and "options cost only a few tokens each"); descriptions never contain numbers (the describe step emits fixed phrases) — including one fixed window-class phrase per candidate (`standard|large|huge context window`, from `caps_json`), and the shortlist shown to Jev is pre-filtered to candidates that fit the turn (§5.4 full-window rule, canonical order preserved), so Jev never picks a model that cannot hold the request and can prefer a roomy one for long documents;
one canonical option order per shortlist version; Jev's weak spots (option-order bias, numbers, irrelevant
context) are respected by keeping the state short, numeric measures out of the words, and the guard
deterministic. `state.ask` is the last user message truncated to ~1200 chars; `state.context.chars` is the full Warslop `messages` payload chars (for the §5.4 context-fit check); `candidates[].id` values map 1:1 to the shortlist order and resolve to `omniroute_id`s in code.

### 7.3 Confidence

Computed in code from the answer's own probabilities — and the formulas are published exact, not demo approximations (verified 2026-10-13 via webfetch of `docs.typesafe.ai/confidence`, which gives code for both): choice confidence = `(pmax − 1/n) / (1 − 1/n)` (equivalently `(n·pmax − 1)/(n − 1)`; the explorer on that page uses exactly this). Score confidence is distance-aware and published too: `max(0, 1 − Σ pᵢ·|i − m| / MAD_unif)` where `MAD_unif = (1/n)·Σ|i − (n−1)/2|`, floored at 0 when at least as spread as uniform (so `(0, 0.5, 0.5)` scores 0.25 — torn neighbours — while `(0.5, 0, 0.5)` scores 0 — torn ends — where the Choice formula gives both 0.25). Noul has no confidence field; `|2p−1|` is the vendor-suggested same-scale stand-in (Choice formula applied to yes/no). The earlier "demo approximation / unpublished production" note is struck — the page states the formulas are exact and every answer ships its full `probabilities`, so we may also gate on `pmax` or `pmax/p_second` per question once the log justifies it. Vendor guidance is illustrative pairs, not recommendations: 0.5 floor + 0.9 high-stakes bar on the Confidence page vs 0.6 floor + 0.85 transfer bar on the routing-pattern page (verified 2026-10-13) — the docs say thresholds are domain-specific and must be tuned on own data, and the version pinned (`jev-latest` moves, so pin once thresholds are tuned per `JEVR_JEV_SOURCES` comment). Hence:
Thresholds below start uncalibrated (0.5/0.8 are ours, not the vendor's), then tuned from the decision log:

| Condition | Action |
|---|---|
| `model` confidence ≥ 0.5 | use Jev's pick (after eligibility) |
| `model` confidence < 0.5 | the task default: the shortlist's strongest for Jev's `task` answer (warslop D42 removed Warslop's floor; this guard is jev-router's own proposal, owner can veto) |
| `high_consequence` p(true) ≥ 0.80 (the raw probability, not the `\|2p−1\|` stand-in — an unsure noul must not read as "low stakes") | never below the shortlist's strong pick for `stakes_domain`; if `stakes_domain` is `other`/unknown, use the task default |
| 0.5 ≤ `high_consequence` p(true) < 0.80 | prefer the strong pick unless its burn exceeds `JEVR_STAKES_BURN_MULT` (default 3)× the cheap pick's |
| Jev timeout / error / malformed | task default from the current call's `task` answer if present, else `analysis` strong pick (no cross-turn memory in v1) |

The eligibility check (§5.4) runs **after** Jev: an ineligible pick falls to the next favourite by Jev's
own probabilities; every downgrade is recorded with its reason.

### 7.4 Effort

v1 **records** Jev's `effort` answer (`low|medium|high`) in the decision row and in `x-jev-effort` as advice only; it is not applied. Reasoning parameters are OmniRoute's and the model's business: whatever `reasoning`/`reasoning_effort`/`max_tokens` Warslop sends is forwarded unchanged, and jev-router never injects, clamps or converts effort or token budgets (no per-provider effort tables, no budget maths). Using Jev's effort answer to set reasoning is parked (P6) until the B4 probe shows OmniRoute forwards such fields and the decision log justifies it. Note for the log only: reasoning tokens bill as output, so `burn` underestimates reasoning-heavy models (§5.3).

### 7.5 Decision cache and pins

- Cache key: SHA-256 of (ask excerpt + pool + index version + shortlist hash of the **context-fitting** shortlist + context bucket (`≤32k|≤128k|≤256k|≤512k|>512k` estimated tokens) + `uses_tools` + `has_image`), where `shortlist_hash = SHA-256(ordered omniroute_ids + burn)` (never headroom/usage — those change every turn and would zero the hit rate). TTL 5 min. A hit re-runs eligibility/cooldown/headroom before reuse — a stale pick falls forward like a fresh Jev pick; a repeated "hi" never pays twice.
- `x-jev-conversation` (optional header): used only as the value for the upstream `x-opencode-session` (stable per conversation when Warslop sends it, else a generated UUID per request). There is **no pin and no stored state**: every request is routed independently by Jev + guard. Cache-aware economics and any stickiness are P6 and need an owner decision plus decision-log evidence of real churn.

---

## 8. Routing policy and fallback semantics

### 8.1 Selection

1. Shortlist for the pool (built from the index, §5.3), each entry with description + burn + headroom.
2. Jev picks (§7); guard adjusts; eligibility filters (empty eligible set: **first widen to the pool's non-shortlist scored members (and unscored priced members, burn-ordered) that fit the context** — the 12-entry shortlist is Jev's menu, not the pool's limit, so a large turn must never fail while some pool member's window would hold it — then `context_too_long` only if no pool member at all (shortlist or not) passed context fit; if any member failed for another reason (price/tools/headroom/cooldown/denylist) in a **paid** turn, skip straight to step 4 — "paid capacity gone" (headroom/cooldown exhaustion) is exactly the D1 spill case, so the free pool serves it; `502 all_candidates_failed` without dispatch only when the free pool's eligible set is empty too, and for a **free** turn).
3. Dispatch candidates = the guarded pick, then the pool's next-best *for the same task* (role-quality order for Jev's `task`; deprioritised low-5h models at the end; `cooldowns`/`denylist` skipped), at most 3 attempts total in paid (initial + 2 retries).
4. Paid turns that exhaust the paid list continue into the free pool (any exhaust — warslop D55 lists quota/payment, rate-limit, server error and timeout as triggers): the free shortlist's best
   for the same task in free-shortlist order (no second Jev call; if the free pool has no scored candidate for that task, take its shortlist head), at most 2 attempts. Free turns never cross into paid.

### 8.2 Fallback triggers (explicit list, never inferred)

Matching is status-first, then `error.type`/code substring (case-insensitive) on the OmniRoute body — P2 pins the real Go/Zen refusal shapes by reading `~/projects/opencode-openai-proxy/server.mjs` + `FORK.md` error mapping and one 401 probe with a bad key (never by spending quota); discovery is a P2 gate, never inferred. Recorded from the sidecar source 2026-10-13 (so P2 probes OpenRouter/OmniRoute shapes, not these): sidecar envelope `{error:{message, type, code?}}` with `type` ∈ `api_error` (generic incl. 502 `zen unreachable`, 404 `not_found`, pool-empty 503 `egress_unavailable`, stream failures as `upstream_stream_error`), `plan_error`/`account_required` (402 paid-model gate — keyless mode only; keyed mode serves the full catalog), `FreeTierError` (free-tier misuse — 400-ish), `auth_error`/`invalid_api_key` (401 inbound, all non-health routes), `invalid_request_error`/`invalid_json` (400; 413 body-too-large), and the string match `ModelProtocolUnsupported|does not support this protocol|not supported for format` (wrong-wire model — 400 today, 401 on older paths, so match the string, never the status alone); overload-retry set `408/429/500/502/503/504/529` with quota-signal winning over bare 429. P4's fault-injecting fake proves each row.

| Trigger | Match |
|---|---|
| Quota / billing | `402`, `billing_error`, `payment_required`, `account_required`, `quota_exhausted`, `openrouter_credits`, `openrouter_in_flight_budget`, `in_flight_budget_exhausted`, `weight_exceeds_budget`, `403` with budget `limit_source` (`openrouter_guardrail_budget`/`openrouter_workspace_budget`/`openrouter_key_limit`) |
| Rate limit | `429`, `rate_limited`, `429 model_cooldown` (hop immediately; skip that model for the rest of the request until OmniRoute's `Retry-After`/`reset_seconds` — read it from the error, keep no separate copy; do not wait on the request path) |
| OpenRouter free variant retired | `404 "This model is unavailable for free. The paid version is available now…"` (seen 2026-10-14 on `nvidia/nemotron-3.5-lightning:free` and `google/gemma-4-26b-a4b-it:free`) → denylist that `:free` id until the next `pool sync` (never retry, never auto-swap to the paid slug — that would bill); OmniRoute also puts the model on a 2 min cooldown (`429 model_cooldown`, `reset_seconds`, `retry_after` ISO time) |
| Provider/server fault | `5xx`, `503 provider_circuit_open` (skip every model of that provider for the request), `503 no_eligible_providers`, connect timeout, upstream `api_error` |
| Model cannot serve the protocol | `ModelProtocolUnsupported` → `denylist` until the next `pool sync` re-probe passes (never a timed cooldown) |
| Auth broken | `401 auth_error`: if the first hop 401s with an OmniRoute-level error, the OmniRoute key (`OMNIR_API_KEY`) is suspect → `502` immediately; a provider-level 401 (all of that provider's accounts expired/banned, surfaced by OmniRoute as 401/402) just skips that provider's models. No same-model retry (OmniRoute already rotated accounts) |

Not triggers: content refusals (`content_policy` — that is the answer Warslop shows), `context_too_long`
(a Warslop-side concern; jev-router returns `400 {"error":{"type":"context_too_long",…}}` with `x-jev-error: context_too_long`).

Per-attempt deadlines: first byte 15 s (paid) / 20 s (free); total attempt cap 120 s; overall request cap 150 s (5 × 120 s would overrun Warslop's 280 s edge — the overall cap wins and remaining hops are skipped). **These caps bound only the pre-first-chunk phase** (hop decisions while waiting for the first SSE chunk of any kind): once any chunk has streamed, jev-router passes the stream through untouched and applies no duration or idle cap of its own (D40; OmniRoute and the client own the rest). The non-streaming buffered path has no first-chunk event, so there the 120 s attempt cap applies to the whole response; Warslop should stream long answers. Responses are never inspected for quality: an empty or odd answer is the answer. **B1 — integration gate (RESOLVED in the spec as a Warslop config change; applied at P5):** Warslop's gateway fails a paid turn over to free when the paid upstream's first event misses `PAID_TIMEOUT_SECS` (default **8**, `crates/gateway/src/config.rs:433/471/699`, read at `routes/chat.rs:1474`) — shorter than one 15 s jev-router attempt — and its upstream read timeout `UPSTREAM_READ_TIMEOUT_MS` defaults to **120000**, below jev-router's 150 s overall cap. Both are **environment settings, not code** (`secs("PAID_TIMEOUT_SECS", …)`, `UPSTREAM_READ_TIMEOUT_MS`): the Warslop F100 repoint sets `PAID_TIMEOUT_SECS=160` and `UPSTREAM_READ_TIMEOUT_MS=170000` (≥ `JEVR_REQUEST_MAX_MS` + margin, under Warslop's 280 s edge), so Warslop's own paid→free attempt becomes a last-resort backstop behind jev-router's internal paid→free spill (a backstop `free` call re-enters jev-router with `model: "free"`, so it never double-bills a paid model). Acceptance (P5 dry run): a paid request whose first two paid candidates are forced to hang 15 s each still answers through jev-router without Warslop's fallback firing. If Warslop refuses the longer budget the fallback is a spec change (shrink paid first-token to ≤ 8 s), never a silent retry. Hops happen only before the first streamed chunk; after headers+first chunk, failures pass through mid-stream (warslop D10: post-first-token failure is billed visible output, never retried). Streaming starts as soon as the winning attempt emits
its first chunk; earlier failed attempts are invisible to the caller except in headers/logs.

### 8.3 Failure of everything

`502` with `{"error":{"type":"all_candidates_failed","message":"paid and free pools exhausted","attempts":[{"model":…,"code":…},…]}}`.
Warslop shows its resting message and charges nothing (D55 rule); jev-router records the decision row
either way.

---

## 9. API contract

### 9.1 Public (Warslop-facing)

- `POST /v1/chat/completions` — OpenAI shape. `model: "free" | "paid"` (an exact OmniRoute id also routes,
  for debugging only and only when `JEVR_DEBUG_IDS=1`; default off; never part of the Warslop prod contract per D7). Dispatch forwards Warslop's `messages`/`tools`/`temperature`/`max_tokens` (if Warslop omits `max_tokens`, omit it — native window per warslop D40, never impose one) unchanged, swapping only `model` → concrete OmniRoute id (no effort injection, §7.4), and always sends `x-opencode-session` upstream (stable per `x-jev-conversation` when Warslop sends it, else a generated UUID per request — Go requires a stable per-conversation id for routing/cache; only this header is known to pass OmniRoute per §6.4 item 2). Streaming (`"stream": true`) is passthrough SSE; non-streaming is a
  buffered passthrough. Response body is the upstream body unchanged (including `usage`) (the `model` field still names the concrete upstream model); extra headers in
  §9.3. Bearer `JEVR_API_KEY`. Container bind is `127.0.0.1:4098` in the host netns (`network_mode: host`, same as OmniRoute — same-box Warslop assumed); if Warslop runs off-box, add a Tailscale bind instead of widening to LAN — never `0.0.0.0` with a billable key behind it.
- `GET /v1/models` — exactly two entries: `free`, `paid` (`{id, object:"model", created, owned_by:"jev-router", context_length}`), each with `context_length` = the max known over its
  pool (unknown-context members ignored; if all unknown, omit the field rather than lie). Max lets Warslop send large turns; jev-router's eligibility still picks a fitting model or returns `context_too_long`.
- `GET /healthz` — `{"ok":true,"version":"<image tag, e.g. 0.3.1|edge>","revision":"<git sha>","index":<version>,"pools":{"free":n,"paid":n},"jev":"ok|degraded"}` (no auth,
  loopback only). `version`/`revision` are baked at image build time from the release workflow's `VERSION`/`REVISION` build-args (§14.3); local `cargo run` builds report `dev` + the working-tree sha (P0 fixes the exact fallback strings; the doc-constants test asserts the fields exist, never their values). `index` is the score-index version. Counts are current pool member counts; `jev=degraded` when all three `jev:<source>` keys are cooling, else `ok`. Deploy/upgrade scripts assert `version`/`revision` after every `pull` + `up -d` (§11).

### 9.2 Admin (loopback + `JEVR_ADMIN_KEY`, never `JEVR_API_KEY`)

- `GET /admin/index` — current version, sources with dates, AA attribution string (D10), per-role shortlists, full report text.
- `GET /admin/decisions?since=…&pool=…&limit=…` (default limit 100, max 1000) — decision rows, aggregated counts; `GET /admin/decisions/{id}`.
- `GET /admin/pools` — members with health, `cooldowns`/`denylist` state, rolling headroom estimate.
- `POST /admin/fetch` — run the ops fetch now (budget still applies; 202 + `{job:"…", status:"/admin/jobs/…"}` — long AA passes never block the caller).
- `POST /admin/index/build` — rebuild + version bump (same async rule).
- `POST /admin/pool/sync` — the §6.5 sync (same async rule).
- `GET /admin/jobs/{id}` — `{state: queued|running|done|error, result}` for the three POSTs above.

### 9.3 Provenance headers (always set)

```
x-jev-pool: paid|free
x-jev-model: <canonical id>          x-jev-source: <served provider/model from OmniRoute's X-OmniRoute-Provider/-Model response headers, falling back to the requested id; the connection id (X-OmniRoute-Selected-Connection-Id) and X-OmniRoute-Fallback-Attempts go to the decision row only>
x-jev-decision: <decision id>        x-jev-index: <index version>
x-jev-fallback: 0|1 (1 if any retry past the first attempt, within or across pools)   x-jev-hops: n (total dispatch attempts)
x-jev-effort: low|medium|high (Jev's answer, informational — not applied in v1)
# conditional only: x-jev-error: context_too_long|all_candidates_failed
```

### 9.4 Config (`~/.config/jev-router/env`, 0600)

```
JEVR_BASE_URL=http://127.0.0.1:4098   # host-netns loopback; both containers use network_mode: host so this never becomes a docker-bridge name
JEVR_API_KEY=<generated via: openssl rand -base64 32>
JEVR_DB=/app/data/jev-router.db   # persistent volume (compose: ./data:/app/data); WAL mode, 0600; port 4098 checked free in P0
JEVR_DEBUG_IDS=0                                   # 1 = allow exact OmniRoute ids (debugging only)
OCFREE_BASE_URL=http://OCFREE_HOST:4097          # Jev direct + pool-sync listing reads (chat dispatch via OmniRoute)
OCPAID_BASE_URL=http://127.0.0.1:4097              # Jev direct + pool-sync listing reads (chat dispatch via OmniRoute)
OCPAID_API_KEY=<from dev-secrets>
OMNIR_BASE_URL=http://127.0.0.1:20128              # all chat dispatch
OMNIR_API_KEY=<from dev-secrets>
OPENROUTER_API_KEY=<from dev-secrets>              # benchmarks, models, Jev, (:free caps) — never chat in v1 (D3)
OPENROUTER_MONTHLY_CAP_USD=25                      # paid-pool cap for the headroom gate (D14)
ARTIFICIALANALYSIS_API_KEY=<from dev-secrets>      # AA free
JEVR_JEV_SOURCES=ocfree:jev-1.13-free,ocpaid:jev-1.13-free,openrouter:~typesafe/jev-latest
# default tracks latest; pin to openrouter:typesafe/jev-1.13 once guard thresholds are tuned (§7.3 — alias moves shift probability distributions)
JEVR_JEV_DEADLINE_MS=3000
JEVR_JEV_BALANCE=off                               # off|round-robin|weighted (D2)
JEVR_JEV_WEIGHTS=ocfree=3,ocpaid=2,openrouter=1    # required when weighted
JEVR_HEADROOM_MONTH_TURNS=10  JEVR_HEADROOM_MONTH_PCT=80  JEVR_HEADROOM_5H_TURNS=3
JEVR_STAKES_BURN_MULT=3
JEVR_FIRST_TOKEN_PAID_MS=15000  JEVR_FIRST_TOKEN_FREE_MS=20000  JEVR_ATTEMPT_MAX_MS=120000  JEVR_REQUEST_MAX_MS=150000
JEVR_BIND=127.0.0.1:4098   # listen address (the container uses network_mode: host, so there is no port mapping to narrow it — the app itself must bind loopback; startup refuses 0.0.0.0 unless JEVR_ALLOW_WILDCARD_BIND=1)
JEVR_ADMIN_KEY=<generated via: openssl rand -base64 32>   # /admin/* only; the chat key JEVR_API_KEY (held by Warslop) never grants admin
JEVR_CONTEXT_FLOOR=32000  JEVR_EXPIRY_DAYS=14  JEVR_SHORTLIST_MAX=12  JEVR_SHORTLIST_MAX_FREE=8
JEVR_EXCLUDED_IDS=                                 # optional comma-separated omniroute ids to keep out of every pool (ops escape hatch; empty by default — no privacy/training exclusions, D15)
# doc-constants test (§13.6) pins every default above to code.
```

Warslop consumption (its change, for the integration phase): `JEVR_BASE_URL` + `JEVR_API_KEY` added to
`~/.config/warslop/dev-secrets.env`, and its single upstream repointed at jev-router with model `paid`
(and `free` for free guests).

---

## 10. Build plan (phases, each ends usable and green)

**P0 — Scaffold + first snapshots (2–4 focused sessions).**
Repo skeleton (cargo, `cargo test`, `clippy -D warnings`, `fmt --check`, `deny.toml` + `cargo deny check bans licenses sources` (PR) and `cargo audit --deny warnings` (scheduled, §14.2), `rust-toolchain.toml` (stable + `clippy,rustfmt` + `x86_64-unknown-linux-musl`), `.github/workflows/ci.yml` (PR fast jobs per §14) + `.github/workflows/release.yml` (GHCR build+push per §14.3) + `.github/workflows/cleanup.yml` (weekly GHCR retention per §14.3) + `.github/dependabot.yml` (cargo/docker/github-actions weekly), Dockerfile multi-stage (`rust:bookworm` builder + `musl-tools`, `rustup target add x86_64-unknown-linux-musl`, `cargo auditable build --locked --release --target x86_64-unknown-linux-musl`, `strip`, `ARG VERSION/REVISION` baked into the binary and reported by `/healthz` (§9.1), runtime `gcr.io/distroless/static-debian13:nonroot` digest-pinned) + `compose.yaml` service `jev-router` with `image: ghcr.io/bedasrv/jev-router:<pin>` (literal tag, no `build:` on the deploy host — CI is the only publisher), `pull_policy: always`, `network_mode: host`, `env_file: ~/.config/jev-router/env`, `./data:/app/data`, `restart: unless-stopped`, healthcheck on `/healthz`, `env.example` without secrets, port-4098 conflict check, `src/go_catalog.rs` stub with source-date), SQLite schema + migrations (WAL, `busy_timeout`, 0600),
`fetch` pipeline with the budget/flock-lock/429/`rate_limit_state` rules, snapshots for `openrouter_models`, `openrouter_benchmarks`, `aa_language_free` (the `:free` cap check is not a snapshot). Done when:
`jev-router fetch` stores the three snapshot sources within budget; a fake-server test suite counts requests and
proves reserve-before-call, single-flight (flock, no long DB transaction), 429 pause, and hash-conditional storage. No request path exists
yet.

**P1 — Index builder + matching.**
Matching (§5.2 alias-first, D11 newest), roles/scoring (§5.3 global cap 12/8 with stakes-first drops, `quality:unknown` excluded pre-score), eligibility (§5.4 price/vision/context/price-guard/headroom/`denylist`), versioned `model_index` (new version per `index add`, never mutate), `price_json`/`caps_json` shapes, the report,
`index add/build/show/diff` + `index alias add/del`. Done when: the builder over real (captured) snapshots produces the same kind
of report as NOTES-62's worked example; `index add` scores a new model from stored snapshots with zero
network calls (asserted by a fake that fails if called); the generation-collision case (two dated AA rows,
undated listing id) resolves to the newest row (D11/D34), with a fixture for it; `quality:unknown` models are out of the shortlist with reason.

**P2 — Pools + OmniRoute.**
**B5 first** (§12: retire the self-hosted divert and register the four real providers per §6.4 item 1; set the §12 OmniRoute settings), then pool sync (§6.5 daily diff + monthly re-sweep), the OpenRouter provider entry (§6.4 id-shape pin, combos API pin, passthrough probe, no direct-path), liveness probes, `jev:` `cooldowns` + `denylist` (chat health is OmniRoute's), the
Go quota table (no `…` remains) + `quota_events` rolling ledger, `:free` 20/min bucket + credit≥$10 verification, vision/tool capability field pins, Go/Zen quota-refusal shape discovery (P2 gate), health reporting. Done when: `pool sync` probes new members and excludes the dead source (mscopilot as of today) automatically; the per-provider dispatch id shapes (`ocpaid`/`ocfree`/`openrouter`) are pinned and answer through OmniRoute with served-provider headers readable; the pinned OpenRouter id shape answers through OmniRoute; refusal shapes and effort fields are recorded.

**P3 — Jev routing, shadow first.**
Jev client with the source pool (§7.1: `ocfree → ocpaid → openrouter:~typesafe/jev-latest`, `min(1.2 s, remaining)` + 3 s overall, separate `jev:` cooldowns + `JEVR_JEV_WEIGHTS`), questions (§7.2 map-shape, 255-char cap, `context.chars` = full payload), confidence + guard (§7.3 with `JEVR_STAKES_BURN_MULT`), decision cache (eligibility rechecked on hit), `serve` with `free`/`paid` ids but
a fixed default model (shadow logs the would-be choice). Done when: the 23 cafe-task fixtures from brief 47
(adapted to free/paid pools) run through the classifier; injected failures on sources 1 and 2 still yield an answer from 3,
and all-sources-down falls open; decision rows carry features (`index_version`, `jev_source`, `shortlist_hash`), the answering source and no prompt text;
nothing on the request path calls a benchmark API (fake asserts). Per-source response-shape fixtures pinned (sidecar vs OpenRouter `cost`/`id`).

**P4 — Full routing + fallback + streaming.**
Explicit-model dispatch through OmniRoute (full-messages forward, no `max_tokens` unless Warslop set it, no effort injection), the fallback state machine (§8: 3 paid + 2 free attempts, 15/20 s first-token, 120 s/attempt, 150 s overall, pre-stream hops only, `denylist` vs cooldown, `context_too_long` vs `502` shapes), SSE
passthrough, provenance headers (§9.3 incl. `x-jev-error`), error typing, `route explain` CLI. Done when: a fault-injecting fake
OmniRoute proves every §8.2 trigger hops to the next candidate and a paid turn with a fully failed paid
pool lands on the free pool; a streamed answer reaches the client with correct headers; mid-stream failure passes through (no retry).

**P5 — Warslop integration readiness (their F100 repoint).**
Docs + dry-run: a local fake of Warslop's client calling `free`/`paid` under load with a small script (incl. `:free` 20/min burst + paid→free spill);
`JEVR_*` lines for dev-secrets; a one-page integration note (contract version = spec date + image `version`/`revision` in `/healthz` + `index_version` in `x-jev-index`); a GHCR deploy drill on the target host (`pull` a pinned digest + `up -d`, assert `/healthz` `version`/`revision`, roll back to the previous semver tag per §11). Done when: the contract in §9 is frozen,
versioned and announced; a Warslop dev stack can point at jev-router without code changes on this side.

**P6 (parked) — Cache-aware economics.**
Warm-cache evidence to Jev, switch rules (upgrade /
20 % margin / dwell / budget 3) ported from brief 47 §Cache-aware routing. P6 adds the economics and any stickiness. Trigger: after P5, if Warslop
sends the header and the decision log shows real switch churn.

---

## 11. Ops runbook

- Service: `docker compose {up -d,restart,logs -f} jev-router` · logs `docker logs -f jev-router`. DB is WAL + `busy_timeout=5000` on the `./data` volume; the ops loop runs inside the container and the CLI runs via `docker exec jev-router jev-router …` so both share the same flock + short `BEGIN IMMEDIATE` transactions — nothing else may write the DB file from the host while the container runs.
- Deploy/upgrade (GHCR image per §14.3; CI is the only publisher — never `docker compose build` on the deploy host): one-time `echo "$CR_PAT" | docker login ghcr.io -u <user> --password-stdin` (PAT classic with `read:packages`, stored 0600 off-repo; the package stays private until the owner explicitly makes it public). Upgrade: set the new literal tag in `compose.yaml`, then `docker compose pull jev-router && docker compose up -d jev-router`; assert `/healthz` `version`/`revision` equal the deployed tag/digest and `docker inspect` digest equals the release run's published digest; record tag+digest in the deploy log. Rollback is the same two commands with the previous tag+digest (§14.3 retention keeps every semver tag pullable). Prod pins a semver tag or `sha-<short>`; `latest`/`edge` track `master` and are dev-only.
- Fetch/index/sync run inside the container's ops loop (hourly listing check, daily pass with jitter) and
  via `docker exec` by hand; `index add/build/show/diff` never fetch (network-offline) but still take the DB locks.
- Rotating a key: update `~/.config/jev-router/env` (+ dev-secrets where duplicated) and `docker compose up -d`. Nightly: delete `routing_decisions` > 90 days, `VACUUM` weekly; backup is `docker exec jev-router jev-router db backup` (a binary subcommand using SQLite's online backup API / `VACUUM INTO` to `/app/data/jev-router-<date>.bak` — the distroless static image has no `sqlite3`, no shell, no curl, so every ops action is a `jev-router` subcommand; never a raw `.db`/`-wal` copy under write load). The compose `healthcheck` is likewise `["CMD","/app/jev-router","healthcheck"]` (a subcommand that GETs `/healthz` on `JEVR_BIND`), not curl. The image runs as distroless `nonroot` (uid 65532): create `./data` once with `chown 65532:65532 data && chmod 700 data` (or set `user:` in compose to the host uid) before first `up`, else the 0600 DB cannot be created. Use an absolute path for `env_file` (do not rely on Compose expanding `~` — verify in the P5 drill).
- Dead upstream playbook: a source's failures show in `/admin/pools` and `cooldowns`/`denylist`; mscopilot's
  refresh token is the known example — recovery is the HAR re-export documented in dev-secrets, no
  jev-router change. A model dropped from every source disappears at the next `pool sync`.
- Snapshot staleness > 48 h writes `alerts(staleness_48h)` + log line; index keeps serving the last good version.

## 12. Risks and known gaps

- **Jev routing accuracy is unproven** (madewithjev says so about every Jev router): run shadow first
  (P3), log decisions, compare cost per completed task, not per call. The guard thresholds start
  uncalibrated — and the confidence scalar is a peak-probability summary, not a calibrated correctness probability (Choice is peak-only; Score is distance-aware; both are published exact at `docs.typesafe.ai/confidence`), so tune cutoffs on own labelled data per question, never copy vendor example numbers (0.5/0.9 vs 0.6/0.85 are illustrative pairs from different pages).
- **Benchmark coverage is partial.** Go-catalog-only models (LongCat, Hy3, Space Bunny) have no scores;
  they stay out of Jev's shortlist until probes exist. AA matching is heuristic (no `openrouter_api_id`
  on the free tier). **B3 — AA Free-shape (RESOLVED by a live keyed capture, 2026-10-14, one request of the 100/24 h window):** `GET https://artificialanalysis.ai/api/v2/language/models/free?page=1` with `x-api-key` → `200`, `content-type: application/json`; response headers `x-aa-tier: free`, `x-ratelimit-limit: 100`, `x-ratelimit-remaining: 99`, `x-ratelimit-reset: <epoch s, 24 h ahead>` (so the fixed window and the `X-RateLimit-*`/`X-AA-Tier` names are now observed, not partner-stated). Body: `{tier:"free", intelligence_index_version:"4.3", pagination:{page, page_size:200, total_pages:4, has_more}, data:[…200 rows…]}`. Row: `{id (stable uuid), name, slug, release_date, model_creator:{id,name}, evaluations:{artificial_analysis_intelligence_index, …coding_index, …agentic_index, …finance_and_accounting_index, …strategy_and_ops_index, …legal_index, …healthcare_and_medical_index, …engineering_index, …economics_index} (null when unscored), artificial_analysis_intelligence_index_cost, pricing:{price_1m_input_tokens, price_1m_output_tokens, price_1m_cache_hit_tokens, price_1m_cache_write_tokens}, performance:{median_output_tokens_per_second, median_time_to_first_token_seconds, median_time_to_first_answer_token_seconds, median_end_to_end_response_time_seconds}}`. Page 1 coverage: intelligence 198/200, coding 75, agentic 53, finance/strategy/legal 68 each, healthcare 23 (sparse — the §5.3 `health` role must tolerate missing scores), speed 110. **The Free shape does carry the domain indexes the stakes roles need** (the earlier verify item is closed). Matching consequence: **reasoning-effort variants are separate rows** (`Grok 4.7 (Low)`/`(High)`, `Grok 4.6 (Medium)`, `GLM-5 (Reasoning)`), so §5.2 matching must strip the parenthesised variant suffix and pick one row per model by an explicit rule (highest intelligence index = the model's best configuration; recorded in `index show`); 4 pages per pass confirmed. Still unverified: the Pro-403 behaviour and the `Retry-After` on a real 429 (coded defensively, §5.1).
- **The quota ledger is an estimate, and OmniRoute cannot replace it.** OmniRoute's opencode quota fetcher exists only for the built-in `opencode-go`/`opencode`/`opencode-zen` providers and reports account-level 5h/weekly/monthly percentages, not per-model dollar limits; custom `ocpaid` has no quota source today. Keep the per-model ledger; optionally add OmniRoute's account-level Go percentages as a second gate if Go becomes a native connection. The provider's own refusal is the truth signal; the ledger only
  paces. The `60 / monthly_limit` normalizer is community-derived (`anomalyco/opencode` issue #41391, not `sst/opencode`), not Go-docs-stated (the `round()` recording detail is PARTIAL — one thread comment), and per-model dashboards have disagreed with it (Luna, Muse Spark cases) — window alignment and historical multipliers are the suspects, never the refusal path.
- **OmniRoute passthrough: only `x-opencode-session` is known to pass.** Session-identity paths verified via container docs + imports; executor bodies are not shipped, so `provider` prefs, `session_id`/`prompt_cache_key`, `reasoning: {effort}`, and arbitrary custom headers are omitted until the §6.4 item 2 live probe shows them passing — no direct-path bypass (D3). Session affinity is already generalized to any provider (TTL > 0); affinity headers are never forwarded upstream. The 3.8.51 strategy count is 20 including `quota-weighted` (container bundle; docs saying 19 are stale v3.8.40).
- **`:free` economics shift.** Free-variant counts and availability change; the pool sync, the
  20 % daily reserve plus the 20/min bucket handle it, but free capacity is never guaranteed — Warslop's UX must tolerate it. The credit threshold (≥10 all-time, granted from 9) is docs-verified; this account's own credit status and `remaining` are still P2 probes.
- **mscopilot is down today**, and the bridge shares one server-side conversation for all callers
  (answers can be contaminated by other callers' turns; probes pollute it — see §6.2).
- **BLOCKER B2 — OpenRouter provider missing in OmniRoute.** Subsumed by B5: OpenRouter is registered as a provider node + connection (§6.4 item 1) like the other three; P2 pins the real id shape (`openrouter/<author>/<slug>` vs bare) and proves a paid call through it; until then OpenRouter-paid has no dispatch path and Jev-OpenRouter is judgments-only.
- **BLOCKER B5 — OmniRoute's self-hosted divert hides everything the layering assumes (found by a v3.8.51 source read, tag `c1e30b7`, plus live checks 2026-10-14).** With `OMNIROUTE_SELF_HOSTED_PROVIDERS_FILE` set (it is, in `~/Containers/omniroute/docker-compose.yml`), `/v1/chat/completions` is answered by `handleSelfHostedCompletions` before the normal handler: **no** account rotation, breakers, lockouts, combos or quota; one config per YAML provider; on any non-2xx it silently falls through to the *next provider* in YAML order with the same model string (even for a pinned provider) with no per-request fail-fast; the response header names the candidate list, not the provider that served. Live evidence: provider metrics show 0 requests for `ocpaid`, `check_quota` lists 0 providers, no `[AUTH] Using … account` log lines. Also on the full pipeline a raw `opencode/<id>` resolves to the built-in `opencode-zen`, not `ocpaid`, so §6.1's dispatch ids are unverified. **Owner decision 2026-10-14: option (a).** Retire the divert (unset `OMNIROUTE_SELF_HOSTED_PROVIDERS_FILE` in `~/Containers/omniroute/docker-compose.yml`) and register `ocpaid`/`ocfree`/`mscopilot`/`openrouter` as real provider nodes + connections per §6.4 item 1; then P2 pins the dispatch id shape per provider and re-runs the §6.4 item 2 passthrough probe on the real pipeline. B5 closes when a request to each provider's id shows up in `omniroute_get_provider_metrics`/logs with `[AUTH] Using … account`, the response carries `X-OmniRoute-Provider`/`-Model`, and a forced failure of one provider returns an error instead of falling through to another. **Status 2026-10-14: executed** (§6.4 item 1 results). Closing criteria met for `ocpaid` and `openrouter`; `ocfree` re-probed OK; `mscopilot` revived from a fresh HAR (200, 8.7 s), and the §12 OmniRoute settings besides `OMNIROUTE_EMERGENCY_FALLBACK=false` (`globalFallbackModel`, cooldown-wait, task-aware routing) are not yet verified. Whether the owner's several-accounts-per-provider setup exists is unverified (no connections visible without the dashboard).
- **OmniRoute settings jev-router needs (read live from `GET /api/resilience` and `GET /api/settings`, 2026-10-14; changing them is an owner action, none changed):** `OMNIROUTE_EMERGENCY_FALLBACK=false` — set and confirmed in the container env. Found **not** as required: `waitForCooldown {enabled:true, maxRetries:3, maxRetryWaitSec:30}` (a fully-cooled model makes OmniRoute wait up to 3 × 30 s = 90 s before answering — breaks the 15 s first-byte deadline; target `enabled:false`), `requestRetry:3` + `maxRetryIntervalSec:30` (OmniRoute retries a failing model itself up to 3 times — target 0–1 so hops are jev-router's), `requestQueue {requestsPerMinute:60, minTimeBetweenRequestsMs:350, concurrentRequests:6, maxWaitMs:30000}` (a global throttle: sustained Warslop traffic above 60 req/min or 6 in flight queues up to 30 s — raise or measure in P5), `comboCooldownWait {enabled:true,…}` (moot while no combos are on the request path). Fine as is: `providerBreaker.apikey {failureThreshold:12, resetTimeoutMs:30000}`, `connectionCooldown.apikey {baseCooldownMs:3000, useUpstreamRetryHints:true, maxBackoffSteps:5}` (OmniRoute honours upstream retry hints), `quotaPreflight.enabled:false`, `sessionAffinityTtlMs:0`, no `globalFallbackModel`/task-aware/web-search routing keys present. Apply with the resilience API (`PUT /api/resilience`, body per the source) and re-read to confirm; the doc-constants test cannot pin these (they live in OmniRoute), so P2 records them in the deploy log.
- **B4 — passthrough probe (PARTIALLY RESOLVED live, 2026-10-14, built-in `openrouter` provider through the real pipeline, free models only).** Verified: OmniRoute forwards `reasoning: {effort}` **and** top-level `reasoning_effort` to the upstream — on a reasoning model the same prompt used 1618 reasoning tokens by default, 692/690 at `low`, 909/1018 at `high`, and an invalid value (`bogus`) came back as the upstream's own validation error (`reasoning.effort: Invalid option: expected one of "max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none"`, `400`) — a value OmniRoute would not have produced itself. Strong indication, not proof: a `provider: {order:["nonexistent…"], allow_fallbacks:false}` object produced OpenRouter's "This model is unavailable for free" 404 (the only free endpoint was filtered out), i.e. `provider` prefs appear to be forwarded and applied; `data_collection`/`require_parameters`, `session_id`, `prompt_cache_key` and Go's `x-opencode-session` were **not** conclusively tested (the probes hit a model cooldown/retirement first). Rule stays: v1 forwards Warslop's own fields unchanged (§7.4, scope rule) and injects none; the remaining fields are enabled only after a clean probe on a model that is not cooling down.
- **Two-writer safety**: WAL + `busy_timeout` + flock + short transactions (§11); anything else writing the DB bypasses the locks and corrupts the budget.
- **Go catalog drift.** The Go price/quota table is a manual transcription — re-check the live Go page monthly in `pool sync` and fail the sync report if the source-date is > 60 days old.
- **Jev source shapes differ.** OpenRouter's `usage` carries `cost` and its response an `id`/`provider` plus `model` naming the dated build;
  the sidecars carry neither. OpenRouter serves Jev on two equivalent surfaces (`/api/alpha/decisions` for plain HTTP/SDKs, `/api/v1/systemone` for the TypeSafe SDK base-URL switch — same key, same billing); chat completions SDKs are unsupported on either (exact vendor status unstated — do not assert 400). The anonymous oc-free tier can throttle at peak — the fallback chain and
  cooldowns exist for that. Fixtures pin each source's shape.

## 13. Acceptance (project done when)

1. `warslop → jev-router (paid) → OmniRoute → a Go model` answers over SSE with correct `x-jev-*`
   headers, and the same call keeps working after the chosen model is made to fail (next paid, then free).
2. `model: "free"` never routes to a paid offer; a paid turn that exhausts paid (quota/payment, rate-limit, 5xx/timeout per D55) tries the
   free pool first.
3. Adding a model is `index add` + (if unmatched) one budgeted fetch; no request path ever calls the
   benchmark providers (fake-asserted).
4. The decision log explains any turn: pool, candidates, probabilities, guard action, hops, latency,
   usage — with no prompt text stored.
5. The Go subscription is not drained: the ledger and headroom rules appear in `/admin/pools`, and
   refusals fall back cleanly.
6. `bash scripts/verify.sh` equivalent for this repo: §14 CI green on the PR (`fmt`, `check`, `clippy -D warnings`, `doc -D warnings`, `test` incl. `axum-test` + `wiremock`/`httpmock` fakes + spec-constants pin + `proptest`, `llvm-cov --fail-under-lines 70` non-blocking upload, `cargo machete`, `deny check bans licenses sources`, `cargo tree --duplicates`, `docker-build-check`), release publishes `ghcr.io/bedasrv/jev-router` per §14.3 (semver tags on `v*`, `edge` + `sha-*` on `master`; `cargo auditable build` inside the image, verifiable with `cargo audit bin`), image ≤ 25MB compressed (the release fails otherwise — `scripts/check-image-size.sh`; `cargo bloat` informational only), the deployed `/healthz` reports the released `version`/`revision`, `pull` + `up -d` upgrades and the kept previous semver tag rolls back (§11), container survives
   a `docker kill -s 9` (`restart: unless-stopped`), and the spec's tables match the code's constants (a doc-constants test pins §9.4 defaults, §5.4 thresholds, §6.3 prices source-date).
7. Jev failover: with oc-free failing, the turn still routes via oc-paid; with both down, via OpenRouter;
   with every Jev source down, the turn still completes on the task default (fail-open). With
   `JEVR_JEV_BALANCE=round-robin`, the answering source rotates across the healthy set.

---

## 14. CI + GHCR (GitHub Actions — CI researched 2026-10-13; GHCR deployment + versioning re-pinned live 2026-10-13)

No official `rust-lang/setup-rust` exists (infra-team issue #256 still a proposal) — standard is `dtolnay/rust-toolchain` + `Swatinem/rust-cache@v2`. `Cargo.lock` is committed (binary); every `cargo` invocation passes `--locked`.

### 14.1 PR workflow (`.github/workflows/ci.yml`, parallel jobs, fastest failure first)

`concurrency: {group: workflow+ref, cancel-in-progress: true}` on PRs only (never on release). `permissions: {contents: read}`.

1. `fmt`: `dtolnay/rust-toolchain@stable` + `components: rustfmt` → `cargo fmt --all -- --check`.
2. `check`: toolchain + `Swatinem/rust-cache@v2` (`shared-key: ci-linux`) → `cargo check --workspace --all-targets --all-features --locked`.
3. `clippy`: same cache → `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`. Pedantic/nursery are NOT enabled wholesale (intentional false positives / under development per clippy docs); cherry-pick via `[workspace.lints.clippy]` (pays off for a gateway: `missing_errors_doc`, `missing_panics_doc`, `must_use_candidate`, `redundant_clone`, `cast_possible_truncation`), narrow commented `#[allow]` only.
4. `doc`: `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --all-features --workspace` (broken intra-doc links fail; never `#![deny(warnings)]` in lib per rust issue #59367).
5. `test`: `cargo test --workspace --all-features --locked` — own routes via `axum-test TestServer`, upstreams via `wiremock` (tokio-only) or `httpmock` (delay/fault/standalone, fresher in 2026); fault-injection (`500` → fallback, delay → timeout → fallback, 500-then-200 → retry) + spec-constants pin test (§9.4 defaults, §5.4 thresholds, §6.3 `source_date` — fail on silent drift) + `proptest` (3–5 properties on scorer/matcher: monotonicity, bounds, determinism). `nextest` only if suite time/flakiness justifies it (doctests still need `cargo test --doc`).
6. `coverage`: `cargo llvm-cov --workspace --all-features --lcov --output-path lcov.info --fail-under-lines 70` (tarpaulin loses on musl; branch coverage needs nightly — line gate only; raise to 80 only after sustained headroom). Upload via `codecov/codecov-action@v5` with `fail_ci_if_error: false` (outage ≠ red).
7. `deps`: `cargo machete` (fast unused-dep fail) + `cargo deny check bans licenses sources` + `cargo tree --duplicates --target all` (diagnosis; or `multiple-versions = deny` in `deny.toml`). `cargo bloat --release --crates` informational only, never a gate. `cargo +nightly udeps` weekly audit only.
8. `docker-build-check`: `docker/build-push-action` with `push: false` building the real Dockerfile on every PR — validates what the release workflow will publish without publishing anything (attestations need `push: true`, so none are generated here). The release workflow (§14.3) is the only publisher; PRs never push.

Branch protection requires `fmt`, `check`, `clippy`, `doc`, `test`, `deps`, `docker-build-check` + up-to-date branches. Advisory-feed jobs never block PRs.

### 14.2 Supply chain (scheduled, not PR-blocking)

`deny check bans licenses sources` runs on PRs (deterministic). Advisories run two ways because `deny advisories` and `cargo audit` query the same RustSec DB: daily `rustsec/audit-check@v2` cron (files issues) and/or `deny advisories` matrix with `continue-on-error` — a newly disclosed RUSTSEC must not red-flag every open PR. Note 2026-04-03 `krates` soundness bug (renamed `[lib] name` dropped subtrees, fixed 0.21.0): run both `audit` + `deny advisories` until the pinned deny is past the fix.

### 14.3 GHCR deployment + versioning (`.github/workflows/release.yml` + `cleanup.yml` + `compose.yaml`)

Image: `ghcr.io/bedasrv/jev-router` (lowercase — the metadata-action sanitization rule lowercases image names, README verified 2026-10-13). The first `push` creates the package **private** (this repo 404s anonymously, checked 2026-10-13 — it is private); it stays private until the owner explicitly flips it public. The package links to the repo automatically via the OCI `org.opencontainers.image.source` label that `metadata-action` emits — keep the default `labels`/`annotations` outputs wired so inheritance and the package page keep working (GHCR container-registry + access-control docs, verified 2026-10-13).

#### Versioning policy (git tags drive GHCR tags; default branch is `master`)

- Releases are git tags `vX.Y.Z` (semver, leading `v`). Pre-releases (e.g. `v2.0.8-beta.67`) publish only their full `{{version}}` — they never move `{{major}}.{{minor}}` / `{{major}}` / `latest` (metadata-action rule, README verified 2026-10-13). While the major version is `0`, the bare `{{major}}` (`0`) tag is suppressed (major-version-zero rule, same source).
- `metadata-action` config (exact):
  ```yaml
  images: ghcr.io/bedasrv/jev-router
  flavor: latest=auto
  tags: |
    type=edge,branch=master
    type=sha,prefix=sha-,format=short
    type=semver,pattern={{version}}
    type=semver,pattern={{major}}.{{minor}}
    type=semver,pattern={{major}},enable=${{ !startsWith(github.ref, 'refs/tags/v0.') }}
    type=raw,value=latest,enable={{is_default_branch}}
  ```
  Intent: a `master` push publishes `edge` + `sha-<short>` (+ `latest`); a `v1.2.3` push publishes `1.2.3`, `1.2`, `1` (+ `latest` via `flavor: latest=auto` on semver types) + `sha-<short>` — except the bare `{{major}}` is suppressed while 0.x by the guard above. Tag priority (schedule 1000 > semver 900 > edge 700 > ref 600 > raw 200 > sha 100) makes the full semver the OCI `version` label on releases (README-verified defaults, same source). The exact per-event tag sets are asserted by a P0 dry-run (`push: false`) before the first real publish — the config above is frozen, the CI log is truth.
- The image bakes `VERSION` (= the meta step's `version` output) and `REVISION` (= `github.sha`) as Docker build-args into the binary (`ARG VERSION=dev` / `ARG REVISION=unknown` defaults for local builds); `/healthz` reports both (§9.1). The release run's `digest` output is the rollback handle (§11). Prod `compose.yaml` pins a semver tag or `sha-<short>`; `latest`/`edge` track `master` and are dev-only.

#### Release workflow (`master` pushes, `v*` tags, manual dispatch only — never PRs)

Triggers: `push` to `master` + `push` tags `v*` + `workflow_dispatch` (rebuilds only). No `concurrency.cancel-in-progress` (per §14.1 rule). `permissions: {contents: read, packages: write}` — the container-registry docs' `GITHUB_TOKEN` publish path (verified 2026-10-13); no `id-token`/`attestations` permissions are needed for the provenance+SBOM below (they are `build-push-action` inputs, not `actions/attest`).

Steps (every pin is the `latest` release on its repo, verified live 2026-10-13; P0 resolves each to its commit SHA per §14.5):

1. `actions/checkout@v7.0.1`.
2. `docker/setup-buildx-action@v4.4.1` (default `docker-container` driver; also satisfies the GHA-cache backend floor of Buildx ≥ 0.21 — Docker cache docs verified 2026-10-13; GitHub-hosted `ubuntu-latest` runners already carry current Buildx/BuildKit per the same page, so no `version: latest` pin is needed).
3. `docker/login-action@v4.6.0`: `registry: ghcr.io`, `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}`.
4. `docker/metadata-action@v6.2.0`: `images:` + `tags:` + `flavor:` per above; forward `labels` and `annotations` (default annotation level `manifest` is correct for GHCR — only set `DOCKER_METADATA_ANNOTATIONS_LEVELS` if GHCR stops reading manifest-level annotations, never pre-emptively).
5. `docker/build-push-action@v7.4.0`: `context: .`, `push: true`, `tags`/`labels`/`annotations` from the meta step, `build-args: VERSION=${{ steps.meta.outputs.version }} REVISION=${{ github.sha }}`, `provenance: mode=max` (explicit: this repo is private so the default would be `mode=min`; max is the documented recommendation — Docker attestations docs verified 2026-10-13), `sbom: true` (not automatic — must be set, same source), `cache-from: type=gha`, `cache-to: type=gha,mode=max` (add `,ignore-error=true` only if cache-export flakiness ever red-flags a release; default off — the read-only-cache caveat for untrusted triggers does not apply here since this workflow never runs on PRs; Docker cache docs, same source). `type=registry` cache stays rejected (billed storage). `platforms: linux/amd64` only; no QEMU/cross until `arm64` is actually needed. The musl build stays inside the Dockerfile (existing rule). Never pass secrets as build-args — provenance embeds build-arg values (Docker docs warning, same source); this build needs none.
6. Size gate (fails the release over 25 MB compressed): `scripts/check-image-size.sh` (P0 writes it) must run **before anything is published** — otherwise an oversize image is already pushed and `edge`/`latest` already moved when the gate fails. Order: build once with `push: false` + `load`/OCI export → size gate → only then the `push: true` step (cache makes the second invocation cheap). `cargo bloat` stays informational (existing rule). (Renumber: this step precedes the build-push step above.)
7. Digest record: the workflow logs `steps.build.outputs.digest`; the deploy log pins `ghcr.io/bedasrv/jev-router:<tag>@<digest>` for rollback (§11).

`cosign` stays out until third-party distribution (existing rule, kept): default GH provenance (`mode=max`) + `sbom: true` + digest-pinned bases + Dependabot suffice. When signing is enabled, the tool is `sigstore/cosign v3.1.3` (latest 2026-10-13, incl. the GHSA-fx35-mq7g-6g98 verification-bypass fix) — re-pin then, never today.

#### Retention (`.github/workflows/cleanup.yml`, weekly schedule)

Keep every tagged version (`1.2.3` / `1.2` / `1` / `latest` / `edge` / `sha-*`) — at ~25 MB/image the storage is negligible next to the automation risk of deleting a rollback target. Delete only untagged versions (detached manifests/attestation leftovers), keeping the 10 most recent. Weekly `schedule: cron` job with `actions/delete-package-versions@v5.0.0` (latest 2026-10-13; inputs README-verified — `package-type: container` is the v5 value, `docker` is v4-or-older only; at most 100 versions per run per the same README):
- Job: `package-name: jev-router`, `package-type: container`, `delete-only-untagged-versions: "true"`, `min-versions-to-keep: 10`.
- No pass touches tagged versions: semver tags are never auto-deleted. If the tagged count ever becomes a storage problem, add an explicit second pass then — never freeze an `ignore-versions` regex today for a problem that does not exist.
- One-time setup after the first push: package Settings → Manage Actions Access → grant `bedasrv/jev-router` Admin so the workflow can delete (per the action README's access note, verified 2026-10-13); otherwise run with a PAT classic (`delete:packages` + `read:packages`) stored as `CLEANUP_PAT`.

#### Deploy host (`compose.yaml`)

```yaml
services:
  jev-router:
    image: ghcr.io/bedasrv/jev-router:0.3.1   # literal pin per release; prod never tracks latest/edge
    pull_policy: always
    network_mode: host
    env_file: ~/.config/jev-router/env
    volumes: [./data:/app/data]   # ./data must be owned by uid 65532 (distroless nonroot), see §11
    restart: unless-stopped
    healthcheck: {test: ["CMD", "/app/jev-router", "healthcheck"], interval: 30s, timeout: 5s, retries: 3}   # no curl/shell in the image
```

The tag is a literal (P0; example shows the shape, not a real release — no release exists yet). No `build:` block on the deploy host. Upgrade/rollback/healthcheck per §11; the P5 deploy drill proves the loop before Warslop repoints.

### 14.4 Git hygiene (enforced)

- `master` stays deployable and up to date: land via PR only (no direct pushes except fast-forward sync), rebase or squash-merge, CI green required before merge.
- Prune dead/stale branches: `git fetch origin --prune` on sync; delete merged branches (`git branch -d`, `git push origin --delete`), and sweep remote-tracking refs monthly. No long-lived feature branches — short PRs off `master`, merged or closed within days.

### 14.5 Dependabot scope (not Renovate)

`.github/dependabot.yml` weekly for `cargo` + `docker` + `github-actions` (3-day default cooldown applies; security updates exempt). Pin every `uses:` to SHA (or `@vX` minimum), let Dependabot advance. `cargo-mutants` runs nightly/weekly scoped (`--file src/scoring.rs`, `--in-diff` on PRs) — never a per-PR gate (20min–1h); `proptest` covers the per-PR math instead.

---

## 15. Review findings (v1.8) — open decisions for the owner

Contradictions that had one clear fix were corrected in place (see the Status line); v1.9 also dropped the pin and streaming-`usage` items by applying the §1 scope rule (jev-router is a router on OmniRoute, not a harness). These need an owner call
because they touch `[owner]` decisions or trade-offs; each carries a recommendation, none is applied.

1. **mscopilot shares one server-side conversation across all callers (§6.2).** Answers can be contaminated by other callers' turns, and forwarded `messages` duplicate the bridge's own thread — a correctness problem. *Recommend:* add `mscopilot/*` to `JEVR_EXCLUDED_IDS` until the bridge is proven stateless per request.
2. **No offline way to judge the router (§12/§13).** Jev never needs to know whether a task finished — it only maps ask → model. But *we* need to evaluate that mapping, and the log records transport outcome only, so there is nothing to tune thresholds on and nothing showing Jev beats a static task→model table. *Recommend:* add to §13 a
   deterministic baseline (task default only), a cost-per-completed-task definition, and a kill criterion (drop
   Jev routing if shadow shows no win); P3 shadow should call Jev **asynchronously** so it adds no latency.
3. **Decision-cache key uses only the last user message.** "yes"/"continue"/tool-result turns collide across
   unrelated conversations, and agent loops often end on a `tool` message. *Recommend:* include a context-size
   bucket + `uses_tools`/`has_image` in the key and classify the last *user* turn plus a one-line state summary.
4. **Scoring (§5.3) is under-specified and partly weak.** Components with different scales (indices ×10,
   accuracies ×1000) have no stated normalisation or weights; `coding` and `agentic_files` lean on the
   airline-only tau-bench row; `writing` ranks by speed. *Recommend:* specify z-score/rank normalisation with
   explicit weights, mark tau-bench a weak proxy, and gate `writing` on a quality floor rather than speed.
5. **Jev balancing vs calibration (§7.1/§7.3).** Round-robin/weighted across sources with different Jev builds
   (`jev-1.13-free` vs `~typesafe/jev-latest`) makes probabilities incomparable, so one confidence threshold is
   meaningless. *Recommend:* default to pinned versions and strict priority until thresholds are tuned.
6. **Overlap with OmniRoute — resolved in v1.10** by the layering rule (account level = OmniRoute, model/pool level = jev-router; B5 is the prerequisite).
7. **P0 is too large** (scaffold + CI + image + GHCR release + cleanup + fetch pipeline). *Recommend:* split into
    P0a (repo/CI/schema/fetch) and P0b (image + GHCR), since P0b is not needed to validate the index.
8. **Release hygiene (§14.3).** A tag push rebuilds instead of retagging the tested image, and `latest` is
    claimed by both `master` pushes and releases (so it means neither). *Recommend:* promote the already-built
    digest on `v*` tags and drop `latest` entirely (prod pins a semver tag anyway).
9. **Minor:** the spec depends on companion files outside this repo (`~/src/warslop/...` fixtures, NOTES-62
    example) — copy the 23 fixtures and the worked example into `tests/`; fetch snapshots have no retention; the changelog
    residue ("struck", "corrected 2026-10-13") belongs in an appendix, not in the normative text; no inbound
    concurrency cap is specified.

10. **Zen pay-as-you-go spend — resolved by the owner (2026-10-14):** the credit balance is empty and non-Go models are out of every pool (§6.1 hard rule). Nothing to decide; kept only as a pointer.

Verify items (could not be checked from this file): Compose `env_file` `~` expansion; `aws-lc-rs` under the musl
target; the GitHub Action versions in §14.3; whether AA's Free shape actually carries the health/legal/finance
domain indexes (§5.3).
