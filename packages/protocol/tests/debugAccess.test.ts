import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEBUG_ACCESS_MAX_MS,
  canonicalDebugAccessGrant,
  canonicalDebugAccessRevoke,
  debugAccessGrantProblem,
  ed,
  normalizeSshPublicKey,
  parseDebugAccessGrant,
  signDebugAccessGrant,
  sshKeyFingerprint,
  verifyDebugAccessGrant,
  verifyDebugAccessRevoke,
  type DebugAccessGrant,
} from "../src/index.js";

const V = JSON.parse(
  readFileSync(new URL("../test-vectors/debug-access/vectors.json", import.meta.url), "utf8"),
);
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const admin = { privateKey: bytes(V.keys.adminRootSeedHex), publicKey: bytes(V.keys.adminRootPubHex) };

describe("debug access vectors", () => {
  it("derives the pinned admin root", () => {
    expect(Buffer.from(ed.getPublicKey(admin.privateKey)).toString("hex")).toBe(V.keys.adminRootPubHex);
  });

  it("normalizes and fingerprints SSH keys", () => {
    for (const k of V.sshKeys.accept) {
      expect(normalizeSshPublicKey(k.input)).toBe(k.normalized);
      expect(sshKeyFingerprint(k.input)).toBe(k.fingerprint);
    }
    for (const r of V.sshKeys.reject) expect(normalizeSshPublicKey(r), r).toBeNull();
  });

  it("reproduces the grant and revoke bytes and signatures", () => {
    const g = V.grant.fields as DebugAccessGrant;
    expect(new TextDecoder().decode(canonicalDebugAccessGrant(g))).toBe(V.grant.canonical);
    expect(Buffer.from(signDebugAccessGrant(g, admin)).toString("hex")).toBe(V.grant.signatureHex);
    expect(verifyDebugAccessGrant(g, bytes(V.grant.signatureHex), admin.publicKey)).toBe(true);
    expect(verifyDebugAccessGrant(g, bytes(V.grant.reject.signatureHex), admin.publicKey)).toBe(false);
    expect(verifyDebugAccessGrant(g, bytes(V.grant.signatureHex), bytes(V.keys.irkPubHex))).toBe(false);

    const r = V.revoke.fields;
    expect(new TextDecoder().decode(canonicalDebugAccessRevoke(r))).toBe(V.revoke.canonical);
    expect(verifyDebugAccessRevoke(r, bytes(V.revoke.signatureHex), admin.publicKey)).toBe(true);
    expect(verifyDebugAccessRevoke(r, bytes(V.revoke.reject.signatureHex), admin.publicKey)).toBe(false);
  });

  it("refuses every refuse case before signing", () => {
    for (const r of V.refuse) {
      expect(debugAccessGrantProblem(r.fields), r.why).not.toBeNull();
      expect(() => signDebugAccessGrant(r.fields, admin), r.why).toThrow();
    }
  });
});

describe("debug access grant", () => {
  const g = V.grant.fields as DebugAccessGrant;
  const sig = bytes(V.grant.signatureHex);

  it("a changed field never verifies", () => {
    expect(verifyDebugAccessGrant({ ...g, expiresAt: g.expiresAt + 1 }, sig, admin.publicKey)).toBe(false);
    expect(verifyDebugAccessGrant({ ...g, serverDomain: "other.plucky-avocet.flagship.services" }, sig, admin.publicKey)).toBe(false);
    expect(verifyDebugAccessGrant({ ...g, issuedAt: g.issuedAt + 1 }, sig, admin.publicKey)).toBe(false);
  });

  it("a grant signature is not a revoke signature", () => {
    const r = { serverDomain: g.serverDomain, issuedAt: g.issuedAt };
    expect(verifyDebugAccessRevoke(r, sig, admin.publicKey)).toBe(false);
  });

  it("says why a grant can't be used", () => {
    expect(debugAccessGrantProblem({ ...g, sshPublicKey: "" })).toBe("Debug access needs an SSH public key.");
    expect(debugAccessGrantProblem({ ...g, expiresAt: g.issuedAt + DEBUG_ACCESS_MAX_MS })).toBeNull();
    expect(debugAccessGrantProblem({ ...g, expiresAt: g.issuedAt + DEBUG_ACCESS_MAX_MS + 1 })).toMatch(/7 days/);
  });

  it("parses only the v2 shape", () => {
    expect(parseDebugAccessGrant(g)).toEqual(g);
    expect(parseDebugAccessGrant({ serverDomain: g.serverDomain, sshAuthorizedKey: "", issuedAt: 1 })).toBeNull();
  });
});
