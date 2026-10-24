/**
 * The release PQ rule end to end on the box's own verifier: a real `.maintainers/` folder whose
 * release chain is signed by the shared-vector release key, the v2 companions and the binding
 * on disk, and the code pin injected. Once the pin names the key, only an endorsement whose v1
 * signature AND hybrid companion verify is a target; legacy ones before the marker stay for
 * lineage only; a stripped or relabelled companion is refused.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mandatePinHash, signMandate, type Mandate, type ReleaseEndorsement } from "@ibisllc/maintainers";
import type { ReleasePqPin } from "@flagship/protocol";
import { verifyMaintainersFolder } from "../src/releaseVerifier.js";
import { buildMaintainersReleaseGate } from "../src/selfUpdateReleaseGate.js";

const V = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../../protocol/test-vectors/release-endorsement-v2/vectors.json"), "utf8"),
) as {
  keys: Record<string, { ed25519PubHex: string; edSeedHex: string }>;
  pins: Record<string, ReleasePqPin>;
  bindings: Record<string, unknown>;
  endorsements: Record<string, ReleaseEndorsement>;
  companions: Record<string, Record<string, unknown>>;
};

const REL = V.keys.release!;

function repo(opts: { companion?: Record<string, unknown> | null; binding?: boolean } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagship-rpq-"));
  const m = path.join(tmp, ".maintainers");
  const mandate: Mandate = signMandate(
    {
      kind: "Mandate",
      version: 1,
      mandateId: "22222222-2222-4222-8222-222222222222",
      track: "ca",
      holder: REL.ed25519PubHex,
      issuedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2027-03-01T00:00:00.000Z",
      successors: [REL.ed25519PubHex],
      approvalRule: { kind: "threshold", threshold: 1 },
      minSuccessors: 1,
      maxDurationSeconds: 365 * 86400,
      defaultDurationSeconds: 180 * 86400,
      signedBy: REL.ed25519PubHex,
    },
    [{ privKey: REL.edSeedHex }],
  );
  const write = (rel: string, body: unknown) => {
    fs.mkdirSync(path.dirname(path.join(m, rel)), { recursive: true });
    fs.writeFileSync(path.join(m, rel), JSON.stringify(body, null, 2));
  };
  write("tracks/ca/mandates/0001.json", mandate);
  for (const n of ["A", "B", "C", "D"]) write(`endorsements/${n}.json`, V.endorsements[n]);
  if (opts.binding !== false) write("release-pq/bindings/release.json", V.bindings.release);
  const companion = opts.companion === undefined ? V.companions.C : opts.companion;
  if (companion) write("release-pq/endorsements/C.json", companion);
  return { dir: tmp, pin: mandatePinHash(mandate), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

const commitOf = (n: string) => V.endorsements[n]!.commitHash;
const ids = (es: ReleaseEndorsement[]) => es.map((e) => Object.entries(V.endorsements).find(([, x]) => x.releaseId === e.releaseId)![0]);

function gate(r: ReturnType<typeof repo>, releasePqPin: ReleasePqPin) {
  return buildMaintainersReleaseGate({
    repoPath: r.dir,
    pinnedMandateHash: r.pin,
    releasePqPin,
    statusForRef: () => null,
    verifyWalk: () => ({ ok: true }),
  });
}

describe("release PQ rule on the box", () => {
  it("before the pin flips, every v1 endorsement is a target (today's behaviour)", () => {
    const r = repo({ companion: null, binding: false });
    try {
      const s = verifyMaintainersFolder({ gitRepoPath: r.dir, pinnedMandateHash: r.pin, releasePqPin: V.pins.none! });
      expect(ids(s.validEndorsements)).toEqual(["A", "B", "C", "D"]);
      expect(s.releasePq.pinned).toBe(false);
      expect(() => gate(r, V.pins.none!).assertCommitEndorsed(commitOf("D"))).not.toThrow();
    } finally {
      r.cleanup();
    }
  });

  it("after the pin flips, only the v1 + PQ endorsement is a target; legacy stays lineage only", () => {
    const r = repo();
    try {
      const s = verifyMaintainersFolder({ gitRepoPath: r.dir, pinnedMandateHash: r.pin, releasePqPin: V.pins.main! });
      expect(ids(s.validEndorsements)).toEqual(["C"]);
      expect(s.currentRelease?.releaseId).toBe(V.endorsements.C!.releaseId);
      expect(s.releasePq.lineageOnly).toEqual([V.endorsements.A!.releaseId, V.endorsements.B!.releaseId]);
      expect(s.releasePq.refused).toEqual([{ releaseId: V.endorsements.D!.releaseId, code: "pq-missing" }]);
      expect(s.endorsementErrors).toContainEqual({ releaseId: V.endorsements.D!.releaseId, reason: "pq-signature-required", detail: "pq-missing" });
      const g = gate(r, V.pins.main!);
      expect(() => g.assertCommitEndorsed(commitOf("C"))).not.toThrow();
      expect(() => g.assertCommitEndorsed(commitOf("D"))).toThrow(/no valid maintainer release endorsement/);
      expect(() => g.assertCommitEndorsed(commitOf("B"))).toThrow(/no valid maintainer release endorsement/);
    } finally {
      r.cleanup();
    }
  });

  it("a stripped PQ companion is refused (downgrade)", () => {
    const r = repo({ companion: null });
    try {
      const s = verifyMaintainersFolder({ gitRepoPath: r.dir, pinnedMandateHash: r.pin, releasePqPin: V.pins.main! });
      expect(s.validEndorsements).toEqual([]);
      expect(() => gate(r, V.pins.main!).assertCommitEndorsed(commitOf("C"))).toThrow();
    } finally {
      r.cleanup();
    }
  });

  it("a companion relabelled to the classical suite, or with its ML-DSA half cut off, is refused", () => {
    const c = V.companions.C!;
    const sig = c.signature as string;
    for (const [companion, code] of [
      [{ ...c, suite: "ed25519/v1", signature: sig.slice(0, 128) }, "strict-requires-hybrid"],
      [{ ...c, signature: sig.slice(0, 128) }, "bad-signature"],
    ] as const) {
      const r = repo({ companion });
      try {
        const s = verifyMaintainersFolder({ gitRepoPath: r.dir, pinnedMandateHash: r.pin, releasePqPin: V.pins.main! });
        expect(s.validEndorsements).toEqual([]);
        expect(s.releasePq.refused).toContainEqual({ releaseId: V.endorsements.C!.releaseId, code });
      } finally {
        r.cleanup();
      }
    }
  });

  it("a binding missing from the folder refuses every target (the pin is not enough on its own)", () => {
    const r = repo({ binding: false });
    try {
      const s = verifyMaintainersFolder({ gitRepoPath: r.dir, pinnedMandateHash: r.pin, releasePqPin: V.pins.main! });
      expect(s.validEndorsements).toEqual([]);
      expect(s.releasePq.refused[0]).toEqual({ releaseId: V.endorsements.C!.releaseId, code: "no-binding" });
    } finally {
      r.cleanup();
    }
  });
});
