# LineageGuard — независимый аудит текущего MVP

## 1. Executive verdict

**NOT DEMO READY**

В репозитории уже создана сильная основа: канонический DataHub-граф, детерминированная risk policy, строгая схема migration candidate, полноценные пакеты validation, GitHub, DataHub write-back и durable RunStore. Но текущий интегрированный путь в apps/worker и scripts/demo.ts обходит большую часть этих компонентов отдельной упрощённой реализацией. В результате live DataHub может заменяться canonical fixture, risk engine — упрощённым решением по количеству evidence, часть validator checks выставляется в PASS без выполнения, а COMPLETED возможен без реального PR и проверенного write-back. Независимого CI или воспроизводимого runtime evidence для текущего HEAD также нет. Это нарушает главный тезис продукта: именно реальный DataHub должен изменить решение, после чего исполняемые проверки должны доказать безопасность миграции.

## 2. Reviewed change set

| Поле | Результат |
|------|-----------|
| Branch | main |
| Review base | 29173b98664a9b041b94746662e4b1fa67f20be9 — спецификация full E2E/UI |
| Reviewed HEAD | 53d04a64d2085b60a4b23a24cde1fe1ee018f5d4 — Docker validation commit |
| Диапазон | 25 последних implementation commits после E2E/UI spec |
| Uncommitted changes | Невозможно увидеть через remote GitHub API; локальный worktree Claude недоступен |
| Pull requests | Implementation после первого документационного PR выполнялся непосредственно в main |
| CI на HEAD | 0 commit statuses, 0 workflow runs |
| Режим ревью | Read-only; production-код не изменялся |

Основные проверенные компоненты:

- apps/worker/src/orchestration.ts
- apps/worker/src/index.ts
- apps/worker/src/simple-store.ts
- apps/worker/src/datahub-rest-port.ts
- packages/agent/src/pipeline.ts
- packages/agent/src/llm/*
- packages/domain/src/{evidence,risk,migration,run}.ts
- packages/validation/src/validator.ts
- packages/github/src/live-adapter.ts
- packages/datahub/src/{context-port,writeback}.ts
- packages/db/src/*
- apps/web/app/*
- tests/e2e/*
- scripts/demo.ts
- .env.example
- root package.json

Прочитаны source-of-truth документы: AGENTS.md, README.md, PRODUCT_VISION, PRODUCT_STRATEGY, ARCHITECTURE, PRODUCT_WALKTHROUGH, AGENT_HARNESS, IMPLEMENTATION_HANDOFF, ADR-001 и ADR-002. Документы требуют deterministic control plane, реальные DataHub URN/evidence, исполняемые validator receipts, persisted workflow state и отсутствие fake UI values.

## 3. Evidence observed

### Фактически выполненные проверки

| Проверка | Результат |
|----------|-----------|
| `git clone` | FAIL, exit 128 — Could not resolve host: github.com |
| `node --version` | v22.16.0 |
| `pnpm --version` | FAIL, command not found |
| `docker --version` | FAIL, command not found |
| `python3 --version` | Python 3.13.5 |
| `uv --version` | uv 0.10.0 |
| GitHub combined status for HEAD | 0 statuses |
| GitHub workflow runs for HEAD | 0 runs |
| `pnpm format:check` | NOT RUN |
| `pnpm lint` | NOT RUN |
| `pnpm typecheck` | NOT RUN |
| `pnpm test` | NOT RUN |
| `pnpm build` | NOT RUN |
| `pnpm demo` | NOT RUN |
| `pnpm walkthrough:verify` | NOT RUN |
| DataHub live graph verification | NOT PROVEN |
| GitHub PR creation | NOT PROVEN |
| DataHub write-back and read-back | NOT PROVEN |

Reviewer environment не соответствует требованиям репозитория: проект требует Node 24 и pnpm 11.20, а также использует Docker для validation. Это ограничение среды само по себе не является дефектом кода, но в репозитории нет CI evidence, которое могло бы заменить локальный запуск.

Кроме того, текущий walkthrough:verify выполняет только format, lint, typecheck, tests, build и Playwright. Он не запускает pnpm demo, Python tests, live DataHub graph verification, dbt build, DataHub write-back verification или secret scan.

Поэтому заявления из commit messages — «355 tests pass», «8/8 PASS», «full pipeline COMPLETED» — не приняты как независимое доказательство.

## 4. MVP gate matrix

| Gate | Status | Evidence | Blocking gap | Smallest required fix |
|------|--------|----------|--------------|----------------------|
| A. Clean execution | FAIL | Скрипты существуют, но env names расходятся с кодом, developer-specific paths, Playwright ожидает заранее заполненную БД, worker не исполняет runs | Нет одной clean-start команды | Исправить env contract; объединить demo и worker; сделать fresh setup/run/verify |
| B. Real DataHub graph | FAIL | Canonical graph manifest и строгий MCP adapter реализованы, но live fallback заменяет реальный ответ fixture и использует неправильный dataset URN | Нет доказательства, что четыре consumers прочитаны из DataHub | Только official typed port в LIVE; fixture только в VERIFIED_REPLAY |
| C. DataHub changes decision | FAIL | Risk engine существует, но при ошибке pipeline делает evidence count > 0 → BLOCK без rule/evidence IDs | ALLOW → BLOCK может появиться без валидного DataHub context | Удалить fallback decision; invalid context → FAILED_CONTEXT |
| D. Migration generation | PARTIAL | LLM генерирует artifacts, но schema разрешает произвольные kinds, operations и paths; строгий migrationCandidateSchema не используется | Candidate не связан с source change, evidence, owners и base SHA | Использовать strict domain candidate и template-constrained canonical artifacts |
| E. Deterministic validation | FAIL | DBT_COMPILE hardcoded PASS; equality query не проверяет count; structural mode выставляет compatibility PASS | «8/8 PASS» не является доказательством | Удалить ad-hoc validator и подключить @lineageguard/validation |
| F. Review artifact | FAIL | GitHub adapter написан, но pnpm demo его не подключает; ошибка PR может вернуть URL с prNumber: 0 | Нет наблюдаемого PR или exact validated fallback diff | Использовать strict LiveGitHubPort или committed validated review bundle |
| G. DataHub write-back | FAIL | Неправильный URN; non-2xx логируется; функция возвращает SUCCEEDED; read-back отсутствует | Запрос на запись ошибочно считается persistence proof | Подключить strict write-back с idempotency и read-back |
| H. Walkthrough | FAIL | UI показывает run list и базовые панели, но не реальные entities, generated files, validator receipts, PR, write-back или failure states | Нельзя показать полный narrative | Durable canonical run → полноценная run page → 8 Playwright states |

## 5. Critical findings

### C1. LIVE DataHub подменяется fixture и обращается к неправильному dataset URN

**Severity: Critical**

При MCP exception код делает REST lookup, проверяет лишь evidenceCount > 0, затем выбрасывает реальные REST данные и возвращает `createCanonicalImpactContextFixture(changeId)` как COLLECTED_LIVE. При этом fallback использует:

```
lineageguard-canonical.commerce.orders
```

Канонический manifest и domain constant фиксируют:

```
lineageguard-canonical.lineageguard.commerce.orders
```

**Affected files:** apps/worker/src/orchestration.ts, apps/worker/src/datahub-rest-port.ts, scripts/demo.ts

**Fix:** удалить REST→fixture fallback из LIVE. Использовать canonicalDatasetUrn и createOfficialLiveDataHubContextPort. Для contingency создать отдельный VERIFIED_REPLAY.

### C2. Deterministic policy может заменяться решением «есть evidence — значит BLOCK»

**Severity: Critical**

packages/agent/src/pipeline.ts перехватывает ошибку strict risk engine и вручную создаёт RiskComparison через `as any`. triggeredRuleIds и changedBecauseEvidenceIds остаются пустыми, а BLOCK определяется одним consumersFound > 0.

**Affected files:** packages/agent/src/pipeline.ts, tests/e2e/canonical-scenario.vitest.ts

**Fix:** удалить fallback. Ошибка context/policy → FAILED_CONTEXT/typed failure, без generation.

### C3. Migration candidate обходит строгую domain schema

**Severity: Critical**

LLM schema принимает любые kind, operation и path. Pipeline делает `candidate = {...} as any`. Строгая schema с allowlisted paths, SQL/rollback/dbt/test/document artifacts, base SHA, evidence binding уже существует в domain.

**Affected files:** packages/agent/src/llm/schemas.ts, packages/agent/src/pipeline.ts, packages/agent/src/steps/generate-patch.ts

**Fix:** deterministic template-constrained artifact builder. LLM → bounded plan/rationale only. Candidate проходит migrationCandidateSchema.

### C4. «8 validations» содержат ложные PASS

**Severity: Critical**

- DBT_COMPILE всегда PASS
- DBT_PARSE/TEST проверяют наличие файлов, не запускают dbt
- Backfill equality: SELECT COUNT(*) но не читает результат
- Structural mode: always PASS
- Model-generated SQL вставляется в shell через execSync
- Существующий @lineageguard/validation не подключён

**Affected files:** apps/worker/src/orchestration.ts, apps/worker/package.json, packages/validation

**Fix:** удалить ad-hoc createValidationPort; использовать executeEightChecks из packages/validation.

### C5. COMPLETED не означает PR + verified write-back

**Severity: Critical**

- Отсутствие validation port → validationPassed = true
- Отсутствие GitHub port → REVIEW_ARTIFACT_CREATED
- Write-back может быть пропущен
- AMBIGUOUS не блокирует COMPLETED
- Non-2xx DataHub → всё равно SUCCEEDED

**Fix:** COMPLETED только после persisted validation receipt, реального GitHub receipt и DataHub SUCCEEDED с read-back proof.

### C6. Worker, demo, persistence и UI не образуют одну систему

**Severity: Critical**

- Worker не вызывает orchestrator; poll loop только heartbeat
- scripts/demo.ts запускает отдельный in-memory pipeline
- UI показывает hardcoded values
- Timeline из последнего status, не из persisted events

**Fix:** один execution path: create run → worker claims → pipeline persists → UI reads.

## 6. Important findings

### I1. Tests не проверяют E2E

Canonical Vitest не требует COMPLETED, strict candidate, validator receipt, PR или write-back. Playwright предполагает pre-seeded DB.

### I2. Environment contract расходится с кодом

- DATABASE_URL vs LINEAGEGUARD_DATABASE_URL
- GITHUB_REPOSITORY vs GITHUB_REPO
- OPENAI_* vs OMNIROUTE_*
- Hardcoded пути: /Users/igorgarkusha/.local/bin/uvx

### I3. Нет CI

HEAD не имеет status checks или workflow runs.

### I4. State transitions до завершения операций

Pipeline пишет MIGRATION_PLANNED до LLM plan, пропускает VALIDATING, использует invalid WRITEBACK_COMPLETE.

## 7. Minor findings

- Документация: 6 validations vs pipeline: 8 checks
- scripts/demo.ts и orchestration.ts дублируют logic
- UI statusMap не покрывает все failure statuses
- .project-notes/ в .gitignore

## 8. Scope cuts

**Удалить из live path:**
- REST count → canonical fixture fallback
- Structural validation mode с PASS
- Отдельные adapters в scripts/demo.ts
- Hardcoded UI patch, strategy и baseline
- COMPLETED без receipts

**Сделать узко:**
- Только rename customer_id → buyer_id
- Только PostgreSQL/dbt canonical project
- Template-constrained migration artifacts
- Одна Mission Control run page
- Polling вместо SSE
- Один модельный provider/runtime

**Отложить:**
- Settings page, generic schema changes, дополнительные scenarios
- Multi-provider abstraction, arbitrary repository patches
- AWS deployment, multi-user/auth, additional agents
- Workflow editor, Slack integrations

## 9. Corrective work wave (Tasks 1-5)

См. секцию 10 для полного implementation prompt.

## 10. Ready-to-paste Claude implementation prompt

[Содержит полный промпт для implementation agent — см. исходный документ]

## 11. Re-review instructions

После correction wave независимый reviewer должен проверить полный diff и выполнить fresh commands.

## 12. Walkthrough readiness

| Claim | Status | Причина |
|-------|--------|---------|
| 4 hidden consumers protected | FAIL | UI использует общее число evidence, live path подменяет context fixture |
| 1 safe migration generated | NOT PROVEN | Candidate schema bypassed, artifacts не persisted |
| 6 validations passed | FAIL | Checks hardcoded или structural; dbt не запускается |
| 0 downstream systems broken | NOT PROVEN | Нет executable compatibility evidence |
