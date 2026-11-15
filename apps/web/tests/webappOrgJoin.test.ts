// An organization's seat invitation opened in the webapp (docs/enterprise-accounts.md §7): the link
// key in the fragment opens the offer the inviter sealed (CryptoKit AES.GCM combined form), the page
// checks it names this org, seat and genesis, and hands the link to the phone.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

const load = () => import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", "lib", "orgJoin.js")).href);
const ORG = "0a".repeat(16);
const SEAT = "61".repeat(16);
const KEY = "4b".repeat(32);
const GENESIS = "9e".repeat(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function seal(obj: unknown): Promise<string> {
  const key = await webcrypto.subtle.importKey("raw", Buffer.from(KEY, "hex"), "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12).fill(7);
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  return hex(iv) + hex(ct);
}

function fakeFetch(offerHex: string, opts: { status?: number; genesis?: string } = {}) {
  return (async (url: string) => {
    if (url.endsWith(`/invites/${SEAT}`)) {
      if (opts.status) return new Response("{}", { status: opts.status });
      return Response.json({ invite: { seatId: SEAT, expiresAt: 1_900_000_000_000 }, roles: [{ role: "member" }], offerHex, accepted: false });
    }
    if (url.endsWith("/authority")) return Response.json({ org: { orgId: ORG, name: "acme", genesisHash: opts.genesis ?? GENESIS } });
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
    await expect(m.loadOrgInvite({ ...link, keyHex: "00".repeat(32) }, fakeFetch(offer))).rejects.toMatchObject({ code: "org-offer" });
    await expect(m.loadOrgInvite(link, fakeFetch(offer, { status: 410 }))).rejects.toMatchObject({ code: "org-invite-expired" });
  });

  it("the shell precaches the page and routes the landing path", () => {
    const sw = readFileSync(resolve(__dirname, "../public/webapp/service-worker.js"), "utf8");
    expect(sw).toContain('"/views/org-join.js"');
    expect(sw).toContain('"/lib/orgJoin.js"');
    const dl = readFileSync(resolve(__dirname, "../public/webapp/lib/deepLink.js"), "utf8");
    expect(dl).toContain('=== "/org-join"');
  });
});
