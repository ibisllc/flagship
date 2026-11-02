// The voici live group's own parts, offline: the page builder, the draft and reply builders, the simulated phone's
// voi.ci endpoint (lib/voiciPhone.ts) against envelopes from the .com tests' fixture, the CORS-enforcing browser fetch,
// and the gym abuse key entry.
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import {
  b64Decode,
  checkVoiciDraft,
  checkVoiciPageIndex,
  checkVoiciReply,
  deriveAccountDeviceKeySeed,
  deriveVoiciDraftsKey,
  ed,
  mergeVoiciPage,
  openVoiciBody,
  openVoiciDraft,
  parseVoiciChunkPiece,
  parseVoiciProfilePiece,
  signDeviceCapabilityGrant,
  verifyDeviceCapabilityGrant,
  verifyVoiciAck,
  type DeviceCapabilityGrant,
  type VoiciDraftOp,
  type WebEnvelope,
} from "@flagship/protocol";
import { caPub, inbox, ownerSign, PAGE_ID, visitor } from "../../../packages/control-plane/tests/support/voiciFixture.js";
import { parseHttpAnswer, parseHttpRequest, PhoneEndpointSim } from "../lib/phoneSim.js";
import { VoiciPhoneWeb } from "../lib/voiciPhone.js";
import { GYM_ABUSE_SEED, gymAbuseKeyEntry, gymAbuseKeySelfCheck } from "../lib/gymAbuseKey.js";
import { buildIndex, corsFetch, draftEnvelope, newPost, ownerReply, voici } from "../groups/release03/voici.js";
import { RELEASE_03_GROUPS } from "../groups/release03/index.js";
import { hybridSealKeygen } from "@flagship/protocol";

const kp = () => {
  const s = new Uint8Array(randomBytes(32));
  return { privateKey: s, publicKey: ed.getPublicKey(s) };
};
const ORIGIN = "https://voi.ci";
const HOST = "alice.flagship.services";

function raw(method: string, path: string, headers: Record<string, string>, body = ""): string {
  const lines = Object.entries({ host: HOST, ...headers, ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}) })
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  return `${method} ${path} HTTP/1.1\r\n${lines}\r\n${body}`;
}

async function ask(ep: PhoneEndpointSim, method: string, path: string, headers: Record<string, string>, body = "") {
  const req = parseHttpRequest(Buffer.from(raw(method, path, headers, body)));
  const a = parseHttpAnswer(await ep.respond(req!, HOST));
  return a!;
}

describe("voici group: builders", () => {
  it("builds an index .com would take, with parsable pieces", () => {
    const admin = kp();
    const post = newPost("hello");
    const b = buildIndex({
      username: "alice",
      pageId: PAGE_ID,
      seq: 1,
      issuedAt: Date.now(),
      state: { profile: { v: 1, displayName: "A", bio: "", avatar: null, theme: "sea", links: [] }, acceptsMessages: 1, chunks: [[post]], issuedAt: 0 },
      inboxPub: bytesToHex(inbox.publicKey),
      ownerSignPub: bytesToHex(ownerSign.publicKey),
      signerSeed: admin.privateKey,
    });
    expect(checkVoiciPageIndex(b.index, { username: "alice", sensitiveKind: "admin-root", sensitivePub: bytesToHex(admin.publicKey) }).ok).toBe(true);
    const prof = b.index.pieces.find((p) => p.role === "profile")!;
    const chunk = b.index.pieces.find((p) => p.role === "chunk-0")!;
    expect(parseVoiciProfilePiece(b.pieces.get(prof.sha256)!)?.displayName).toBe("A");
    expect(parseVoiciChunkPiece(b.pieces.get(chunk.sha256)!, 0)?.posts[0]?.text).toBe("hello");
  });

  it("builds a non-admin device's draft that passes the grant chain, opens, and merges", () => {
    const umk = new Uint8Array(randomBytes(32));
    const irk = kp();
    const deviceId = randomBytes(16).toString("hex");
    const seed = deriveAccountDeviceKeySeed(umk, "alice", deviceId);
    const device = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
    const g: DeviceCapabilityGrant = { grantId: randomBytes(16).toString("hex"), username: "alice", deviceId, devicePubKey: device.publicKey, scopes: ["browse"] as DeviceCapabilityGrant["scopes"], issuedAt: Date.now(), expiresAt: Date.now() + 86_400_000 };
    const grantSignature = bytesToHex(signDeviceCapabilityGrant(g, irk));
    const op: VoiciDraftOp = { v: 1, opId: randomBytes(16).toString("hex"), op: "post-add", at: Date.now(), deviceId, post: newPost("drafted") };
    const env = draftEnvelope({ username: "alice", umk, device, deviceId, grant: { ...g, devicePubKey: bytesToHex(device.publicKey) }, grantSignature, op, seq: 1 });
    const grantOk = (grant: unknown, sig: string, devicePub: string) =>
      verifyDeviceCapabilityGrant({ ...(grant as DeviceCapabilityGrant), devicePubKey: Buffer.from(devicePub, "hex") }, Buffer.from(sig, "hex"), irk.publicKey);
    expect(checkVoiciDraft(env, { username: "alice", checkGrant: grantOk, freshAt: Date.now() }).ok).toBe(true);
    const opened = openVoiciDraft(deriveVoiciDraftsKey({ seed: umk }), "alice", env.msgId, b64Decode(env.bodyB64)!);
    expect(opened?.post?.text).toBe("drafted");
    const merged = mergeVoiciPage({ profile: { v: 1, displayName: "A", bio: "", avatar: null, theme: "sea", links: [] }, acceptsMessages: 1, chunks: [[]], issuedAt: 0 }, [opened!]);
    expect(merged.chunks.flat().map((p) => p.text)).toEqual(["drafted"]);
  });

  it("builds an owner reply the visitor's browser verifies and opens with T", () => {
    const t0 = Date.now();
    const v = visitor(t0);
    const reply = ownerReply({ pageId: PAGE_ID, conv: v.conv, threadPub: v.cred.threadStmt.threadPub, inboxPub: inbox.publicKey, ownerSign, pageSeq: 1, seq: 1, text: "Hi!", replyTo: null });
    expect(checkVoiciReply(reply, { pageId: PAGE_ID, ownerSignPub: bytesToHex(ownerSign.publicKey), freshAt: t0 }).ok).toBe(true);
    expect(openVoiciBody(b64Decode(reply.bodyB64)!, { conv: v.conv, msgId: reply.msgId }, inbox.seed)).toMatchObject({ ok: true, plaintext: { text: "Hi!" } });
  });

  it("the gym abuse key entry verifies under the gym ca-track key K, and its seed is the key", () => {
    expect(gymAbuseKeySelfCheck()).toBe(true);
    expect(gymAbuseKeyEntry().xwingPub).toBe(bytesToHex(hybridSealKeygen(GYM_ABUSE_SEED).publicKey));
  });

  it("is registered as a 0.3 group that needs no box", () => {
    expect(RELEASE_03_GROUPS).toContain(voici);
    expect(voici.needs).toEqual([]);
  });
});

describe("voici group: the simulated phone's voi.ci endpoint", () => {
  const setup = () => {
    const device = kp();
    const forwarded: WebEnvelope[] = [];
    const ep = new PhoneEndpointSim({ account: "alice", label: "P", phoneRoutePub: bytesToHex(device.publicKey) });
    const web = new VoiciPhoneWeb({
      account: "alice",
      origins: [ORIGIN],
      webOrigin: ORIGIN,
      deviceSeed: device.privateKey,
      caKeys: [caPub],
      grantOk: () => true,
      forward: async (e) => void forwarded.push(e),
    });
    web.page = { pageId: PAGE_ID, acceptsMessages: true, ownerSignPub: bytesToHex(ownerSign.publicKey), ownerSignSeed: ownerSign.seed };
    ep.web = web;
    return { ep, web, forwarded };
  };
  const CT = { "content-type": "application/flagship-envelope+json" };

  it("answers live and the preflight with CORS for exactly the listed origin", async () => {
    const { ep } = setup();
    const live = await ask(ep, "GET", "/api/phone/live", { origin: ORIGIN });
    expect(live.status).toBe(200);
    expect(live.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(JSON.parse(live.body)).toEqual({ live: true, account: "alice", ownerSignPub: bytesToHex(ownerSign.publicKey) });
    const pre = await ask(ep, "OPTIONS", "/api/phone/deliver", { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" });
    expect([pre.status, pre.headers["access-control-allow-origin"], pre.headers["access-control-allow-credentials"]]).toEqual([204, ORIGIN, undefined]);
    const evil = await ask(ep, "GET", "/api/phone/live", { origin: "https://evil.example" });
    expect([evil.status, evil.headers["access-control-allow-origin"]]).toEqual([403, undefined]);
    const extra = await ask(ep, "OPTIONS", "/api/phone/deliver", { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" });
    expect(extra.status).toBe(403);
    expect((await ask(ep, "POST", "/api/phone/deliver", { origin: ORIGIN, "content-type": "text/plain" }, "{}")).status).toBe(415);
  });

  it("delivers a message: forwards it, acks with the page key; a repeat is 409; a blocked sender gets 200 with no ack", async () => {
    const { ep, web, forwarded } = setup();
    const t0 = Date.now();
    const v = visitor(t0);
    const m = v.message(t0, "Hello", randomBytes(16).toString("hex"));
    const a = await ask(ep, "POST", "/api/phone/deliver", { origin: ORIGIN, ...CT }, JSON.stringify(m));
    expect(a.status).toBe(200);
    expect(verifyVoiciAck(JSON.parse(a.body).ack, bytesToHex(ownerSign.publicKey), { msgId: m.msgId, conv: m.conv })).not.toBeNull();
    expect(forwarded.map((e) => e.msgId)).toEqual([m.msgId]);
    expect((await ask(ep, "POST", "/api/phone/deliver", { origin: ORIGIN, ...CT }, JSON.stringify(m))).status).toBe(409);
    web.blocked.add(v.pPub);
    const b = await ask(ep, "POST", "/api/phone/deliver", { origin: ORIGIN, ...CT }, JSON.stringify(v.message(t0, "again", randomBytes(16).toString("hex"))));
    expect([b.status, JSON.parse(b.body)]).toEqual([200, { accepted: true }]);
    expect(forwarded).toHaveLength(1);
  });

  it("refuses a message whose attestation isn't by a CA key it knows", async () => {
    const { ep, web } = setup();
    (web as unknown as { o: { caKeys: string[] } }).o.caKeys = [bytesToHex(kp().publicKey)];
    const t0 = Date.now();
    const a = await ask(ep, "POST", "/api/phone/deliver", { origin: ORIGIN, ...CT }, JSON.stringify(visitor(t0).message(t0)));
    expect([a.status, JSON.parse(a.body).code]).toEqual([403, "bad-attestation"]);
  });

  it("leaves requests it doesn't own to the sim's other routes", async () => {
    const { ep } = setup();
    const w = await ask(ep, "GET", "/.well-known/flagship-phone", {});
    expect(w.status).toBe(200);
  });
});

describe("voici group: the browser's CORS", () => {
  const ORIGIN_SITE = "https://gym.voi.ci";
  it("preflights a non-simple request and refuses an answer without Access-Control-Allow-Origin", async () => {
    const seen: string[] = [];
    const grant = new Headers({ "access-control-allow-origin": ORIGIN_SITE });
    const f = corsFetch(ORIGIN_SITE, async (url, init) => {
      seen.push(`${init.method} ${init.headers.origin ?? "-"}`);
      const preflight = init.method === "OPTIONS";
      return new Response(preflight ? null : "{}", { status: preflight ? 204 : 200, headers: url.includes("bad") ? {} : grant });
    });
    await f("https://api.example/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(seen).toEqual([`OPTIONS ${ORIGIN_SITE}`, `POST ${ORIGIN_SITE}`]);
    await expect(f("https://api.example/bad", {})).rejects.toThrow(/CORS/);
  });
});
