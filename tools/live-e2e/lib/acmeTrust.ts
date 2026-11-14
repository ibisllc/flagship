// The run's trust in the gym's test CA (docs/gym-test-acme.md item 2). Node's fetch reads NODE_EXTRA_CA_CERTS once, at
// start, so shared-run writes `<run>/acme-roots.pem` and runs itself again with it set. Nothing here ever relaxes
// certificate checking: the harness trusts exactly the test CA's root and intermediate, for this process tree only.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchTestCaRoots, mergeRootsFile, pemFingerprint, readIssuanceCa, splitPems, type IssuanceCa } from "./acmeCa.js";

export const ROOTS_FILE = "acme-roots.pem";
/** Set on the re-run, so a root that changes while the run starts stops it instead of looping. */
export const REEXEC_ENV = "GYM_ACME_TRUST_REEXEC";

export type AcmeTrust =
  | { kind: "no-account" }
  | { kind: "letsencrypt"; ca: IssuanceCa }
  | { kind: "test"; ca: IssuanceCa; rootsFile: string; rootFingerprint: string; reexec: boolean };

export async function prepareAcmeTrust(
  control: string,
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  /** A reused fleet's roots file: its boxes may still serve certificates from an earlier root. */
  carryFrom?: string,
): Promise<AcmeTrust> {
  const ca = await readIssuanceCa(control, fetchImpl);
  if (!ca) return { kind: "no-account" };
  if (ca.letsEncrypt) return { kind: "letsencrypt", ca };
  const { root, pems } = await fetchTestCaRoots(ca.directory, fetchImpl);
  const rootsFile = resolve(dir, ROOTS_FILE);
  const before = existsSync(rootsFile) ? readFileSync(rootsFile, "utf8") : "";
  const carried = carryFrom && carryFrom !== rootsFile && existsSync(carryFrom) ? readFileSync(carryFrom, "utf8") : "";
  const after = mergeRootsFile(mergeRootsFile(before, splitPems(carried)), pems);
  if (after !== before) writeFileSync(rootsFile, after);
  const loaded = env.NODE_EXTRA_CA_CERTS === rootsFile && after === before;
  if (!loaded && env[REEXEC_ENV] === "1") {
    throw new Error("the test CA's root changed while the run was starting (Pebble restarted?); start the run again");
  }
  return { kind: "test", ca, rootsFile, rootFingerprint: pemFingerprint(root), reexec: !loaded };
}

/**
 * At the end of a run: the test CA still has the root the run started with. A new root means Pebble restarted and
 * certificates issued after that are not trusted by this process: the new root is added to the file (a rerun of the
 * failed groups with --reuse picks it up) and the caller fails the run.
 */
export async function testCaRootUnchanged(
  trust: Extract<AcmeTrust, { kind: "test" }>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ same: boolean; now: string }> {
  const { root, pems } = await fetchTestCaRoots(trust.ca.directory, fetchImpl);
  const now = pemFingerprint(root);
  if (now !== trust.rootFingerprint) {
    const before = existsSync(trust.rootsFile) ? readFileSync(trust.rootsFile, "utf8") : "";
    writeFileSync(trust.rootsFile, mergeRootsFile(before, pems));
  }
  return { same: now === trust.rootFingerprint, now };
}
