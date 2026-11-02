// voi.ci reply alerts (packages/control-plane/src/voiciAlerts.ts; the "Alerts:" note in docs/voici-and-messages.md
// §8.3): a subscription is bound to one conversation by the browser key that conversation's cred delegates, never to
// someone else's; a stored owner reply sends one content-free push an hour; gone subscriptions, sign-outs, collected
// conversations and deleted accounts take their rows with them.
import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import { canonicalVoiciAlerts, sha256Hex, signVoiciAlertsP256, signVoiciBlock, signWebDelegationRevoke, type VoiciAlertsOrder } from "@flagship/protocol";
import * as web from "../../flagship-web/src/index.js";
import {
  handleVoiciAlerts,
  handleVoiciBlock,
  handleVoiciPieceUpload,
  handleVoiciPublish,
  handleVoiciRevoke,
  handleVoiciSend,
  isWebPushEndpoint,
  runVoiciGc,
  sendVoiciReplyAlerts,
  VOICI_ALERTS_PER_CONV,
  type VoiciMailboxDeps,
  type WebPushOutcome,
} from "../src/index.js";
import { adminPub, buildPage, caPub, fakeBucket, irkPub, ORIGIN, ownerSign, PAGE_ID, uploadHeaders, USER, visitor } from "./support/voiciFixture.js";

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const P256DH = "BN" + "A".repeat(85);
const AUTH = "AAAAAAAAAAAAAAAAAAAAAA";
const endpoint = (n = 1) => `https://fcm.googleapis.com/fcm/send/sub-${n}`;
const sub = (n = 1) => ({ endpoint: endpoint(n), keys: { p256dh: P256DH, auth: AUTH } });

async function world() {
  const storage = new InMemoryStorage();
  await storage.usernames.put({ username: USER, irkPubHex: irkPub, adminRootPubHex: adminPub, claimedAt: 1 });
  let now = T0;
  const bucket = fakeBucket();
  const pagesDeps = { voici: storage.voici, usernames: storage.usernames, bucket, now: () => now };
  const page = buildPage({ seq: 1, issuedAt: T0 });
  for (const bytes of page.pieces.values()) await handleVoiciPieceUpload(pagesDeps, USER, uploadHeaders(bytes, T0), bytes);
  expect((await handleVoiciPublish(pagesDeps, USER, JSON.stringify(page.index))).status).toBe(200);
  const pushes: { subscription: string; payload: string }[] = [];
  const outcome: { next: WebPushOutcome } = { next: "sent" };
  const send = async (subscription: string, payload: Uint8Array) => {
    pushes.push({ subscription, payload: new TextDecoder().decode(payload) });
    return outcome.next;
  };
  const deps: VoiciMailboxDeps = {
    voici: storage.voici,
    origin: ORIGIN,
    caKeys: () => [caPub],
    replyStored: (u, conv) => sendVoiciReplyAlerts({ voici: storage.voici, send, now: () => now }, u, conv),
    now: () => now,
  };
  const alertsDeps = { voici: storage.voici, origin: ORIGIN, caKeys: () => [caPub], now: () => now };
  const order = (v: ReturnType<typeof visitor>, op: "on" | "off", n = 1, over: Partial<VoiciAlertsOrder> = {}, signer = v) => {
    const o: VoiciAlertsOrder = { conv: v.conv, op, endpointHash: sha256Hex(endpoint(n)), issuedAt: now, ...over };
    return { conv: o.conv, op, endpoint: endpoint(n), issuedAt: o.issuedAt, sig: signVoiciAlertsP256(o, signer.browserPriv), cred: signer.cred, ...(op === "on" ? { subscription: sub(n) } : {}) };
  };
  const alerts = async (body: unknown) => {
    const r = await handleVoiciAlerts(alertsDeps, body);
    return { status: r.status, body: r.body as Record<string, unknown> };
  };
  const send1 = async (env: unknown) => (await handleVoiciSend(deps, JSON.stringify(env))).status;
  return { storage, deps, pushes, outcome, order, alerts, send: send1, setNow: (t: number) => (now = t), now: () => now };
}

describe("reply alerts: who may turn them on", () => {
  it("binds a subscription to the signing visitor's own conversation, after they wrote", async () => {
    const w = await world();
    const v = visitor(T0);
    expect((await w.alerts(w.order(v, "on"))).body.code).toBe("no-conversation");
    expect(await w.send(v.message(T0))).toBe(200);
    expect(await w.alerts(w.order(v, "on"))).toEqual({ status: 200, body: { ok: true, alerts: "on" } });
    const rows = await w.storage.voici.listAlerts(v.conv);
    expect(rows.map((r) => [r.pageId, r.endpointHash, r.delegatePub, r.expiresAt])).toEqual([[PAGE_ID, sha256Hex(endpoint(1)), v.browserPub, v.cred.delegation.expiresAt]]);
    expect(JSON.parse(rows[0]!.subscription)).toEqual(sub(1));
  });

  it("refuses someone else's conversation, a forged or replayed order, and any endpoint but a push service's", async () => {
    const w = await world();
    const v = visitor(T0);
    const other = visitor(T0, 2);
    await w.send(v.message(T0));
    // Mallory signs with her own key and cred, naming the victim's conversation.
    expect((await w.alerts(w.order(v, "on", 1, {}, other))).body.code).toBe("wrong-conv");
    // Mallory replays the victim's cred with her own browser key.
    const stolen = { ...w.order(other, "on", 1, { conv: v.conv }), cred: v.cred };
    expect((await w.alerts(stolen)).body.code).toBe("bad-signature");
    // A signature over another endpoint, an on/off swap, a stale order.
    expect((await w.alerts({ ...w.order(v, "on", 1), endpoint: endpoint(2), subscription: sub(2) })).body.code).toBe("bad-signature");
    expect((await w.alerts({ ...w.order(v, "off", 1), op: "on", subscription: sub(1) })).body.code).toBe("bad-signature");
    expect((await w.alerts(w.order(v, "on", 1, { issuedAt: T0 - 11 * 60_000 }))).body.code).toBe("stale");
    for (const bad of ["http://fcm.googleapis.com/x", "https://evil.example/push", "https://fcm.googleapis.com:8443/x", "https://u:p@fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x"]) {
      expect(isWebPushEndpoint(bad), bad).toBe(false);
    }
    for (const good of [endpoint(1), "https://updates.push.services.mozilla.com/wpush/v2/gAAAA", "https://web.push.apple.com/QGx", "https://wns2-bl2p.notify.windows.com/w/?token=AQ"]) {
      expect(isWebPushEndpoint(good), good).toBe(true);
    }
    expect((await w.alerts({ ...w.order(v, "on"), endpoint: "https://evil.example/push" })).body.code).toBe("bad-endpoint");
    expect((await w.alerts({ ...w.order(v, "on"), subscription: { endpoint: endpoint(1), keys: { p256dh: "AAAA", auth: AUTH } } })).body.code).toBe("bad-endpoint");
    expect(await w.storage.voici.listAlerts(v.conv)).toEqual([]);
  });

  it("stores nothing for a blocked pseudonym yet answers the same, and keeps the newest browsers only", async () => {
    const w = await world();
    const v = visitor(T0);
    await w.send(v.message(T0));
    const block = { pageId: PAGE_ID, pseudonymPub: v.pPub, op: "block" as const, issuedAt: T0 };
    const owner = { voici: w.storage.voici, readTokens: {} as never, directory: {} as never, now: w.now };
    expect((await handleVoiciBlock(owner, USER, { block, signature: signVoiciBlock(block, ownerSign.seed) })).status).toBe(200);
    expect(await w.alerts(w.order(v, "on"))).toEqual({ status: 200, body: { ok: true, alerts: "on" } });
    expect(await w.storage.voici.listAlerts(v.conv)).toEqual([]);

    const u = visitor(T0, 3);
    await w.send(u.message(T0));
    for (let n = 1; n <= VOICI_ALERTS_PER_CONV + 2; n++) {
      w.setNow(T0 + n);
      expect((await w.alerts(w.order(u, "on", n))).status).toBe(200);
    }
    expect((await w.storage.voici.listAlerts(u.conv)).map((r) => r.endpointHash)).toEqual([3, 4, 5, 6, 7].map((n) => sha256Hex(endpoint(n))));
    expect(await w.alerts(w.order(u, "off", 7))).toEqual({ status: 200, body: { ok: true, alerts: "off" } });
    expect((await w.storage.voici.listAlerts(u.conv)).length).toBe(4);
  });
});

describe("reply alerts: the push", () => {
  it("sends one content-free push per conversation an hour, and drops a gone subscription", async () => {
    const w = await world();
    const v = visitor(T0);
    const other = visitor(T0, 2);
    await w.send(v.message(T0, "a secret about cats"));
    await w.send(other.message(T0));
    await w.alerts(w.order(v, "on", 1));
    await w.alerts(w.order(v, "on", 2));
    await w.alerts(w.order(other, "on", 9));
    expect(await w.send(v.reply(T0 + 1, "aa".repeat(16)))).toBe(200);
    expect(w.pushes.map((p) => p.payload)).toEqual(['{"kind":"voici-reply","u":"alice"}', '{"kind":"voici-reply","u":"alice"}']);
    expect(w.pushes.map((p) => JSON.parse(p.subscription).endpoint).sort()).toEqual([endpoint(1), endpoint(2)]);
    expect(w.pushes.some((p) => /cats|Hi!|aa{8}/.test(p.payload))).toBe(false);
    w.setNow(T0 + HOUR - 1);
    expect(await w.send(v.reply(T0 + HOUR - 1, "ab".repeat(16)))).toBe(200);
    expect(w.pushes.length).toBe(2);
    w.setNow(T0 + HOUR + 2);
    w.outcome.next = "gone";
    expect(await w.send(v.reply(T0 + HOUR + 2, "ac".repeat(16)))).toBe(200);
    expect(w.pushes.length).toBe(4);
    expect(await w.storage.voici.listAlerts(v.conv)).toEqual([]);
    expect((await w.storage.voici.listAlerts(other.conv)).length).toBe(1);
  });

  it("removes alerts when the browser key signs out, the conversation is collected or the account goes", async () => {
    const w = await world();
    const v = visitor(T0);
    const u = visitor(T0, 3);
    await w.send(v.message(T0));
    await w.send(u.message(T0));
    await w.alerts(w.order(v, "on"));
    await w.alerts(w.order(u, "on"));
    const revoke = { delegatePub: v.browserPub, issuedAt: T0 };
    expect((await handleVoiciRevoke(w.deps, { revoke, signature: signWebDelegationRevoke(revoke, v.pseud.seed), principalPub: v.pPub })).status).toBe(200);
    expect(await w.storage.voici.listAlerts(v.conv)).toEqual([]);
    expect((await w.storage.voici.listAlerts(u.conv)).length).toBe(1);
    expect((await runVoiciGc({ voici: w.storage.voici }, T0 + 181 * 86_400_000)).alerts).toBe(1);
    expect(await w.storage.voici.listAlerts(u.conv)).toEqual([]);
    const x = visitor(T0, 4);
    await w.send(x.message(T0));
    await w.alerts(w.order(x, "on"));
    await w.storage.voici.deleteAccount(USER);
    expect(await w.storage.voici.listAlerts(x.conv)).toEqual([]);
  });
});

describe("reply alerts: flagship-web", () => {
  it("signs the same bytes the server checks", async () => {
    const o: VoiciAlertsOrder = { conv: "ab".repeat(32), op: "on", endpointHash: sha256Hex(endpoint(1)), issuedAt: T0 };
    expect(Buffer.from(web.canonicalVoiciAlerts(o)).toString()).toBe(Buffer.from(canonicalVoiciAlerts(o)).toString());
    expect(Buffer.from(canonicalVoiciAlerts(o)).toString()).toBe(`flagship/voici-alerts/v1|${"ab".repeat(32)}|on|${sha256Hex(endpoint(1))}|${T0}`);
    expect(await web.endpointHashOf(endpoint(1))).toBe(sha256Hex(endpoint(1)));
    expect(() => web.canonicalVoiciAlerts({ ...o, op: "maybe" })).toThrow();
  });

  it("builds on and off orders with a non-extractable WebCrypto key that the server accepts", async () => {
    const w = await world();
    const v = visitor(T0);
    await w.send(v.message(T0));
    const pub = Buffer.from(v.browserPub, "hex");
    const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
    const jwk = { kty: "EC", crv: "P-256", d: b64u(v.browserPriv), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), ext: false };
    const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const session = { pageId: PAGE_ID, pseudonymPub: v.pPub, privateKey, ...v.cred };
    const on = await web.buildVoiciAlertsOrder(session, { op: "on", subscription: sub(4), issuedAt: T0 });
    expect(Object.keys(on).sort()).toEqual(["conv", "cred", "endpoint", "issuedAt", "op", "sig", "subscription"]);
    expect(await w.alerts(on)).toEqual({ status: 200, body: { ok: true, alerts: "on" } });
    expect((await w.storage.voici.listAlerts(v.conv)).length).toBe(1);
    expect(await w.alerts(await web.buildVoiciAlertsOrder(session, { op: "off", endpoint: endpoint(4), issuedAt: T0 }))).toEqual({ status: 200, body: { ok: true, alerts: "off" } });
    expect(await w.storage.voici.listAlerts(v.conv)).toEqual([]);
  });
});
