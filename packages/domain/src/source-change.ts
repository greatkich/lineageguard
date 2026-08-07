import { z } from "zod";

export const sourceChangeSchema = z.object({
  source: z.literal("GITHUB"),
  repository: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  pullRequestUrl: z.string().url(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  filePath: z.string().min(1),
  unifiedDiff: z.string().min(1),
  diffFingerprint: z.string().min(1),
});

export type SourceChange = z.infer<typeof sourceChangeSchema>;

export function validateSourceChange(
  input: unknown,
): { success: true; data: SourceChange } | { success: false; error: string } {
  const result = sourceChangeSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error.message };
}
