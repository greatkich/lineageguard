import { randomBytes } from "node:crypto";

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^run_[a-f0-9]{24}$/;
const EVENT_ID_PATTERN = /^evt_[a-f0-9]{24}$/;
const LEASE_ID_PATTERN = /^lease_[a-f0-9]{24}$/;

function suffix(): string {
  return randomBytes(12).toString("hex");
}

export function newRunId(): string {
  return `run_${suffix()}`;
}

export function newEventId(): string {
  return `evt_${suffix()}`;
}

export function newLeaseId(): string {
  return `lease_${suffix()}`;
}

export function newInternalId(prefix: string): string {
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(prefix)) throw new TypeError("invalid ID prefix");
  return `${prefix}_${suffix()}`;
}

function requirePattern(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new TypeError(`${label} has an invalid domain ID format`);
  return value;
}

export const requireRunId = (value: string) => requirePattern(value, RUN_ID_PATTERN, "run ID");
export const requireEventId = (value: string) =>
  requirePattern(value, EVENT_ID_PATTERN, "event ID");
export const requireLeaseId = (value: string) =>
  requirePattern(value, LEASE_ID_PATTERN, "lease ID");

export function requireFingerprint(value: string): string {
  if (!FINGERPRINT_PATTERN.test(value)) {
    throw new TypeError("input fingerprint must be a lowercase SHA-256 hex digest");
  }
  return value;
}
