import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEnvironment } from "./environment-policy.mjs";

const valid = {
  node: "v24.18.0",
  python: "Python 3.12.13",
  compose: "Docker Compose version v5.3.1",
  dockerServer: "29.6.2",
  freeKilobytes: 31 * 1024 * 1024,
};

test("accepts the pinned runtime family and disk floor", () => {
  assert.deepEqual(evaluateEnvironment(valid), { ok: true, failures: [] });
});

test("accepts both supported Compose CLI major versions", () => {
  for (const compose of ["Docker Compose version v2.40.0", "Docker Compose version v5.3.1"]) {
    assert.deepEqual(evaluateEnvironment({ ...valid, compose }), { ok: true, failures: [] });
  }
});

test("reports every failed precondition without short circuiting", () => {
  const result = evaluateEnvironment({
    ...valid,
    node: "v22.23.0",
    python: "Python 3.11.3",
    compose: "docker-compose version 1.29.2",
    dockerServer: "",
    freeKilobytes: 2 * 1024 * 1024,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.split(":")[0]),
    ["node", "python", "compose", "docker", "disk"],
  );
});
