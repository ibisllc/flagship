// The webapp's Public switch for the voi.ci page (docs/voici-and-messages.md §3.3, §11.1): the removal it signs
// (checked with the TypeScript reference and the shared vectors), turning the page back on from this device's copy
// or from another device that has none, the one-time warning's memory, the removed page's copy, and the states of
// Home's pointer and the switch.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as P from "../public/webapp/lib/voiciProtocol.js";
import * as R from "../../../packages/protocol/src/index.js";
import { defaultVoiciProfile, makeDraftOp, publishVoiciPage, removeVoiciPage } from "../public/webapp/lib/voiciOwner.js";
import {
  clearRemovedSnapshot,
  hasSeenPublicWarning,
  loadRemovedSnapshot,
  markPublicWarningSeen,
  pageHomeState,
  publicSwitchState,
  saveRemovedSnapshot,
} from "../public/webapp/lib/voiciPagePublic.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "packages", "protocol", "test-vectors", "voici-page-remove", "vectors.json"), "utf8"));

const U = "alice";
const UMK = new Uint8Array(32).fill(7);
const ADMIN_SEED = new Uint8Array(32).fill(9);
const ADMIN_PUB = P.hex(P.ed25519PublicKey(ADMIN_SEED));
const NOW = 1_800_000_000_000;
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
const signer = { kind: "admin-root", pub: ADMIN_PUB, sign: async (b: Uint8Array) => P.ed25519SignHex(b, ADMIN_SEED) };
const session = { umk: UMK, username: U, adminRootSeed: ADMIN_SEED };

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

/** `.com` for one account, with the removal route as handleVoiciRemove answers it. */
function fakeCom() {
  const pieces = new Map<string, Uint8Array>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s: { index: any; seq: number; pageId: string | null; removed: boolean; removals: any[]; uploads: number } = { index: null, seq: 0, pageId: null, removed: false, removals: [], uploads: 0 };
  const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const conflict = () => json(409, { code: "seq-conflict", index: s.index, seq: s.seq, pageId: s.pageId, removed: s.removed });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetch = async (url: string, init: any = {}) => {
    const u = new URL(url);
    if (u.pathname === `/api/username/${U}`) return json(200, { adminRootPub: ADMIN_PUB, irkPub: "11".repeat(32) });
    if (u.pathname === `/api/voici/pages/${U}` && (init.method ?? "GET") === "GET") return s.index && !s.removed ? json(200, { index: s.index }) : json(404, { code: "not-found" });
    if (u.pathname === `/api/voici/pages/${U}/pieces` && init.method === "POST") {
      const bytes = new Uint8Array(init.body);
      pieces.set(P.sha256Hex(bytes), bytes);
      s.uploads++;
      return json(200, { ok: true });
    }
    const piece = /^\/api\/voici\/pages\/alice\/pieces\/([0-9a-f]{64})$/.exec(u.pathname);
    if (piece) return !s.removed && pieces.has(piece[1]!) ? new Response(pieces.get(piece[1]!)) : json(404, { code: "not-found" });
    if (u.pathname === `/api/voici/pages/${U}/publish`) {
      const idx = JSON.parse(init.body).index;
      const r = R.checkVoiciPublish(idx, { username: U, sensitiveKind: "admin-root", sensitivePub: ADMIN_PUB, storedSeq: s.seq, storedPageId: s.pageId, now: NOW });
      if (!r.ok) return r.code === "seq-conflict" ? conflict() : json(409, { code: r.code, pageId: s.pageId });
      for (const p of idx.pieces) if (!pieces.has(p.sha256)) return json(409, { code: "missing-piece" });
      Object.assign(s, { index: idx, seq: idx.seq, pageId: idx.pageId, removed: false });
      return json(200, { ok: true, pageId: idx.pageId, seq: idx.seq });
    }
    if (u.pathname === `/api/voici/pages/${U}/remove` && init.method === "POST") {
      const env = JSON.parse(init.body);
      if (!s.index || s.removed) return json(404, { code: "not-found" });
      const r = R.checkVoiciPageRemove(env, { username: U, sensitiveKind: "admin-root", sensitivePub: ADMIN_PUB, storedSeq: s.seq, storedPageId: s.pageId, now: NOW });
      if (!r.ok) return r.code === "seq-conflict" ? conflict() : json(r.code === "wrong-page" ? 409 : 403, { code: r.code });
      s.removals.push(env);
      Object.assign(s, { seq: env.seq, removed: true });
      pieces.clear();
      return json(200, { ok: true, pageId: env.pageId, seq: env.seq });
    }
    return json(404, { code: "not-found" });
  };
  return { fetch, s, pieces };
}

const deps = (com: ReturnType<typeof fakeCom>, extra: Record<string, unknown> = {}) => ({
  fetch: com.fetch,
  now: () => NOW,
  session,
  profile: { accountId: U, deviceId: "a1".repeat(16) },
  apex: "https://flagshipserver.com",
  signer,
  ...extra,
});

async function publishedPage(com: ReturnType<typeof fakeCom>) {
  const sha = P.sha256Hex(JPEG);
  const ops = [
    makeDraftOp("profile", { profile: { ...defaultVoiciProfile(U), displayName: "Alice", avatar: sha } }, { now: NOW - 10 }),
    makeDraftOp("post-add", { post: { id: "ab".repeat(16), createdAt: NOW - 20, editedAt: null, text: "Hello", links: [] } }, { now: NOW - 9 }),
  ];
  return publishVoiciPage({ ops, images: new Map([[sha, JPEG]]) }, deps(com, { published: null }));
}

describe("the removal in the webapp's protocol port", () => {
  it("reproduces the shared vectors byte for byte", () => {
    expect(new TextDecoder().decode(P.canonicalVoiciPageRemove(V.fields))).toBe(V.canonical);
    expect(P.signVoiciPageRemove({ ...V.fields, signerKind: "admin-root" }, P.hexToBytes(V.keys.adminRootSeed))).toEqual(V.signed);
    expect(P.signVoiciPageRemove({ ...V.fields, signerKind: "irk" }, P.hexToBytes(V.keys.irkSeed))).toEqual(V.signedIrk);
    expect(() => P.canonicalVoiciPageRemove({ ...V.fields, seq: 0 })).toThrow();
  });
});

describe("turning the page off and on again", () => {
  it("signs a removal one step up the ladder, which .com's check accepts", async () => {
    const com = fakeCom();
    const page = await publishedPage(com);
    const r = await removeVoiciPage({ published: page }, deps(com));
    expect(r).toEqual({ pageId: page.index.pageId, seq: 2 });
    expect(com.s.removals[0]).toMatchObject({ kind: "VoiciPageRemove", version: 1, username: U, pageId: page.index.pageId, seq: 2, signerKind: "admin-root", signerPub: ADMIN_PUB });
    expect(Object.keys(com.s.removals[0])).toEqual(["kind", "version", "username", "pageId", "seq", "issuedAt", "signerKind", "signerPub", "signature"]);
    // Again: the page is gone, nothing new is signed.
    expect(await removeVoiciPage({ published: page }, deps(com))).toMatchObject({ already: true });
    expect(com.s.removals).toHaveLength(1);
  });

  it("follows the stored seq when another admin device published meanwhile", async () => {
    const com = fakeCom();
    const page = await publishedPage(com);
    const stale = { ...page, index: { ...page.index, seq: 0 } };
    expect((await removeVoiciPage({ published: stale }, deps(com))).seq).toBe(2);
  });

  it("publishes again from this device's copy: same pageId, every piece uploaded again, seq = removal + 1", async () => {
    const com = fakeCom();
    const store = new MemStorage();
    const page = await publishedPage(com);
    const { seq } = await removeVoiciPage({ published: page }, deps(com));
    expect(saveRemovedSnapshot(U, page, seq, store)).toBe(true);
    const removed = loadRemovedSnapshot(U, store)!;
    expect(removed.index).toEqual({ pageId: page.index.pageId, seq: 2, inboxEpoch: 1, pieces: [] });
    expect(removed.profile.displayName).toBe("Alice");
    expect(removed.pieces.get(P.sha256Hex(JPEG))).toEqual(JPEG);
    const before = com.s.uploads;
    const back = await publishVoiciPage({ ops: [] }, deps(com, { published: null, removed }));
    expect([back.index.seq, back.index.pageId]).toEqual([3, page.index.pageId]);
    expect(back.chunks.flat().map((p: { text: string }) => p.text)).toEqual(["Hello"]);
    expect(com.s.uploads - before).toBe(page.index.pieces.length);
    expect(back.index.inboxPub).toBe(page.index.inboxPub);
  });

  it("publishes again from a device with no copy, following the ladder .com answers with", async () => {
    const com = fakeCom();
    const page = await publishedPage(com);
    await removeVoiciPage({ published: page }, deps(com));
    const back = await publishVoiciPage({ ops: [] }, deps(com, { published: null }));
    expect([back.index.seq, back.index.pageId, back.profile.displayName]).toEqual([3, page.index.pageId, U]);
  });
});

describe("what this device remembers", () => {
  it("the public warning is asked once per account", () => {
    const store = new MemStorage();
    expect(hasSeenPublicWarning(U, store)).toBe(false);
    markPublicWarningSeen("Alice", store);
    expect(hasSeenPublicWarning(U, store)).toBe(true);
    expect(hasSeenPublicWarning("bob", store)).toBe(false);
  });

  it("the removed page's copy round-trips, is per account and is cleared", async () => {
    const store = new MemStorage();
    const com = fakeCom();
    const page = await publishedPage(com);
    saveRemovedSnapshot(U, page, 2, store);
    expect(loadRemovedSnapshot("bob", store)).toBeNull();
    expect(loadRemovedSnapshot(U, store)?.chunks.flat()).toHaveLength(1);
    clearRemovedSnapshot(U, store);
    expect(loadRemovedSnapshot(U, store)).toBeNull();
    store.setItem("flagship.voici.removedPage.v1:alice", "{not json");
    expect(loadRemovedSnapshot(U, store)).toBeNull();
  });

  it("keeps the words when the photos don't fit", async () => {
    const com = fakeCom();
    const page = await publishedPage(com);
    const tight = new MemStorage();
    let calls = 0;
    tight.setItem = function (k: string, v: string) {
      if (calls++ === 0) throw new Error("QuotaExceededError");
      MemStorage.prototype.setItem.call(this, k, v);
    };
    expect(saveRemovedSnapshot(U, page, 2, tight)).toBe(true);
    const snap = loadRemovedSnapshot(U, tight)!;
    expect([snap.profile.avatar, snap.pieces.size, snap.profile.displayName]).toEqual([null, 0, "Alice"]);
  });
});

describe("Home's pointer and the switch", () => {
  const st = (o: Partial<Parameters<typeof pageHomeState>[0]> = {}) =>
    pageHomeState({ hasAccount: true, checked: true, published: false, removed: false, pendingChanges: 0, dismissed: null, ...o });
  it("the welcome card until the page is published or the card dismissed, then the compact row", () => {
    expect(st()).toBe("card");
    expect(st({ published: true })).toBe("row");
    expect(st({ removed: true })).toBe("row");
    expect(st({ dismissed: "true" })).toBe("row");
    expect(st({ pendingChanges: 2 })).toBe("row");
  });
  it("nothing without an account (or a sample one) or before .com answered", () => {
    expect(st({ hasAccount: false })).toBeNull();
    expect(st({ checked: false })).toBeNull();
    expect(pageHomeState()).toBeNull();
  });
  it("the switch is on for a published page and only an admin device may flip it", () => {
    expect(publicSwitchState({ published: { index: {} }, canPublish: true })).toEqual({ on: true, disabled: false });
    expect(publicSwitchState({ published: null, canPublish: false })).toEqual({ on: false, disabled: true });
    expect(publicSwitchState({ published: null, canPublish: true, busy: true })).toEqual({ on: false, disabled: true });
  });
});
