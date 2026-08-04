import { pathToFileURL } from "node:url";

export const MINIMUM_FREE_KILOBYTES = 30 * 1024 * 1024;

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
    failures.push(`disk:${observed.freeKilobytes}`);
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
