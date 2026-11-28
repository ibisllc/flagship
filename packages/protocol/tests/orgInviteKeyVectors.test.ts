import { readFileSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalOrgInviteRead,
  canonicalOrgInviteWithdraw,
  canonicalOrgSeatAccept,
  canonicalOrgSeatInvite,
  deriveOrgInviteKeys,
  orgSha256Hex,
  orgInviteAcceptSignature,
  orgInviteReadSignature,
  verifyOrgInviteAccept,
  verifyOrgInviteRead,
} from "../src/orgAuthority.js";

const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "test-vectors", "org-invite-key", "vectors.json"), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("org invite key vectors", () => {
  it("derives the offer key and the invite key from the link key", () => {
    const k = deriveOrgInviteKeys(unhex(V.linkKeyHex));
    expect(hex(k.offerKey)).toBe(V.offerKeyHex);
    expect(hex(k.hybridSecret)).toBe(V.inviteSecretHex);
    expect(k.inviteKeyPub).toBe(V.inviteKeyPub);
    expect(deriveOrgInviteKeys(unhex(V.wrongLinkKeyHex)).inviteKeyPub).toBe(V.wrongInviteKeyPub);
  });

  it("opens the offer under the offer key, not the raw link key", () => {
    const sealed = unhex(V.offer.sealedHex);
    const open = (key: Uint8Array) => {
      const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
      d.setAuthTag(sealed.subarray(sealed.length - 16));
      return Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]).toString("utf8");
    };
    expect(open(unhex(V.offerKeyHex))).toBe(V.offer.plaintext);
    expect(() => open(unhex(V.linkKeyHex))).toThrow();
  });

  it("canonical bytes", () => {
    expect(dec(canonicalOrgSeatInvite(V.invites.invite))).toBe(V.canonical.invite.bytes);
    expect(orgSha256Hex(canonicalOrgSeatInvite(V.invites.invite))).toBe(V.canonical.invite.sha256);
    const r = V.canonical.read;
    expect(dec(canonicalOrgInviteRead(r.orgId, r.seatId, r.issuedAt))).toBe(r.bytes);
    expect(dec(canonicalOrgSeatAccept(V.acceptObjects.accept))).toBe(V.canonical.accept.bytes);
    const w = V.canonical.withdraw;
    expect(dec(canonicalOrgInviteWithdraw({ orgId: w.orgId, seatId: w.seatId, oarVersion: w.oarVersion, issuedAt: w.issuedAt }))).toBe(w.bytes);
  });

  it("an invite without an invite key is malformed", () => {
    const { inviteKeyPub: _drop, ...old } = V.invites.invite;
    expect(() => canonicalOrgSeatInvite(old)).toThrow(/inviteKeyPub/);
  });

  for (const r of V.reads) {
    it(`read: ${r.name}`, () => {
      expect(verifyOrgInviteRead(V.invites[r.invite], r.issuedAt, r.signature, r.now)).toBe(r.expect);
    });
  }

  for (const a of V.accepts) {
    it(`accept: ${a.name}`, () => {
      expect(verifyOrgInviteAccept(V.invites[a.invite], V.acceptObjects[a.accept], a.signature)).toBe(a.expect);
    });
  }

  it("signing reproduces the deterministic proofs", () => {
    const secret = unhex(V.inviteSecretHex);
    const r = V.canonical.read;
    expect(orgInviteReadSignature(secret, r.orgId, r.seatId, r.issuedAt, { deterministic: true })).toBe(V.reads[0].signature);
    expect(orgInviteAcceptSignature(secret, V.acceptObjects.accept, { deterministic: true })).toBe(V.accepts[0].signature);
  });
});
