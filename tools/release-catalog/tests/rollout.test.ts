import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed, inRolloutCohort, verifyReleaseCatalog, EMPTY_TRUST_STATE, type RootMeta } from "../../../packages/protocol/src/index.js";
import { applyRollout, nextVersion, signCatalog, stateAfter, type ReleaseList } from "../rollout.js";

const C1 = "1111111111111111111111111111111111111111";
const C2 = "2222222222222222222222222222222222222222";
const SHA = "a".repeat(64);
const ROOT_DIR = new URL("../../../", import.meta.url).pathname;

function keys() {
  const seed = new Uint8Array(32).fill(7);
  const ts = new Uint8Array(32).fill(9);
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const root: RootMeta = {
    role: "root", format: 1, version: 1, expiresAt: Date.now() + 365 * 86_400_000,
    keys: { r1: hex(ed.getPublicKey(seed)), t1: hex(ed.getPublicKey(ts)) },
    roles: { root: { keyIds: ["r1"], threshold: 1 }, targets: { keyIds: ["r1"], threshold: 1 }, snapshot: { keyIds: ["r1"], threshold: 1 }, timestamp: { keyIds: ["t1"], threshold: 1 } },
  };
  return { root, signer: { keyId: "r1", privateKey: seed }, ts: { keyId: "t1", privateKey: ts }, seedHex: hex(seed), tsHex: hex(ts) };
}

const list = (): ReleaseList => ({
  version: 1,
  floor: 0,
  releases: [
    { commit: C1, label: "0.2", securityVersion: 1, artifactSha256: SHA, rolloutPercent: 100 },
    { commit: C2, label: "0.3", securityVersion: 2, artifactSha256: SHA, rolloutPercent: 5 },
  ],
});

describe("rollout changes", () => {
  it("lowers, raises or removes one release and refuses a no-op or a bad percent", () => {
    const stop = applyRollout(list(), C2, { percent: 0 });
    expect(stop).toMatchObject({ ok: true, before: 5, after: 0 });
    expect(applyRollout(list(), C2, { percent: 5 })).toMatchObject({ ok: false });
    expect(applyRollout(list(), C2, { percent: 101 })).toMatchObject({ ok: false });
    expect(applyRollout(list(), C2, { percent: 2.5 })).toMatchObject({ ok: false });
    expect(applyRollout(list(), "3".repeat(40), { percent: 0 })).toMatchObject({ ok: false });
    const rm = applyRollout(list(), C2, { remove: true });
    expect(rm.ok && rm.list.releases.map((r) => r.commit)).toEqual([C1]);
    expect(rm.ok && rm.warnings).toEqual([]);
    const floored = applyRollout({ ...list(), floor: 1 }, C2, { remove: true });
    expect(floored.ok && floored.warnings.join(" ")).toContain("--percent 0");
  });

  it("signs a stop that a box holding the published catalog accepts, and that replay cannot undo", () => {
    const k = keys();
    const v1 = signCatalog({ root: k.root, list: list(), version: 1, signers: [k.signer], timestampSigners: [k.ts] });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    const accepted = verifyReleaseCatalog({ root: k.root, ...v1.catalog, now: Date.now(), state: EMPTY_TRUST_STATE });
    expect(accepted.ok).toBe(true);
    const state = stateAfter(k.root, v1.catalog);
    const change = applyRollout(list(), C2, { percent: 0 });
    if (!change.ok) throw new Error(change.reason);
    const version = nextVersion(list(), v1.catalog.targets);
    expect(version).toBe(2);
    const v2 = signCatalog({ root: k.root, list: change.list, version, signers: [k.signer], timestampSigners: [k.ts], previousTimestampVersion: v1.catalog.timestamp.signed.version, state });
    expect(v2.ok).toBe(true);
    if (!v2.ok || !accepted.ok) return;
    const after = verifyReleaseCatalog({ root: k.root, ...v2.catalog, now: Date.now(), state: accepted.value.state });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // the stopped release now admits no box at all
    const stopped = after.value.targets.releases.find((r) => r.commit === C2)!;
    for (let i = 0; i < 200; i++) expect(inRolloutCohort(`salt-${i}`, stopped)).toBe(false);
    // replaying the published 5% catalog to a box that saw the stop is refused
    expect(verifyReleaseCatalog({ root: k.root, ...v1.catalog, now: Date.now(), state: after.value.state })).toMatchObject({ ok: false, reason: "rollback" });
  });

  it("refuses to sign at a version a box that holds the published catalog would reject", () => {
    const k = keys();
    const v1 = signCatalog({ root: k.root, list: list(), version: 3, signers: [k.signer], timestampSigners: [k.ts] });
    if (!v1.ok) throw new Error(String(v1.reason));
    const r = signCatalog({ root: k.root, list: list(), version: 2, signers: [k.signer], timestampSigners: [k.ts], state: stateAfter(k.root, v1.catalog) });
    expect(r).toMatchObject({ ok: false, reason: "rollback" });
  });

  it("the CLI's rollout command writes the catalog and moves the list's version", () => {
    const k = keys();
    const dir = mkdtempSync(join(tmpdir(), "rollout-"));
    writeFileSync(join(dir, "root.json"), JSON.stringify(k.root));
    writeFileSync(join(dir, "r1.key.json"), JSON.stringify({ keyId: "r1", seedHex: k.seedHex }));
    writeFileSync(join(dir, "t1.key.json"), JSON.stringify({ keyId: "t1", seedHex: k.tsHex }));
    writeFileSync(join(dir, "list.json"), JSON.stringify(list()));
    const v1 = signCatalog({ root: k.root, list: list(), version: 1, signers: [k.signer], timestampSigners: [k.ts] });
    if (!v1.ok) throw new Error("sign");
    writeFileSync(join(dir, "served-targets.json"), JSON.stringify(v1.catalog.targets));
    writeFileSync(join(dir, "served-timestamp.json"), JSON.stringify(v1.catalog.timestamp));
    const r = spawnSync(
      "npx",
      ["tsx", "tools/release-catalog/catalog.ts", "rollout", "--root", join(dir, "root.json"), "--list", join(dir, "list.json"), "--commit", C2, "--percent", "0",
        "--key", join(dir, "r1.key.json"), "--timestamp-key", join(dir, "t1.key.json"),
        "--previous-targets", join(dir, "served-targets.json"), "--previous-timestamp", join(dir, "served-timestamp.json"), "--out-dir", join(dir, "out")],
      { cwd: ROOT_DIR, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("5% -> 0%");
    const written = JSON.parse(readFileSync(join(dir, "list.json"), "utf8")) as ReleaseList;
    expect(written.version).toBe(2);
    expect(written.releases.find((x) => x.commit === C2)!.rolloutPercent).toBe(0);
    const targets = JSON.parse(readFileSync(join(dir, "out", "targets.json"), "utf8"));
    expect(targets.signed.version).toBe(2);
  }, 60_000);
});
