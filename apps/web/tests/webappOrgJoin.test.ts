// An organization's seat invitation opened in the webapp (docs/enterprise-accounts.md §7): the link
// key in the fragment derives the offer key, which opens the offer the inviter sealed (CryptoKit
// AES.GCM combined form), and the invite key, whose fresh signature `.com` needs to serve the offer.
// The page checks it names this org, seat, invite key and genesis, and hands the link to the phone.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveOrgInviteKeys, verifyOrgInviteRead } from "../../../packages/protocol/src/orgAuthority.js";

const load = () => import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", "lib", "orgJoin.js")).href);
const ORG = "0a".repeat(16);
const SEAT = "61".repeat(16);
const KEY = "4b".repeat(32);
const GENESIS = "9e".repeat(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const IK = deriveOrgInviteKeys(Buffer.from(KEY, "hex"));
const V = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/org-invite-key/vectors.json"), "utf8"));

async function seal(obj: unknown): Promise<string> {
  const key = await webcrypto.subtle.importKey("raw", IK.offerKey, "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12).fill(7);
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  return hex(iv) + hex(ct);
}

function fakeFetch(offerHex: string, opts: { status?: number; genesis?: string; pub?: string } = {}) {
  return (async (url: string, init?: RequestInit) => {
    if (url.endsWith(`/invites/${SEAT}`)) {
      // As `.com`: no valid invite-key proof reads as an unknown invite.
      const h = new Headers(init?.headers);
      const invite = { orgId: ORG, seatId: SEAT, inviteKeyPub: opts.pub ?? IK.inviteKeyPub, expiresAt: 1_900_000_000_000 };
      if (!verifyOrgInviteRead({ ...invite, inviteKeyPub: IK.inviteKeyPub }, Number(h.get("x-flagship-issued-at")), h.get("x-flagship-signature"), Date.now())) return new Response("{}", { status: 404 });
      if (opts.status) return new Response("{}", { status: opts.status });
      // The chain rides with the offer (the joiner has no seat to mint an org read token with).
      return Response.json({ invite, roles: [{ role: "member" }], offerHex, accepted: false, authority: { org: { orgId: ORG, name: "acme", genesisHash: opts.genesis ?? GENESIS } } });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("webapp org-join", () => {
  it("parses only a well-formed link, keeping the key in the fragment", async () => {
    const m = await load();
    const link = m.parseOrgJoinLink(`https://flagshipserver.com/org-join#o=${ORG}&s=${SEAT}&k=${KEY}`);
    expect(link).toMatchObject({ orgId: ORG, seatId: SEAT, keyHex: KEY });
    expect(link.link).toContain(`/org-join#o=${ORG}`);
    expect(m.parseOrgJoinLink(`https://flagshipserver.com/org-join#o=${ORG}&s=${SEAT}`)).toBeNull();
    expect(m.parseOrgJoinLink(`https://flagshipserver.com/join#o=${ORG}&s=${SEAT}&k=${KEY}`)).toBeNull();
  });

  it("opens the offer and checks it against the org's genesis", async () => {
    const m = await load();
    const link = m.parseOrgJoinLink(`https://flagshipserver.com/org-join#o=${ORG}&s=${SEAT}&k=${KEY}`);
    const offer = await seal({ orgId: ORG, orgName: "acme", genesisHash: GENESIS, seatId: SEAT, pseudonym: "Priya", roles: [] });
    const inv = await m.loadOrgInvite(link, fakeFetch(offer));
    expect(inv).toMatchObject({ orgName: "acme", pseudonym: "Priya", accepted: false });
    await expect(m.loadOrgInvite(link, fakeFetch(offer, { genesis: "00".repeat(32) }))).rejects.toMatchObject({ code: "org-offer" });
    await expect(m.loadOrgInvite(link, fakeFetch(offer, { status: 410 }))).rejects.toMatchObject({ code: "org-invite-expired" });
    // Another link's key has no valid proof: the invite reads as missing.
    await expect(m.loadOrgInvite({ ...link, keyHex: "00".repeat(32) }, fakeFetch(offer))).rejects.toMatchObject({ code: "org-invite-missing" });
    // An invite naming another invite key than the link's is refused.
    await expect(m.loadOrgInvite(link, fakeFetch(offer, { pub: V.wrongInviteKeyPub }))).rejects.toMatchObject({ code: "org-offer" });
  });

  it("derives the shared vectors' keys and opens their offer; the raw link key opens nothing", async () => {
    const m = await load();
    const k = m.inviteKeys(V.linkKeyHex);
    expect(hex(k.offerKey)).toBe(V.offerKeyHex);
    expect(k.inviteKeyPub).toBe(V.inviteKeyPub);
    expect(JSON.stringify(await m.openOrgOffer(V.offer.sealedHex, V.linkKeyHex))).toBe(JSON.stringify(JSON.parse(V.offer.plaintext)));
    const h = m.inviteReadHeaders({ orgId: V.invites.invite.orgId, seatId: V.invites.invite.seatId, keyHex: V.linkKeyHex }, 1_795_000_600_000);
    expect(verifyOrgInviteRead(V.invites.invite, Number(h["x-flagship-issued-at"]), h["x-flagship-signature"], 1_795_000_600_000)).toBe(true);
    expect(verifyOrgInviteRead(V.invites.otherInvite, Number(h["x-flagship-issued-at"]), h["x-flagship-signature"], 1_795_000_600_000)).toBe(false);
    for (const r of V.reads) expect(verifyOrgInviteRead(V.invites[r.invite], r.issuedAt, r.signature, r.now)).toBe(r.expect);
  });

  it("the shell precaches the page and routes the landing path", () => {
    const sw = readFileSync(resolve(__dirname, "../public/webapp/service-worker.js"), "utf8");
    expect(sw).toContain('"/views/org-join.js"');
    expect(sw).toContain('"/lib/orgJoin.js"');
    const dl = readFileSync(resolve(__dirname, "../public/webapp/lib/deepLink.js"), "utf8");
    expect(dl).toContain('=== "/org-join"');
  });
});
