import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalCaEndorsement } from "@ibisllc/maintainers";
import { ed25519 } from "@noble/curves/ed25519.js";
import { classifyReleaseEndorsements, gateCaLeasesPq, mldsa65PublicKey, signBoxArtifact, signReleasePqBinding, verifyBoxArtifact, type ReleasePqPin } from "@flagship/protocol";
import * as K from "./pq-release-key.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const V = JSON.parse(fs.readFileSync(path.join(REPO, "packages/protocol/test-vectors/release-endorsement-v2/vectors.json"), "utf8")) as {
  keys: Record<string, { edSeedHex: string }>;
  endorsements: Record<string, Record<string, unknown> & { releaseId: string; commitHash: string; semverTag: string }>;
};

let tmp = "";
const p = (...x: string[]) => path.join(tmp, ...x);
const run = (script: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}) =>
  spawnSync("node", [path.join(REPO, "scripts", script), ...args], {
    cwd: REPO,
    input: opts.input ?? "",
    encoding: "utf8",
    env: { ...process.env, FLAGSHIP_PQ_FAKE_PIN: "123456", ...opts.env },
  });
const fake = () => ["--fake-yubikey", p("yk")];
const rowsOf = (stdout: string) => stdout.split("\n").filter((l) => /^ {4}[0-9A-Z]{5}( [0-9A-Z]{5}){3} {2}[0-9A-Z]{2}$/.test(l)).map((l) => l.trim());

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-pqkey-"));
  K.createFakeYubikeys(p("yk"));
  fs.writeFileSync(p("ed.hex"), V.keys.release!.edSeedHex + "\n");
  fs.mkdirSync(p(".maintainers", "endorsements"), { recursive: true });
  for (const n of ["A", "B", "C", "D"]) fs.writeFileSync(p(".maintainers", "endorsements", `${n}.json`), JSON.stringify(V.endorsements[n]));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("paper code", () => {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
  it("round-trips, forgives O/I/L and spacing, and finds the row with a typo", () => {
    const rows: string[] = K.paperRows(seed);
    expect(rows).toHaveLength(3);
    expect(Buffer.from(K.seedFromPaper(rows))).toEqual(Buffer.from(seed));
    expect(Buffer.from(K.seedFromPaper(rows.map((r) => r.toLowerCase().replace(/ /g, "-"))))).toEqual(Buffer.from(seed));
    const bad = [...rows];
    bad[1] = (bad[1]![0] === "A" ? "B" : "A") + bad[1]!.slice(1);
    expect(() => K.seedFromPaper(bad)).toThrow(/row 2 has a typo/);
  });
});

// The one thing fake YubiKeys cannot tell us: a real YubiKey's PIV applet takes about 3 KB of message per signature
// (measured on firmware 5.7.4: 3,000 bytes sign, the 6,095-byte v1 binding is refused). Every message the Ed25519
// half signs must stay well under that.
describe("messages handed to the YubiKey stay inside its PIV limit", () => {
  const PIV_SAFE = 2_700;
  it("every release-key binding (the compact v2 form)", async () => {
    const seed = new Uint8Array(32).fill(7);
    const edSeed = new Uint8Array(32).fill(9);
    const pubHex = Buffer.from(ed25519.getPublicKey(edSeed)).toString("hex");
    const sizes: number[] = [];
    const ed = { pubHex, sign: async (m: Uint8Array) => (sizes.push(m.length), ed25519.sign(m, edSeed)) };
    for (const subject of ["flagship-ca-track", "flagship-box-artifact"]) {
      const b = await K.signSubjectBinding(subject, ed, seed);
      expect(b.v).toBe(2);
    }
    expect(sizes).toHaveLength(2);
    for (const n of sizes) expect(n).toBeLessThan(PIV_SAFE);
  });
  it("the ceremony's own release binding (init)", async () => {
    const seed = new Uint8Array(32).fill(7);
    const edSeed = new Uint8Array(32).fill(9);
    const pubHex = Buffer.from(ed25519.getPublicKey(edSeed)).toString("hex");
    const mldsaPubHex = Buffer.from(mldsa65PublicKey(seed)).toString("hex");
    let size = 0;
    const b = await signReleasePqBinding({ ed25519PubHex: pubHex, mldsaPubHex, issuedAt: Date.now() }, async (m) => (size = m.length, ed25519.sign(m, edSeed)), seed);
    expect(b.v).toBe(2);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(PIV_SAFE);
  });
});

describe("pq-release-key ceremony (fake YubiKeys)", () => {
  let keyId = "";
  let paper: string[] = [];

  it("refuses test mode against the real .maintainers folder", () => {
    const r = run("pq-release-key.mjs", ["init", "--recipient", "fake-yubikey:yk-a", "--recipient", "fake-yubikey:yk-b", "--out", p("x.age"), "--signing-key", `file:${p("ed.hex")}`, ...fake()]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/must not write into the real \.maintainers/);
  });

  it("init: one recipient is not enough", () => {
    const r = run("pq-release-key.mjs", ["init", "--recipient", "fake-yubikey:yk-a", "--out", p("x.age"), "--signing-key", `file:${p("ed.hex")}`, "--path", p(".maintainers"), ...fake()]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/two distinct --recipient/);
  });

  it("init: encrypts to both YubiKeys, binds the key and prints the paper backup, never writing the seed", () => {
    const r = run("pq-release-key.mjs", [
      "init", "--recipient", "fake-yubikey:yk-a", "--recipient", "fake-yubikey:yk-b",
      "--out", p("key.age"), "--signing-key", `file:${p("ed.hex")}`, "--path", p(".maintainers"), ...fake(),
    ]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    keyId = /Release key id: ([0-9a-f]{64})/.exec(r.stdout)![1]!;
    paper = rowsOf(r.stdout);
    expect(paper).toHaveLength(3);
    const seedHex = Buffer.from(K.seedFromPaper(paper)).toString("hex");
    const files = fs.readdirSync(tmp, { recursive: true, withFileTypes: true }).filter((d) => d.isFile());
    for (const f of files) {
      const body = fs.readFileSync(path.join(f.parentPath, f.name));
      expect(body.includes(Buffer.from(seedHex, "hex"))).toBe(false);
      expect(body.toString("utf8").includes(seedHex)).toBe(false);
    }
    expect(fs.statSync(p("key.age")).mode & 0o077).toBe(0);
    const again = run("pq-release-key.mjs", ["init", "--recipient", "fake-yubikey:yk-a", "--recipient", "fake-yubikey:yk-b", "--out", p("key.age"), "--signing-key", `file:${p("ed.hex")}`, "--path", p(".maintainers"), ...fake()]);
    expect(again.status).toBe(2);
  });

  it("verify-yubikey: each YubiKey opens it with its PIN; a wrong PIN does not", () => {
    for (const yk of ["yk-a", "yk-b"]) {
      const r = run("pq-release-key.mjs", ["verify-yubikey", "--key-file", p("key.age"), "--path", p(".maintainers"), ...fake()], { env: { FLAGSHIP_PQ_FAKE_INSERTED: yk } });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(keyId.slice(0, 16));
    }
    const bad = run("pq-release-key.mjs", ["verify-yubikey", "--key-file", p("key.age"), "--path", p(".maintainers"), ...fake()], { env: { FLAGSHIP_PQ_FAKE_PIN: "000000" } });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/wrong PIN/);
  });

  it("paper-backup prints the same code init printed", () => {
    const r = run("pq-release-key.mjs", ["paper-backup", "--key-file", p("key.age"), "--path", p(".maintainers"), ...fake()]);
    expect(r.status, r.stderr).toBe(0);
    expect(rowsOf(r.stdout)).toEqual(paper);
  });

  it("restore-from-paper re-encrypts the same key to new YubiKeys and refuses a typo", () => {
    K.createFakeYubikeys(p("yk"), ["yk-c", "yk-d"], "654321");
    const args = ["restore-from-paper", "--recipient", "fake-yubikey:yk-c", "--recipient", "fake-yubikey:yk-d", "--out", p("restored.age"), "--path", p(".maintainers"), ...fake()];
    const typo = [...paper];
    typo[2] = (typo[2]![0] === "A" ? "B" : "A") + typo[2]!.slice(1);
    expect(run("pq-release-key.mjs", args, { input: typo.join("\n") + "\n" }).status).toBe(2);
    const r = run("pq-release-key.mjs", args, { input: paper.join("\n") + "\n" });
    expect(r.status, r.stderr).toBe(0);
    const v = run("pq-release-key.mjs", ["verify-yubikey", "--key-file", p("restored.age"), "--path", p(".maintainers"), ...fake()], {
      env: { FLAGSHIP_PQ_FAKE_INSERTED: "yk-d", FLAGSHIP_PQ_FAKE_PIN: "654321" },
    });
    expect(v.status, v.stderr).toBe(0);
    expect(v.stdout).toContain(keyId.slice(0, 16));
  });

  it("show-pub lists the bound key as not pinned yet", () => {
    const r = run("pq-release-key.mjs", ["show-pub", "--path", p(".maintainers")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`key id:         ${keyId}  (NOT pinned)`);
    expect(r.stdout).toContain("YubiKey-encrypted at rest");
  });

  it("pin writes the key id and the newest endorsement as the marker", () => {
    const pinFile = p("releasePqPin.ts");
    fs.copyFileSync(path.join(REPO, "packages/protocol/src/releasePqPin.ts"), pinFile);
    const pin = K.cmdPin({ keyId, path: p(".maintainers") }, () => {}, { pinFile, current: { version: 1, keyIds: [], requirePqAfter: null } });
    expect(pin.requirePqAfter).toEqual({ releaseId: V.endorsements.D!.releaseId, commitHash: V.endorsements.D!.commitHash });
    const src = fs.readFileSync(pinFile, "utf8");
    expect(src).toContain(`keyIds: Object.freeze(["${keyId}"])`);
    expect(src).toContain(`releaseId: "${V.endorsements.D!.releaseId}"`);
    expect(() => K.cmdPin({ keyId: "ab".repeat(32), path: p(".maintainers") }, () => {}, { pinFile })).toThrow(/no binding/);
  });

  it("endorse-release --pq-only signs a companion that the box's rule accepts", () => {
    const C = V.endorsements.C!;
    const r = run("endorse-release.mjs", ["--pq-only", C.releaseId, "--sign", "--signing-key", `file:${p("ed.hex")}`, "--path", p(".maintainers"), "--key-file", p("key.age"), ...fake()]);
    expect(r.status, r.stderr).toBe(0);
    const companion = JSON.parse(fs.readFileSync(p(".maintainers", "release-pq", "endorsements", `${C.semverTag}.json`), "utf8"));
    const binding = JSON.parse(fs.readFileSync(p(".maintainers", "release-pq", "bindings", `${keyId.slice(0, 16)}.json`), "utf8"));
    const pin: ReleasePqPin = { version: 1, keyIds: [keyId], requirePqAfter: { releaseId: V.endorsements.B!.releaseId, commitHash: V.endorsements.B!.commitHash } };
    const all = ["A", "B", "C", "D"].map((n) => V.endorsements[n]!) as unknown as Parameters<typeof classifyReleaseEndorsements>[0];
    const out = classifyReleaseEndorsements(all, [companion], [binding], { pin, now: Date.now() });
    expect(out.eligible.map((e) => e.releaseId)).toEqual([C.releaseId]);
    expect(out.lineageOnly.map((e) => e.releaseId)).toEqual([V.endorsements.A!.releaseId, V.endorsements.B!.releaseId]);
  });

  it("sign-ca-lease writes the CA lease's companion, the ca-track binding and the Worker bundle", () => {
    const seed = Buffer.from(V.keys.release!.edSeedHex, "hex");
    const pub = Buffer.from(ed25519.getPublicKey(seed)).toString("hex");
    const e = {
      kind: "CaEndorsement" as const, version: 1 as const, endorsementId: "6f1c2d3e-0000-4000-8000-0000000000aa", track: "ca",
      caPubkey: "a".repeat(64), scope: "flagship/directory-attestation", notBefore: "2026-10-19T01:36:06.489Z",
      notAfter: "2027-01-17T01:36:06.489Z", issuedAt: "2026-10-19T01:36:06.489Z", signedBy: pub,
    };
    const lease = { ...e, signatures: [{ pubkey: pub, sig: Buffer.from(ed25519.sign(canonicalCaEndorsement(e), seed)).toString("hex") }] };
    fs.writeFileSync(p("lease.json"), JSON.stringify(lease));
    const r = run("pq-release-key.mjs", ["sign-ca-lease", "--endorsement", p("lease.json"), "--signing-key", `file:${p("ed.hex")}`, "--path", p(".maintainers"), "--key-file", p("key.age"), ...fake()]);
    expect(r.status, r.stderr).toBe(0);
    const bundle = JSON.parse(fs.readFileSync(p(".maintainers", "ca-pq", "bundle.json"), "utf8"));
    expect(bundle.bindings[0].subjectId).toBe("flagship-ca-track");
    const pin = { version: 1 as const, keyIds: [keyId], legacyLeases: [] };
    expect(gateCaLeasesPq([lease] as never, bundle, { pin, now: Date.now() }).accepted).toHaveLength(1);
    expect(gateCaLeasesPq([lease] as never, { bindings: bundle.bindings, endorsements: [] }, { pin, now: Date.now() }).accepted).toHaveLength(0);
  });

  it("sign-box-artifact adds the companion and binding a pinned verifier needs", () => {
    const BA = JSON.parse(fs.readFileSync(path.join(REPO, "packages/protocol/test-vectors/box-artifact/pq-vectors.json"), "utf8"));
    const seed = Buffer.from(V.keys.release!.edSeedHex, "hex");
    const pub = Buffer.from(ed25519.getPublicKey(seed)).toString("hex");
    fs.writeFileSync(p("manifest.json"), JSON.stringify({ manifest: BA.manifest, signatures: [signBoxArtifact(BA.manifest, seed)] }));
    const r = run("pq-release-key.mjs", ["sign-box-artifact", "--manifest", p("manifest.json"), "--out", p("manifest.pq.json"), "--signing-key", `file:${p("ed.hex")}`, "--key-file", p("key.age"), ...fake()]);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(fs.readFileSync(p("manifest.pq.json"), "utf8"));
    const opts = {
      trust: { keys: [pub], threshold: 1 }, expectedCommit: BA.manifest.commit, expectedArch: BA.manifest.arch,
      measuredSha256: BA.manifest.artifactSha256, measuredBytes: BA.manifest.artifactBytes, verifierVersion: 1,
      pqPin: { version: 1 as const, keyIds: [keyId], legacyManifests: [] }, now: Date.now(),
    };
    expect(verifyBoxArtifact(doc.manifest, doc.signatures, { ...opts, pqBindings: doc.pqBindings } as never)).toMatchObject({ ok: true });
    const stripped = doc.signatures.map(({ pq: _pq, ...s }: { pq?: unknown }) => s);
    expect(verifyBoxArtifact(doc.manifest, stripped, { ...opts, pqBindings: doc.pqBindings } as never)).toMatchObject({ ok: false, code: "pq-signature-required" });
  });

  it("endorse-release refuses to sign a companion with a key that did not sign the endorsement", () => {
    fs.writeFileSync(p("other.hex"), "77".repeat(32));
    const r = run("endorse-release.mjs", ["--pq-only", V.endorsements.D!.releaseId, "--sign", "--signing-key", `file:${p("other.hex")}`, "--path", p(".maintainers"), "--key-file", p("key.age"), ...fake()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/did not sign endorsement/);
  });
});

describe("pin --ca-lease and --box-artifact", () => {
  const KEY = "ab".repeat(32);
  it("pins the key for CA leases and lists every committed lease as signed before the cut-over", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pq-ca-pin-"));
    const pinFile = path.join(dir, "caLeasePq.ts");
    // The repo may already pin its real release key: start from the unpinned state this test is about.
    fs.writeFileSync(
      pinFile,
      fs
        .readFileSync(path.join(REPO, "packages/protocol/src/caLeasePq.ts"), "utf8")
        .replace(/keyIds: Object\.freeze\(\[[^\]]*\]\)/, "keyIds: Object.freeze([])")
        .replace(/legacyLeases: Object\.freeze\(\[[^\]]*\]\)/, "legacyLeases: Object.freeze([])"),
    );
    const lines: string[] = [];
    K.pinCaLease(path.join(REPO, ".maintainers"), KEY, (m: string) => lines.push(m), pinFile);
    const src = fs.readFileSync(pinFile, "utf8");
    const leases = fs.readdirSync(path.join(REPO, ".maintainers/ca-endorsements")).filter((f) => f.endsWith(".json") && f !== "bundle.json");
    expect(src).toContain(`keyIds: Object.freeze(["${KEY}"])`);
    expect(src.match(/legacyLeases: Object\.freeze\(\[([^\]]*)\]\)/)![1]!.match(/[0-9a-f]{64}/g)).toHaveLength(leases.length);
    K.pinCaLease(path.join(REPO, ".maintainers"), KEY, () => {}, pinFile);
    expect(fs.readFileSync(pinFile, "utf8")).toBe(src);
  });

  it("pins the key for box artifacts and lists the given published manifests by digest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pq-box-pin-"));
    const trust = path.join(dir, "box-artifact-trust.json");
    // Start from the unpinned state even once the repo pins its real release key.
    const base = JSON.parse(fs.readFileSync(path.join(REPO, "release/box-artifact-trust.json"), "utf8"));
    base.pq = { ...(base.pq ?? { version: 1 }), keyIds: [], legacyManifests: [] };
    fs.writeFileSync(trust, JSON.stringify(base, null, 2) + "\n");
    const v = JSON.parse(fs.readFileSync(path.join(REPO, "packages/protocol/test-vectors/box-artifact/vectors.json"), "utf8"));
    const manifest = v.manifest ?? v.valid?.manifest ?? (v.cases ?? v.vectors)[0].manifest;
    const mf = path.join(dir, "m.manifest.json");
    fs.writeFileSync(mf, JSON.stringify({ manifest, signatures: [signBoxArtifact(manifest, new Uint8Array(32).fill(7))] }));
    K.pinBoxArtifact(KEY, [mf], () => {}, trust);
    const t = JSON.parse(fs.readFileSync(trust, "utf8"));
    expect(t.pq.keyIds).toEqual([KEY]);
    expect(t.pq.legacyManifests).toHaveLength(1);
    expect(t.pq.legacyManifests[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});
