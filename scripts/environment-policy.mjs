import { pathToFileURL } from "node:url";

/**
 * Derived from what a canonical run actually consumes, not a round number.
 *
 *   validator runner image      ~0.5 GiB   (lineageguard/validation-runner)
 *   validator PostgreSQL image  ~0.5 GiB   (postgres:17)
 *   per-run container state     ~0.5 GiB   (ephemeral database + writable layers)
 *   worktree, evidence, shots   ~0.5 GiB
 *   Docker + OS headroom        ~2.0 GiB
 *                               ---------
 *                                 4.0 GiB
 *
 * The previous 30 GiB floor blocked the known demo host while the real requirement is under 1 GiB
 * of images plus working space, so it rejected healthy machines and told the operator nothing
 * actionable. Keep this derivation next to the number: if the image set grows, re-derive it.
 */
const REQUIRED_IMAGE_KILOBYTES = 1 * 1024 * 1024;
const REQUIRED_RUNTIME_KILOBYTES = 1 * 1024 * 1024;
const REQUIRED_HEADROOM_KILOBYTES = 2 * 1024 * 1024;
export const MINIMUM_FREE_KILOBYTES =
  REQUIRED_IMAGE_KILOBYTES + REQUIRED_RUNTIME_KILOBYTES + REQUIRED_HEADROOM_KILOBYTES;

export function evaluateEnvironment(observed) {
  const failures = [];
  if (!/^v24\./.test(observed.node)) failures.push(`node:${observed.node}`);
  if (observed.pnpm !== "11.20.0") failures.push(`pnpm:${observed.pnpm}`);
  if (!/^Python 3\.12\./.test(observed.python)) failures.push(`python:${observed.python}`);
  if (!/^Docker Compose version v?(?:2|5)\./.test(observed.compose)) {
    failures.push(`compose:${observed.compose}`);
  }
  if (observed.dockerServer.trim().length === 0) failures.push("docker:daemon unavailable");
  if (observed.freeKilobytes < MINIMUM_FREE_KILOBYTES) {
    const needGib = (MINIMUM_FREE_KILOBYTES / 1024 / 1024).toFixed(1);
    const haveGib = (observed.freeKilobytes / 1024 / 1024).toFixed(1);
    failures.push(`disk:${observed.freeKilobytes} (need ${needGib} GiB, have ${haveGib} GiB)`);
  }
  return { ok: failures.length === 0, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const observed = JSON.parse(process.argv[2]);
  const result = evaluateEnvironment(observed);

  if (result.ok) {
    console.log("environment: ok");
  } else {
    console.log("environment: failed");
    for (const failure of result.failures) console.log(`failure: ${failure}`);
    process.exitCode = 1;
  }
}
