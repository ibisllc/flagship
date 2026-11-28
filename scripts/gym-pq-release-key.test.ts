// The gym's PQ release key (scripts/gym-pq-release-key.mjs): gym boxes need hybrid companions on their artifacts the way
// production boxes do, and the refresh fails when one is missing.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterAll, describe, expect, it } from "vitest";
import { boxArtifactV1Digest, canonicalBoxArtifact } from "@flagship/protocol";
// @ts-expect-error plain ESM script
import { cmdCheck, cmdInit, cmdPin, cmdSign, manifestHasCompanion, readKey, readPin } from "./gym-pq-release-key.mjs";

const root = join(import.meta.dirname, "..");
const V = JSON.parse(readFileSync(join(root, "packages/protocol/test-vectors/box-artifact/pq-vectors.json"), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "gym-pq-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const quiet = () => {};
const edSeed = randomBytes(32);
const artifactKeyFile = join(dir, "gym-artifact-key");
writeFileSync(artifactKeyFile, edSeed.toString("hex") + "\n", { mode: 0o600 });
const edPub = Buffer.from(ed25519.getPublicKey(edSeed)).toString("hex");
const keyFile = join(dir, "gym-release-pq-key.json");

function signed(commit: string) {
  const manifest = { ...V.manifest, commit };
  const sig = ed25519.sign(canonicalBoxArtifact(manifest), edSeed);
  return { manifest, signatures: [{ keyHex: edPub, signatureHex: Buffer.from(sig).toString("hex") }] };
}
const serve = (files: Record<string, unknown>) =>
  (async (u: string) => {
    const name = String(u).split("/").pop()!;
    return name in files ? new Response(JSON.stringify(files[name]), { status: 200 }) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;

/** A gym worktree with just the files the tool writes and reads. */
function worktree(name: string, commit: string, pq: string[]) {
  const wt = join(dir, name);
  for (const f of [
    "packages/protocol/src/releasePqPin.ts",
    "apps/web/public/webapp/lib/releasePqPin.js",
    "apps/mobile/shared/Sources/FlagshipCore/SecurityNotice.swift",
    "apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/SecurityNotice.kt",
  ]) {
    mkdirSync(dirname(join(wt, f)), { recursive: true });
    copyFileSync(join(root, f), join(wt, f));
  }
  // Start from an empty pin whatever the checkout pins (production's key on main, the gym's on the gym branch).
  const pinFile = join(wt, "packages/protocol/src/releasePqPin.ts");
  writeFileSync(pinFile, readFileSync(pinFile, "utf8").replace(/keyIds: Object\.freeze\(\[[^\]]*\]\)/, "keyIds: Object.freeze([])").replace(/requirePqAfter: \{[^}]*\}/, "requirePqAfter: null"));
  mkdirSync(join(wt, "release"), { recursive: true });
  writeFileSync(join(wt, "release/box-artifact-trust.json"), JSON.stringify({ schema: 1, threshold: 1, keys: [edPub], pq: { keyIds: pq, legacyManifests: [] } }));
  writeFileSync(join(wt, "release/box-release.json"), JSON.stringify({ commit }));
  return wt;
}

describe("the gym's PQ release key", async () => {
  const k = await cmdInit({ keyFile, artifactKeyFile }, quiet);

  it("is made once, bound to the gym artifact key, and kept out of the repo", async () => {
    expect(k.ed25519PubHex).toBe(edPub);
    expect(k.keyId).toMatch(/^[0-9a-f]{64}$/);
    expect((await cmdInit({ keyFile, artifactKeyFile }, quiet)).keyId).toBe(k.keyId);
    expect(readKey(keyFile).keyId).toBe(k.keyId);
    const other = join(dir, "other-ed");
    writeFileSync(other, randomBytes(32).toString("hex"));
    await expect(cmdInit({ keyFile, artifactKeyFile: other }, quiet)).rejects.toThrow(/artifact key changed/);
  });

  it("adds a companion a pinned verifier accepts; without one the manifest is refused, legacy listing or not", async () => {
    const trust = { keys: [edPub], threshold: 1, pq: { keyIds: [k.keyId], legacyManifests: [] as string[] } };
    const plain = signed("a".repeat(40));
    expect(manifestHasCompanion(plain, trust)).toEqual({ ok: false, why: expect.stringMatching(/^pq-signature-required/) });
    trust.pq.legacyManifests = [boxArtifactV1Digest(canonicalBoxArtifact(plain.manifest))];
    expect(manifestHasCompanion(plain, trust).ok).toBe(false);
    writeFileSync(join(dir, "m.json"), JSON.stringify(plain));
    await cmdSign({ manifest: join(dir, "m.json"), outFile: join(dir, "m.pq.json"), keyFile, artifactKeyFile }, quiet);
    const pq = JSON.parse(readFileSync(join(dir, "m.pq.json"), "utf8"));
    expect(pq.signatures[0].pq.keyId).toBe(k.keyId);
    expect(manifestHasCompanion(pq, trust)).toEqual({ ok: true });
  });

  it("pins the gym key with a requirePqAfter marker, and lists what the gym already publishes as legacy", async () => {
    const old = signed("b".repeat(40));
    const wt = worktree("wt-pin", "b".repeat(40), []);
    const marker = { releaseId: "978ca58f-a29a-4857-8afc-6dd6238ed223", commitHash: "dbdf2e08875ae55d9b575f390a29810670f9a54d" };
    mkdirSync(join(wt, ".maintainers/release-pq/bindings"), { recursive: true });
    await cmdPin(
      { wt, keyFile, artifactKeyFile, requirePqAfter: marker, regenerate: false, fetchImpl: serve({ "releases.json": { releases: [{ commit: old.manifest.commit, arch: ["amd64"] }] }, [`flagship-box-${"b".repeat(12)}-amd64.manifest.json`]: old }) },
      quiet,
    );
    expect(readPin(wt)).toEqual({ keyIds: [k.keyId], requirePqAfter: marker });
    expect(readFileSync(join(wt, "packages/protocol/src/releasePqPin.ts"), "utf8")).toMatch(/GYM TEST BRANCH ONLY: the gym's own PQ release key/);
    expect(readFileSync(join(wt, "apps/web/public/webapp/lib/releasePqPin.js"), "utf8")).toContain(k.keyId);
    const t = JSON.parse(readFileSync(join(wt, "release/box-artifact-trust.json"), "utf8"));
    expect(t.pq).toEqual({ keyIds: [k.keyId], legacyManifests: [boxArtifactV1Digest(canonicalBoxArtifact(old.manifest))] });
    const b = JSON.parse(readFileSync(join(wt, `.maintainers/release-pq/bindings/${k.keyId.slice(0, 16)}.json`), "utf8"));
    expect(b.ed25519PubHex).toBe(edPub);
  });

  it("check fails when the box release or the update target lacks its companion, or the gym pins no key", async () => {
    const c = "c".repeat(40);
    const u = "d".repeat(40);
    writeFileSync(join(dir, "c.json"), JSON.stringify(signed(c)));
    await cmdSign({ manifest: join(dir, "c.json"), outFile: join(dir, "c.pq.json"), keyFile, artifactKeyFile }, quiet);
    const good = JSON.parse(readFileSync(join(dir, "c.pq.json"), "utf8"));
    const wt = worktree("wt-check", c, [k.keyId]);
    await cmdPin({ wt, keyFile, artifactKeyFile, requirePqAfter: { releaseId: "r", commitHash: "e".repeat(40) }, regenerate: false, fetchImpl: serve({}) }, quiet);
    const files = { [`flagship-box-${c.slice(0, 12)}-amd64.manifest.json`]: good };
    await expect(cmdCheck({ wt, keyFile, fetchImpl: serve(files) }, quiet)).resolves.toBeUndefined();
    await expect(cmdCheck({ wt, keyFile, fetchImpl: serve({ ...files, "update-target.json": { from: c, commit: u }, [`flagship-box-${u.slice(0, 12)}-amd64.manifest.json`]: signed(u) }) }, quiet)).rejects.toThrow(
      /update target .*no valid PQ companion \(pq-signature-required/,
    );
    await expect(cmdCheck({ wt, keyFile, fetchImpl: serve({ [`flagship-box-${c.slice(0, 12)}-amd64.manifest.json`]: signed(c) }) }, quiet)).rejects.toThrow(/box release .*no valid PQ companion/);
    await expect(cmdCheck({ wt: worktree("wt-empty", c, []), keyFile, fetchImpl: serve(files) }, quiet)).rejects.toThrow(/RELEASE_PQ_PIN on the gym branch names \[\]/);
  });
});
