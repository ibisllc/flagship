// The webapp's username claim signs flagship/claim-username/v2 (test-vectors/claim-username): the same bytes and
// signature as the shared vectors, and the refused cases fail the webapp's own verify.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { claimUsername, TAG_CLAIM } from "../public/webapp/lib/openAccount.js";
import { verifyEd25519Sync } from "../public/webapp/lib/edKey.js";

interface Case {
  name: string;
  request: { username: string; irkPub: string; issuedAt: number };
  aidPub: string | null;
  adminRootPub: string | null;
  canonical: string;
  signatureHex: string;
}
const v = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/claim-username/vectors.json"), "utf8"),
) as { keys: { irkSeedHex: string }; accept: Case[]; reject: Case[] };
const b = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const enc = (s: string) => new TextEncoder().encode(s);

afterEach(() => vi.restoreAllMocks());

describe("web claim-username v2", () => {
  it("signs the vector bytes for a claim with and without an admin root", async () => {
    expect(TAG_CLAIM).toBe("flagship/claim-username/v2");
    for (const c of v.accept.filter((x) => x.aidPub === null)) {
      vi.spyOn(Date, "now").mockReturnValue(c.request.issuedAt);
      let signed = "";
      let body: Record<string, unknown> = {};
      await claimUsername(c.request.username, b(c.request.irkPub), async (bytes: Uint8Array) => {
        signed = new TextDecoder().decode(bytes);
        return ed25519.sign(bytes, b(v.keys.irkSeedHex));
      }, {
        fetch: (async (_u: string, init: { body: string }) => {
          body = JSON.parse(init.body);
          return new Response("{}", { status: 200 });
        }) as never,
        ...(c.adminRootPub ? { adminRootPubHex: c.adminRootPub } : {}),
      });
      expect(signed, c.name).toBe(c.canonical);
      expect(body.signature, c.name).toBe(c.signatureHex);
      expect(body.adminRootPub ?? null, c.name).toBe(c.adminRootPub);
    }
  });

  it("accepts every accept case and refuses every reject case", () => {
    for (const c of v.accept) expect(verifyEd25519Sync(b(c.request.irkPub), b(c.signatureHex), enc(c.canonical)), c.name).toBe(true);
    for (const c of v.reject) expect(verifyEd25519Sync(b(c.request.irkPub), b(c.signatureHex), enc(c.canonical)), c.name).toBe(false);
  });
});
