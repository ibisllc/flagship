/**
 * The owner's tool for the signed release catalog (protocol releaseMetadata.ts, N13). Run it on the
 * offline signing machine; only the public outputs go to the artifact bucket.
 *
 *   keygen --id k1 --out k1.key.json
 *       a new Ed25519 key: { keyId, seedHex } (keep it offline), and its public half on stdout.
 *   root --key k1=<pubHex> [--key k2=<pubHex>] [--threshold 1] [--role timestamp=k2 ...] --version 1
 *        [--expires-days 365] [--sign k1.key.json ...] --out root.json
 *       every role trusts every listed key unless `--role <role>=<keyId>[,<keyId>]` names its keys: give the
 *       timestamp role its own key, the only one kept online (a repo secret the daily workflow uses).
 *       version 1 is unsigned and is pinned in the release as release/catalog-root.json; a later version
 *       must be signed by enough keys of the root before it (and its own) and is published as
 *       catalog-root-<version>.json plus catalog-root.json.
 *   sign --root root.json --releases releases.json --version N [--floor F] [--targets-days 30]
 *        [--snapshot-days 7] [--timestamp-days 1] --key k1.key.json ... [--timestamp-key ts.key.json]
 *        [--previous-timestamp timestamp.json] --out-dir out
 *       timestamp.json, snapshot.json and targets.json, published as catalog-<name>.json. releases.json is a list of
 *       { commit, label, securityVersion, artifactSha256, rolloutPercent }.
 *
 *   timestamp --snapshot snapshot.json --key timestamp.key.json [--timestamp-days 1] [--previous timestamp.json] --out timestamp.json
 *       a fresh timestamp over the published snapshot (the daily workflow, release-catalog-timestamp.yml).
 *
 * Publish: `wrangler r2 object put <bucket>/catalog-<name>.json --file out/<name>.json --remote` for each file.
 * Re-sign the timestamp at least daily: a box treats an expired one as stale and takes nothing new.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EMPTY_TRUST_STATE, ed, releaseMetaSha256, signReleaseMeta, verifyReleaseCatalog, type ReleaseEntry, type RootMeta, type SnapshotMeta, type TargetsMeta, type TimestampMeta } from "../../packages/protocol/src/index.js";

const DAY = 86_400_000;
const args = process.argv.slice(2);
const cmd = args[0];
const all = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]!] : []));
const one = (flag: string, fallback?: string) => all(flag)[0] ?? fallback ?? fail(`missing ${flag}`);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function fail(m: string): never {
  console.error(m);
  process.exit(2);
}
const signer = (file: string) => {
  const k = JSON.parse(readFileSync(file, "utf8")) as { keyId: string; seedHex: string };
  return { keyId: k.keyId, privateKey: Uint8Array.from(Buffer.from(k.seedHex, "hex")) };
};
const write = (file: string, v: unknown) => writeFileSync(file, JSON.stringify(v, null, 2) + "\n");

if (cmd === "keygen") {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  write(one("--out"), { keyId: one("--id"), seedHex: hex(seed) });
  console.log(hex(ed.getPublicKey(seed)));
} else if (cmd === "root") {
  const keys = Object.fromEntries(all("--key").map((kv) => kv.split("=") as [string, string]));
  if (Object.keys(keys).length === 0) fail("at least one --key id=pubHex");
  const threshold = Number(one("--threshold", "1"));
  const named = Object.fromEntries(all("--role").map((kv) => { const [r, ids] = kv.split("="); return [r!, ids!.split(",")]; }));
  const roleOf = (r: string) => { const ids = named[r] ?? Object.keys(keys); for (const id of ids) if (!keys[id]) fail(`role ${r} names unknown key ${id}`); return { keyIds: ids, threshold: Math.min(threshold, ids.length) }; };
  const version = Number(one("--version"));
  const root: RootMeta = {
    role: "root", format: 1, version, expiresAt: Date.now() + Number(one("--expires-days", "365")) * DAY, keys,
    roles: { root: roleOf("root"), timestamp: roleOf("timestamp"), snapshot: roleOf("snapshot"), targets: roleOf("targets") },
  };
  const signers = all("--sign").map(signer);
  write(one("--out"), version === 1 && signers.length === 0 ? root : signReleaseMeta(root, signers));
} else if (cmd === "sign") {
  const rootFile = JSON.parse(readFileSync(one("--root"), "utf8")) as RootMeta | { signed: RootMeta };
  const root = "signed" in rootFile ? rootFile.signed : rootFile;
  const releases = JSON.parse(readFileSync(one("--releases"), "utf8")) as ReleaseEntry[];
  const version = Number(one("--version"));
  const now = Date.now();
  const targets: TargetsMeta = { role: "targets", format: 1, version, expiresAt: now + Number(one("--targets-days", "30")) * DAY, securityFloor: Number(one("--floor", "0")), releases };
  const snapshot: SnapshotMeta = { role: "snapshot", format: 1, version, expiresAt: now + Number(one("--snapshot-days", "7")) * DAY, targetsVersion: version, targetsSha256: releaseMetaSha256(targets) };
  // The timestamp only moves forward: past the published one (the daily workflow raises it every day).
  const prevTs = all("--previous-timestamp")[0];
  const tsVersion = Math.max(version, prevTs ? (JSON.parse(readFileSync(prevTs, "utf8")) as { signed: TimestampMeta }).signed.version + 1 : 0);
  const timestamp: TimestampMeta = { role: "timestamp", format: 1, version: tsVersion, expiresAt: now + Number(one("--timestamp-days", "1")) * DAY, snapshotVersion: version, snapshotSha256: releaseMetaSha256(snapshot) };
  const signers = all("--key").map(signer);
  if (signers.length === 0) fail("at least one --key file");
  const tsSigners = all("--timestamp-key").map(signer);
  const signed = { targets: signReleaseMeta(targets, signers), snapshot: signReleaseMeta(snapshot, signers), timestamp: signReleaseMeta(timestamp, tsSigners.length ? tsSigners : signers) };
  // Check it the way a box will, before anything is written.
  const check = verifyReleaseCatalog({ root, ...signed, now, state: EMPTY_TRUST_STATE });
  if (!check.ok) fail(`a box would refuse this catalog: ${check.reason}`);
  const out = one("--out-dir");
  mkdirSync(out, { recursive: true });
  write(join(out, "targets.json"), signed.targets);
  write(join(out, "snapshot.json"), signed.snapshot);
  write(join(out, "timestamp.json"), signed.timestamp);
  console.log(`wrote ${out}/{targets,snapshot,timestamp}.json (version ${version}, floor ${targets.securityFloor})`);
} else if (cmd === "timestamp") {
  const snapshot = JSON.parse(readFileSync(one("--snapshot"), "utf8")) as { signed: SnapshotMeta };
  const prevFile = all("--previous")[0];
  const prev = prevFile ? (JSON.parse(readFileSync(prevFile, "utf8")) as { signed: TimestampMeta }).signed.version : 0;
  const timestamp: TimestampMeta = {
    role: "timestamp", format: 1, version: Math.max(prev + 1, snapshot.signed.version), expiresAt: Date.now() + Number(one("--timestamp-days", "1")) * DAY,
    snapshotVersion: snapshot.signed.version, snapshotSha256: releaseMetaSha256(snapshot.signed),
  };
  write(one("--out"), signReleaseMeta(timestamp, [signer(one("--key"))]));
  console.log(`timestamp v${timestamp.version} over snapshot v${snapshot.signed.version}`);
} else {
  fail("usage: catalog.ts keygen|root|sign|timestamp … (see the header)");
}
