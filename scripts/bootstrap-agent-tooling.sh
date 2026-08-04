#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
LineageGuard agent-tooling bootstrap

This script installs only the official project-level DataHub skills.
Superpowers and curated OpenAI skills must be installed interactively in Codex
so their current marketplace/installer behavior can be reviewed.
EOF

required=(node npm git)
for command_name in "${required[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

echo "Installing official DataHub skills for Codex into .agents/skills/ ..."
npx skills add datahub-project/datahub-skills -a codex

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
3. Review all added skill files and licenses before committing.
4. Configure and verify the DataHub MCP server using current official docs.
5. Start with CODEX_START_PROMPT.md.
EOF
