#!/usr/bin/env bash
# build-image.sh <upstream-tag> [--push]
# Clone upstream at the tag, apply patches, run the plugin unit tests, build the amd64
# `runner-web` target. Without --push the image is loaded into the local docker daemon.
# Env: IMAGE (default ghcr.io/bedasrv/omniroute), JEV_REV (default: file JEV_REV),
#      SKIP_TESTS=1, WORK (default ./.work), BUILD_MEMORY_MB (default 12288; upstream's CI value).
set -euo pipefail
TAG="${1:?upstream tag, e.g. v3.8.51}"; MODE="${2:---load}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-ghcr.io/bedasrv/omniroute}"
REV="${JEV_REV:-$(cat "$ROOT/JEV_REV")}"
VER="${TAG#v}"
WORK="${WORK:-$ROOT/.work}"
UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/diegosouzapw/OmniRoute.git}"

rm -rf "$WORK/upstream"; mkdir -p "$WORK"
git clone --quiet --depth 1 --branch "$TAG" "$UPSTREAM_REPO" "$WORK/upstream"
"$ROOT/scripts/apply-patches.sh" "$WORK/upstream" "$ROOT/patches"

if [ "${SKIP_TESTS:-0}" != 1 ]; then
  ( cd "$WORK/upstream" && npm ci --no-audit --no-fund >/dev/null && \
    DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 --import tsx/esm \
      --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts \
      --test --test-force-exit --test-concurrency=4 tests/unit/plugins-*.test.ts )
fi

TAGS=(-t "$IMAGE:$VER-jev$REV")
COMMON=(--platform linux/amd64 --target runner-web
        --build-arg OMNIROUTE_USE_TURBOPACK=0 --build-arg "OMNIROUTE_BUILD_MEMORY_MB=${BUILD_MEMORY_MB:-12288}"
        --label "org.opencontainers.image.revision=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
        --label "org.opencontainers.image.version=$VER-jev$REV"
        --label "org.opencontainers.image.source=https://github.com/diegosouzapw/OmniRoute")
if [ "$MODE" = "--push" ]; then
  docker buildx build "${COMMON[@]}" "${TAGS[@]}" --provenance=mode=max --sbom=true --push "$WORK/upstream"
else
  docker buildx build "${COMMON[@]}" "${TAGS[@]}" --load "$WORK/upstream"
fi
echo "built $IMAGE:$VER-jev$REV"
