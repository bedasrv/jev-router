#!/usr/bin/env bash
# apply-patches.sh <upstream-checkout> [patches-dir]
# For each patch, in order: already upstream (reverse applies cleanly) -> drop it;
# otherwise `git am --3way`. Exit 3 on a conflict so CI can open an issue and leave the
# previous image live.
set -euo pipefail
UP="$(cd "${1:?upstream checkout dir}" && pwd)"
PATCHES="$(cd "${2:-$(dirname "$0")/../patches}" && pwd)"
cd "$UP"
git config user.name "${GIT_AUTHOR_NAME:-jev-router-ci}"
git config user.email "${GIT_AUTHOR_EMAIL:-jev-router-ci@users.noreply.github.com}"
shopt -s nullglob
applied=0; dropped=0
for p in "$PATCHES"/*.patch; do
  if git apply --reverse --check "$p" 2>/dev/null; then
    echo "DROP  $(basename "$p"): already in upstream"; dropped=$((dropped+1)); continue
  fi
  if git am --3way "$p" >/dev/null 2>&1; then
    echo "APPLY $(basename "$p")"; applied=$((applied+1))
  else
    git am --abort >/dev/null 2>&1 || true
    echo "CONFLICT $(basename "$p") does not apply to $(git describe --tags --always)" >&2
    exit 3
  fi
done
echo "patches applied=$applied dropped=$dropped"
