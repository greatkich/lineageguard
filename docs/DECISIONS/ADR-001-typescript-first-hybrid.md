# ADR-001: TypeScript-First Hybrid Architecture

- Status: Accepted
- Date: 2026-08-03
- Decision owners: LineageGuard project

## Context

LineageGuard needs:

- a polished React interface;
- a web/BFF layer;
- a durable worker;
- typed domain contracts shared across UI and backend;
- an agent runtime with MCP integration and structured outputs;
- DataHub ingestion and metadata seeding;
- dbt-based validation;
- delivery in approximately one week.

The main implementation choice is whether the backend should be Python or TypeScript.

## Options considered

### Option A — Python backend + TypeScript frontend

Potential stack:

- FastAPI/Pydantic/Agents SDK Python;
- Next.js/React frontend;
- Python DataHub SDK and dbt tooling.

Advantages:

- Python is native to much of the data ecosystem;
- strong DataHub SDK and ingestion ergonomics;
- convenient SQL/data manipulation;
- familiar agent ecosystem.

Disadvantages:

- two full application languages and build systems;
- duplicated API/domain schemas or a code-generation layer;
- slower UI/backend iteration;
- additional deployment/service boundary;
- more integration work during a short hackathon;
- official DataHub MCP and the selected TypeScript agent runtime fit naturally into Node.

### Option B — Pure TypeScript

Potential stack:

- Next.js + Node worker;
- TypeScript for all ingestion and demo tooling.

Advantages:

- one language;
- shared types;
- fast frontend/backend iteration;
- compact deployment.

Disadvantages:

- fights the Python-native DataHub ingestion and dbt ecosystem;
- risks rebuilding official tooling;
- makes metadata seeding unnecessarily awkward.

### Option C — TypeScript-first hybrid

Potential stack:

- Next.js + React;
- Node worker;
- OpenAI Agents SDK TypeScript;
- official DataHub MCP Server;
- shared Zod/domain contracts;
- Python 3.12 + uv only for DataHub ingestion/metadata utilities;
- dbt Core for transformations and tests.

Advantages:

- one primary application language;
- shared runtime types between UI, worker, and adapters;
- direct TypeScript-first agent/MCP integration;
- preserves the strongest Python tools for DataHub and dbt;
- no second HTTP backend;
- lower coordination cost for coding agents;
- easy monorepo development and deployment.

Disadvantages:

- still contains two languages;
- Python tooling needs its own quality gates;
- team must maintain a clear boundary so Python does not become a shadow backend.

## Decision

Adopt **Option C: TypeScript-first hybrid**.

TypeScript owns all product runtime behavior:

- web UI and BFF;
- worker orchestration;
- domain model and policy;
- OpenAI Agents SDK integration;
- DataHub MCP adapter;
- GitHub adapter;
- persistence;
- validation orchestration.

Python is limited to:

- DataHub ingestion and metadata emission;
- canonical graph seeding and verification where official Python APIs are advantageous;
- dbt-related utility scripts if required.

Python must not expose a second product HTTP API in the MVP.

## Why this is the best hackathon decision

The UI is part of the judging artifact, not an optional admin screen. TypeScript lets the same team/agent move quickly between the React experience and the orchestration layer without translating every domain contract.

The selected TypeScript Agents SDK provides structured TypeScript/Zod tools, MCP integration, guardrails, tracing, and human-in-the-loop mechanisms. DataHub's official skills target Codex and its official MCP server is the primary runtime interface.

At the same time, forcing DataHub ingestion and dbt setup into TypeScript would discard mature official Python tooling. The hybrid boundary captures both advantages without paying for two full backends.

## Consequences

### Positive

- faster end-to-end feature delivery;
- shared schemas and event types;
- one product runtime deployment model;
- strong React integration;
- clean MCP adapter in the main language;
- Python remains available where it adds real value.

### Negative

- CI must run Node and Python checks;
- Docker images and local tooling need both runtimes;
- architecture reviews must enforce the Python tooling boundary.

## Guardrails

- `packages/domain` is TypeScript and infrastructure-free.
- Python code lives under `tools/datahub` or another explicitly approved tooling path.
- Python cannot own run state, safety policy, or product endpoints.
- Cross-language exchange uses committed configuration/data formats or command contracts, not duplicated business logic.
- Any proposal for a Python backend requires a superseding ADR with measured evidence.
