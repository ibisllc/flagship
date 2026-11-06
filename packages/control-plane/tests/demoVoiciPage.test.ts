// The operator's example voi.ci page for a sample account (demoVoiciPage.ts, docs/sample-users.md "Example voi.ci page").
import { describe, expect, it } from "vitest";
import {
  checkVoiciPageIndex,
  isVoiciJpeg,
  parseVoiciChunkPiece,
  parseVoiciProfilePiece,
  sha256Hex,
  voiciJpegHasMetadata,
  voiciPieceRefsOk,
  VOICI_AVATAR_MAX_BYTES,
  type VoiciPageIndex,
} from "@flagship/protocol";
import { InMemoryStorage, type DemoUserRecord } from "@flagship/storage";
import { deriveDemoAdminRoot, deriveDemoUserIrk } from "../src/demoIdentity.js";
import { demoExampleAvatar, demoExamplePageContent, handleDemoVoiciExamplePage } from "../src/demoVoiciPage.js";
import { handleVoiciGetPage, voiciIndexKey, voiciPieceKey } from "../src/voiciPages.js";
import { bytesToHex } from "../src/hex.js";
import { fakeBucket } from "./support/voiciFixture.js";

const U = "playstore-test-0725";
const KEK = new Uint8Array(32).fill(9);
const T0 = 1_800_000_000_000;
const adminPub = bytesToHex(deriveDemoAdminRoot(KEK, U).publicKey);
const irkPub = bytesToHex(deriveDemoUserIrk(KEK, U).publicKey);

function demoRow(username: string): DemoUserRecord {
  return {
    username,
    idempotencyKey: "demo-test",
    snapshotId: null,
    isoR2Key: null,
    ttlIdleMinutes: 30,
    region: "fsn1",
    size: "cpx11",
    activeServerId: null,
    activeServerIp: null,
    image: "debian-12",
    activeServerFqdn: null,
    lastActivityAt: 10,
    state: "ready",
    createdAt: 1,
    provisionPhase: null,
    provisionPhaseAt: null,
    provisionLastError: null,
  } as DemoUserRecord;
}

async function world(o: { demoRow?: boolean; isDemo?: boolean; admin?: boolean; foreignAdmin?: boolean } = {}) {
  const s = new InMemoryStorage();
  if (o.demoRow !== false) await s.demoUsers.insert(demoRow(U));
  await s.usernames.put({
    username: U,
    irkPubHex: irkPub,
    claimedAt: 1,
    ...(o.admin === false ? {} : { adminRootPubHex: o.foreignAdmin ? "ab".repeat(32) : adminPub }),
    ...(o.isDemo === false ? {} : { isDemo: true, accountType: "demo" as const }),
  });
  const bucket = fakeBucket();
  let now = T0;
  const deps = { voici: s.voici, usernames: s.usernames, bucket, demos: s.demoUsers, demoIrkKek: KEK, now: () => now };
  return { s, bucket, deps, run: (body?: unknown) => handleDemoVoiciExamplePage(deps, U, body), setNow: (t: number) => (now = t) };
}

const code = (r: { body: unknown }) => (r.body as { code?: string }).code;

async function readBack(w: Awaited<ReturnType<typeof world>>, sensitive: { kind: "admin-root" | "irk"; pub: string }) {
  const got = await handleVoiciGetPage(w.deps, U);
  expect(got.status).toBe(200);
  const raw = (got.body as { index: unknown }).index;
  // What a client does: check the index against the account's own sensitive key, then each piece by hash.
  const checked = checkVoiciPageIndex(raw, { username: U, sensitiveKind: sensitive.kind, sensitivePub: sensitive.pub });
  expect(checked.ok).toBe(true);
  const index = (checked as { index: VoiciPageIndex }).index;
  const piece = (role: string) => {
    const ref = index.pieces.find((p) => p.role === role)!;
    const bytes = w.bucket.objects.get(voiciPieceKey(index.pageId, ref.sha256))!.bytes;
    expect(sha256Hex(bytes)).toBe(ref.sha256);
    expect(bytes.length).toBe(ref.size);
    return bytes;
  };
  const profile = parseVoiciProfilePiece(piece("profile"))!;
  const chunk = parseVoiciChunkPiece(piece("chunk-0"), 0)!;
  const avatar = piece("avatar");
  expect(voiciPieceRefsOk(index, profile, [chunk])).toBe(true);
  return { index, profile, chunk, avatar };
}

describe("sample account example page", () => {
  it("publishes the fixed content, signed by the demo admin root, verifiable by a client", async () => {
    const w = await world();
    const r = await w.run();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, seq: 1 });
    const { index, profile, chunk, avatar } = await readBack(w, { kind: "admin-root", pub: adminPub });
    const content = demoExamplePageContent(U);
    expect(profile).toEqual(content.profile);
    expect(profile.displayName).toBe(U);
    expect(chunk.posts).toEqual(content.posts);
    expect(index.acceptsMessages).toBe(0);
    expect(index.signerKind).toBe("admin-root");
    expect(isVoiciJpeg(avatar)).toBe(true);
    expect(voiciJpegHasMetadata(avatar)).toBe(false);
    expect(avatar.length).toBeLessThanOrEqual(VOICI_AVATAR_MAX_BYTES);
    expect(profile.avatar).toBe(sha256Hex(demoExampleAvatar()));
    expect(w.bucket.objects.has(voiciIndexKey(U))).toBe(true);
  });

  it("republishes the same content at the next seq, same page", async () => {
    const w = await world();
    const first = await w.run();
    w.setNow(T0 + 60_000);
    const again = await w.run({});
    expect(again.status).toBe(200);
    expect((again.body as { seq: number }).seq).toBe(2);
    expect((again.body as { pageId: string }).pageId).toBe((first.body as { pageId: string }).pageId);
    const a = await readBack(w, { kind: "admin-root", pub: adminPub });
    expect(a.index.seq).toBe(2);
    expect(a.profile).toEqual(demoExamplePageContent(U).profile);
  });

  it("removes the page with the remove path, and publishes again after", async () => {
    const w = await world();
    await w.run();
    const rm = await w.run({ remove: true });
    expect(rm.status).toBe(200);
    expect(rm.body).toMatchObject({ ok: true, seq: 2, removed: true });
    expect(code(await handleVoiciGetPage(w.deps, U))).toBe("not-found");
    expect(w.bucket.objects.size).toBe(0);
    expect((await w.s.voici.getPage(U))?.removedAt).toBe(T0);
    // Removing again is a no-op.
    const twice = await w.run({ remove: true });
    expect(twice.body).toMatchObject({ ok: true, already: true });
    w.setNow(T0 + 1000);
    const back = await w.run();
    expect(back.status).toBe(200);
    expect((back.body as { seq: number }).seq).toBe(3);
    await readBack(w, { kind: "admin-root", pub: adminPub });
  });

  it("signs with the IRK when the account pins no admin root", async () => {
    const w = await world({ admin: false });
    expect((await w.run()).status).toBe(200);
    const { index } = await readBack(w, { kind: "irk", pub: irkPub });
    expect(index.signerKind).toBe("irk");
  });

  it("refuses a real account, an unknown account and keys that aren't the derived ones", async () => {
    expect(code(await (await world({ isDemo: false })).run())).toBe("not-demo");
    expect(code(await (await world({ demoRow: false })).run())).toBe("not-found");
    const foreign = await world({ foreignAdmin: true });
    const r = await foreign.run();
    expect([r.status, code(r)]).toEqual([409, "demo-keys-mismatch"]);
    expect(foreign.bucket.objects.size).toBe(0);
  });

  it("takes no content from the request", async () => {
    const w = await world();
    for (const body of [{ displayName: "x" }, { remove: "yes" }, [], "text", { remove: true, bio: "x" }]) {
      const r = await w.run(body);
      expect([r.status, code(r)]).toEqual([400, "malformed"]);
    }
    expect(w.bucket.objects.size).toBe(0);
  });

  it("goes through the publish checks: a taken-down page stays down", async () => {
    const w = await world();
    await w.run();
    await w.s.voici.setTakedown(U, T0, "illegal");
    const r = await w.run();
    expect([r.status, code(r)]).toEqual([410, "taken-down"]);
  });
});
