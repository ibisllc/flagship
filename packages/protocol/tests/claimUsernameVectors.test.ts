import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyClaimUsername, type ClaimUsername } from "../src/index.js";

interface Case {
  name: string;
  request: { username: string; irkPub: string; issuedAt: number };
  aidPub: string | null;
  adminRootPub: string | null;
  canonical: string;
  signatureHex: string;
}
const v = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../test-vectors/claim-username/vectors.json"), "utf8"),
) as { accept: Case[]; reject: Case[] };
const b = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
const claimOf = (c: Case): ClaimUsername => ({
  username: c.request.username,
  irkPub: b(c.request.irkPub),
  issuedAt: c.request.issuedAt,
  ...(c.aidPub ? { aidPub: b(c.aidPub) } : {}),
  ...(c.adminRootPub ? { adminRootPub: b(c.adminRootPub) } : {}),
});
const canonicalOf = (c: Case): string =>
  ["flagship/claim-username/v2", c.request.username, c.request.irkPub, c.aidPub ?? "", c.adminRootPub ?? "", c.request.issuedAt].join("|");

describe("flagship/claim-username/v2 vectors", () => {
  for (const c of v.accept) {
    it(`accepts ${c.name}`, () => {
      expect(canonicalOf(c)).toBe(c.canonical);
      expect(verifyClaimUsername(claimOf(c), b(c.signatureHex), b(c.request.irkPub))).toBe(true);
    });
  }
  for (const c of v.reject) {
    it(`refuses ${c.name}`, () => {
      expect(canonicalOf(c)).toBe(c.canonical);
      expect(verifyClaimUsername(claimOf(c), b(c.signatureHex), b(c.request.irkPub))).toBe(false);
    });
  }
});
