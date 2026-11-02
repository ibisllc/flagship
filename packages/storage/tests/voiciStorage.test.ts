/**
 * VoiciStorage contract (docs/voici-and-messages.md, migration 0123), run against the in-memory adapter and the D1
 * adapter over real SQLite with every migration applied, so the two cannot drift.
 */
import { describe, expect, it } from "vitest";
import { D1Storage, InMemoryStorage, type Storage } from "../src/index.js";
import { createSqliteD1 } from "./support/sqliteD1.js";

function fresh(adapter: "InMemory" | "D1"): { s: Storage; done: () => void } {
  if (adapter === "InMemory") return { s: new InMemoryStorage(), done: () => {} };
  const db = createSqliteD1();
  return { s: new D1Storage(db), done: () => db.close() };
}

const PAGE = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const H = (n: number) => n.toString(16).padStart(64, "0");
const page = (seq: number, over: Partial<{ pageId: string; username: string }> = {}) => ({
  username: over.username ?? "alice",
  pageId: over.pageId ?? PAGE,
  seq,
  issuedAt: 1000 + seq,
  acceptsMessages: 1 as const,
  inboxEpoch: 1,
  ownerSignPub: "aa".repeat(32),
  indexJson: `{"seq":${seq}}`,
  publishedAt: 2000 + seq,
});
const msg = (conv: string, msgId: string, over: Partial<{ kind: "voici-message" | "voici-reply"; storedAt: number; pushed: boolean; pageId: string }> = {}) => ({
  pageId: over.pageId ?? PAGE,
  conv,
  msgId,
  kind: over.kind ?? ("voici-message" as const),
  fromPub: "bb".repeat(32),
  delegatePub: over.kind === "voici-reply" ? null : "04" + "cd".repeat(64),
  sentAt: 5,
  envelope: "{}",
  size: 2,
  direct: false,
  pushed: over.pushed ?? false,
  storedAt: over.storedAt ?? 100,
});

describe.each(["InMemory", "D1"] as const)("VoiciStorage (%s)", (adapter) => {
  it("publishes with compare-and-set on seq and never changes the page id", async () => {
    const { s, done } = fresh(adapter);
    try {
      expect(await s.voici.publishPage(page(1), 0)).toBe(true);
      expect(await s.voici.publishPage(page(1), 0)).toBe(false);
      expect(await s.voici.publishPage(page(2), 2)).toBe(false);
      expect(await s.voici.publishPage(page(2, { pageId: "11".repeat(16) }), 1)).toBe(false);
      expect(await s.voici.publishPage(page(2), 1)).toBe(true);
      expect((await s.voici.getPage("alice"))?.seq).toBe(2);
      expect((await s.voici.getPageById(PAGE))?.username).toBe("alice");
      expect(await s.voici.publishPage(page(1, { username: "bob" }), 0)).toBe(false);
      expect(await s.voici.setTakedown("alice", 9, "illegal")).toBe(true);
      expect(await s.voici.publishPage(page(3), 2)).toBe(true);
      const p = await s.voici.getPage("alice");
      expect([p?.takenDownAt, p?.takedownReason]).toEqual([9, "illegal"]);
      await s.voici.setTakedown("alice", null, "x");
      expect((await s.voici.getPage("alice"))?.takedownReason).toBeNull();
      expect(await s.voici.setTakedown("nobody", 1, "x")).toBe(false);
    } finally {
      done();
    }
  });

  it("keeps pieces once, marks them referenced and unreferenced, and collects them", async () => {
    const { s, done } = fresh(adapter);
    try {
      const base = { pageId: PAGE, username: "alice", size: 10, jpeg: false, uploadedAt: 100, unreferencedAt: 100 };
      await s.voici.putPiece({ ...base, sha256: H(1) });
      const again = await s.voici.putPiece({ ...base, sha256: H(1), size: 99, uploadedAt: 500 });
      expect([again.size, again.uploadedAt, again.role]).toEqual([10, 100, null]);
      await s.voici.putPiece({ ...base, sha256: H(2), jpeg: true, uploadedAt: 200 });
      expect(await s.voici.uploadedBytesSince("alice", 150)).toBe(10);
      expect(await s.voici.uploadedBytesSince("alice", 0)).toBe(20);
      await s.voici.markPieces(PAGE, [H(1), H(2)], [], 300);
      expect((await s.voici.getPieces(PAGE, [H(1), H(2), H(3)])).map((p) => p.unreferencedAt)).toEqual([null, null]);
      await s.voici.markPieces(PAGE, [], [H(2)], 400);
      await s.voici.markPieces(PAGE, [], [H(2)], 450);
      expect((await s.voici.getPieces(PAGE, [H(2)]))[0]?.unreferencedAt).toBe(400);
      await s.voici.setPieceParse(PAGE, H(1), "chunk-0", [H(7), H(8)]);
      await s.voici.setPieceParse(PAGE, H(2), "profile", []);
      const got = await s.voici.listPagePieces(PAGE);
      expect(got.map((p) => [p.sha256, p.role, p.imageRefs, p.jpeg])).toEqual([
        [H(1), "chunk-0", [H(7), H(8)], false],
        [H(2), "profile", [], true],
      ]);
      expect((await s.voici.listUnreferencedBefore(401, 10)).map((p) => p.sha256)).toEqual([H(2)]);
      expect(await s.voici.deleteUnreferencedBefore(401, 10)).toEqual([{ pageId: PAGE, sha256: H(2) }]);
      expect(await s.voici.deleteUnreferencedBefore(401, 10)).toEqual([]);
      expect(await s.voici.unreferenceAllPieces(PAGE, 7)).toBe(1);
      expect((await s.voici.listUnreferencedBefore(8, 10)).map((p) => p.sha256)).toEqual([H(1)]);
      const many = Array.from({ length: 200 }, (_, i) => H(1000 + i));
      for (const h of many) await s.voici.putPiece({ ...base, sha256: h });
      await s.voici.markPieces(PAGE, many, [], 1);
      expect((await s.voici.getPieces(PAGE, many)).filter((p) => p.unreferencedAt === null)).toHaveLength(200);
    } finally {
      done();
    }
  });

  it("stores each (conv, msgId) once and pages the inbox and threads by id", async () => {
    const { s, done } = fresh(adapter);
    try {
      const a = "a".repeat(64);
      const b = "b".repeat(64);
      const r1 = await s.voici.insertMessage(msg(a, "01".repeat(16), { pushed: true, storedAt: 50 }));
      expect(r1.ok).toBe(true);
      expect((await s.voici.insertMessage(msg(a, "01".repeat(16)))).ok).toBe(false);
      await s.voici.insertMessage(msg(b, "01".repeat(16), { storedAt: 3000 }));
      await s.voici.insertMessage(msg(a, "02".repeat(16), { kind: "voici-reply", storedAt: 4000 }));
      await s.voici.insertMessage(msg(a, "03".repeat(16), { storedAt: 5000 }));
      expect(await s.voici.convStats(a, 4500, 40)).toEqual({ messages: 2, replies: 1, messagesLastHour: 1, messagesLastDay: 2, lastPushedAt: 50 });
      expect(await s.voici.convStats("c".repeat(64), 0, 0)).toEqual({ messages: 0, replies: 0, messagesLastHour: 0, messagesLastDay: 0, lastPushedAt: null });
      const inbox = await s.voici.listInbox(PAGE, 0, 3);
      expect(inbox.map((m) => m.msgId)).toEqual(["01".repeat(16), "01".repeat(16), "02".repeat(16)]);
      expect(await s.voici.markFetched(PAGE, 0, inbox[2]!.id, 9)).toBe(2);
      expect(await s.voici.deliveredThrough(a)).toBe(inbox[0]!.id);
      const thread = await s.voici.listThread(a, inbox[0]!.id, 10);
      expect(thread.map((m) => [m.kind, m.fetchedAt])).toEqual([["voici-reply", null], ["voici-message", null]]);
      expect((await s.voici.getMessage(a, "03".repeat(16)))?.storedAt).toBe(5000);
      expect(await s.voici.delegatePage("bb".repeat(32), "04" + "cd".repeat(64))).toBe(PAGE);
      expect(await s.voici.delegatePage("aa".repeat(32), "04" + "cd".repeat(64))).toBeNull();
      expect(await s.voici.deleteMessagesBefore(4000, 10)).toBe(2);
      expect((await s.voici.listInbox(PAGE, 0, 10)).map((m) => m.storedAt)).toEqual([4000, 5000]);
    } finally {
      done();
    }
  });

  it("keeps the newest block order and lists only blocks", async () => {
    const { s, done } = fresh(adapter);
    try {
      const b = (op: "block" | "unblock", issuedAt: number, pub = "cc".repeat(32)) => ({ pageId: PAGE, pseudonymPub: pub, op, issuedAt, signature: "dd".repeat(64) });
      expect(await s.voici.setBlock(b("block", 10), 1)).toBe(true);
      expect(await s.voici.setBlock(b("unblock", 10), 1)).toBe(false);
      expect(await s.voici.setBlock(b("unblock", 5), 1)).toBe(false);
      expect(await s.voici.listBlocked(PAGE)).toEqual(["cc".repeat(32)]);
      expect(await s.voici.setBlock(b("unblock", 11), 1)).toBe(true);
      expect(await s.voici.listBlocked(PAGE)).toEqual([]);
      expect((await s.voici.getBlock(PAGE, "cc".repeat(32)))?.op).toBe("unblock");
      expect(await s.voici.getBlock(PAGE, "ee".repeat(32))).toBeNull();
    } finally {
      done();
    }
  });

  it("refuses revoked browser keys until their expiry", async () => {
    const { s, done } = fresh(adapter);
    try {
      const d = "04" + "ab".repeat(64);
      await s.voici.revokeDelegate({ delegatePub: d, pageId: PAGE, principalPub: "aa".repeat(32), expiresAt: 100, revokedAt: 1 });
      await s.voici.revokeDelegate({ delegatePub: d, pageId: PAGE, principalPub: "aa".repeat(32), expiresAt: 999, revokedAt: 2 });
      expect(await s.voici.isRevoked(d, 50)).toBe(true);
      expect(await s.voici.listRevoked(PAGE, 50)).toEqual([d]);
      expect(await s.voici.isRevoked(d, 100)).toBe(false);
      expect(await s.voici.deleteExpiredRevoked(100, 10)).toBe(1);
      expect(await s.voici.listRevoked(PAGE, 0)).toEqual([]);
    } finally {
      done();
    }
  });

  it("keeps draft ops once, consumes and expires them", async () => {
    const { s, done } = fresh(adapter);
    try {
      const d = (opId: string, createdAt: number) => ({ username: "alice", opId, devicePub: "aa".repeat(32), envelope: "{}", size: 2, createdAt });
      expect(await s.voici.putDraft(d("01".repeat(16), 5))).toBe(true);
      expect(await s.voici.putDraft(d("01".repeat(16), 6))).toBe(false);
      await s.voici.putDraft(d("02".repeat(16), 3));
      await s.voici.putDraft(d("03".repeat(16), 9));
      expect((await s.voici.listDrafts("alice")).map((x) => x.opId)).toEqual(["02".repeat(16), "01".repeat(16), "03".repeat(16)]);
      expect(await s.voici.countDrafts("alice")).toBe(3);
      expect(await s.voici.consumeDrafts("alice", ["01".repeat(16), "ff".repeat(16)])).toBe(1);
      expect(await s.voici.deleteDraftsBefore(4, 10)).toBe(1);
      expect((await s.voici.listDrafts("alice")).map((x) => x.opId)).toEqual(["03".repeat(16)]);
    } finally {
      done();
    }
  });

  it("moves the state blob only to the next version", async () => {
    const { s, done } = fresh(adapter);
    try {
      expect(await s.voici.putState("alice", 2, "x", 1)).toBe(false);
      expect(await s.voici.putState("alice", 1, "a", 1)).toBe(true);
      expect(await s.voici.putState("alice", 1, "b", 2)).toBe(false);
      expect(await s.voici.putState("alice", 2, "c", 3)).toBe(true);
      expect(await s.voici.getState("alice")).toEqual({ username: "alice", version: 2, blob: "c", updatedAt: 3 });
      expect(await s.voici.getState("bob")).toBeNull();
    } finally {
      done();
    }
  });

  it("finds a username by its hyphen-less key and deletes an account's voi.ci state", async () => {
    const { s, done } = fresh(adapter);
    try {
      await s.usernames.put({ username: "plucky-avocet", irkPubHex: "11".repeat(32), claimedAt: 1 });
      expect(await s.voici.usernameWithKey("pluckyavocet")).toBe("plucky-avocet");
      expect(await s.voici.usernameWithKey("plucky")).toBeNull();
      await s.voici.publishPage(page(1), 0);
      await s.voici.putPiece({ pageId: PAGE, sha256: H(1), username: "alice", size: 1, jpeg: false, uploadedAt: 1, unreferencedAt: null });
      await s.voici.insertMessage(msg("a".repeat(64), "01".repeat(16)));
      await s.voici.putDraft({ username: "alice", opId: "01".repeat(16), devicePub: "aa".repeat(32), envelope: "{}", size: 2, createdAt: 1 });
      await s.voici.putState("alice", 1, "a", 1);
      expect(await s.voici.deleteAccount("alice")).toBe(PAGE);
      expect(await s.voici.getPage("alice")).toBeNull();
      expect(await s.voici.listInbox(PAGE, 0, 10)).toEqual([]);
      expect(await s.voici.listDrafts("alice")).toEqual([]);
      expect(await s.voici.getState("alice")).toBeNull();
      expect((await s.voici.listUnreferencedBefore(1, 10)).map((p) => p.sha256)).toEqual([H(1)]);
      expect(await s.voici.deleteAccount("alice")).toBeNull();
    } finally {
      done();
    }
  });

  it("keeps reply alerts per conversation: upsert, newest few, one push claim an hour, and every way out", async () => {
    const { s, done } = fresh(adapter);
    try {
      const A = "a".repeat(64);
      const B = "b".repeat(64);
      const alert = (conv: string, n: number, over: Partial<{ createdAt: number; expiresAt: number; delegatePub: string; pageId: string }> = {}) => ({
        conv,
        endpointHash: H(n),
        pageId: over.pageId ?? PAGE,
        subscription: `{"endpoint":"https://fcm.googleapis.com/fcm/send/${n}"}`,
        delegatePub: over.delegatePub ?? "04" + "cd".repeat(64),
        createdAt: over.createdAt ?? n,
        expiresAt: over.expiresAt ?? 10_000,
      });
      for (let n = 1; n <= 4; n++) await s.voici.putAlert(alert(A, n), 3);
      expect((await s.voici.listAlerts(A)).map((r) => r.endpointHash)).toEqual([H(2), H(3), H(4)]);
      await s.voici.putAlert(alert(A, 2, { createdAt: 9 }), 3);
      expect((await s.voici.listAlerts(A)).map((r) => [r.endpointHash, r.createdAt])).toEqual([[H(3), 3], [H(4), 4], [H(2), 9]]);
      await s.voici.putAlert(alert(A, 5, { expiresAt: 50 }), 4);
      await s.voici.putAlert(alert(B, 1, { delegatePub: "04" + "ef".repeat(64) }), 3);

      const claimed = await s.voici.claimAlertPush(A, 100, 100 - 3600);
      expect(claimed.map((c) => c.endpointHash).sort()).toEqual([H(2), H(3), H(4)]);
      expect(await s.voici.claimAlertPush(A, 200, 200 - 3600)).toEqual([]);
      expect((await s.voici.claimAlertPush(A, 3800, 3800 - 3600)).length).toBe(3);
      expect((await s.voici.listAlerts(A)).find((r) => r.endpointHash === H(5))?.lastPushedAt).toBeNull();
      expect((await s.voici.claimAlertPush(B, 100, 100 - 3600)).length).toBe(1);

      expect(await s.voici.deleteAlert(A, H(3))).toBe(true);
      expect(await s.voici.deleteAlert(A, H(3))).toBe(false);
      expect(await s.voici.deleteAlertsForDelegate("04" + "ef".repeat(64))).toBe(1);
      expect(await s.voici.listAlerts(B)).toEqual([]);

      // collected: past the delegation's expiry, or the conversation has no mail left
      await s.voici.insertMessage(msg(A, "01".repeat(16)));
      await s.voici.putAlert(alert(B, 2), 3);
      const gc = await s.voici.collect({ piecesBefore: 0, messagesBefore: 0, draftsBefore: 0, now: 60, limit: 100 });
      expect(gc.alerts).toBe(2);
      expect((await s.voici.listAlerts(A)).map((r) => r.endpointHash)).toEqual([H(4), H(2)]);
      expect(await s.voici.listAlerts(B)).toEqual([]);

      expect(await s.voici.deleteAlertsForPage("11".repeat(16))).toBe(0);
      await s.voici.publishPage(page(1), 0);
      expect(await s.voici.deleteAccount("alice")).toBe(PAGE);
      expect(await s.voici.listAlerts(A)).toEqual([]);
    } finally {
      done();
    }
  });
});
