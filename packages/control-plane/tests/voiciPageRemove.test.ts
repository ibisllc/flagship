// The owner's "Remove my page" (flagship/voici-page-remove/v1, docs/voici-and-messages.md §3.3).
import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import { signVoiciPageRemove, type VoiciSignerKind } from "@flagship/protocol";
import { resolveVoiciPath } from "../src/voici.js";
import { handleVoiciGetPage, handleVoiciPieceUpload, handleVoiciPublish, handleVoiciRemove, voiciIndexKey, voiciListedPiece } from "../src/index.js";
import { adminPub, adminSeed, buildPage, fakeBucket, irkPub, irkSeed, PAGE_ID, post, uploadHeaders, USER, type BuiltPage } from "./support/voiciFixture.js";

const T0 = 1_800_000_000_000;

async function world(opts: { admin?: boolean; isDemo?: boolean } = {}) {
  const storage = new InMemoryStorage();
  await storage.usernames.put({
    username: USER,
    irkPubHex: irkPub,
    claimedAt: 1,
    ...(opts.admin === false ? {} : { adminRootPubHex: adminPub }),
    ...(opts.isDemo ? { isDemo: true, accountType: "demo" as const } : {}),
  });
  const bucket = fakeBucket();
  let now = T0;
  let banned = false;
  const deps = { voici: storage.voici, usernames: storage.usernames, bucket, now: () => now, isAccountBanned: async () => banned };
  const upload = async (page: BuiltPage, seed?: Uint8Array) => {
    for (const bytes of page.pieces.values()) {
      const r = await handleVoiciPieceUpload(deps, USER, uploadHeaders(bytes, now, seed ? { seed } : {}), bytes);
      expect(r.status).toBe(200);
    }
  };
  const publish = (page: BuiltPage) => handleVoiciPublish(deps, USER, JSON.stringify(page.index));
  const removal = (seq: number, o: { seed?: Uint8Array; kind?: VoiciSignerKind; issuedAt?: number; pageId?: string } = {}) =>
    signVoiciPageRemove({ username: USER, pageId: o.pageId ?? PAGE_ID, seq, issuedAt: o.issuedAt ?? now, signerKind: o.kind ?? "admin-root" }, o.seed ?? adminSeed);
  const remove = (body: unknown) => handleVoiciRemove(deps, USER, JSON.stringify(body));
  return { storage, bucket, deps, upload, publish, removal, remove, setNow: (t: number) => (now = t), ban: () => (banned = true) };
}

const code = (r: { body: unknown }) => (r.body as { code?: string }).code;
const resolver = (storage: InMemoryStorage) => ({ names: storage.names, pages: storage.voici });

async function published(w: Awaited<ReturnType<typeof world>>) {
  const p1 = buildPage({ seq: 1, issuedAt: T0, posts: [[post(1, true)]] });
  await w.upload(p1);
  expect((await w.publish(p1)).status).toBe(200);
  return p1;
}

describe("voi.ci page removal", () => {
  it("removes the page: index and pieces gone, no page to readers, mailbox kept", async () => {
    const w = await world();
    const p1 = await published(w);
    const sha = p1.index.pieces[0]!.sha256;
    expect(await voiciListedPiece(w.deps, USER, sha)).not.toBeNull();
    const r = await w.remove(w.removal(2));
    expect([r.status, r.body]).toEqual([200, { ok: true, pageId: PAGE_ID, seq: 2 }]);
    expect(w.bucket.objects.has(voiciIndexKey(USER))).toBe(false);
    expect(w.bucket.objects.size).toBe(0);
    expect(await w.storage.voici.listPagePieces(PAGE_ID)).toEqual([]);
    const row = await w.storage.voici.getPage(USER);
    expect([row?.seq, row?.pageId, row?.removedAt]).toEqual([2, PAGE_ID, T0]);
    const got = await handleVoiciGetPage(w.deps, USER);
    expect([got.status, code(got)]).toEqual([404, "not-found"]);
    expect(await voiciListedPiece(w.deps, USER, sha)).toBeNull();
    // Removing again reads as no page.
    expect(code(await w.remove(w.removal(3)))).toBe("not-found");
  });

  it("a removed page is the same 404 as an unpublished one on voi.ci", async () => {
    const w = await world();
    await published(w);
    const before = await resolveVoiciPath(resolver(w.storage), `/${USER}`);
    await w.remove(w.removal(2));
    const after = await resolveVoiciPath(resolver(w.storage), `/${USER}`);
    expect(before).toEqual({ kind: "page", username: USER });
    expect(after).toEqual({ kind: "not-found" });
  });

  it("refuses a replay of the removal and of the old index", async () => {
    const w = await world();
    const p1 = await published(w);
    const rm = w.removal(2);
    expect((await w.remove(rm)).status).toBe(200);
    // The removal again: there's no page any more.
    expect(code(await w.remove(rm))).toBe("not-found");
    // The old public index (seq 1) can't bring the page back.
    const replay = await w.publish(p1);
    expect([replay.status, code(replay)]).toEqual([409, "seq-conflict"]);
    expect((replay.body as { seq: number; pageId: string; removed: boolean })).toMatchObject({ seq: 2, pageId: PAGE_ID, removed: true });
    // An index at the removal's own seq neither.
    const same = buildPage({ seq: 2, issuedAt: T0 });
    await w.upload(same);
    expect(code(await w.publish(same))).toBe("seq-conflict");
  });

  it("publishes again at removal seq + 1 with the same pageId", async () => {
    const w = await world();
    await published(w);
    await w.remove(w.removal(2));
    w.setNow(T0 + 1000);
    const p3 = buildPage({ seq: 3, issuedAt: T0 + 1000, posts: [[post(1, true), post(2)]] });
    await w.upload(p3);
    expect(w.bucket.objects.size).toBe(p3.pieces.size);
    const r = await w.publish(p3);
    expect(r.body).toEqual({ ok: true, pageId: PAGE_ID, seq: 3 });
    expect((await w.storage.voici.getPage(USER))?.removedAt).toBeNull();
    expect((await handleVoiciGetPage(w.deps, USER)).body).toEqual({ index: p3.index });
    const other = buildPage({ seq: 4, issuedAt: T0 + 1000, pageId: "11".repeat(16) } as Parameters<typeof buildPage>[0]);
    const wrong = await w.publish(other);
    expect(code(wrong)).toBe("wrong-page");
  });

  it("refuses the wrong signer, a bad signature, stale, a skipped seq and another page", async () => {
    const w = await world();
    await published(w);
    expect([(await w.remove(w.removal(2, { seed: irkSeed, kind: "irk" }))).status, code(await w.remove(w.removal(2, { seed: irkSeed, kind: "irk" })))]).toEqual([403, "wrong-signer"]);
    const bad = { ...w.removal(2), signature: "00".repeat(64) };
    expect(code(await w.remove(bad))).toBe("bad-signature");
    expect(code(await w.remove(w.removal(2, { issuedAt: T0 - 11 * 60_000 })))).toBe("stale");
    const skip = await w.remove(w.removal(3));
    expect([skip.status, code(skip)]).toEqual([409, "seq-conflict"]);
    const other = await w.remove(w.removal(2, { pageId: "11".repeat(16) }));
    expect([other.status, code(other)]).toEqual([409, "wrong-page"]);
    expect(code(await handleVoiciRemove(w.deps, USER, "{"))).toBe("malformed");
    expect(code(await handleVoiciRemove(w.deps, "bob", JSON.stringify(w.removal(2))))).toBe("malformed");
    expect(w.bucket.objects.has(voiciIndexKey(USER))).toBe(true);
  });

  it("takes the IRK on an account that pins no admin root", async () => {
    const w = await world({ admin: false });
    const p1 = buildPage({ seq: 1, issuedAt: T0, signer: "irk" });
    await w.upload(p1, irkSeed);
    expect((await w.publish(p1)).status).toBe(200);
    expect(code(await w.remove(w.removal(2)))).toBe("wrong-signer");
    expect((await w.remove(w.removal(2, { seed: irkSeed, kind: "irk" }))).status).toBe(200);
  });

  it("a banned or taken-down account can't use removal to escape the record", async () => {
    const w = await world();
    await published(w);
    await w.storage.voici.setTakedown(USER, T0, "illegal");
    const t = await w.remove(w.removal(2));
    expect([t.status, code(t)]).toEqual([410, "taken-down"]);
    expect((await w.storage.voici.getPage(USER))?.takenDownAt).toBe(T0);
    w.ban();
    expect(code(await w.remove(w.removal(2)))).toBe("banned");
  });

  it("a removal that lands between a publish's commit and its R2 write leaves no index on R2", async () => {
    const w = await world();
    const purged: string[][] = [];
    const deps = { ...w.deps, purge: async (keys: string[]) => void purged.push(keys) };
    await published(w);
    const p2 = buildPage({ seq: 2, issuedAt: T0, posts: [[post(1, true), post(2)]] });
    await w.upload(p2);
    // The publish has committed seq 2 in D1; before its index reaches R2, the owner's removal (seq 3) runs to the end.
    const put = w.bucket.put.bind(w.bucket);
    let armed = true;
    w.bucket.put = async (key: string, value: Uint8Array | string, opts?: Parameters<typeof put>[2]) => {
      if (armed && key === voiciIndexKey(USER)) {
        armed = false;
        expect((await handleVoiciRemove(deps, USER, JSON.stringify(w.removal(3)))).status).toBe(200);
      }
      return put(key, value, opts);
    };
    expect((await handleVoiciPublish(deps, USER, JSON.stringify(p2.index))).status).toBe(200);
    expect(w.bucket.objects.has(voiciIndexKey(USER))).toBe(false);
    expect(purged).toContainEqual([voiciIndexKey(USER)]);
    expect((await handleVoiciGetPage(deps, USER)).status).toBe(404);
  });

  it("a newer publish that lands between a publish's commit and its R2 write keeps the newer index on R2", async () => {
    const w = await world();
    const deps = { ...w.deps, purge: async () => undefined };
    await published(w);
    const p2 = buildPage({ seq: 2, issuedAt: T0, posts: [[post(1, true)]] });
    const p3 = buildPage({ seq: 3, issuedAt: T0, posts: [[post(1, true), post(2)]] });
    await w.upload(p2);
    await w.upload(p3);
    const put = w.bucket.put.bind(w.bucket);
    let armed = true;
    w.bucket.put = async (key: string, value: Uint8Array | string, opts?: Parameters<typeof put>[2]) => {
      if (armed && key === voiciIndexKey(USER)) {
        armed = false;
        expect((await handleVoiciPublish(deps, USER, JSON.stringify(p3.index))).status).toBe(200);
      }
      return put(key, value, opts);
    };
    expect((await handleVoiciPublish(deps, USER, JSON.stringify(p2.index))).status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(w.bucket.objects.get(voiciIndexKey(USER))!.bytes))).toEqual(p3.index);
  });

  it("refuses an account with no page", async () => {
    const w = await world();
    const r = await w.remove(w.removal(1));
    expect([r.status, code(r)]).toEqual([404, "not-found"]);
  });

  it("a sample (demo) account publishes and removes like any other", async () => {
    const w = await world({ isDemo: true });
    await published(w);
    expect((await w.remove(w.removal(2))).status).toBe(200);
  });
});
