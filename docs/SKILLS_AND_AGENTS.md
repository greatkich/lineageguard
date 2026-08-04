# Skills, MCP Servers, and Agent Roles

## Selection principles

Use skills and tools that reduce ambiguity or improve verification. Do not install every available MCP server or skill.

Priorities:

1. official or first-party source;
2. directly relevant to LineageGuard;
3. narrow permissions;
4. repository-local and reproducible where possible;
5. clear fallback when a tool is unavailable.

The runtime product and the development harness are separate:

- **Development skills** help Codex build and review the repository.
- **Runtime integrations** are part of LineageGuard itself.

## Required development framework

### Superpowers

Source: `obra/superpowers`.

Install through the official Codex plugin marketplace:

```text
/plugins
search: superpowers
Install Plugin
```

Required workflow skills:

- `brainstorming`;
- `writing-plans`;
- `using-git-worktrees`;
- `subagent-driven-development`;
- `test-driven-development`;
- `requesting-code-review`;
- `systematic-debugging`;
- `verification-before-completion`;
- `finishing-a-development-branch`.

Use Superpowers as the delivery methodology. Do not copy its planning logic into ad-hoc prompts.

## Required DataHub skills

Source: official `datahub-project/datahub-skills` repository, vendored from commit `f22f93074cf265ba6f9401947404f090c2584d9d` under Apache-2.0.

Verify the committed project-level snapshot from the repository root:

```bash
bash scripts/bootstrap-agent-tooling.sh
```

This command is offline and does not install or update anything. The exact eight-root, 55-file manifest and the reviewed `datahub-setup` security patch are documented in `docs/THIRD_PARTY_SKILLS.md` and authenticated by `skills-lock.json`.

Required skills for this project:

### `datahub-setup`

Use for:

- installing/configuring DataHub CLI access;
- verifying endpoint and token;
- defining the walkthrough scope/profile.

### `datahub-search`

Use for:

- resolving datasets, dashboards, models, owners, and fields;
- testing catalog discoverability.

### `datahub-lineage`

Use for:

- field/table lineage exploration;
- downstream impact analysis;
- verifying exact paths in the canonical scenario.

### `datahub-enrich`

Use for:

- controlled tag/owner/description/deprecation changes;
- reviewing the write-back plan before mutation.

### `datahub-quality`

Use for:

- understanding assertion capabilities;
- designing quality evidence and incidents;
- separating OSS-supported behavior from cloud-only behavior.

### `using-datahub` and shared references

Install with the repository bundle. These provide reusable MCP and CLI guidance used by the interaction skills.

Connector-planning and connector-review skills are optional. LineageGuard is not building a new connector in the core scope.

## Recommended official OpenAI Codex skills

Source: `openai/skills` curated catalog.

Install inside Codex with `$skill-installer`, then restart Codex.

### Essential

```text
$skill-installer playwright
$skill-installer playwright-interactive
$skill-installer screenshot
$skill-installer security-best-practices
$skill-installer security-threat-model
$skill-installer gh-fix-ci
$skill-installer gh-address-comments
$skill-installer openai-docs
```

Purpose:

| Skill | Use in LineageGuard |
|---|---|
| `playwright` | repository E2E tests and reproducible browser verification |
| `playwright-interactive` | local exploratory UI debugging and screenshot review |
| `screenshot` | consistent visual evidence for review/release |
| `security-best-practices` | implementation-level security checks |
| `security-threat-model` | trust-boundary and mutation-risk review |
| `gh-fix-ci` | inspect and fix failed GitHub Actions runs |
| `gh-address-comments` | resolve review comments systematically |
| `openai-docs` | verify current Agents SDK and Codex behavior from official docs |

`playwright-interactive` may require elevated/local capabilities. Keep normal Playwright tests as the portable CI source of truth.

### Optional

- `linear` only if the project backlog is moved to Linear;
- `sentry` only after the canonical walkthrough works and a Sentry project exists;
- an official deployment skill only if the deployment target changes to a supported platform.

Do not install Vercel/Netlify/Cloudflare deployment skills for the default VPS plan.

## Runtime MCP servers

### 1. DataHub MCP Server — required

Source: official `acryldata/mcp-server-datahub`.

Runtime responsibilities:

- search and entity resolution;
- schema inspection;
- lineage and exact paths;
- query history;
- entity metadata;
- controlled document/tag/structured-property write-back.

Read-phase allowlist:

```text
search
get_entities
list_schema_fields
get_lineage
get_lineage_paths_between
get_dataset_queries
```

Write-phase allowlist:

```text
save_document
add_tags
add_structured_properties
update_description        # only when the approved write-back design needs it
```

Mutation tools remain disabled by default and are enabled only for the explicit write-back process.

### 2. GitHub MCP Server — development optional, runtime not required

Source: official `github/github-mcp-server`.

Use for Codex development only when the native GitHub integration is insufficient. Start with:

- read-only mode for review/research;
- limited toolsets;
- a fine-grained token.

The LineageGuard application should use a typed GitHub API adapter rather than depend on an MCP server as a runtime architectural requirement.

### 3. AWS Agent Toolkit / AWS MCP — contingency only

Source: official `awslabs/mcp`.

AWS is not necessary for the MVP because an existing VPS is available. Installing broad AWS mutation tools would increase risk and context size.

If EC2 becomes necessary:

- begin with AWS documentation/knowledge tools;
- use infrastructure tools only inside a deployment-specific approved plan;
- require least-privilege credentials and human approval;
- do not expose generic AWS API mutation tools to the implementation agent by default.

## Runtime agent SDK

Use the OpenAI Agents SDK for TypeScript.

Relevant capabilities:

- TypeScript-first agent orchestration;
- Zod-backed structured outputs/tools;
- MCP stdio and Streamable HTTP support;
- tool filtering;
- guardrails;
- human approval;
- tracing;
- sandbox agents if a later plan proves they are preferable to the repository's explicit worktree sandbox.

The runtime starts with two bounded roles:

1. repository-only baseline assessor;
2. migration planner/generator.

Do not build a swarm. Deterministic application code orchestrates the overall workflow.

## Project-specific repository skills

This foundation includes four small skills under `.agents/skills/`. They encode project-specific repetition and should remain narrow.

### `lineageguard-impact-analysis`

Trigger when implementing or reviewing DataHub context collection, evidence normalization, or risk decisions.

### `lineageguard-walkthrough-verification`

Trigger before claiming the canonical walkthrough works or before walkthrough.

### `lineageguard-writeback-safety`

Trigger for any code that enables DataHub/GitHub mutations.

### `lineageguard-release-readiness`

Trigger during final README, examples, deployment, and walkthrough guide preparation.

These do not replace Superpowers or official DataHub skills.

## Agent role matrix

| Role | Primary skills | Main output |
|---|---|---|
| Product Architect | Superpowers brainstorming/writing-plans | feature spec and plan |
| DataHub Engineer | DataHub setup/search/lineage/enrich/quality | seeded graph and typed adapter |
| Domain Engineer | TDD, security best practices | policies and state machine |
| Agent Runtime Engineer | openai-docs, threat model | bounded agents and tool filters |
| Full-Stack Engineer | Playwright, screenshot | Mission Control UI |
| Independent Reviewer | requesting-code-review, security skills | severity-ranked findings |
| QA/Visual Reviewer | Playwright interactive, screenshot | browser evidence |
| Release Lead | walkthrough verification, release readiness | clean run and release assets |

## Installation order

Run from the repository root unless stated otherwise.

### Step 1 — verify base tools

```bash
node --version
pnpm --version
python3 --version
uv --version
docker --version
docker compose version
git --version
gh --version
codex --version
```

Target Node is 24 LTS and Python is 3.12.

### Step 2 — install Superpowers

Use `/plugins` in Codex and restart the session after installation.

### Step 3 — verify DataHub skills

```bash
bash scripts/bootstrap-agent-tooling.sh
```

The bootstrap must report the committed snapshot verified without network access. For a controlled upstream update, follow `docs/THIRD_PARTY_SKILLS.md`; do not run a floating installer against the working tree.

### Step 4 — install curated Codex skills

Use the `$skill-installer` commands listed above, restart Codex, then ask Codex to list the available skills.

### Step 5 — verify DataHub MCP

After DataHub is running and a token exists:

```bash
npx -y @acryldata/mcp-server-datahub init
```

Follow the current official prompts. Configure the MCP in the Codex environment using the current Codex documentation, then verify with the Codex MCP inspection command available in the installed version.

Do not assume that a project-local MCP configuration is loaded by every Codex surface. Confirm tool visibility in the exact CLI/App session that will execute the plan.

### Step 6 — optional GitHub/AWS MCP

Install only after a plan explicitly requires them.

## Version and supply-chain policy

- Verify current versions from official sources at planning time.
- Pin package versions in lockfiles.
- Pin vendored skills to an immutable upstream commit and authenticate every file with `skills-lock.json`.
- Keep skill bootstrap verification offline; update the snapshot only through the reviewed procedure in `docs/THIRD_PARTY_SKILLS.md`.
- Do not use unreviewed skills from broad community indexes for core implementation.
- Review skill files before installation because skills are executable instructions.
- Keep third-party licenses intact.
- Prefer first-party MCP servers and SDKs.
- Record adopted external tools in `docs/SOURCES.md` and an ADR when architectural.

## What not to install

Do not add these by default:

- generic browser MCP when Playwright skills/tests are sufficient;
- direct production database mutation MCP;
- broad filesystem/shell agents with unrestricted access;
- LangGraph or another orchestration framework;
- Kubernetes skills;
- a vector database;
- extra cloud providers;
- a large “full-stack developer” community skill pack.

A smaller trusted tool surface produces more reliable autonomous work.
