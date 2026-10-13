// Share a server on the webapp (docs/share-a-server.md §3, §4): every value in
// the shared server-share vectors, reproduced by lib/serverShare.js.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const V = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/server-share/vectors.json"), "utf8"),
);

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}
const loadShare = () => load("lib/serverShare.js");

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

const ownerSeed = fromHex(V.keys.ownerUmkSeedHex);
const memberSeed = fromHex(V.keys.memberUmkSeedHex);
const secret = fromHex(V.keys.secretHex);

const NAMES: Record<string, string> = {
  grant: "ServerShareGrant",
  revoke: "ServerShareRevoke",
  accept: "ServerShareAccept",
  leave: "ServerShareLeave",
  session: "ServerShareSession",
  offer: "ServerShareOffer",
  list: "ServerShareList",
  unlock: "ServerShareUnlock",
  inbox: "ShareInboxRequest",
};

function fns(m: Record<string, any>, kind: string) {
  const n = NAMES[kind]!;
  const canonName = kind === "inbox" ? "shareInboxRequestCanonicalBytes" : `${n[0]!.toLowerCase()}${n.slice(1)}CanonicalBytes`;
  return { canon: m[canonName], sign: m[`sign${n}`], verify: m[`verify${n}`], parse: m[`parse${n}`] };
}

async function signers() {
  const m = await loadShare();
  const { signWithIrk, deriveIrkFromSeed } = await load("keystore.js");
  const member = await m.deriveShareMemberKey(memberSeed, V.keys.shareId);
  const inbox = await m.deriveShareInboxKey(memberSeed);
  const ownerPub = new Uint8Array((await deriveIrkFromSeed(ownerSeed)).publicKey);
  return {
    m,
    sign: {
      owner: { umk: ownerSeed, signWithIrk },
      member: member.seed,
      inbox: inbox.seed,
    } as Record<string, unknown>,
    pub: { owner: ownerPub, member: member.publicKey, inbox: inbox.publicKey } as Record<string, Uint8Array>,
  };
}

describe("server share — keys", () => {
  it("derives every key value from the UMK seeds and the link secret", async () => {
    const m = await loadShare();
    const { deriveIrkFromSeed, deriveHouseholdKeyFromSeed } = await load("keystore.js");
    expect(hex(new Uint8Array((await deriveIrkFromSeed(ownerSeed)).publicKey))).toBe(V.keys.ownerSignerPub);
    expect(hex(await deriveHouseholdKeyFromSeed(ownerSeed))).toBe(V.keys.householdKeyHex);

    const member = await m.deriveShareMemberKey(memberSeed, V.keys.shareId);
    expect(hex(member.publicKey)).toBe(V.keys.memberPubHex);
    expect(hex(await m.ed25519PublicKey(member.seed))).toBe(V.keys.memberPubHex);
    expect(hex((await m.deriveShareInboxKey(memberSeed)).publicKey)).toBe(V.keys.inboxPubHex);
    expect(hex((await m.deriveShareInboxKey({ seed: memberSeed })).publicKey)).toBe(V.keys.inboxPubHex);
    expect(hex(await m.deriveShareInboxSealKey(memberSeed))).toBe(V.keys.inboxSealKeyHex);

    expect(await m.shareTokenFromSecret(secret)).toBe(V.keys.token);
    expect(await m.shareTokenHash(V.keys.token)).toBe(V.keys.tokenHash);
    expect(hex(await m.shareLinkKey(secret))).toBe(V.keys.linkKeyHex);

    const sas = await m.shareSas(V.keys.shareId, V.keys.memberPubHex, secret);
    expect(sas).toBe(V.keys.sas);
    expect(m.formatShareSas(sas)).toBe(V.keys.sasFormatted);
  });

  it("gives a different member key per share and per account", async () => {
    const m = await loadShare();
    const a = await m.deriveShareMemberKey(memberSeed, V.keys.shareId);
    const b = await m.deriveShareMemberKey(memberSeed, "00000000000000000000000000000001");
    const c = await m.deriveShareMemberKey(ownerSeed, V.keys.shareId);
    expect(hex(a.publicKey)).not.toBe(hex(b.publicKey));
    expect(hex(a.publicKey)).not.toBe(hex(c.publicKey));
    expect(hex(a.publicKey)).not.toBe(V.keys.inboxPubHex);
    await expect(m.deriveShareMemberKey(memberSeed, "XYZ")).rejects.toThrow(/shareId/);
  });

  it("refuses bad inputs to the derivations", async () => {
    const m = await loadShare();
    await expect(m.shareTokenFromSecret(new Uint8Array(31))).rejects.toThrow(/32 bytes/);
    await expect(m.shareTokenHash(V.keys.token.toUpperCase())).rejects.toThrow(/64 lowercase hex/);
    await expect(m.shareSas(V.keys.shareId, "ab", secret)).rejects.toThrow(/memberPubHex/);
    expect(m.randomShareId()).toMatch(/^[0-9a-f]{32}$/);
    expect(m.randomShareId()).not.toBe(m.randomShareId());
  });
});

describe("server share — envelopes", () => {
  it("builds each canonical string, reproduces each signature and verifies it", async () => {
    const { m, sign, pub } = await signers();
    expect(V.envelopes.length).toBe(13);
    for (const e of V.envelopes) {
      const f = fns(m, e.kind);
      expect(utf8(f.canon(e.fields)), e.kind).toBe(e.canonical);
      const sig = await f.sign(e.fields, sign[e.signer]);
      expect(hex(sig), e.kind).toBe(e.signature);
      expect(await f.verify(e.fields, sig, pub[e.signer]), e.kind).toBe(true);
      expect(await f.verify(e.fields, e.signature, hex(pub[e.signer]!)), e.kind).toBe(true);
      expect(f.parse(JSON.parse(JSON.stringify(e.fields))), e.kind).toEqual(e.fields);
    }
  });

  it("signs with a bare seed, a function and {umk, signWithIrk} alike", async () => {
    const { m, pub } = await signers();
    const { signWithIrk } = await load("keystore.js");
    const grant = V.envelopes[0].fields;
    const viaObj = await m.signServerShareGrant(grant, { umk: ownerSeed, signWithIrk });
    const viaFn = await m.signServerShareGrant(grant, (b: Uint8Array) => signWithIrk(ownerSeed, b));
    expect(hex(viaObj)).toBe(V.envelopes[0].signature);
    expect(hex(viaFn)).toBe(V.envelopes[0].signature);
    expect(await m.verifyServerShareGrant(grant, viaObj, pub.owner)).toBe(true);
    await expect(m.signServerShareGrant(grant, new Uint8Array(5))).rejects.toThrow(/32 bytes/);
    await expect(m.signServerShareGrant(grant, null)).rejects.toThrow(/signer/);
  });

  it("refuses every refuse case, in the builder, the signer and the parser", async () => {
    const { m, sign } = await signers();
    for (const c of V.refuse) {
      const f = fns(m, c.kind);
      expect(() => f.canon(c.fields), c.why).toThrow();
      await expect(f.sign(c.fields, sign.member), c.why).rejects.toThrow();
      expect(f.parse(c.fields), c.why).toBeNull();
    }
  });

  it("fails to verify every reject case", async () => {
    const { m, pub } = await signers();
    for (const c of V.reject) {
      const f = fns(m, c.kind);
      expect(await f.verify(c.fields, fromHex(c.signature), pub[c.pub]), c.why).toBe(false);
    }
  });

  it("verify never throws on garbage", async () => {
    const { m, pub } = await signers();
    const g = V.envelopes[0];
    expect(await m.verifyServerShareGrant(g.fields, new Uint8Array(3), pub.owner)).toBe(false);
    expect(await m.verifyServerShareGrant(g.fields, g.signature, new Uint8Array(3))).toBe(false);
    expect(await m.verifyServerShareGrant({ ...g.fields, level: "admin" }, g.signature, pub.owner)).toBe(false);
  });

  it("normalizes labels by code points", async () => {
    const m = await loadShare();
    expect(m.normalizeShareLabel("  Sam ")).toBe("Sam");
    expect(m.normalizeShareLabel("🌹".repeat(64))).toBe("🌹".repeat(64));
    expect(m.normalizeShareLabel("🌹".repeat(65))).toBeNull();
    expect(m.normalizeShareLabel("a|b")).toBeNull();
    expect(m.normalizeShareLabel("a\u007fb")).toBeNull();
    expect(m.normalizeShareLabel("   ")).toBeNull();
  });
});

describe("server share — sealed payloads", () => {
  it("seals each plaintext to the exact hex and opens it back", async () => {
    const m = await loadShare();
    expect(V.sealed.length).toBe(4);
    for (const s of V.sealed) {
      const key = fromHex(s.keyHex);
      const [prefix, id] = s.aad.split("|");
      const aad = m.shareAad(prefix, id);
      expect(utf8(aad)).toBe(s.aad);
      expect(await m.sealShareJson(key, aad, s.plaintext, fromHex(s.nonceHex)), s.name).toBe(s.sealed);
      expect(await m.sealShareJson(key, aad, JSON.parse(s.plaintext), fromHex(s.nonceHex)), s.name).toBe(s.sealed);
      expect(await m.openShareJson(key, aad, s.sealed), s.name).toEqual(JSON.parse(s.plaintext));
    }
  });

  it("parses each opened payload with its parser", async () => {
    const m = await loadShare();
    const byName = Object.fromEntries(V.sealed.map((s: any) => [s.name, JSON.parse(s.plaintext)]));
    expect(m.parseShareOfferPayload(byName.offer)).toEqual(byName.offer);
    expect(m.parseShareAcceptancePayload(byName.acceptance)).toEqual(byName.acceptance);
    expect(m.parseShareOwnerRecord(byName.owner)).toEqual(byName.owner);
    expect(m.parseShareInboxEntry(byName.inbox)).toEqual(byName.inbox);
    expect(m.parseShareOfferPayload({ ...byName.offer, level: "admin" })).toBeNull();
    expect(m.parseShareOwnerRecord({ ...byName.owner, label: "a|b" })).toBeNull();
    expect(m.parseShareAcceptancePayload({ ...byName.acceptance, signature: "ab" })).toBeNull();
    expect(m.parseShareInboxEntry({ ...byName.inbox, v: 2 })).toBeNull();
  });

  it("refuses a wrong key, a wrong AAD and a tampered ciphertext", async () => {
    const m = await loadShare();
    const s = V.sealed[0];
    const key = fromHex(s.keyHex);
    const aad = m.shareAad("flagship/server-share/offer/v1", V.keys.shareId);
    await expect(m.openShareJson(new Uint8Array(32), aad, s.sealed)).rejects.toThrow();
    await expect(m.openShareJson(key, m.shareAad("flagship/server-share/acceptance/v1", V.keys.shareId), s.sealed)).rejects.toThrow();
    const flipped = s.sealed.slice(0, -2) + (s.sealed.endsWith("00") ? "01" : "00");
    await expect(m.openShareJson(key, aad, flipped)).rejects.toThrow();
    await expect(m.openShareJson(key, aad, "abcd")).rejects.toThrow(/too short/);
    await expect(m.sealShareJson(new Uint8Array(16), aad, "{}")).rejects.toThrow(/32 bytes/);
    expect(() => m.shareAad("x", "a|b")).toThrow();
    const random = await m.sealShareJson(key, aad, s.plaintext);
    expect(random).not.toBe(s.sealed);
    expect(await m.openShareJson(key, aad, random)).toEqual(JSON.parse(s.plaintext));
  });
});

describe("server share — links", () => {
  it("builds and parses the links", async () => {
    const m = await loadShare();
    const b = V.links.build;
    const link = m.buildShareLink(b.apex, b.shareId, fromHex(b.secretHex));
    expect(link).toBe(b.link);
    expect(m.buildShareLink(`${b.apex}/`, b.shareId, fromHex(b.secretHex))).toBe(b.link);
    expect(m.parseShareLink(link)).toEqual({ shareId: b.shareId, secretHex: b.secretHex });
    for (const c of V.links.parse) expect(m.parseShareLink(c.in), c.in).toEqual(c.out);
  });
});
