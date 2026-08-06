import { z } from "zod";

export const migrationPlanSchema = z.object({
  strategy: z.string().min(1),
  steps: z
    .array(
      z.object({
        order: z.number().int().positive(),
        action: z.string().min(1),
        description: z.string().min(1).max(500),
        targetPath: z.string().optional(),
      }),
    )
    .min(1)
    .max(20),
  rationale: z.string().min(1).max(2000),
});
export type MigrationPlan = z.infer<typeof migrationPlanSchema>;

export const migrationPatchSchema = z.object({
  artifacts: z
    .array(
      z.object({
        kind: z.string().min(1),
        path: z.string().min(1).max(240),
        content: z.string().min(1).max(100_000),
        operation: z.string().min(1),
      }),
    )
    .min(1)
    .max(20),
  summary: z.string().min(1).max(1000),
});
export type MigrationPatch = z.infer<typeof migrationPatchSchema>;
