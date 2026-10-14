#!/usr/bin/env bash
# Prints the newest stable upstream release tag (vX.Y.Z, no -rc/-beta), e.g. v3.8.51.
set -euo pipefail
UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/diegosouzapw/OmniRoute.git}"
git ls-remote --tags --refs "$UPSTREAM_REPO" 'v*' \
  | awk '{sub("refs/tags/","",$2); print $2}' \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort -V | tail -n1
