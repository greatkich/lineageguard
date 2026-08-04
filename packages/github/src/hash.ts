import { createHash } from "node:crypto";

export function sha256Bytes(content: string): string {
  return sha256Buffer(Buffer.from(content, "utf8"));
}

export function sha256Buffer(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
