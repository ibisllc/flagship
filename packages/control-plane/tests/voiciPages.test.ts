import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import { resolveVoiciPath } from "../src/voici.js";
import {
  canonicalJsonBytes,
  sha256Hex,
  signAccountDirectoryRequest,
  signDeviceCapabilityGrant,
  signVoiciDraftsConsume,
  signVoiciPageIndex,
  signWebEnvelopeEd25519,
  ed,
  type DeviceCapabilityGrant,
  type VoiciPageIndex,
  type VoiciPieceRef,
} from "@flagship/protocol";
import {
  handleVoiciDraftConsume,
  handleVoiciDraftDeposit,
  handleVoiciDraftList,
  handleVoiciGetPage,
  handleVoiciPieceUpload,
  handleVoiciPublish,
  voiciIndexKey,
  voiciPieceKey,
  VOICI_PIECE_BYTES_PER_DAY,
  type VoiciDraftsDeps,
} from "../src/index.js";
import { adminPub, adminSeed, buildPage, fakeBucket, hex, irkPub, irkSeed, PAGE_ID, post, profile, uploadHeaders, USER, type BuiltPage } from "./support/voiciFixture.js";

const T0 = 1_800_000_000_000;

async function world(opts: { admin?: boolean } = {}) {
  const storage = new InMemoryStorage();
  await storage.usernames.put({ username: USER, irkPubHex: irkPub, claimedAt: 1, ...(opts.admin === false ? {} : { adminRootPubHex: adminPub }) });
  const bucket = fakeBucket();
  let now = T0;
  const deps = { voici: storage.voici, usernames: storage.usernames, bucket, now: () => now };
  const upload = async (page: BuiltPage, seed?: Uint8Array) => {
    for (const bytes of page.pieces.values()) {
      const r = await handleVoiciPieceUpload(deps, USER, uploadHeaders(bytes, now, seed ? { seed } : {}), bytes);
      expect(r.status).toBe(200);
    }
  };
  const publish = (page: BuiltPage) => handleVoiciPublish(deps, USER, JSON.stringify(page.index));
  return { storage, bucket, deps, upload, publish, setNow: (t: number) => (now = t) };
}

describe("voi.ci pieces", () => {
  it("stores a signed piece once, under its page, immutable", async () => {
    const w = await world();
    const bytes = canonicalJsonBytes(profile());
    const r = await handleVoiciPieceUpload(w.deps, USER, uploadHeaders(bytes, T0), bytes);
    expect(r.body).toEqual({ ok: true, sha256: sha256Hex(bytes), size: bytes.length });
    const obj = w.bucket.objects.get(voiciPieceKey(PAGE_ID, sha256Hex(bytes)))!;
    expect([obj.contentType, obj.cacheControl]).toEqual(["application/json", "public, max-age=31536000, immutable"]);
    const again = await handleVoiciPieceUpload(w.deps, USER, uploadHeaders(bytes, T0), bytes);
    expect(again.status).toBe(200);
    expect(w.bucket.stats.puts).toBe(1);
  });

  it("refuses a piece signed by the IRK when an admin root is pinned, stale, or another page's", async () => {
    const w = await world();
    const bytes = canonicalJsonBytes(profile());
    const code = async (h: ReturnType<typeof uploadHeaders>, body = bytes) => ((await handleVoiciPieceUpload(w.deps, USER, h, body)).body as { code: string }).code;
    expect(await code(uploadHeaders(bytes, T0, { seed: irkSeed }))).toBe("bad-signature");
    expect(await code(uploadHeaders(bytes, T0 - 11 * 60_000))).toBe("stale");
    expect(await code({ ...uploadHeaders(bytes, T0), pageId: "zz" })).toBe("malformed");
    expect(await code(uploadHeaders(new Uint8Array(300 * 1024), T0), new Uint8Array(300 * 1024))).toBe("too-large");
    const page = buildPage({ seq: 1, issuedAt: T0 });
    await w.upload(page);
    expect((await w.publish(page)).status).toBe(200);
    expect(await code(uploadHeaders(bytes, T0, { pageId: "11".repeat(16) }))).toBe("wrong-page");
  });

  it("accepts the IRK on an account that pins no admin root", async () => {
    const w = await world({ admin: false });
    const page = buildPage({ seq: 1, issuedAt: T0, signer: "irk" });
    await w.upload(page, irkSeed);
    expect((await w.publish(page)).status).toBe(200);
  });

  it("brakes uploads at 50 MiB a day per account", async () => {
    const w = await world();
    await w.storage.voici.putPiece({ pageId: PAGE_ID, sha256: "ab".repeat(32), username: USER, size: VOICI_PIECE_BYTES_PER_DAY - 10, jpeg: false, uploadedAt: T0 - 1000, unreferencedAt: T0 });
    const bytes = canonicalJsonBytes(profile());
    const r = await handleVoiciPieceUpload(w.deps, USER, uploadHeaders(bytes, T0), bytes);
    expect([r.status, (r.body as { code: string }).code]).toEqual([429, "rate-limited"]);
  });
});

describe("voi.ci publish", () => {
  it("publishes seq 1, then only seq + 1, and writes the index to R2", async () => {
    const w = await world();
    const p1 = buildPage({ seq: 1, issuedAt: T0, posts: [[post(1, true), post(2)]] });
    await w.upload(p1);
    expect((await w.publish(p1)).body).toEqual({ ok: true, pageId: PAGE_ID, seq: 1 });
    const idx = w.bucket.objects.get(voiciIndexKey(USER))!;
    expect(idx.cacheControl).toBe("public, max-age=30");
    expect(JSON.parse(new TextDecoder().decode(idx.bytes))).toEqual(p1.index);
    const again = await w.publish(p1);
    expect([again.status, (again.body as { code: string }).code]).toEqual([409, "seq-conflict"]);
    expect((again.body as { index: unknown }).index).toEqual(p1.index);
    expect((await handleVoiciGetPage(w.deps, USER)).body).toEqual({ index: p1.index });
  });

  it("parses each JSON piece once and marks a replaced chunk unreferenced", async () => {
    const w = await world();
    const p1 = buildPage({ seq: 1, issuedAt: T0, posts: [[post(1)]] });
    await w.upload(p1);
    await w.publish(p1);
    const gets = w.bucket.stats.gets;
    const p2 = buildPage({ seq: 2, issuedAt: T0 + 1, posts: [[post(1), post(2)]] });
    await w.upload(p2);
    expect((await w.publish(p2)).status).toBe(200);
    expect(w.bucket.stats.gets - gets).toBe(1);
    const oldChunk = p1.index.pieces.find((p) => p.role === "chunk-0")!.sha256;
    const [row] = await w.storage.voici.getPieces(PAGE_ID, [oldChunk]);
    expect(row?.unreferencedAt).toBe(T0);
    const newProfile = p2.index.pieces.find((p) => p.role === "profile")!.sha256;
    expect((await w.storage.voici.getPieces(PAGE_ID, [newProfile]))[0]?.unreferencedAt).toBeNull();
  });

  it("refuses missing, mismatched and unlisted pieces", async () => {
    const w = await world();
    const code = async (index: VoiciPageIndex) => ((await handleVoiciPublish(w.deps, USER, JSON.stringify(index))).body as { code: string }).code;
    const p1 = buildPage({ seq: 1, issuedAt: T0, posts: [[post(1, true)]] });
    expect(await code(p1.index)).toBe("missing-piece");
    await w.upload(p1);
    const resign = (pieces: VoiciPieceRef[]) => {
      const { kind, version, signature, signerPub, ...body } = p1.index;
      void kind, version, signature, signerPub;
      return signVoiciPageIndex({ ...body, pieces }, adminSeed);
    };
    const without = (role: string) => p1.index.pieces.filter((p) => p.role !== role);
    expect(await code(resign(without("avatar")))).toBe("bad-piece");
    expect(await code(resign(p1.index.pieces.filter((p) => !p.role.startsWith("card-"))))).toBe("bad-piece");
    const junk = canonicalJsonBytes({ v: 1 });
    await handleVoiciPieceUpload(w.deps, USER, uploadHeaders(junk, T0), junk);
    const junkRef = { sha256: sha256Hex(junk), size: junk.length };
    expect(await code(resign([...without("profile"), { role: "profile", ...junkRef }]))).toBe("bad-piece");
    expect(await code(resign([...without("avatar"), { role: "avatar", ...junkRef }]))).toBe("bad-piece");
    expect(await code(resign([...without("avatar"), { role: "avatar", sha256: junkRef.sha256, size: junkRef.size + 1 }]))).toBe("missing-piece");
    expect(await code(p1.index)).toBe(undefined);
  });

  it("refuses a stale index, another page id, the IRK on an admin-pinned account, and a taken-down page", async () => {
    const w = await world();
    const code = async (page: BuiltPage) => ((await w.publish(page)).body as { code: string }).code;
    const p1 = buildPage({ seq: 1, issuedAt: T0 });
    await w.upload(p1);
    expect(await code(buildPage({ seq: 1, issuedAt: T0 - 11 * 60_000 }))).toBe("stale");
    expect(await code(buildPage({ seq: 1, issuedAt: T0, signer: "irk" }))).toBe("not-sensitive-key");
    expect(await code(p1)).toBe(undefined);
    const other = buildPage({ seq: 2, issuedAt: T0, pageId: "11".repeat(16) });
    expect(await code(other)).toBe("wrong-page");
    await w.storage.voici.setTakedown(USER, T0, "illegal");
    expect(await code(buildPage({ seq: 2, issuedAt: T0 }))).toBe("taken-down");
    expect((await handleVoiciGetPage(w.deps, USER)).status).toBe(410);
  });
});

describe("voi.ci paths and the one namespace", () => {
  it("answers a published page, a taken-down page, /@name and nothing (resolveVoiciPath)", async () => {
    const w = await world();
    const p1 = buildPage({ seq: 1, issuedAt: T0 });
    await w.upload(p1);
    await w.publish(p1);
    const resolve = (p: string) => resolveVoiciPath({ names: w.storage.names, pages: w.storage.voici }, p);
    expect(await resolve("/Alice")).toEqual({ kind: "redirect", location: "https://voi.ci/alice" });
    expect(await resolve("/alice")).toEqual({ kind: "page", username: USER });
    expect(await resolve("/@alice")).toEqual({ kind: "redirect", location: "https://voi.ci/alice" });
    expect(await resolve("/bob")).toEqual({ kind: "not-found" });
    expect(await resolve("/a_b")).toEqual({ kind: "not-found" });
    await w.storage.voici.setTakedown(USER, T0, "spam");
    expect(await resolve("/alice")).toEqual({ kind: "page-gone", username: USER });
  });
});

describe("voi.ci drafts", () => {
  const deviceSeed = new Uint8Array(32).fill(0x71);
  const device = { privateKey: deviceSeed, publicKey: ed.getPublicKey(deviceSeed) };
  const devicePub = hex(device.publicKey);
  const deviceId = "ab".repeat(16);

  async function draftWorld(demo = true) {
    const w = await world();
    await w.storage.deviceIdentities.put({ accountId: USER, deviceId, devicePubHex: devicePub, platformClass: "android", createdAt: 1, lastSeenAt: 1, revokedAt: null });
    const nonces = new Set<string>();
    const pushed: string[] = [];
    const deps: VoiciDraftsDeps = {
      voici: w.storage.voici,
      usernames: w.storage.usernames,
      directory: {
        identities: w.storage.deviceIdentities,
        nonces: { claim: async (k: string) => (nonces.has(k) ? false : (nonces.add(k), true)) },
        now: () => T0,
      },
      readTokens: {
        secret: undefined,
        // A demo account: its demo row and an account row marked demo (security review M5).
        usernames: { get: async (u: string) => ({ ...(await w.storage.usernames.get(u))!, isDemo: demo }) } as never,
        identities: w.storage.deviceIdentities,
        servers: w.storage.servers,
        demoUsers: { get: async () => (demo ? ({ username: USER } as never) : undefined) } as never,
        nonces: { claim: async () => true },
      },
      notifyAdmins: async (u) => void pushed.push(u),
      now: () => T0,
    };
    return { ...w, deps, pushed };
  }

  let rid = 0;
  const auth = (method: string, path: string) => {
    const request = { accountId: USER, deviceId, signerPubHex: devicePub, method, path, requestId: (++rid).toString(16).padStart(32, "0"), issuedAt: T0 };
    return { request, signature: signAccountDirectoryRequest(request, device) };
  };
  const grant: DeviceCapabilityGrant = { grantId: "g-1", username: USER, deviceId, devicePubKey: device.publicKey, scopes: ["view-directory"], issuedAt: T0 - 1000, expiresAt: T0 + 86_400_000 };
  const grantSignature = hex(signDeviceCapabilityGrant(grant, { privateKey: irkSeed, publicKey: ed.getPublicKey(irkSeed) }));
  const draft = (opId: string) =>
    signWebEnvelopeEd25519(
      {
        v: 1,
        kind: "voici-draft",
        audience: USER,
        conv: "",
        from: devicePub,
        msgId: opId,
        seq: 1,
        sentAt: T0,
        bodyB64: Buffer.from(JSON.stringify({ ct: "AAAA", nonce: "00".repeat(12), suite: "flagship/voici-draft/v1" })).toString("base64"),
        cred: { grant: { ...grant, devicePubKey: devicePub }, grantSignature },
      },
      deviceSeed,
    );

  it("takes a device-signed draft once, pushes the admins, lists and consumes it", async () => {
    const w = await draftWorld();
    const path = `/api/accounts/${USER}/voici-drafts`;
    const r = await handleVoiciDraftDeposit(w.deps, USER, auth("POST", path), JSON.stringify(draft("01".repeat(16))));
    expect(r.body).toEqual({ ok: true, opId: "01".repeat(16) });
    expect(w.pushed).toEqual([USER]);
    await handleVoiciDraftDeposit(w.deps, USER, auth("POST", path), JSON.stringify(draft("01".repeat(16))));
    expect(w.pushed).toEqual([USER]);
    const list = await handleVoiciDraftList(w.deps, USER, null);
    expect((list.body as { drafts: { msgId: string }[] }).drafts.map((d) => d.msgId)).toEqual(["01".repeat(16)]);
    const consume = { username: USER, opIds: ["01".repeat(16)], issuedAt: T0 };
    const sig = signVoiciDraftsConsume(consume, new Uint8Array(32).fill(0x33));
    expect((await handleVoiciDraftConsume(w.deps, USER, { consume, signature: sig })).body).toEqual({ ok: true, removed: 1 });
    await handleVoiciDraftDeposit(w.deps, USER, auth("POST", path), JSON.stringify({ envelope: draft("04".repeat(16)) }));
    const flat = { opIds: ["04".repeat(16)], issuedAt: T0 };
    const flatSig = signVoiciDraftsConsume({ username: USER, ...flat }, new Uint8Array(32).fill(0x33));
    expect((await handleVoiciDraftConsume(w.deps, USER, { ...flat, signerPub: adminPub, signature: flatSig })).body).toEqual({ ok: true, removed: 1 });
    const byIrk = signVoiciDraftsConsume(consume, irkSeed);
    expect(((await handleVoiciDraftConsume(w.deps, USER, { consume, signature: byIrk })).body as { code: string }).code).toBe("bad-signature");
  });

  it("refuses an unsigned request, a grant the account did not give, and a read without a token", async () => {
    const w = await draftWorld(false);
    const path = `/api/accounts/${USER}/voici-drafts`;
    expect((await handleVoiciDraftDeposit(w.deps, USER, undefined, JSON.stringify(draft("02".repeat(16))))).status).toBe(403);
    const forged = signWebEnvelopeEd25519({ ...draft("03".repeat(16)), cred: { grant: { ...grant, devicePubKey: devicePub, scopes: ["admin"] }, grantSignature } }, deviceSeed);
    const r = await handleVoiciDraftDeposit(w.deps, USER, auth("POST", path), JSON.stringify(forged));
    expect((r.body as { code: string }).code).toBe("bad-grant");
    expect((await handleVoiciDraftList(w.deps, USER, null)).status).toBe(401);
  });
});
