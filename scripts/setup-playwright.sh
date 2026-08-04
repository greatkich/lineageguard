#!/bin/sh
set -eu

expected_version=1.62.1
observed_version=$(pnpm exec playwright --version | awk '{ print $2 }')

if [ "$observed_version" != "$expected_version" ]; then
  printf 'playwright version mismatch: expected %s, observed %s\n' "$expected_version" "$observed_version" >&2
  exit 1
fi

pnpm exec playwright install chromium
