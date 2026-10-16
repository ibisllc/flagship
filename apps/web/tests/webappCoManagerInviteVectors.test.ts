// Co-manager invites on the webapp (docs/service-access-gating.md "Co-manager
// invites"): every value in the shared co-manager-invite vectors, reproduced by
// lib/serverShare.js and lib/serviceInvite.js.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const V = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/co-manager-invite/vectors.json"), "utf8"),
);

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

async function verify(sigHex: string, msg: Uint8Array, pubHex: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", fromHex(pubHex), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, fromHex(sigHex), msg);
}

function create(f: Record<string, unknown>) {
  return { ...f, authorAID: fromHex(f.authorAID as string) };
}

describe("co-manager invite vectors (webapp)", () => {
  it("derives the member key and the bundle key", async () => {
    const ss = await load("lib/serverShare.js");
    const seed = fromHex(V.keys.memberUmkSeedHex);
    expect(hex((await ss.deriveShareMemberKey(seed, V.keys.shareId)).publicKey)).toBe(V.keys.memberPubHex);
    expect(hex((await ss.deriveShareMemberKey(seed, V.keys.otherShareId)).publicKey)).toBe(V.keys.otherMemberPubHex);
    expect(hex(await ss.deriveShareInviteBundleKey(seed, V.keys.shareId))).toBe(V.keys.bundleKeyHex);
  });

  it("seals and opens each bundle", async () => {
    const si = await load("lib/serviceInvite.js");
    const key = fromHex(V.keys.bundleKeyHex);
    for (const b of V.bundles) {
      const plain = JSON.parse(b.plaintext);
      expect(await si.sealInviteBundle(plain, key, b.inviteId, fromHex(b.nonceHex))).toBe(b.sealedHex);
      expect(await si.openInviteBundle(b.sealedHex, key, b.inviteId)).toEqual(plain);
    }
  });

  it("reproduces the create and revoke strings and their member-key signatures", async () => {
    const si = await load("lib/serviceInvite.js");
    for (const c of V.creates) {
      const bytes = si.canonicalCreateBytes(create(c.fields));
      expect(utf8(bytes)).toBe(c.canonical);
      expect(await verify(c.signatureHex, bytes, V.keys.memberPubHex)).toBe(true);
    }
    const rb = si.canonicalRevokeBytes(V.revoke.fields);
    expect(utf8(rb)).toBe(V.revoke.canonical);
    expect(await verify(V.revoke.signatureHex, rb, V.keys.memberPubHex)).toBe(true);
  });

  it("fails the create rejects", async () => {
    const si = await load("lib/serviceInvite.js");
    for (const r of V.reject.filter((x: { envelope: string }) => x.envelope === "create")) {
      const bytes = si.canonicalCreateBytes(create(r.fields));
      expect(await verify(r.signatureHex, bytes, V.keys[r.verifyUnder]), r.why).toBe(false);
    }
  });
});
