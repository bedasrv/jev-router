# jev-router

An OmniRoute plugin that picks the model for `free` / `paid` requests, plus the small upstream patch it needs and the pipeline that publishes a patched OmniRoute image.

- `jev-router-spec.md` — the design (v2.0), test results and open items.
- `plugin/` — the plugin (`onRoute` hook): `policy.example.json` → copy to `policy.json` (git-ignored; order, facts, denylist, listing sources, with your own hosts and key path), eligibility, list builder, decision log. `node --test plugin/test/`; `node plugin/check.mjs` prints the pools against the live listings.
- `patches/` — `git format-patch` output against upstream OmniRoute: `0001` adds the `onRoute` hook (the plugin picks the model list), `0002` adds the one-way `onRouteResult` hook (per-attempt outcomes, so the plugin can see failures and demote failing models), `0007` adds route provenance to the response head of a successful plugin-routed combo (`x-omniroute-route`, `x-omniroute-attempts`, `x-router-reason`, `x-router-confidence`), `0008` applies the `onRoute` thinking selection to the request body (`reasoning_effort` or `thinking.enabled/disabled`; budget-only models are omitted in v1). Upstream v3.8.52 makes the 110 s streaming fetch-start cap configurable itself (`OMNIROUTE_FETCH_START_TIMEOUT_CAP_MS`, 0 = off); the former 0007 did that for v3.8.51 (`FETCH_START_TIMEOUT_CAP_MS`, image `3.8.51-jev8`) and is gone. The only changes to OmniRoute.
- `scripts/` — `latest-upstream-tag.sh`, `apply-patches.sh` (drops a patch upstream already has; exit 3 on conflict), `build-image.sh <tag> [--push]`.
- `.github/workflows/build.yml` — daily: newest upstream tag → patch → plugin tests → amd64 `runner-web` image → `ghcr.io/<owner>/omniroute:<ver>-jev<rev>` with provenance and SBOM. Conflict → issue; previous image stays live.
- `deploy/docker-compose.example.yml` — production compose, digest-pinned, plugin dir mounted.
- `plugin/ops/` — one-off OmniRoute config scripts (`register-models.py`, `recreate-combos.py`, `split-ocpaid.py`, `set-request-queue.py`), dry run by default; `apply-effort-policy.mjs` generates every model's `thinking` map from the bundled warslop effort-table/effort-policy-draft data (dead routes removed, unknown = omit).
- `plugin/report.mjs` — shadow-mode evaluation of Jev against the static order (`node plugin/report.mjs plugin/decisions.jsonl`).
- `JEV_REV` — bump when `patches/` or the build changes without an upstream release (image tag `<ver>-jev<rev>`).

Local build (needs ~12 GB free RAM and Docker): `scripts/build-image.sh v3.8.51` (`SKIP_TESTS=1` to skip `npm ci` + tests).

Updating the patch: edit in a clone of upstream on a branch, `git format-patch -1 -o patches/`, bump `JEV_REV`.
