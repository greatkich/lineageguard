# Third-Party Agent Skills

LineageGuard vendors the official DataHub agent skills so development sessions use a reviewed, reproducible instruction set without executing an online installer.

## DataHub snapshot

- Repository: `https://github.com/datahub-project/datahub-skills`
- Commit: `f22f93074cf265ba6f9401947404f090c2584d9d`
- License: Apache-2.0
- Manifest: `skills-lock.json`
- Verified files: 55 regular files across the eight roots below

```text
.agents/skills/datahub-enrich
.agents/skills/datahub-lineage
.agents/skills/datahub-quality
.agents/skills/datahub-search
.agents/skills/datahub-setup
.agents/skills/load-standards
.agents/skills/shared-references
.agents/skills/using-datahub
```

`skills-lock.json` records every vendored path and SHA-256 digest. `node scripts/verify-agent-skills.mjs --root .` rejects a missing or non-immutable source ref, a missing, extra, changed, symlinked, or non-regular vendored file, an unexpected root, and inconsistent local-patch metadata. `bash scripts/bootstrap-agent-tooling.sh` is deliberately offline: it verifies the committed snapshot and never downloads, installs, or replaces skills.

## Reviewed local divergence

`.agents/skills/datahub-setup/SKILL.md` carries a repository-local security patch:

- upstream SHA-256: `1b809071bd46a853c4e1fbe28b63b6cb3b2473a17eb09b72c059c6afa0c773f7`
- vendored SHA-256: `ed4c2408e82ac09ff81ca6ce35bbd9e398555837a69d10251498a409a3e77ed5`

The patch prevents secrets from entering chat or command output, limits token-file checks to presence/ownership/mode metadata, requires HTTPS and verified CA trust for remote endpoints, forbids disabling TLS verification, pins the CLI example, and requires revocation/rotation after accidental disclosure. The manifest authenticates both the upstream and patched content so the divergence cannot be mistaken for upstream text.

## Controlled update procedure

1. In an isolated temporary checkout, fetch the official repository and select an explicit 40-hex commit. Never install a floating branch directly into this repository.
2. Review the selected commit, its Apache-2.0 licensing, every changed skill instruction, and any executable helper before copying files.
3. Copy only the eight declared roots above. Do not run `npx skills add` against the working tree.
4. Reapply and independently review the local `datahub-setup` security patch. Record its new upstream and vendored hashes and a precise patch description.
5. Update the source ref, exact root list, every file digest, and local-patch metadata in `skills-lock.json`.
6. Run:

   ```bash
   node --test scripts/verify-agent-skills.test.mjs
   node scripts/verify-agent-skills.mjs --root .
   bash scripts/bootstrap-agent-tooling.sh
   ```

7. Inspect the complete diff, including additions and deletions, before committing the snapshot update.

Any unexpected path, license change, mutable ref, verification failure, or security regression stops the update.
