#!/bin/sh
set -eu

node_version=$(node --version 2>/dev/null || true)
pnpm_version=$(pnpm --version 2>/dev/null || true)
python_version=$(uv run --python 3.12 python --version 2>/dev/null || true)
compose_version=$(docker compose version 2>/dev/null || true)
docker_server=$(docker info --format '{{.ServerVersion}}' 2>/dev/null || true)
free_kilobytes=$(df -Pk . 2>/dev/null | awk 'NR == 2 { print $4 }' || true)

case "$free_kilobytes" in
  "" | *[!0-9]*) free_kilobytes=0 ;;
esac

observed_json=$(node -e '
  const [node, pnpm, python, compose, dockerServer, freeKilobytes] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    node,
    pnpm,
    python,
    compose,
    dockerServer,
    freeKilobytes: Number(freeKilobytes),
  }));
' "$node_version" "$pnpm_version" "$python_version" "$compose_version" "$docker_server" "$free_kilobytes")

printf 'node: %s\n' "${node_version:-unavailable}"
printf 'pnpm: %s\n' "${pnpm_version:-unavailable}"
printf 'python: %s\n' "${python_version:-unavailable}"
printf 'compose: %s\n' "${compose_version:-unavailable}"
printf 'docker: %s\n' "${docker_server:-daemon unavailable}"
printf 'disk: %s KiB available\n' "$free_kilobytes"

node "$(dirname "$0")/environment-policy.mjs" "$observed_json"
