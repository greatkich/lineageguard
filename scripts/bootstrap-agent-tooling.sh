#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
LineageGuard agent-tooling bootstrap

This script performs an offline integrity check of the committed DataHub skill
snapshot. It never downloads, installs, or replaces agent instructions.
EOF

if ! command -v node >/dev/null 2>&1; then
  echo "Missing required command: node" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_dir/.." && pwd -P)"
node "$script_dir/verify-agent-skills.mjs" --root "$repository_root"

cat <<'EOF'

Next steps inside Codex:

1. Install Superpowers from /plugins and restart Codex.
2. Install curated official skills with $skill-installer:
   playwright
   playwright-interactive
   screenshot
   security-best-practices
   security-threat-model
   gh-fix-ci
   gh-address-comments
   openai-docs
3. Use the documented controlled-update flow when changing vendored skills.
4. Configure and verify the DataHub MCP server using current official docs.
5. Start with CODEX_START_PROMPT.md.
EOF
