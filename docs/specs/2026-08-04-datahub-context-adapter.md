# DataHub Context Adapter

Status: approved for P0 implementation

## Outcome

Resolve the canonical PostgreSQL field in a live DataHub catalog and collect enough official MCP
evidence to turn the repository-only `ALLOW` assessment into an evidence-backed deterministic
`BLOCK`. Raw MCP payloads remain inside `@lineageguard/datahub`; all callers receive only strict
domain evidence with stable provenance and fingerprints.

## Runtime boundary

- `@lineageguard/datahub` exposes a `DataHubContextPort` with live and replay implementations.
- The live implementation uses the official MCP client SDK and the pinned official DataHub MCP
  server/configuration. Connection, authentication, transport, command, and timeout are explicit.
- Context collection is read-only. The client allowlists only the approved discovery, entity,
  schema, lineage, path, and query-history tools required by the canonical scenario.
- Mutation-capable tools are never exposed to the collector. Discovery fails if an allowlisted tool
  unexpectedly reports mutation semantics; unrelated additional read-only tools may be ignored.
- The process receives only the read credential and bounded environment. Secrets, raw authorization,
  server stderr, and raw metadata text are redacted from application logs.
- Replay loads a committed normalized fixture produced by a verified live collection and makes zero
  DataHub or MCP calls. Live and replay provenance are impossible to confuse.

## Domain collection contract

- The canonical identity is the exact DataHub platform-instance identity, not a logical alias:
  `urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)`.
  All downstream datasets, owners, tags, glossary terms, dashboards, models, and queries retain the
  corresponding `lineageguard-canonical` namespace from the verified graph.
- Resolution is explicit typed evidence. It binds the requested platform, platform instance,
  environment, database, schema, dataset, and field to the resolved dataset and schema-field URNs,
  with independent search provenance.
- A failure before unique resolution is a typed collection-failure result, not an `ImpactContext`
  carrying a fabricated resolved URN. `COMPLETE` and `PARTIAL` contexts exist only after successful
  resolution.
- Lineage paths retain ordered typed segments. Each segment records entity endpoints, field or
  entity granularity, and exact field paths where applicable; the canonical paths end at the real
  dashboard and model rather than at an intermediate dataset.
- Query evidence retains the DataHub query URN, `SYSTEM` source, exact dataset/schema-field subject,
  normalized statement fingerprint, observed usage count, and last-observed timestamp. Raw SQL is
  not part of the domain evidence contract.
- Schema, glossary, criticality, lifecycle, classification, and ownership fields remain
  machine-readable. Titles and summaries are presentation data and cannot substitute for them.
- `impactContextFingerprint` is the stable semantic fingerprint used by policy, generation, and
  validation. A separate collection fingerprint binds retrieval timestamps, invocation IDs, raw
  response fingerprints, and other audit provenance. Repeating the same semantic collection may
  change the collection fingerprint without changing the semantic fingerprint or evidence IDs.

## Canonical collection sequence

1. Search for the exact platform/environment/dataset and require one source dataset URN.
2. List schema fields and bind `commerce.orders.customer_id` with its native type/nullability.
3. Collect downstream lineage and exact mixed entity/field paths to the analytics revenue asset,
   Finance dashboard, fraud feature dataset, and production fraud model.
4. Read entity details for criticality/lifecycle plus real ownership of the Finance dashboard and
   fraud model.
5. Collect recent unmanaged query usage that proves `customer_id` was observed through ingested
   PostgreSQL query history, including source, subject, normalized fingerprint, count, and last time.
6. Collect the governed Customer Identifier glossary association on the source field.
7. Normalize, deduplicate, semantically bind, and validate the complete impact context through the
   accepted domain schemas.

Every normalized item preserves the MCP tool, invocation ID, retrieval timestamp, and SHA-256 of the
canonical raw response bytes. Stable evidence IDs derive from full normalized semantics, including
criticality, targets, payload, related evidence, and non-volatile provenance.

## Failure behavior

- Zero or multiple source matches are typed resolution failures, never best-effort selection.
- Missing required paths, downstream fields, critical owners, governed term, or ingested query proof
  makes canonical collection partial/failed and cannot be represented as complete.
- Tool absence, schema drift, malformed content, timeout, response-size overflow, and MCP termination
  produce bounded typed failures with tool/invocation references.
- Untrusted metadata descriptions, SQL, query text, URNs, and names are treated as data. They cannot
  alter tool access, prompts, commands, paths, or final policy.
- Pagination has fixed page/item/byte limits and detects cursor cycles.

## Replay fixture rule

A fixture may be committed only after the same normalized collection passes live verification. It
contains no tokens, credentials, private hostnames, raw query literals, personal data, or fabricated
receipts. A manifest records server/tool versions, collection fingerprint, source scenario marker,
and redaction method.

## Verification gates

- Contract tests use recorded official MCP-shaped responses for success, empty, ambiguity,
  pagination, missing fields, malformed schema, tool failure, timeout, and response limits.
- Tests prove raw response fingerprints differ from normalized semantic fingerprints and that a
  criticality/target/payload change changes the evidence ID.
- Tests prove mutation tools cannot be called, replay has zero transport calls, untrusted prompt-like
  metadata remains inert, and secret-bearing diagnostics are redacted.
- A live integration gate against the canonical disposable DataHub graph returns the exact accepted
  impact context and stable evidence IDs.
- Format, lint, typecheck, unit/contract tests, build, and package-boundary checks pass.

## Integration constraint

The adapter consumes the accepted domain change/evidence schemas and the verified canonical DataHub
graph. It does not evaluate risk, invoke a model, persist state, mutate DataHub, or invent missing
context.
