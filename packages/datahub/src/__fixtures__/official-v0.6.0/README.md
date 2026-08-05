# Official DataHub MCP v0.6.0 contract fixtures

These generic payloads mirror the public tool return shapes and upstream tests at tag `v0.6.0`
(`9a6946daa7d30eb481c82dd8ee5e15ae6526a3c9`). They are parser contract inputs only.

They are not a LineageGuard live collection, replay bundle, verification receipt, or evidence that
the canonical DataHub graph was queried. A canonical replay fixture may be added only after a
successful live collection is independently verified.

Mutation source notes (sanitized):

- upstream repository: `acryldata/mcp-server-datahub`;
- immutable tag/commit: `v0.6.0` / `9a6946daa7d30eb481c82dd8ee5e15ae6526a3c9`;
- `save_document` accepts `id`, `title`, `content`, and `related_entities`;
- `add_tags` accepts one entity `urn` and `tag_urns`;
- both tools are mutation operations. LineageGuard requires explicit MCP mutation annotations and
  treats tool output only as transport evidence; read-after-write is authoritative;
- `save-document-result.json` and `add-tags-result.json` retain only generic official-shaped success
  envelopes. They contain no live receipt, catalog data, token, private host, or canonical claim.

No write-back replay fixture exists. Production exports intentionally provide no write-back replay
constructor until an authenticated, committed, independently verified LIVE receipt is available.
