import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("compose service boundaries", () => {
  it("defines distinct services with correct postgres image and health checks", () => {
    const env = {
      ...process.env,
      APP_POSTGRES_DB: "app",
      APP_POSTGRES_USER: "app",
      APP_POSTGRES_PASSWORD: "app",
      VALIDATION_POSTGRES_DB: "validation",
      VALIDATION_POSTGRES_USER: "validation",
      VALIDATION_POSTGRES_PASSWORD: "validation",
    };
    const output = execSync(
      "docker compose -f compose.yaml config --format json",
      {
        encoding: "utf8",
        env,
      },
    );
    const config = JSON.parse(output);

    // Two distinct services
    expect(Object.keys(config.services)).toContain("app-postgres");
    expect(Object.keys(config.services)).toContain("validation-postgres");

    // PostgreSQL 17.10 image
    expect(config.services["app-postgres"].image).toBe("postgres:17.10");
    expect(config.services["validation-postgres"].image).toBe("postgres:17.10");

    // Health checks exist
    expect(config.services["app-postgres"].healthcheck.test).toBeDefined();
    expect(
      config.services["validation-postgres"].healthcheck.test,
    ).toBeDefined();

    // Distinct volumes
    expect(config.volumes).toHaveProperty("app-postgres-data");
    expect(config.volumes).toHaveProperty("validation-postgres-data");

    // Distinct networks
    expect(config.networks).toHaveProperty("app-network");
    expect(config.networks).toHaveProperty("validation-network");

    // No DataHub internal service in application file
    const serviceNames = Object.keys(config.services);
    expect(serviceNames.find((s) => s.includes("datahub"))).toBeUndefined();
  });
});
