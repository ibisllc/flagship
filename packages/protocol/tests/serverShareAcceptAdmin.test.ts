import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_KEY_ATTESTATION_TTL_MS,
  canonicalAccountKeyAttestation,
  canonicalShareKeyAttestationRequest,
  deriveIRK,
  deriveShareAdminKey,
  deriveShareMemberKey,
  ed,
  parseAccountKeyAttestation,
  parseServerShareAcceptAdmin,
  parseShareAcceptancePayload,
  serverShareAcceptAdminCanonicalBytes,
  signAccountKeyAttestation,
  verifyCaSignedAccountKeyAttestation,
  verifyServerShareAcceptAdmin,
  verifyShareKeyAttestationRequest,
  type CaTrustChain,
  type ServerShareAcceptAdmin,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const V = JSON.parse(readFileSync(join(here, "..", "test-vectors", "server-share-accept-admin", "vectors.json"), "utf8"));
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const kp = (seedHex: string) => ({ privateKey: bytes(seedHex), publicKey: ed.getPublicKey(bytes(seedHex)) });

const umk = { seed: bytes(V.keys.memberUmkSeedHex) };
const signers: Record<string, { privateKey: Uint8Array; publicKey: Uint8Array }> = {
  adminRoot: kp(V.keys.adminRootSeedHex),
  otherAdmin: kp(V.keys.otherAdminSeedHex),
  irk: deriveIRK(umk),
  member: deriveShareMemberKey(umk, V.keys.shareId),
  shareAdmin: deriveShareAdminKey(umk, V.keys.shareId),
};
const ca = kp(V.keys.caSeedHex);
const chain = (keys: string[]): CaTrustChain => ({ authorizedCaKeys: () => keys });

describe("share accept-admin vectors (#12)", () => {
  it("derives the keys", () => {
    expect(Buffer.from(signers.adminRoot!.publicKey).toString("hex")).toBe(V.keys.adminRootPubHex);
    expect(Buffer.from(signers.irk!.publicKey).toString("hex")).toBe(V.keys.irkPubHex);
    expect(Buffer.from(signers.member!.publicKey).toString("hex")).toBe(V.keys.memberPubHex);
    expect(Buffer.from(ca.publicKey).toString("hex")).toBe(V.keys.caPubHex);
    expect(Buffer.from(signers.shareAdmin!.publicKey).toString("hex")).toBe(V.keys.shareAdminPubHex);
    expect(Buffer.from(deriveShareAdminKey(umk, V.keys.otherShareId).publicKey).toString("hex")).toBe(V.keys.otherShareAdminPubHex);
  });

  it("the share admin key is never a stable account key, and differs per share (AT-LNK-10)", () => {
    const stable = [V.keys.adminRootPubHex, V.keys.irkPubHex, V.keys.memberPubHex];
    expect(stable).not.toContain(V.keys.shareAdminPubHex);
    expect(V.keys.otherShareAdminPubHex).not.toBe(V.keys.shareAdminPubHex);
  });

  it("builds, signs and verifies every attestation request, and refuses every requestRefuse case", () => {
    expect(V.requests.length).toBeGreaterThan(0);
    for (const c of V.requests) {
      const b = canonicalShareKeyAttestationRequest(c.fields);
      expect(new TextDecoder().decode(b)).toBe(c.canonical);
      expect(Buffer.from(ed.sign(b, signers[c.signer]!.privateKey)).toString("hex")).toBe(c.signature);
      expect(verifyShareKeyAttestationRequest(c.fields, bytes(c.signature), signers[c.signer]!.publicKey)).toBe(true);
      expect(verifyShareKeyAttestationRequest({ ...c.fields, keyPubHex: V.keys.otherShareAdminPubHex }, bytes(c.signature), signers[c.signer]!.publicKey)).toBe(false);
    }
    for (const c of V.requestRefuse) expect(() => canonicalShareKeyAttestationRequest(c.fields), c.why).toThrow();
  });

  it("builds, signs, verifies and parses every envelope", () => {
    expect(V.envelopes).toHaveLength(1);
    for (const c of V.envelopes) {
      const f = c.fields as ServerShareAcceptAdmin;
      const b = serverShareAcceptAdminCanonicalBytes(f);
      expect(new TextDecoder().decode(b)).toBe(c.canonical);
      const sig = Buffer.from(ed.sign(b, signers[c.signer]!.privateKey)).toString("hex");
      expect(sig).toBe(c.signature);
      expect(verifyServerShareAcceptAdmin(f, bytes(sig), signers[c.signer]!.publicKey)).toBe(true);
      expect(verifyServerShareAcceptAdmin(f, bytes(sig), signers.otherAdmin!.publicKey)).toBe(false);
      expect(parseServerShareAcceptAdmin(f)).toEqual(f);
    }
  });

  it("refuses every refuse case", () => {
    for (const c of V.refuse) {
      expect(() => serverShareAcceptAdminCanonicalBytes(c.fields), c.why).toThrow();
      expect(parseServerShareAcceptAdmin(c.fields), c.why).toBeNull();
    }
  });

  it("fails every reject case", () => {
    for (const c of V.reject) {
      expect(verifyServerShareAcceptAdmin(c.fields, bytes(c.signature), signers[c.pub]!.publicKey), c.why).toBe(false);
    }
  });

  it("parses the sealed acceptance's plaintext with its admin proof", () => {
    const p = parseShareAcceptancePayload(V.payload);
    expect(p?.admin?.admit).toEqual(V.payload.admin.admit);
    expect(p?.admin?.attestation.keyPubHex).toBe(V.keys.shareAdminPubHex);
    expect(p?.admin?.attestation.keyKind).toBe("share");
    const { admin: _a, ...withoutAdmin } = V.payload;
    expect(parseShareAcceptancePayload(withoutAdmin)?.admin).toBeUndefined();
    expect(parseShareAcceptancePayload({ ...V.payload, admin: { ...V.payload.admin, signature: "ab" } })).toBeNull();
  });

  it("the vectors file is current", () => {
    execFileSync("node", [join(root, "scripts", "gen-share-accept-admin-vectors.mjs"), "--check"], { stdio: "pipe" });
  });
});

describe("AccountKeyAttestation", () => {
  const a = V.attestation.attestation;
  const t0 = a.issuedAt as number;

  it("matches the vector and re-signs to the same bytes", () => {
    expect(new TextDecoder().decode(canonicalAccountKeyAttestation(a))).toBe(V.attestation.canonical);
    const again = signAccountKeyAttestation(
      { keyKind: a.keyKind, keyPubHex: a.keyPubHex, issuedAt: a.issuedAt, expiresAt: a.expiresAt },
      ca,
    );
    expect(again).toEqual(a);
    expect(a.expiresAt - a.issuedAt).toBe(ACCOUNT_KEY_ATTESTATION_TTL_MS);
  });

  it("verifies only under an authorized CA key, inside its TTL", () => {
    const parsed = parseAccountKeyAttestation(a)!;
    expect(verifyCaSignedAccountKeyAttestation(parsed, chain([V.keys.caPubHex]), t0 + 1)).toEqual({ ok: true });
    expect(verifyCaSignedAccountKeyAttestation(parsed, chain([V.keys.otherAdminPubHex]), t0 + 1)).toEqual({
      ok: false,
      reason: "signature-unverified",
    });
    expect(verifyCaSignedAccountKeyAttestation(parsed, chain([]), t0 + 1)).toEqual({ ok: false, reason: "no-authorized-ca-keys" });
    expect(verifyCaSignedAccountKeyAttestation(parsed, null, t0 + 1)).toEqual({ ok: false, reason: "no-authorized-ca-keys" });
    expect(verifyCaSignedAccountKeyAttestation(parsed, chain([V.keys.caPubHex]), a.expiresAt)).toEqual({
      ok: false,
      reason: "artifact-expired",
    });
    expect(verifyCaSignedAccountKeyAttestation(parsed, chain([V.keys.caPubHex]), t0 + 1, "")).toEqual({
      ok: false,
      reason: "pin-unconfigured",
    });
  });

  it("a swapped key or kind no longer verifies", () => {
    const swapped = { ...a, keyPubHex: V.keys.otherAdminPubHex };
    expect(verifyCaSignedAccountKeyAttestation(swapped, chain([V.keys.caPubHex]), t0 + 1).ok).toBe(false);
    const relabelled = { ...a, keyKind: "admin-root" as never };
    expect(verifyCaSignedAccountKeyAttestation(relabelled, chain([V.keys.caPubHex]), t0 + 1).ok).toBe(false);
    expect(parseAccountKeyAttestation({ ...a, keyKind: "admin-root" })).toBeNull();
    expect(parseAccountKeyAttestation({ ...a, keyKind: "irk" })).toBeNull();
  });

  it("rejects malformed shapes", () => {
    expect(parseAccountKeyAttestation({ ...a, kind: "UserPubKeyBinding" })).toBeNull();
    expect(parseAccountKeyAttestation({ ...a, keyKind: "device" })).toBeNull();
    expect(parseAccountKeyAttestation({ ...a, expiresAt: a.issuedAt })).toBeNull();
    expect(parseAccountKeyAttestation({ ...a, signature: "00" })).toBeNull();
    expect(parseAccountKeyAttestation(null)).toBeNull();
  });
});
