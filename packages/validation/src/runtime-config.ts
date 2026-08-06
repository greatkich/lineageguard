import { ValidationError } from "./errors.js";
import type { ValidationRuntimePolicy } from "./validator.js";

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new ValidationError("INVALID_PATH", `missing=${name}`);
  return value;
}

function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new ValidationError("INVALID_PATH", `invalid=${name}`);
  return Number(value);
}

export function loadValidationRuntimePolicy(
  environment: Readonly<Record<string, string | undefined>>,
): ValidationRuntimePolicy {
  return {
    baseFixtureSql: required(environment, "VALIDATION_BASE_FIXTURE_SQL"),
    dockerExecutable: required(environment, "VALIDATION_DOCKER_EXECUTABLE"),
    validationRunnerImageId: required(environment, "VALIDATION_RUNNER_IMAGE_ID"),
    postgresImageId: required(environment, "VALIDATION_POSTGRES_IMAGE_ID"),
    sqlDriverImplementationId: required(environment, "VALIDATION_SQL_DRIVER_IMPLEMENTATION_ID"),
    sqlDriverVersion: required(environment, "VALIDATION_SQL_DRIVER_VERSION"),
    dbtImplementationId: required(environment, "VALIDATION_DBT_IMPLEMENTATION_ID"),
    dbtVersion: required(environment, "VALIDATION_DBT_VERSION"),
    timeoutMs: integer(required(environment, "VALIDATION_COMMAND_TIMEOUT_MS"), "timeout"),
    maxOutputBytes: integer(required(environment, "VALIDATION_MAX_OUTPUT_BYTES"), "max_output"),
  };
}
