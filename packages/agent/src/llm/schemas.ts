import { z } from "zod";

export const migrationPlanSchema = z
  .object({
    strategy: z.literal("expand-migrate-contract"),
    steps: z
      .array(
        z
          .object({
            order: z.number().int().positive(),
            action: z.enum([
              "ADD_COLUMN",
              "BACKFILL",
              "UPDATE_DBT_MODEL",
              "ADD_DBT_TEST",
              "DEPRECATE_COLUMN",
              "REQUEST_REVIEW",
              "CREATE_DOCUMENTATION",
            ]),
            description: z.string().min(1).max(500),
            targetPath: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    rationale: z.string().min(1).max(2000),
  })
  .strict();
export type MigrationPlan = z.infer<typeof migrationPlanSchema>;

export const migrationPatchSchema = z
  .object({
    artifacts: z
      .array(
        z
          .object({
            kind: z.enum([
              "SQL_MIGRATION",
              "ROLLBACK_SQL",
              "DBT_MODEL",
              "DBT_TEST",
              "MIGRATION_DOCUMENT",
            ]),
            path: z.string().min(1).max(240),
            content: z.string().min(1).max(100_000),
            operation: z.enum(["CREATE", "MODIFY"]),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    summary: z.string().min(1).max(1000),
  })
  .strict();
export type MigrationPatch = z.infer<typeof migrationPatchSchema>;
