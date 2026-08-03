# Official Research Sources

This document records the primary sources used for the initial product, architecture, and agent-harness decisions. Verify current versions and installation commands again at implementation time.

## Hackathon

- Build with DataHub: The Agent Hackathon — overview, requirements, categories, prizes, judges, and judging criteria: https://datahub.devpost.com/
- Official rules: https://datahub.devpost.com/rules

## DataHub

- DataHub open-source repository: https://github.com/datahub-project/datahub
- Official DataHub MCP Server: https://github.com/acryldata/mcp-server-datahub
- DataHub MCP documentation: https://docs.datahub.com/docs/features/feature-guides/mcp
- Official DataHub skills for agents: https://github.com/datahub-project/datahub-skills
- DataHub lineage SDK tutorial: https://github.com/datahub-project/datahub/blob/master/docs/api/tutorials/lineage.md

## Codex and agent skills

- OpenAI Codex repository: https://github.com/openai/codex
- OpenAI skills catalog for Codex: https://github.com/openai/skills
- Superpowers development methodology: https://github.com/obra/superpowers

## OpenAI Agents SDK

- TypeScript Agents SDK documentation: https://openai.github.io/openai-agents-js/
- MCP integration guide: https://openai.github.io/openai-agents-js/guides/mcp/
- Agents guide: https://openai.github.io/openai-agents-js/guides/agents/

## GitHub integration

- Official GitHub MCP Server, useful as an optional development tool: https://github.com/github/github-mcp-server
- GitHub REST API documentation: https://docs.github.com/en/rest

## Web and runtime

- Next.js documentation: https://nextjs.org/docs
- Node.js release schedule: https://nodejs.org/en/about/previous-releases
- Biome documentation: https://biomejs.dev/
- Playwright documentation: https://playwright.dev/docs/intro
- pnpm workspaces: https://pnpm.io/workspaces

## Data and validation

- dbt Core: https://github.com/dbt-labs/dbt-core
- PostgreSQL documentation: https://www.postgresql.org/docs/
- uv documentation: https://docs.astral.sh/uv/

## AWS contingency

- Official AWS Labs MCP servers and Agent Toolkit guidance: https://github.com/awslabs/mcp

## Source policy

- Prefer official docs and first-party repositories.
- Pin dependencies through lockfiles, not through this research document.
- Review installed skills before use; skill files are executable instructions for an agent.
- Record material technology changes in a new or superseding ADR.
