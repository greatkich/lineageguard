export function migrationPlanPrompt(input: {
  table: string;
  field: string;
  operation: string;
  newName: string;
  consumers: Array<{ name: string; type: string; criticality: string }>;
}): string {
  const consumerList = input.consumers
    .map((consumer) => `- ${consumer.name} (${consumer.type}, ${consumer.criticality})`)
    .join("\n");

  return `You are a database migration expert. Generate an expand-migrate-contract migration plan.

## Proposed Change
Table: ${input.table}
Operation: ${input.operation} column "${input.field}" to "${input.newName}"

## Downstream Consumers Found
${consumerList}

## Requirements
1. The migration must be backward-compatible
2. Old column must remain accessible during transition
3. All known consumers must be updated
4. Add assertions to verify data integrity
5. Include a deprecation timeline
6. Include rollback instructions

Return a JSON object matching the migration plan schema.`;
}

export function migrationPatchPrompt(input: {
  plan: { steps: Array<{ action: string; description: string; targetPath?: string }> };
  table: string;
  field: string;
  newName: string;
  existingModels: string[];
}): string {
  const steps = input.plan.steps
    .map((step, index) => `${index + 1}. [${step.action}] ${step.description}`)
    .join("\n");

  return `You are a database migration code generator. Generate the actual migration artifacts.

## Migration Plan
${steps}

## Context
- Table: ${input.table}
- Old column: ${input.field}
- New column: ${input.newName}
- Existing dbt models to update: ${input.existingModels.join(", ") || "none"}

## Output Requirements
Generate actual SQL and dbt code for each artifact. Be precise and production-ready.
- SQL migrations go in walkthrough/migrations/
- dbt models go in walkthrough/models/
- dbt tests go in walkthrough/tests/
- Documentation goes in docs/migrations/

Return a JSON object matching the migration patch schema.`;
}
