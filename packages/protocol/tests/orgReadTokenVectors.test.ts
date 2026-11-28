import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalOrgReadTokenRequest,
  deriveOrgSeatMemberSeeds,
  ed,
  orgBoxReadSubject,
  orgReadTokenPath,
  orgSeatReadSubject,
  signOrgReadTokenRequest,
  verifyOrgReadTokenRequest,
} from "../src/index.js";

const v = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/org-read-token/vectors.json"), "utf8"),
);
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("org-read-token vectors", () => {
  const member = deriveOrgSeatMemberSeeds(bytes(v.keys.umkSeedHex), v.keys.orgId);

  it("derives the seat member key", () => {
    expect(hex(member.edSeed)).toBe(v.keys.memberEdSeedHex);
    expect(hex(ed.getPublicKey(member.edSeed))).toBe(v.keys.memberPubHex);
    expect(hex(ed.getPublicKey(bytes(v.keys.stkSeedHex)))).toBe(v.keys.stkPubHex);
  });

  for (const [name, seed, pub, subject] of [
    ["seat", () => member.edSeed, v.keys.memberPubHex, orgSeatReadSubject(v.keys.seatId)],
    ["box", () => bytes(v.keys.stkSeedHex), v.keys.stkPubHex, orgBoxReadSubject("home.acme.flagship.services")],
  ] as const) {
    it(`reproduces the ${name} request`, () => {
      const x = v[name];
      expect(x.path).toBe(orgReadTokenPath(v.keys.orgId));
      expect(x.request.subject).toBe(subject);
      expect(new TextDecoder().decode(canonicalOrgReadTokenRequest(x.request))).toBe(x.canonical);
      expect(signOrgReadTokenRequest(x.request, (m) => ed.sign(m, seed()))).toBe(x.signatureHex);
      expect(verifyOrgReadTokenRequest(x.request, x.signatureHex, bytes(pub))).toBe(true);
      expect(verifyOrgReadTokenRequest(x.request, x.reject.signatureHex, bytes(pub))).toBe(false);
    });
  }
});
