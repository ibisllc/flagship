import { BOX_RELEASE } from "@flagship/protocol";

/** True when `version` (e.g. "24.22.1" or "v24.22.1") is at least `floor`. */
export function nodeMeetsFloor(version: string, floor: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split("-")[0]!.split(".").map((p) => Number.parseInt(p, 10));
  const a = parse(version);
  const b = parse(floor);
  if (a.length < 3 || b.length < 3 || [...a, ...b].some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

/**
 * SEC-NODE-001: a daemon on a Node below the security floor serves TLS and holds
 * keys on a runtime with known fixed vulnerabilities, so it refuses to start.
 * Boxes install the Node that ships in their signed release; this is the backstop
 * for a box that was started by hand or a release built on an old Node.
 * `FLAGSHIP_ALLOW_OLD_NODE=1` is for developer machines only and is logged.
 */
export function assertNodeFloor(
  version: string = process.versions.node,
  floor: string = BOX_RELEASE.nodeFloor,
  env: NodeJS.ProcessEnv = process.env,
  log: (m: string) => void = (m) => console.error(m),
): void {
  if (nodeMeetsFloor(version, floor)) return;
  if (env.FLAGSHIP_ALLOW_OLD_NODE === "1") {
    log(`[daemon] WARNING: Node ${version} is below the security floor ${floor}; allowed by FLAGSHIP_ALLOW_OLD_NODE (developer machines only)`);
    return;
  }
  throw new Error(`Node ${version} is below the security floor ${floor}; install the signed box release, which ships a current Node`);
}
