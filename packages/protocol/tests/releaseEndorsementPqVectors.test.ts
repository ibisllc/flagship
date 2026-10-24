import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalReleaseEndorsement, type ReleaseEndorsement } from "@ibisllc/maintainers";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
  canonicalReleaseEndorsementV2,
  classifyReleaseEndorsements,
  RELEASE_PQ_PIN,
  releaseEndorsementV1Digest,
  ReleasePqError,
  releasePqPinConfigured,
  signReleaseEndorsementPq,
  verifyReleaseEndorsementPq,
  verifyReleasePqBindings,
  type ReleasePqPin,
} from "../src/index.js";

const V = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../test-vectors/release-endorsement-v2/vectors.json"), "utf8"),
) as {
  now: number;
  keys: Record<string, { ed25519PubHex: string; mldsaPubHex: string; keyId: string; edSeedHex: string; mldsaSeedHex: string }>;
  pins: Record<string, ReleasePqPin>;
  bindings: Record<string, unknown>;
  endorsements: Record<string, ReleaseEndorsement>;
  companions: Record<string, unknown>;
  statements: Record<string, { v1CanonicalHex: string; v1Digest: string; v2StatementHex: string }>;
  companionCases: { name: string; endorsement: string; companion: unknown; bindings: string[]; pin: string; expect: { ok: boolean; keyId?: string; code?: string } }[];
  bindingCases: { name: string; binding: string; pin: string; expect: { verified: string[]; errors: string[] } }[];
  classifyCases: { name: string; pin: string; companions: string[]; bindings: string[]; expect: { eligible: string[]; lineageOnly: string[]; refused: { endorsement: string; code: string }[] } }[];
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const nameOf = (e: ReleaseEndorsement) => Object.entries(V.endorsements).find(([, x]) => x.releaseId === e.releaseId)![0];
const bindingsFor = (pin: ReleasePqPin, names: string[]) => verifyReleasePqBindings(names.map((n) => V.bindings[n]), pin, V.now).bindings;

describe("release-endorsement v2 vectors", () => {
  it("rebuilds every statement byte for byte", () => {
    for (const e of ["A", "B", "C", "D"].map((n) => V.endorsements[n]!)) {
      const s = V.statements[e.releaseId]!;
      const { signatures: _s, ...unsigned } = e;
      expect(hex(canonicalReleaseEndorsement(unsigned))).toBe(s.v1CanonicalHex);
      expect(releaseEndorsementV1Digest(e)).toBe(s.v1Digest);
      expect(hex(canonicalReleaseEndorsementV2(e, V.keys.release!.keyId))).toBe(s.v2StatementHex);
    }
  });

  it("re-signs the companion byte for byte (deterministic ML-DSA)", async () => {
    const k = V.keys.release!;
    const seed = Buffer.from(k.edSeedHex, "hex");
    const wire = await signReleaseEndorsementPq(
      V.endorsements.C!,
      k,
      async (m) => ed25519.sign(m, seed),
      Buffer.from(k.mldsaSeedHex, "hex"),
      { deterministic: true },
    );
    expect(wire).toEqual(V.companions.C);
  });

  for (const c of V.companionCases) {
    it(`companion: ${c.name}`, () => {
      const pin = V.pins[c.pin]!;
      const run = () =>
        verifyReleaseEndorsementPq(V.endorsements[c.endorsement]!, c.companion ?? undefined, { pin, bindings: bindingsFor(pin, c.bindings) });
      if (c.expect.ok) expect(run()).toEqual({ keyId: c.expect.keyId });
      else {
        expect(run).toThrow(ReleasePqError);
        try {
          run();
        } catch (e) {
          expect((e as ReleasePqError).code).toBe(c.expect.code);
        }
      }
    });
  }

  for (const c of V.bindingCases) {
    it(`binding: ${c.name}`, () => {
      const r = verifyReleasePqBindings([V.bindings[c.binding]], V.pins[c.pin]!, V.now);
      expect(r.bindings.map((b) => b.keyIdHex)).toEqual(c.expect.verified);
      expect(r.errors.map((e) => e.code)).toEqual(c.expect.errors);
    });
  }

  for (const c of V.classifyCases) {
    it(`classify: ${c.name}`, () => {
      const r = classifyReleaseEndorsements(
        ["A", "B", "C", "D"].map((n) => V.endorsements[n]!),
        c.companions.map((n) => V.companions[n]),
        c.bindings.map((n) => V.bindings[n]),
        { pin: V.pins[c.pin]!, now: V.now },
      );
      expect(r.eligible.map(nameOf)).toEqual(c.expect.eligible);
      expect(r.lineageOnly.map(nameOf)).toEqual(c.expect.lineageOnly);
      expect(r.refused.map((x) => ({ endorsement: nameOf(x.endorsement), code: x.code }))).toEqual(c.expect.refused);
    });
  }

  it("ships with no release key pinned (the v1 YubiKey endorsement alone until the ceremony)", () => {
    expect(releasePqPinConfigured(RELEASE_PQ_PIN)).toBe(false);
  });

  it("a signer that holds the wrong ML-DSA seed never yields a companion", async () => {
    const k = V.keys.release!;
    const seed = Buffer.from(k.edSeedHex, "hex");
    await expect(
      signReleaseEndorsementPq(V.endorsements.C!, k, async (m) => ed25519.sign(m, seed), Buffer.from(V.keys.other!.mldsaSeedHex, "hex")),
    ).rejects.toThrow();
  });
});
