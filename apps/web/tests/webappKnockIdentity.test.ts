// Knock authorize identity (docs/app-apis.md §5): on a box the user was invited
// to, the webapp signs the knock with its PER-OWNER contact AID (what the
// invite put on the allow-list), on its own boxes with the global AID. Checks
// the derivation against @flagship/protocol + the pinned vector, the owner-AID
// record, and the real box handler (allowed contact AID → 200, global → 401).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveAccountId, deriveContactAccountId, ed } from "@flagship/protocol";
import { buildServiceAccessWeb, ServiceAccessStore, ServiceSessionStore } from "@flagship/server-daemon";

function webappPath(...p: string[]) {
  return pathToFileURL(resolve(__dirname, "..", "public", "webapp", ...p)).href;
}
const loadKnockIdentity = () => import(webappPath("lib", "knockIdentity.js"));
const loadServiceInvite = () => import(webappPath("lib", "serviceInvite.js"));

const VECTORS = JSON.parse(
  readFileSync(
    resolve(__dirname, "..", "..", "..", "packages", "protocol", "tests", "fixtures", "serviceAccessGating.vectors.json"),
    "utf8",
  ),
) as {
  seeds: { authorUmkSeedHex: string; friendUmkSeedHex: string };
  derived: { authorAidPubHex: string; friendAidPubHex: string };
  contactAid: { authorAidPubHex: string; contactAidPubHex: string };
};

class MemStorage implements Storage {
  private kv = new Map<string, string>();
  get length() { return this.kv.size; }
  clear(): void { this.kv.clear(); }
  getItem(k: string): string | null { return this.kv.get(k) ?? null; }
  setItem(k: string, v: string): void { this.kv.set(k, String(v)); }
  removeItem(k: string): void { this.kv.delete(k); }
  key(i: number): string | null { return [...this.kv.keys()][i] ?? null; }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const FQDN = "home.alice.flagship.services";
const SERVICE = "alice-notes";
const ownerUmk = { seed: hexToBytes(VECTORS.seeds.authorUmkSeedHex) };
const friendUmk = { seed: hexToBytes(VECTORS.seeds.friendUmkSeedHex) };
const ownerAidHex = hex(deriveAccountId(ownerUmk).publicKey);

describe("knock identity — derivation matches @flagship/protocol", () => {
  it("an invited box signs with deriveContactAccountId(UMK, ownerAID), byte-for-byte", async () => {
    const ki = await loadKnockIdentity();
    const storage = new MemStorage();
    expect(ki.rememberInviteOwner({ serverId: FQDN, ownerAidHex: VECTORS.contactAid.authorAidPubHex, serviceRef: SERVICE }, storage)).toBe(true);
    const ident = await ki.knockIdentity(friendUmk.seed, FQDN, { storage, ownServers: ["mine.friend.flagship.services"] });
    expect(ident.kind).toBe("contact");
    const proto = deriveContactAccountId(friendUmk, hexToBytes(VECTORS.contactAid.authorAidPubHex));
    expect(hex(ident.visitorAID)).toBe(hex(proto.publicKey));
    expect(hex(ident.visitorAID)).toBe(VECTORS.contactAid.contactAidPubHex);
    // Its signer is the contact key: a protocol verify under the contact pub passes.
    const bytes = new TextEncoder().encode("flagship/test/v1|x");
    expect(ed.verify(await ident.sign(friendUmk.seed, bytes), bytes, proto.publicKey)).toBe(true);
  });

  it("a fixed UMK/author pair matches the protocol (not just the pinned vector)", async () => {
    const ki = await loadKnockIdentity();
    const storage = new MemStorage();
    const umk = { seed: new Uint8Array(32).fill(0x16) };
    const author = deriveAccountId({ seed: new Uint8Array(32).fill(0x42) }).publicKey;
    ki.rememberInviteOwner({ serverId: FQDN, ownerAidHex: hex(author) }, storage);
    const ident = await ki.knockIdentity(umk.seed, FQDN, { storage });
    expect(hex(ident.visitorAID)).toBe(hex(deriveContactAccountId(umk, author).publicKey));
    expect(hex(ident.visitorAID)).not.toBe(hex(deriveAccountId(umk).publicKey));
  });
});

describe("knock identity — which boxes get which id", () => {
  it("one of our own servers signs with the global AID, even with an invite record for it", async () => {
    const ki = await loadKnockIdentity();
    const storage = new MemStorage();
    const own = await ki.knockIdentity(ownerUmk.seed, FQDN, { storage, ownServers: [FQDN.toUpperCase()] });
    expect(own.kind).toBe("account");
    expect(hex(own.visitorAID)).toBe(VECTORS.derived.authorAidPubHex);
    ki.rememberInviteOwner({ serverId: FQDN, ownerAidHex: "ab".repeat(32) }, storage);
    expect((await ki.knockIdentity(ownerUmk.seed, FQDN, { storage, ownServers: [FQDN] })).kind).toBe("account");
  });

  it("a record naming our own AID is ignored (an invite author could plant it to harvest our global AID)", async () => {
    const ki = await loadKnockIdentity();
    const storage = new MemStorage();
    ki.rememberInviteOwner({ serverId: FQDN, ownerAidHex }, storage);
    expect(await ki.knockIdentity(ownerUmk.seed, FQDN, { storage, ownServers: ["other.alice.flagship.services"] })).toBeNull();
    // Nothing reaches the box either.
    const calls: string[] = [];
    const spy = (async (url: string) => {
      calls.push(url);
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    await expect(
      ki.authorizeKnockFor({ serverId: FQDN, serviceRef: SERVICE, pageId: "p1", svc: "notes" }, ownerUmk.seed, { storage, fetch: spy }),
    ).rejects.toMatchObject({ code: "not-own" });
    expect(calls).toEqual([]);
    // Only the own-server set makes it ours.
    expect((await ki.knockIdentity(ownerUmk.seed, FQDN, { storage, ownServers: [FQDN] }))?.kind).toBe("account");
  });

  it("a box that is neither ours nor invited gets no identity at all", async () => {
    const ki = await loadKnockIdentity();
    const storage = new MemStorage();
    ki.rememberInviteOwner({ serverId: "other.bob.flagship.services", ownerAidHex }, storage);
    expect(await ki.knockIdentity(friendUmk.seed, FQDN, { storage, ownServers: ["mine.friend.flagship.services"] })).toBeNull();
    expect(await ki.knockIdentity(friendUmk.seed, "", { storage, ownServers: [""] })).toBeNull();
  });

  it("hostsFromPods reads serverDomain and fqdn", async () => {
    const ki = await loadKnockIdentity();
    expect(ki.hostsFromPods([{ serverDomain: "A.x.flagship.services" }, { fqdn: "b.x.flagship.services." }, null, {}])).toEqual([
      "a.x.flagship.services",
      "b.x.flagship.services",
    ]);
    expect(ki.hostsFromPods(undefined)).toEqual([]);
  });
});

describe("knock identity — owner-AID record", () => {
  it("rejects bad input, matches an app host to its box, and lets the latest owner win", async () => {
    const ki = await loadKnockIdentity();
    const storage = new MemStorage();
    expect(ki.rememberInviteOwner({ serverId: FQDN, ownerAidHex: "zz" }, storage)).toBe(false);
    expect(ki.rememberInviteOwner({ serverId: "", ownerAidHex }, storage)).toBe(false);
    expect(ki.inviteOwnerFor(FQDN, storage)).toBeNull();
    // An invite opened on the app's own host still counts for the box.
    ki.rememberInviteOwner({ serverId: `notes.${FQDN}`, ownerAidHex: ownerAidHex.toUpperCase() }, storage);
    expect(ki.inviteOwnerFor(FQDN.toUpperCase(), storage)).toBe(ownerAidHex);
    expect(ki.inviteOwnerFor("other.bob.flagship.services", storage)).toBeNull();
    const next = "ab".repeat(32);
    ki.rememberInviteOwner({ serverId: FQDN, ownerAidHex: next }, storage);
    expect(ki.inviteOwnerFor(FQDN, storage)).toBe(next);
    storage.setItem("flagship.inviteOwners.v1", "{not json");
    expect(ki.inviteOwnerFor(FQDN, storage)).toBeNull();
  });
});

describe("knock identity — against the box's knock handler", () => {
  async function box(allowHex: string) {
    const dir = mkdtempSync(join(tmpdir(), "knock-id-"));
    const store = new ServiceAccessStore(join(dir, "access.json"), { ownerAidHex });
    await store.load();
    await store.addAllowed(SERVICE, allowHex);
    const sessions = new ServiceSessionStore(join(dir, "sessions.json"));
    await sessions.load();
    const web = buildServiceAccessWeb({ serverId: FQDN, store, sessions });
    const knock = web.maybeServeKnock(SERVICE, {
      method: "GET",
      path: "/",
      headers: { host: `notes.${FQDN}`, accept: "text/html", "user-agent": "Mozilla/5.0 (Test)" },
      body: Buffer.alloc(0),
    })!;
    const pageId = /&page=([0-9a-f]+)/.exec(String(knock.body))![1]!;
    const calls: string[] = [];
    const fetchVia = (async (url: string, init: RequestInit) => {
      calls.push(url);
      const res = (await web.handle({
        method: "POST",
        path: "/api/service-access/knock/authorize",
        headers: { host: FQDN, "content-type": "application/json" },
        body: Buffer.from(String(init.body)),
      }))!;
      const text = String(res.body);
      return { ok: res.status < 300, status: res.status, json: async () => JSON.parse(text), text: async () => text } as Response;
    }) as unknown as typeof fetch;
    const link = { serverId: FQDN, serviceRef: SERVICE, pageId, svc: "notes" };
    return { link, fetchVia, calls };
  }

  it("an invited friend gets in with the contact AID; the global AID would have been refused", async () => {
    const ki = await loadKnockIdentity();
    const storage = new MemStorage();
    const contactHex = hex(deriveContactAccountId(friendUmk, hexToBytes(ownerAidHex)).publicKey);
    // The invite bound the contact AID; the webapp remembered the owner from `a=`.
    ki.rememberInviteOwner({ serverId: FQDN, ownerAidHex, serviceRef: SERVICE }, storage);
    const b = await box(contactHex);
    const ok = await ki.authorizeKnockFor(b.link, friendUmk.seed, { storage, ownServers: [], fetch: b.fetchVia });
    expect(ok.secretId).toMatch(/^[0-9a-f]{64}$/);

    // The old behaviour: signing with the global AID gets 401 from the box.
    const si = await loadServiceInvite();
    const k = await import(webappPath("keystore.js"));
    const g = await k.deriveAccountIdFromSeed(friendUmk.seed);
    const b2 = await box(contactHex);
    await expect(
      si.authorizeKnock(
        { ...b2.link, visitorAID: g.publicKey, umk: friendUmk.seed, signWithAccountId: k.signWithAccountId },
        { fetch: b2.fetchVia },
      ),
    ).rejects.toMatchObject({ code: "401" });
  });

  it("the owner gets in to their own box with the global AID", async () => {
    const ki = await loadKnockIdentity();
    const b = await box("cd".repeat(32));
    const ok = await ki.authorizeKnockFor(b.link, ownerUmk.seed, { storage: new MemStorage(), ownServers: [FQDN], fetch: b.fetchVia });
    expect(ok.secretId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an unknown box is refused and nothing is sent", async () => {
    const ki = await loadKnockIdentity();
    const b = await box("cd".repeat(32));
    await expect(
      ki.authorizeKnockFor(b.link, friendUmk.seed, { storage: new MemStorage(), ownServers: ["mine.friend.flagship.services"], fetch: b.fetchVia }),
    ).rejects.toMatchObject({ code: "not-own", message: ki.NOT_YOUR_SERVER });
    expect(b.calls).toEqual([]);
    expect(ki.NOT_YOUR_SERVER).toBe(
      "This isn't one of your servers. Open its invite link on this device first, then try again.",
    );
  });
});
