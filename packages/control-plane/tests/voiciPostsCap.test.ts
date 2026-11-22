// Capped server copy (docs/voici-and-messages.md §2.7a): `.com` holds at most VOICI_COM_MAX_CHUNKS chunks of a page,
// the older ones are phone-only, and a visitor's browser may offer a phone-only piece back to the cache by its hash.
import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import { sha256Hex, VOICI_COM_MAX_CHUNKS, type VoiciPost } from "@flagship/protocol";
import { handleVoiciPieceCache, handleVoiciPieceUpload, handleVoiciPublish, voiciListedPiece, voiciPieceKey } from "../src/index.js";
import { adminPub, buildPage, fakeBucket, irkPub, PAGE_ID, post, uploadHeaders, USER, type BuiltPage } from "./support/voiciFixture.js";

const T0 = 1_800_000_000_000;

async function world() {
  const storage = new InMemoryStorage();
  await storage.usernames.put({ username: USER, irkPubHex: irkPub, claimedAt: 1, adminRootPubHex: adminPub });
  const bucket = fakeBucket();
  const deps = { voici: storage.voici, usernames: storage.usernames, bucket, now: () => T0 };
  const upload = async (page: BuiltPage, skip: Set<string> = new Set()) => {
    for (const [sha, bytes] of page.pieces) {
      if (skip.has(sha)) continue;
      expect((await handleVoiciPieceUpload(deps, USER, uploadHeaders(bytes, T0), bytes)).status).toBe(200);
    }
  };
  const publish = (page: BuiltPage) => handleVoiciPublish(deps, USER, JSON.stringify(page.index));
  return { storage, bucket, deps, upload, publish };
}

/** `n` chunks of one post each; chunk 0's post carries a card. */
const chunks = (n: number): VoiciPost[][] => Array.from({ length: n }, (_, i) => [post(i + 1, i === 0)]);
const sha = (page: BuiltPage, role: string) => page.index.pieces.find((p) => p.role === role)!.sha256;
const cardSha = (page: BuiltPage) => page.index.pieces.find((p) => p.role.startsWith("card-"))!.sha256;
const code = (r: { body: unknown }) => (r.body as { code?: string }).code;

describe("voi.ci capped server copy", () => {
  it("refuses a page holding more than the cap on .com, accepts it with the oldest on the phone", async () => {
    const w = await world();
    const n = VOICI_COM_MAX_CHUNKS + 2;
    const all = buildPage({ seq: 1, issuedAt: T0, posts: chunks(n) });
    await w.upload(all);
    const r = await w.publish(all);
    expect([r.status, code(r)]).toEqual([400, "too-many-chunks"]);
    const one = buildPage({ seq: 1, issuedAt: T0, posts: chunks(n), phoneChunks: 1 });
    expect(code(await w.publish(one))).toBe("too-many-chunks");
    const two = buildPage({ seq: 1, issuedAt: T0, posts: chunks(n), phoneChunks: 2 });
    expect((await w.publish(two)).status).toBe(200);
  });

  it("does not need the phone-only chunks or their card images in R2, and marks any it has unreferenced", async () => {
    const w = await world();
    const n = VOICI_COM_MAX_CHUNKS + 2;
    const page = buildPage({ seq: 1, issuedAt: T0, posts: chunks(n), phoneChunks: 2 });
    const phoneOnly = new Set([sha(page, "chunk-0"), sha(page, "chunk-1"), cardSha(page)]);
    await w.upload(page, phoneOnly);
    expect((await w.publish(page)).body).toEqual({ ok: true, pageId: PAGE_ID, seq: 1 });

    // Seq 2: the same page; chunk-0 was uploaded by an older client meanwhile: it is not kept as referenced.
    const again = buildPage({ seq: 2, issuedAt: T0, posts: chunks(n), phoneChunks: 2 });
    const c0 = page.pieces.get(sha(page, "chunk-0"))!;
    await handleVoiciPieceUpload(w.deps, USER, uploadHeaders(c0, T0), c0);
    expect((await w.publish(again)).status).toBe(200);
    const [row] = await w.storage.voici.getPieces(PAGE_ID, [sha(page, "chunk-0")]);
    expect(row?.unreferencedAt).toBe(T0);
    const [held] = await w.storage.voici.getPieces(PAGE_ID, [sha(page, "chunk-2")]);
    expect(held?.unreferencedAt).toBeNull();
  });

  it("still requires a held chunk's card image", async () => {
    const w = await world();
    const posts = chunks(VOICI_COM_MAX_CHUNKS + 1);
    posts[1] = [post(99, true)];
    const page = buildPage({ seq: 1, issuedAt: T0, posts, phoneChunks: 1 });
    await w.upload(page, new Set([cardSha(page)]));
    expect(code(await w.publish(page))).toBe("missing-piece");
  });

  it("reads a page published before the cap (no phoneChunks) as before", async () => {
    const w = await world();
    const page = buildPage({ seq: 1, issuedAt: T0, posts: chunks(3) });
    await w.upload(page, new Set([sha(page, "chunk-0")]));
    expect(code(await w.publish(page))).toBe("missing-piece");
  });

  it("caches a phone-only piece offered by a browser, by its hash, and serves it", async () => {
    const w = await world();
    const page = buildPage({ seq: 1, issuedAt: T0, posts: chunks(VOICI_COM_MAX_CHUNKS + 1), phoneChunks: 1 });
    const c0 = sha(page, "chunk-0");
    await w.upload(page, new Set([c0, cardSha(page)]));
    await w.publish(page);
    expect(await voiciListedPiece(w.deps, USER, c0)).toBeNull();

    const bytes = page.pieces.get(c0)!;
    const wrong = new Uint8Array(bytes);
    wrong[wrong.length - 2] ^= 1;
    expect(code(await handleVoiciPieceCache(w.deps, USER, c0, wrong))).toBe("bad-piece");
    expect(code(await handleVoiciPieceCache(w.deps, USER, c0, bytes.slice(1)))).toBe("bad-piece");
    expect(code(await handleVoiciPieceCache(w.deps, USER, sha(page, "chunk-1"), page.pieces.get(sha(page, "chunk-1"))!))).toBe("not-found");
    expect(code(await handleVoiciPieceCache(w.deps, USER, sha(page, "profile"), page.pieces.get(sha(page, "profile"))!))).toBe("not-found");
    expect(code(await handleVoiciPieceCache(w.deps, USER, sha256Hex(new Uint8Array([1])), new Uint8Array([1])))).toBe("not-found");

    expect((await handleVoiciPieceCache(w.deps, USER, c0, bytes)).body).toEqual({ ok: true, cached: true });
    const got = await voiciListedPiece(w.deps, USER, c0);
    expect(got?.bytes).toEqual(bytes);
    expect(w.bucket.objects.get(voiciPieceKey(PAGE_ID, c0))?.contentType).toBe("application/json");
    const [row] = await w.storage.voici.getPieces(PAGE_ID, [c0]);
    expect([row?.unreferencedAt, row?.uploadedAt]).toEqual([T0, 0]);
    // The owner's daily brake doesn't count it.
    expect(await w.storage.voici.uploadedBytesSince(USER, T0 - 86_400_000)).toBe([...page.pieces.entries()].filter(([h]) => h !== c0 && h !== cardSha(page)).reduce((n, [, b]) => n + b.length, 0));

    const card = page.pieces.get(cardSha(page))!;
    expect((await handleVoiciPieceCache(w.deps, USER, cardSha(page), card)).status).toBe(200);
    expect((await voiciListedPiece(w.deps, USER, cardSha(page)))?.contentType).toBe("image/jpeg");
  });
});
