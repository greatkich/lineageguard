import { createHash } from "node:crypto";

export function sha256Bytes(content: string): string {
  return sha256Buffer(Buffer.from(content, "utf8"));
}

export function sha256Buffer(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function sha256CanonicalJson(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("canonical JSON contains an unsupported value");
}
