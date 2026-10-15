// Knock authorize identity (docs/app-apis.md §5; docs/service-access-gating.md
// "Who is signing in"): on its own boxes the webapp signs the knock with this
// device's account device key, on a server shared with it with that share's
// member key, and on a box the user was invited to with its id for the knock's
// app (what the invite put on the allow-list). Checks the derivations against
// @flagship/protocol + the pinned vector, the invited-box record, and the real
// box handler (device key / share key / allowed per-app id → 200, global → 401).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveAccountDeviceKeySeed, deriveAccountId, deriveAppAccountId, ed } from "@flagship/protocol";
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
  appAid: { serviceRef: string; appAidPubHex: string };
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
const ACCOUNT_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const DEVICE_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const SHARE_ID = "0123456789abcdef0123456789abcdef";
const DEVICE = { accountId: ACCOUNT_ID, deviceId: DEVICE_ID };
const devicePubHex = hex(ed.getPublicKey(deriveAccountDeviceKeySeed(ownerUmk.seed, ACCOUNT_ID, DEVICE_ID)));

describe("knock identity — derivation matches @flagship/protocol", () => {
  it("an invited box signs with deriveAppAccountId(UMK, serviceRef), byte-for-byte", async () => {
    const ki = await loadKnockIdentity();
    const storage = new MemStorage();
    expect(ki.rememberInviteOwner({ serverId: FQDN, ownerAidHex: VECTORS.contactAid.authorAidPubHex, serviceRef: SERVICE }, storage)).toBe(true);
    const ident = await ki.knockIdentity(friendUmk.seed, FQDN, {
      storage,
      ownServers: ["mine.friend.flagship.services"],
      serviceRef: VECTORS.appAid.serviceRef,
    });
    expect(ident.kind).toBe("app");
    const proto = deriveAppAccountId(friendUmk, VECTORS.appAid.serviceRef);
    expect(hex(ident.visitorAID)).toBe(hex(proto.publicKey));
    expect(hex(ident.visitorAID)).toBe(VECTORS.appAid.appAidPubHex);
    const bytes = new TextEncoder().encode("flagship/test/v1|x");
    expect(ed.verify(await ident.sign(friendUmk.seed, bytes), bytes, proto.publicKey)).toBe(true);
  });

  it("each app gets its own id, whoever the box's owner is; no app ⇒ no id", async () => {
    const ki = await loadKnockIdentity();
    const storage = new MemStorage();
    const umk = { seed: new Uint8Array(32).fill(0x16) };
    ki.rememberInviteOwner({ serverId: FQDN, ownerAidHex: hex(deriveAccountId({ seed: new Uint8Array(32).fill(0x42) }).publicKey) }, storage);
    const a = await ki.knockIdentity(umk.seed, FQDN, { storage, serviceRef: "alice-notes" });
    const b = await ki.knockIdentity(umk.seed, FQDN, { storage, serviceRef: "alice-chess" });
    expect(hex(a.visitorAID)).toBe(hex(deriveAppAccountId(umk, "alice-notes").publicKey));
    expect(hex(b.visitorAID)).not.toBe(hex(a.visitorAID));
    expect(hex(a.visitorAID)).not.toBe(hex(deriveAccountId(umk).publicKey));
    // A different owner record for the box doesn't change the id for the app.
    ki.rememberInviteOwner({ serverId: FQDN, ownerAidHex: "ab".repeat(32) }, storage);
    const a2 = await ki.knockIdentity(umk.seed, FQDN, { storage, serviceRef: "alice-notes" });
    expect(hex(a2.visitorAID)).toBe(hex(a.visitorAID));
    expect(await ki.knockIdentity(umk.seed, FQDN, { storage })).toBeNull();
  });
});

describe("knock identity — which boxes get which id", () => {
  it("one of our own servers signs with this device's account device key, even with an invite record for it", async () => {
    const ki = await loadKnockIdentity();
    const storage = new MemStorage();
    const own = await ki.knockIdentity(ownerUmk.seed, FQDN, { storage, ownServers: [FQDN.toUpperCase()], device: DEVICE });
    expect(own.kind).toBe("device");
    expect(hex(own.visitorAID)).toBe(devicePubHex);
    expect(hex(own.visitorAID)).not.toBe(VECTORS.derived.authorAidPubHex);
    const bytes = new TextEncoder().encode("flagship/test/v1|x");
    expect(ed.verify(await own.sign(ownerUmk.seed, bytes), bytes, hexToBytes(devicePubHex))).toBe(true);
    ki.rememberInviteOwner({ serverId: FQDN, ownerAidHex: "ab".repeat(32) }, storage);
    expect((await ki.knockIdentity(ownerUmk.seed, FQDN, { storage, ownServers: [FQDN], device: DEVICE })).kind).toBe("device");
  });

  it("an own server with no account device id is refused rather than shown a shared account key", async () => {
    const ki = await loadKnockIdentity();
    for (const device of [undefined, null, { accountId: ACCOUNT_ID, deviceId: "nope" }, { accountId: "", deviceId: DEVICE_ID }]) {
      await expect(ki.knockIdentity(ownerUmk.seed, FQDN, { storage: new MemStorage(), ownServers: [FQDN], device })).rejects.toMatchObject({
        code: "no-device",
        message: ki.NO_DEVICE_KEY,
      });
    }
  });

  it("a server shared with us signs with that share's member key, and only there", async () => {
    const ki = await loadKnockIdentity();
    const ss = await import(webappPath("lib", "serverShare.js"));
    const memberPub = hex((await ss.deriveShareMemberKey(friendUmk.seed, SHARE_ID)).publicKey);
    const sharedServers = [{ serverDomain: FQDN.toUpperCase(), shareId: SHARE_ID }];
    const shared = await ki.knockIdentity(friendUmk.seed, FQDN, { storage: new MemStorage(), ownServers: [], sharedServers, device: DEVICE });
    expect(shared.kind).toBe("share");
    expect(hex(shared.visitorAID)).toBe(memberPub);
    const bytes = new TextEncoder().encode("flagship/test/v1|y");
    expect(ed.verify(await shared.sign(friendUmk.seed, bytes), bytes, hexToBytes(memberPub))).toBe(true);
    // An app host of the shared server counts; another box never gets the share key.
    expect((await ki.knockIdentity(friendUmk.seed, `notes.${FQDN}`, { storage: new MemStorage(), sharedServers }))?.kind).toBe("share");
    expect(await ki.knockIdentity(friendUmk.seed, "other.bob.flagship.services", { storage: new MemStorage(), sharedServers })).toBeNull();
    // A malformed share id is ignored.
    expect(await ki.knockIdentity(friendUmk.seed, FQDN, { storage: new MemStorage(), sharedServers: [{ serverDomain: FQDN, shareId: "xyz" }] })).toBeNull();
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
    expect((await ki.knockIdentity(ownerUmk.seed, FQDN, { storage, ownServers: [FQDN], device: DEVICE }))?.kind).toBe("device");
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
  // The box's device book and shares: this device (non-admin) and one co-manager.
  async function sharePub() {
    const ss = await import(webappPath("lib", "serverShare.js"));
    return hex((await ss.deriveShareMemberKey(friendUmk.seed, SHARE_ID)).publicKey);
  }
  async function principals() {
    const share = await sharePub();
    const device = { kind: "device" as const, pub: devicePubHex, deviceId: DEVICE_ID, tier: "member" as const, legacy: false };
    const co = { kind: "co-manager" as const, pub: share, shareId: SHARE_ID, label: "Mum" };
    return {
      classify: (pub: string) => (pub === devicePubHex ? device : pub === share ? co : null),
      ensure: async () => {},
      devices: () => [device],
      coManagers: () => [co],
      ownerAidHex: () => ownerAidHex,
    };
  }
  async function box(allowHex: string) {
    const dir = mkdtempSync(join(tmpdir(), "knock-id-"));
    const store = new ServiceAccessStore(join(dir, "access.json"), { ownerAidHex, principals: await principals() });
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

  it("an invited friend gets in with their id for the app; the global AID would have been refused", async () => {
    const ki = await loadKnockIdentity();
    const storage = new MemStorage();
    const contactHex = hex(deriveAppAccountId(friendUmk, SERVICE).publicKey);
    // The invite bound the per-app id; the webapp remembered the box (and owner from `a=`).
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

  it("a device of the account gets in to its own box with its account device key; the global AID is refused", async () => {
    const ki = await loadKnockIdentity();
    const b = await box("cd".repeat(32));
    const ok = await ki.authorizeKnockFor(b.link, ownerUmk.seed, { storage: new MemStorage(), ownServers: [FQDN], device: DEVICE, fetch: b.fetchVia });
    expect(ok.secretId).toMatch(/^[0-9a-f]{64}$/);

    const si = await loadServiceInvite();
    const k = await import(webappPath("keystore.js"));
    const g = await k.deriveAccountIdFromSeed(ownerUmk.seed);
    const b2 = await box("cd".repeat(32));
    await expect(
      si.authorizeKnock({ ...b2.link, visitorAID: g.publicKey, umk: ownerUmk.seed, signWithAccountId: k.signWithAccountId }, { fetch: b2.fetchVia }),
    ).rejects.toMatchObject({ code: "401" });
  });

  it("a co-manager gets in to the shared box with the share's member key", async () => {
    const ki = await loadKnockIdentity();
    const b = await box("cd".repeat(32));
    const ok = await ki.authorizeKnockFor(b.link, friendUmk.seed, {
      storage: new MemStorage(),
      ownServers: [],
      sharedServers: [{ serverDomain: FQDN, shareId: SHARE_ID }],
      fetch: b.fetchVia,
    });
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
