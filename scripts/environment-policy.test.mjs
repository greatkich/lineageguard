import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEnvironment, MINIMUM_FREE_KILOBYTES } from "./environment-policy.mjs";

const valid = {
  node: "v24.18.0",
  pnpm: "11.20.0",
  python: "Python 3.12.13",
  compose: "Docker Compose version v5.3.1",
  dockerServer: "29.6.2",
  freeKilobytes: 5 * 1024 * 1024,
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
    pnpm: "10.30.3",
    python: "Python 3.11.3",
    compose: "docker-compose version 1.29.2",
    dockerServer: "",
    freeKilobytes: 1 * 1024 * 1024,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.split(":")[0]),
    ["node", "pnpm", "python", "compose", "docker", "disk"],
  );
});

test("the disk floor is derived from the real image set, not an arbitrary round number", () => {
  // Two validator images under ~1 GiB plus working space; a 30 GiB floor rejected healthy hosts.
  assert.equal(MINIMUM_FREE_KILOBYTES, 4 * 1024 * 1024);
  assert.ok(MINIMUM_FREE_KILOBYTES < 8 * 1024 * 1024, "floor must not exceed a modest dev disk");
});

test("a disk failure states both the requirement and the observation", () => {
  const result = evaluateEnvironment({ ...valid, freeKilobytes: 1024 });
  assert.equal(result.ok, false);
  const failure = result.failures.find((entry) => entry.startsWith("disk:"));
  assert.match(failure, /need 4\.0 GiB/);
  assert.match(failure, /have 0\.0 GiB/);
});
