import { CorruptDataError } from "./errors.js";
import type { StrictCodec } from "./types.js";

export function parsePersisted<T>(codec: StrictCodec<T>, value: unknown, label: string): T {
  try {
    return codec.parse(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "parser rejected value";
    throw new CorruptDataError(`persisted ${label} is corrupt: ${reason}`);
  }
}
