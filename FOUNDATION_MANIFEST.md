# Foundation Bundle Manifest

This bundle contains the initial LineageGuard product and engineering foundation intended for the repository root.

## Files

- `README.md`
- `AGENTS.md`
- `CODEX_START_PROMPT.md`
- `.env.example`
- `.codex/config.toml.example`
- `scripts/bootstrap-agent-tooling.sh`
- `.agents/skills/lineageguard-impact-analysis/SKILL.md`
- `.agents/skills/lineageguard-walkthrough-verification/SKILL.md`
- `.agents/skills/lineageguard-writeback-safety/SKILL.md`
- `.agents/skills/lineageguard-release-readiness/SKILL.md`
- `docs/PRODUCT_VISION.md`
- `docs/PRODUCT_STRATEGY.md`
- `docs/ARCHITECTURE.md`
- `docs/PRODUCT_WALKTHROUGH.md`
- `docs/AGENT_HARNESS.md`
- `docs/SKILLS_AND_AGENTS.md`
- `docs/IMPLEMENTATION_HANDOFF.md`
- `docs/DECISIONS/ADR-001-typescript-first-hybrid.md`
- `docs/DECISIONS/ADR-002-deterministic-control-plane.md`
- `docs/SOURCES.md`

## Suggested commit

```text
docs: establish LineageGuard product and agent engineering foundation
```

## Apply to a local clone

From a parent directory containing the extracted bundle and the cloned repository:

```bash
rsync -av --exclude FOUNDATION_MANIFEST.md lineageguard-foundation/ lineageguard/
cd lineageguard
chmod +x scripts/bootstrap-agent-tooling.sh
git status
git diff --check
git add README.md AGENTS.md CODEX_START_PROMPT.md .env.example .codex .agents scripts docs
git commit -m "docs: establish LineageGuard product and agent engineering foundation"
git push origin main
```

Review the current README before replacing it if the repository has evolved since this bundle was generated.
