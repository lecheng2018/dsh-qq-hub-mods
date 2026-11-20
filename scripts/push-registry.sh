#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'Direct registry pushes are disabled. Use the verified GitHub Release workflow and scripts/release.mjs.' >&2
exit 1
