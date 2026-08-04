import { createHash } from "node:crypto";

export function sha256Bytes(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}
