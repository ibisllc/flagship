import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildShareLink,
  deriveHouseholdKey,
  deriveIRK,
  deriveShareInboxKey,
  deriveShareInboxSealKey,
  deriveShareMemberKey,
  ed,
  formatShareSas,
  normalizeShareLabel,
  openShareJson,
  parseServerShareAccept,
  parseServerShareGrant,
  parseServerShareLeave,
  parseServerShareList,
  parseServerShareOffer,
  parseServerShareRevoke,
  parseServerSharePush,
  parseServerShareSession,
  parseServerShareUnlock,
  parseServerShareUpdate,
  parseShareAcceptancePayload,
  parseShareInboxEntry,
  parseShareInboxRequest,
  parseShareLink,
  parseShareOfferPayload,
  parseShareOwnerRecord,
  sealShareJson,
  serverShareAcceptCanonicalBytes,
  serverShareGrantCanonicalBytes,
  serverShareLeaveCanonicalBytes,
  serverShareListCanonicalBytes,
  serverShareOfferCanonicalBytes,
  serverSharePushCanonicalBytes,
  serverShareRevokeCanonicalBytes,
  serverShareSessionCanonicalBytes,
  serverShareUnlockCanonicalBytes,
  serverShareUpdateCanonicalBytes,
  shareSha256Hex,
  shareAad,
  shareInboxRequestCanonicalBytes,
  shareLinkKey,
  shareSas,
  shareTokenFromSecret,
  shareTokenHash,
  signServerShareGrant,
  verifyAppAccessGrant,
  verifyServerShareAccept,
  verifyServerShareGrant,
  verifyServerShareLeave,
  verifyServerShareSession,
  verifyServerShareUpdate,
  verifyUpdateOrder,
  type ServerShareGrant,
  type ServerShareUpdate,
} from "../src/index.js";
import { hex } from "../src/canonicalBase.js";
import type { Bytes } from "../src/types.js";

type Kind = "grant" | "revoke" | "accept" | "leave" | "session" | "offer" | "list" | "unlock" | "inbox" | "push" | "update";
interface Vectors {
  keys: Record<string, string>;
  envelopes: Array<{ kind: Kind; signer: "owner" | "member" | "inbox"; fields: Record<string, unknown>; canonical: string; signature: string }>;
  refuse: Array<{ kind: Kind; why: string; fields: Record<string, unknown> }>;
  reject: Array<{ kind: Kind; why: string; fields: Record<string, unknown>; signature: string; pub: "owner" | "member" }>;
  sealed: Array<{ name: string; keyHex: string; aad: string; plaintext: string; nonceHex: string; sealed: string }>;
  links: { build: { apex: string; shareId: string; secretHex: string; link: string }; parse: Array<{ in: string; out: unknown }> };
  pushTokens: Array<{ platform: string; token: string; sha256: string }>;
}

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/server-share/vectors.json"), "utf8"),
) as Vectors;
const fromHex = (h: string): Bytes => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const K = V.keys as Record<string, string>;
const owner = deriveIRK({ seed: fromHex(K.ownerUmkSeedHex!) });
const memberUmk = { seed: fromHex(K.memberUmkSeedHex!) };
const member = deriveShareMemberKey(memberUmk, K.shareId!);
const inbox = deriveShareInboxKey(memberUmk);
const secret = fromHex(K.secretHex!);
const signers = { owner, member, inbox };

/* eslint-disable @typescript-eslint/no-explicit-any */
const canon: Record<Kind, (f: any) => Bytes> = {
  grant: serverShareGrantCanonicalBytes,
  revoke: serverShareRevokeCanonicalBytes,
  accept: serverShareAcceptCanonicalBytes,
  leave: serverShareLeaveCanonicalBytes,
  session: serverShareSessionCanonicalBytes,
  offer: serverShareOfferCanonicalBytes,
  list: serverShareListCanonicalBytes,
  unlock: serverShareUnlockCanonicalBytes,
  inbox: shareInboxRequestCanonicalBytes,
  push: serverSharePushCanonicalBytes,
  update: serverShareUpdateCanonicalBytes,
};
const parse: Record<Kind, (v: unknown) => unknown> = {
  grant: parseServerShareGrant,
  revoke: parseServerShareRevoke,
  accept: parseServerShareAccept,
  leave: parseServerShareLeave,
  session: parseServerShareSession,
  offer: parseServerShareOffer,
  list: parseServerShareList,
  unlock: parseServerShareUnlock,
  inbox: parseShareInboxRequest,
  push: parseServerSharePush,
  update: parseServerShareUpdate,
};

describe("server-share vectors: keys", () => {
  it("derives every key from the two account seeds and the link secret", () => {
    expect(hex(owner.publicKey)).toBe(K.ownerSignerPub);
    expect(hex(member.publicKey)).toBe(K.memberPubHex);
    expect(hex(inbox.publicKey)).toBe(K.inboxPubHex);
    expect(hex(deriveShareInboxSealKey(memberUmk))).toBe(K.inboxSealKeyHex);
    expect(shareTokenFromSecret(secret)).toBe(K.token);
    expect(shareTokenHash(K.token!)).toBe(K.tokenHash);
    expect(hex(shareLinkKey(secret))).toBe(K.linkKeyHex);
    expect(hex(deriveHouseholdKey({ seed: fromHex(K.ownerUmkSeedHex!) }))).toBe(K.householdKeyHex);
    expect(shareSas(K.shareId!, K.memberPubHex!, secret)).toBe(K.sas);
    expect(formatShareSas(K.sas!)).toBe(K.sasFormatted);
  });

  it("gives the same person an unrelated key in every share", () => {
    const other = deriveShareMemberKey(memberUmk, "ffeeddccbbaa99887766554433221100");
    expect(hex(other.publicKey)).not.toBe(K.memberPubHex);
    expect(hex(deriveShareMemberKey({ seed: new Uint8Array(32).fill(1) }, K.shareId!).publicKey)).not.toBe(K.memberPubHex);
  });
});

describe("server-share vectors: envelopes", () => {
  it.each(V.envelopes.map((c, i) => [i, c.kind, c] as const))("#%i %s", (_i, kind, c) => {
    const bytes = canon[kind](c.fields);
    expect(new TextDecoder().decode(bytes)).toBe(c.canonical);
    const s = signers[c.signer];
    expect(hex(ed.sign(bytes, s.privateKey))).toBe(c.signature);
    expect(ed.verify(fromHex(c.signature), bytes, s.publicKey)).toBe(true);
    expect(parse[kind](JSON.parse(JSON.stringify(c.fields)))).toEqual(c.fields);
  });

  it.each(V.refuse.map((c) => [c.kind, c.why, c] as const))("refuses %s: %s", (kind, _why, c) => {
    expect(() => canon[kind](c.fields)).toThrow();
    expect(parse[kind](c.fields)).toBeNull();
  });

  it.each(V.reject.map((c) => [c.why, c] as const))("does not verify: %s", (_why, c) => {
    const pub = c.pub === "owner" ? owner.publicKey : member.publicKey;
    let ok = false;
    try {
      ok = ed.verify(fromHex(c.signature), canon[c.kind](c.fields), pub);
    } catch {
      ok = false;
    }
    expect(ok).toBe(false);
  });
});

describe("server-share vectors: sealed payloads and links", () => {
  it.each(V.sealed.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    const [prefix, id] = [c.aad.slice(0, c.aad.lastIndexOf("|")), c.aad.slice(c.aad.lastIndexOf("|") + 1)];
    const aad = shareAad(prefix, id);
    expect(new TextDecoder().decode(aad)).toBe(c.aad);
    const key = fromHex(c.keyHex);
    expect(sealShareJson(key, aad, JSON.parse(c.plaintext), fromHex(c.nonceHex))).toBe(c.sealed);
    expect(openShareJson(key, aad, c.sealed)).toEqual(JSON.parse(c.plaintext));
    expect(() => openShareJson(key, shareAad(prefix, "00".repeat(16)), c.sealed)).toThrow();
  });

  it("parses each sealed payload's shape", () => {
    const by = Object.fromEntries(V.sealed.map((c) => [c.name, JSON.parse(c.plaintext) as unknown]));
    expect(parseShareOfferPayload(by.offer)).not.toBeNull();
    expect(parseShareOwnerRecord(by.owner)).not.toBeNull();
    expect(parseShareInboxEntry(by.inbox)).not.toBeNull();
    const acc = parseShareAcceptancePayload(by.acceptance);
    expect(acc).not.toBeNull();
    expect(verifyServerShareAccept(acc!.accept, fromHex(acc!.signature), member.publicKey)).toBe(true);
    expect(parseShareOfferPayload({ ...(by.offer as object), level: "admin" })).toBeNull();
    expect(parseShareOwnerRecord({ ...(by.owner as object), label: "a|b" })).toBeNull();
  });

  it("hashes push tokens as the envelopes sign them", () => {
    for (const t of V.pushTokens) expect(shareSha256Hex(t.token)).toBe(t.sha256);
  });

  it("builds and parses links", () => {
    const b = V.links.build;
    expect(buildShareLink(b.apex, b.shareId, fromHex(b.secretHex))).toBe(b.link);
    for (const c of V.links.parse) expect(parseShareLink(c.in)).toEqual(c.out);
  });
});

describe("server-share beyond the vectors", () => {
  const g = V.envelopes[0]!.fields as unknown as ServerShareGrant;

  it("a grant signed by the member never verifies as the owner's", () => {
    const sig = signServerShareGrant(g, member);
    expect(verifyServerShareGrant(g, sig, owner.publicKey)).toBe(false);
    expect(verifyServerShareGrant(g, signServerShareGrant(g, owner), owner.publicKey)).toBe(true);
  });

  it("never accepts a member signature from one envelope as another", () => {
    const base = { serverDomain: g.serverDomain, shareId: g.shareId, memberPubHex: g.memberPubHex };
    const acceptSig = ed.sign(serverShareAcceptCanonicalBytes({ ...base, acceptedAt: 5 }), member.privateKey);
    expect(verifyServerShareLeave({ ...base, issuedAt: 5 }, acceptSig, member.publicKey)).toBe(false);
    expect(verifyServerShareSession({ ...base, nonceHex: "00".repeat(32), issuedAt: 5 }, acceptSig, member.publicKey)).toBe(false);
    expect(verifyAppAccessGrant({ serverDomain: g.serverDomain, serviceId: "x", listSha256: "00".repeat(32), issuedAt: 5 }, acceptSig, member.publicKey)).toBe(false);
  });

  it("never lets a member's update verify as the owner's update order, or the reverse", () => {
    const u = V.envelopes.find((e) => e.kind === "update")!.fields as unknown as ServerShareUpdate;
    const order = { serverDomain: u.serverDomain, targetCommit: u.targetCommit, fromCommit: u.fromCommit, nonce: u.nonce, issuedAt: u.issuedAt };
    const memberSig = ed.sign(serverShareUpdateCanonicalBytes(u), member.privateKey);
    expect(verifyUpdateOrder(order, memberSig, member.publicKey)).toBe(false);
    expect(verifyServerShareUpdate(u, memberSig, member.publicKey)).toBe(true);
    expect(verifyServerShareUpdate(u, memberSig, owner.publicKey)).toBe(false);
    expect(verifyServerShareUpdate({ ...u, shareId: "ffeeddccbbaa99887766554433221100" }, memberSig, member.publicKey)).toBe(false);
  });

  it("normalizes labels", () => {
    expect(normalizeShareLabel("  Sam ")).toBe("Sam");
    expect(normalizeShareLabel("🌹".repeat(64))).toBe("🌹".repeat(64));
    expect(normalizeShareLabel("🌹".repeat(65))).toBeNull();
    expect(normalizeShareLabel("   ")).toBeNull();
    expect(normalizeShareLabel("a|b")).toBeNull();
  });
});
