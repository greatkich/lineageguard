# F2 Proposed Change Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse the canonical Git diff into one stable typed field-rename change and fail closed on every unsupported or ambiguous change.

**Architecture:** Pure change types and parser rules live in `packages/domain`; worker adapters supply Git text and allowlisted repository context. The parser supports only the committed canonical SQL/dbt rename shape and returns typed errors instead of heuristics or partial results.

**Tech Stack:** TypeScript 6.0.3 strict mode, Zod 4.4.3, Vitest 4.1.10, Node.js 24.18.0.

## Global Constraints

- Branch `feat/f2-proposed-change-parser` starts from accepted F0.
- `packages/domain` imports no Next.js, database, MCP, GitHub, or model SDK modules.
- Parsing is pure and has no network, filesystem, Git process, or model dependency.
- Only `commerce.orders.customer_id -> buyer_id` syntax class is supported for P0; other changes return explicit errors.
- Repository context reads only allowlisted relative paths inside the isolated checkout.
- Stable IDs use canonical serialization plus SHA-256, never timestamps or random UUIDs.
- F4 supplies one active `AbortSignal`; every Git/filesystem adapter accepts it, terminates child work on abort, and returns no stale result after lease loss.

---

### Task 1: Define proposed-change and error contracts

**Files:**
- Create: `packages/domain/src/change.ts`
- Create: `packages/domain/src/canonical-json.ts`
- Create: `packages/domain/src/repository-context.ts`
- Create: `packages/domain/src/errors.ts`
- Create: `packages/domain/test/change.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: plain untrusted values at Zod boundaries.
- Produces: `DatasetRefSchema`, `ProposedChangeSchema`, `RepositoryChangeInputSchema`, `ChangeParseError`, and `stableChangeId`.

- [ ] **Step 1: Write failing schema and stable-ID tests**

```ts
import { describe, expect, it } from "vitest";
import { ProposedChangeSchema, stableChangeId } from "../src/change.js";

const canonical = {
  operation: "RENAME_FIELD",
  dataset: { platform: "postgres", env: "PROD", name: "commerce.orders" },
  before: { fieldPath: "customer_id", nativeType: "uuid" },
  after: { fieldPath: "buyer_id", nativeType: "uuid" },
  source: {
    repository: "greatkich/lineageguard",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    patchSha256: "c".repeat(64),
  },
};

describe("ProposedChange", () => {
  it("parses the canonical rename and derives a stable ID", () => {
    const parsed = ProposedChangeSchema.parse({ ...canonical, id: stableChangeId(canonical) });
    expect(parsed.id).toBe(stableChangeId(canonical));
    expect(parsed.operation).toBe("RENAME_FIELD");
  });

  it("rejects an unknown operation", () => {
    expect(() => ProposedChangeSchema.parse({ ...canonical, id: "x", operation: "DROP_TABLE" }))
      .toThrow();
  });
});
```

- [ ] **Step 2: Run test and observe missing contracts**

Run: `pnpm --filter @lineageguard/domain vitest run test/change.test.ts`
Expected: FAIL resolving `../src/change.js`.

- [ ] **Step 3: Implement strict Zod contracts and stable serialization**

```ts
import { createHash } from "node:crypto";
import { z } from "zod";

export const DatasetRefSchema = z.object({
  platform: z.literal("postgres"),
  env: z.literal("PROD"),
  name: z.string().regex(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/),
}).strict();

const FieldStateSchema = z.object({
  fieldPath: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  nativeType: z.string().nullable(),
}).strict();

export const ProposedChangeSchema = z.object({
  id: z.string().min(16),
  operation: z.literal("RENAME_FIELD"),
  dataset: DatasetRefSchema,
  before: FieldStateSchema,
  after: FieldStateSchema,
  source: z.object({
    repository: z.string().min(1),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    patchSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
}).strict();

export function stableChangeId(input: Omit<z.input<typeof ProposedChangeSchema>, "id">): string {
  const canonical = canonicalJson(input);
  return `chg_${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}
```

`canonicalJson` recursively sorts object keys while preserving array order and rejects `undefined`, non-finite numbers, class instances, and other non-JSON values. Tests must change nested dataset/field/source properties independently and prove that each changes the ID.

Implement `ChangeParseError` as a discriminated union with codes `NO_SUPPORTED_CHANGE`, `MULTIPLE_SUPPORTED_CHANGES`, `AMBIGUOUS_DATASET`, `UNSUPPORTED_OPERATION`, `UNSUPPORTED_SYNTAX`, and `INVALID_SOURCE_METADATA`; each variant carries safe file/line context but no arbitrary full file dump.

- [ ] **Step 4: Run domain tests and typecheck**

Run: `pnpm --filter @lineageguard/domain test && pnpm --filter @lineageguard/domain typecheck`
Expected: all PASS and no implicit `any`.

- [ ] **Step 5: Commit domain change contracts**

```bash
git add packages/domain/src/change.ts packages/domain/src/canonical-json.ts packages/domain/src/repository-context.ts packages/domain/src/errors.ts packages/domain/src/index.ts packages/domain/test/change.test.ts
git commit -m "feat: define proposed change contracts"
```

### Task 2: Add canonical and unsupported patch fixtures

**Files:**
- Create: `demo/scenarios/canonical/unsafe-rename.patch`
- Create: `demo/scenarios/canonical/repository-context.json`
- Create: `demo/scenarios/unsupported/multi-rename.patch`
- Create: `demo/scenarios/unsupported/type-change.patch`
- Create: `demo/scenarios/unsupported/dynamic-sql.patch`
- Create: `demo/scenarios/unsupported/unqualified-table.patch`
- Create: `packages/domain/test/fixtures.test.ts`

**Interfaces:**
- Consumes: canonical dbt project paths from F1 naming contract.
- Produces: immutable parser fixtures and checked SHA-256 values in `repository-context.json`.

- [ ] **Step 1: Write a failing fixture-integrity test**

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("pins the canonical patch fingerprint", async () => {
  const patch = await readFile("demo/scenarios/canonical/unsafe-rename.patch");
  const context = JSON.parse(
    await readFile("demo/scenarios/canonical/repository-context.json", "utf8"),
  ) as { patchSha256: string };
  expect(createHash("sha256").update(patch).digest("hex")).toBe(context.patchSha256);
});
```

- [ ] **Step 2: Run and observe missing fixtures**

Run: `pnpm --filter @lineageguard/domain vitest run test/fixtures.test.ts`
Expected: FAIL with `ENOENT`.

- [ ] **Step 3: Create exact patches and checked context**

The canonical patch changes only the supported schema/model declaration from `customer_id` to `buyer_id` while preserving the underlying native type. Include standard `diff --git`, `index`, `---`, `+++`, and hunk lines. The unsupported fixtures each isolate exactly one failure class. `repository-context.json` records repository, 40-character base/head fixture SHAs, patch hash, allowed paths, and dbt manifest hash.

- [ ] **Step 4: Run fixture integrity tests**

Run: `pnpm --filter @lineageguard/domain vitest run test/fixtures.test.ts`
Expected: PASS and canonical hash matches exactly.

- [ ] **Step 5: Commit immutable fixtures**

```bash
git add demo/scenarios packages/domain/test/fixtures.test.ts
git commit -m "test: add proposed change parser fixtures"
```

### Task 3: Implement the pure supported-rename parser

**Files:**
- Create: `packages/domain/src/change-parser.ts`
- Create: `packages/domain/test/change-parser.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `RepositoryChangeInput` containing trusted source metadata and untrusted patch text.
- Produces: `parseProposedChange(input): Result<ProposedChange, ChangeParseError>`.

- [ ] **Step 1: Write red canonical and failure tests**

```ts
describe("parseProposedChange", () => {
  it("parses the canonical field rename", async () => {
    const result = parseProposedChange(await canonicalInput());
    expect(result).toMatchObject({
      ok: true,
      value: {
        operation: "RENAME_FIELD",
        dataset: { name: "commerce.orders" },
        before: { fieldPath: "customer_id" },
        after: { fieldPath: "buyer_id" },
      },
    });
  });

  it.each([
    ["multi-rename.patch", "MULTIPLE_SUPPORTED_CHANGES"],
    ["type-change.patch", "UNSUPPORTED_OPERATION"],
    ["dynamic-sql.patch", "UNSUPPORTED_SYNTAX"],
    ["unqualified-table.patch", "AMBIGUOUS_DATASET"],
  ])("fails closed for %s", async (fixture, code) => {
    const result = parseProposedChange(await unsupportedInput(fixture));
    expect(result).toMatchObject({ ok: false, error: { code } });
  });
});
```

- [ ] **Step 2: Run tests and observe missing parser**

Run: `pnpm --filter @lineageguard/domain vitest run test/change-parser.test.ts`
Expected: FAIL because `parseProposedChange` is not exported.

- [ ] **Step 3: Implement a line-oriented diff parser for the supported grammar**

Parse file headers and hunks, retain paired removed/added lines, and match only the explicit canonical grammar:

```ts
const qualifiedRename = /alter\s+table\s+([a-z_][\w]*)\.([a-z_][\w]*)\s+rename\s+column\s+([a-z_][\w]*)\s+to\s+([a-z_][\w]*)/i;
```

Also support the exact schema-YAML removed/added column-name pair only when the changed file belongs to the canonical dbt source/model allowlist and a unique qualified dataset mapping exists in repository context. Normalize comments/whitespace before matching, but never infer a dataset from a bare field name. Collect all candidates, then return zero/one/multiple results explicitly. Construct `ProposedChange` and validate it through `ProposedChangeSchema` before success.

- [ ] **Step 4: Run parser tests and deterministic repeat test**

Run: `pnpm --filter @lineageguard/domain vitest run test/change-parser.test.ts --repeat=20`
Expected: all canonical and failure cases PASS on every repeat.

- [ ] **Step 5: Commit the pure parser**

```bash
git add packages/domain/src/change-parser.ts packages/domain/src/index.ts packages/domain/test/change-parser.test.ts
git commit -m "feat: parse the supported field rename"
```

### Task 4: Build allowlisted repository context and Git diff source

**Files:**
- Create: `apps/worker/src/change/git-diff-source.ts`
- Create: `apps/worker/src/change/repository-context-source.ts`
- Create: `apps/worker/src/change/parse-proposed-change.ts`
- Create: `apps/worker/test/change/git-diff-source.test.ts`
- Create: `apps/worker/test/change/repository-context-source.test.ts`
- Create: `apps/worker/test/change/parse-proposed-change.test.ts`

**Interfaces:**
- Consumes: absolute isolated checkout root, repository slug, base/head SHA.
- Produces: `GitDiffSource.load(locator, options: { signal: AbortSignal }): Promise<RepositoryChangeInput>` and `RepositoryContextSource.collect(root, options: { signal: AbortSignal }): Promise<RepositoryContextBundle>`.

- [ ] **Step 1: Write red path-policy, adapter, and cancellation tests**

```ts
it("rejects an allowlisted path that resolves outside the checkout", async () => {
  const source = new RepositoryContextSource(["../secret.env"]);
  await expect(source.collect(fixtureRoot)).rejects.toMatchObject({ code: "PATH_OUTSIDE_CHECKOUT" });
});

it("does not silently truncate git diff stderr", async () => {
  const git = fakeGit({ exitCode: 128, stderr: "fatal: bad revision" });
  await expect(new GitDiffSource(git).load(locator)).rejects.toMatchObject({
    code: "GIT_DIFF_FAILED",
    safeMessage: "fatal: bad revision",
  });
});
```

Pass one signal through `parse-proposed-change.ts`, both sources, and the Git process runner. Abort a deliberately blocked Git fixture and a delayed filesystem read; assert the child exits, no normalized input is returned, and the F4 harness cannot commit a parser receipt or transition with the stale claim token.

- [ ] **Step 2: Run tests and observe missing adapters**

Run: `pnpm --filter @lineageguard/worker vitest run test/change`
Expected: FAIL resolving source modules.

- [ ] **Step 3: Implement bounded Git and filesystem adapters**

Invoke Git with an argument array, never a shell string: `git diff --no-ext-diff --unified=3 <base>..<head> -- <allowlisted paths>`. Validate SHAs against `/^[0-9a-f]{40}$/`. Cap stdout/stderr bytes, apply a timeout, and return a typed error. Pass the caller signal to the child; on abort use the shared bounded `SIGTERM` then `SIGKILL` policy and discard output. Resolve each repository path with `realpath`; check the signal between bounded reads, require the resolved path to equal or start with `${realRoot}/`, and reject symlink escapes. Hash content and return normalized file metadata, never secrets or arbitrary hidden files.

`parse-proposed-change.ts` composes only these adapters and the pure parser, accepts `WorkerStepExecutionContext.signal`, and passes that identical object through every I/O call; it writes no database state yet.

- [ ] **Step 4: Run worker adapter and integration fixture tests**

Run: `pnpm --filter @lineageguard/worker test -- change && pnpm --filter @lineageguard/worker typecheck`
Expected: PASS for canonical checkout fixture, Git failure, timeout, oversize output, parent traversal, and symlink escape.

- [ ] **Step 5: Commit bounded repository adapters**

```bash
git add apps/worker/src/change apps/worker/test/change
git commit -m "feat: load bounded repository change context"
```

### Task 5: Document, review, and verify F2

**Files:**
- Modify: `README.md`
- Create: `examples/canonical/proposed-change.json`
- Create: `scripts/demo-change-parse.ts`
- Create: `scripts/demo-change-parse.test.ts`
- Modify: `package.json`
- Review: complete F2 diff.

**Interfaces:**
- Consumes: parser output.
- Produces: checked example and F3-ready `ProposedChange` contract.

- [ ] **Step 1: Write the failing CLI ownership tests**

Test that the command accepts no path/SHA argument, reads the exact committed canonical fixtures, emits one strict `ProposedChange`, produces byte-identical output twice, and performs no network or write outside stdout.

- [ ] **Step 2: Run the CLI test and observe the missing entry point**

Run: `pnpm vitest run scripts/demo-change-parse.test.ts`
Expected: FAIL resolving `scripts/demo-change-parse.ts`.

- [ ] **Step 3: Implement the CLI and verify the checked example**

Implement `scripts/demo-change-parse.ts` as an erasable-syntax-only Node 24 no-argument CLI that reads only the committed canonical patch/context fixtures, invokes the same parser boundary through relative/package exports, prints Zod-validated JSON, and rejects path/SHA overrides. Own the root script as `"demo:change:parse": "node scripts/demo-change-parse.ts"`; do not add a second TypeScript runner. Run:

```bash
pnpm demo:change:parse > examples/canonical/proposed-change.json
pnpm demo:change:parse | diff -u examples/canonical/proposed-change.json -
```

Expected: no diff. Document the supported grammar and each error code in README.

- [ ] **Step 4: Commit CLI, docs, and example**

```bash
git add package.json scripts/demo-change-parse.ts scripts/demo-change-parse.test.ts README.md examples/canonical/proposed-change.json
git commit -m "docs: publish canonical proposed change example"
```

- [ ] **Step 5: Run independent specification review**

Fresh read-only reviewer maps every F2 acceptance example to a test and checks the output against the canonical scenario. Reviewer specifically looks for heuristic silent degradation, extra supported scope, unstable IDs, and domain-boundary imports. Resolve blockers test-first.

- [ ] **Step 6: Run independent code-quality/security review**

Different reviewer inspects diff parsing correctness, error taxonomy, process argument safety, path containment, symlink handling, output caps, deterministic hashing, and test quality. Resolve blockers in focused commits.

- [ ] **Step 7: Invoke verification-before-completion**

Run:

```bash
pnpm format:check
pnpm lint
pnpm --filter @lineageguard/domain typecheck
pnpm --filter @lineageguard/domain test
pnpm --filter @lineageguard/worker typecheck
pnpm --filter @lineageguard/worker test -- change
pnpm demo:change:parse | diff -u examples/canonical/proposed-change.json -
```

Expected: all zero; unsupported fixtures fail only inside asserted tests; canonical output is stable. Attach reviewer evidence and stop before F3.
