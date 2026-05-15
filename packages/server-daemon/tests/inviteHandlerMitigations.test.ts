import { describe, expect, it } from "vitest";
import {
  ed,
  type Keypair,
} from "@flagship/protocol";
import {
  buildInviteHandler,
  InMemoryAppInviteStore,
  signIssueInvite,
} from "../src/inviteHandler.js";
import { createHash } from "node:crypto";

const SERVER_FQDN = "home.alice.flagship.services";
const APP_ID = "alice-chat";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function makeReq(method: string, path: string, body?: unknown) {
  return {
    method,
    path,
    headers: { "content-type": "application/json" },
    body: Buffer.from(body === undefined ? "" : JSON.stringify(body)),
  };
}

function issueEnvelope(args: {
  appId: string;
  ttlMs?: number;
  contextNote?: string | null;
  issuedAt: number;
  psk: Keypair;
}) {
  const f = {
    serverId: SERVER_FQDN,
    appId: args.appId,
    role: "reader",
    opaqueTag: new Uint8Array(16),
    expectedIrkPubKey: null,
    contextNote: args.contextNote ?? null,
    ttlMs: args.ttlMs ?? 24 * 60 * 60_000,
    issuedAt: args.issuedAt,
  };
  const sig = signIssueInvite(f, args.psk);
  return {
    request: {
      serverId: f.serverId,
      appId: f.appId,
      role: f.role,
      opaqueTag: bytesToHex(f.opaqueTag),
      expectedIrkPubKey: null,
      contextNote: f.contextNote,
      ttlMs: f.ttlMs,
      issuedAt: f.issuedAt,
    },
    signature: bytesToHex(sig),
  };
}

describe("invite bearer-token mitigations (#83)", () => {
  it("TTL bounds: 24h default applied when ttlMs omitted (24h ± slack)", async () => {
    const psk = makeKey();
    const store = new InMemoryAppInviteStore();
    const handler = buildInviteHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, store });
    const fields = {
      serverId: SERVER_FQDN,
      appId: APP_ID,
      role: "reader",
      opaqueTag: new Uint8Array(16),
      expectedIrkPubKey: null,
      contextNote: null,
      ttlMs: 24 * 60 * 60_000,
      issuedAt: Date.now(),
    };
    const sig = signIssueInvite(fields, psk);
    // Omit ttlMs from the wire request entirely.
    const env = {
      request: {
        serverId: fields.serverId,
        appId: fields.appId,
        role: fields.role,
        opaqueTag: bytesToHex(fields.opaqueTag),
        expectedIrkPubKey: null,
        contextNote: null,
        issuedAt: fields.issuedAt,
      },
      signature: bytesToHex(sig),
    };
    const r = await handler(makeReq("POST", `/.flagship/app/${APP_ID}/invite`, env));
    expect(r?.status).toBe(200);
    const body = JSON.parse(String(r!.body)) as { expiresAt: number };
    const now = Date.now();
    expect(body.expiresAt - now).toBeGreaterThan(24 * 60 * 60_000 - 5_000);
    expect(body.expiresAt - now).toBeLessThanOrEqual(24 * 60 * 60_000 + 5_000);
  });

  it("TTL bounds: rejects ttlMs > 72h cap", async () => {
    const psk = makeKey();
    const store = new InMemoryAppInviteStore();
    const handler = buildInviteHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, store });
    const env = issueEnvelope({
      appId: APP_ID,
      ttlMs: 73 * 60 * 60_000,
      issuedAt: Date.now(),
      psk,
    });
    const r = await handler(makeReq("POST", `/.flagship/app/${APP_ID}/invite`, env));
    expect(r?.status).toBe(400);
    expect(String(r!.body)).toContain("ttlMs exceeds cap");
  });

  it("TTL bounds: rejects ttlMs < 60s", async () => {
    const psk = makeKey();
    const store = new InMemoryAppInviteStore();
    const handler = buildInviteHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, store });
    const env = issueEnvelope({
      appId: APP_ID,
      ttlMs: 5_000,
      issuedAt: Date.now(),
      psk,
    });
    const r = await handler(makeReq("POST", `/.flagship/app/${APP_ID}/invite`, env));
    expect(r?.status).toBe(400);
    expect(String(r!.body)).toContain("ttlMs too small");
  });

  it("TTL bounds: accepts ttlMs exactly at the 72h cap", async () => {
    const psk = makeKey();
    const store = new InMemoryAppInviteStore();
    const handler = buildInviteHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, store });
    const env = issueEnvelope({
      appId: APP_ID,
      ttlMs: 72 * 60 * 60_000,
      issuedAt: Date.now(),
      psk,
    });
    const r = await handler(makeReq("POST", `/.flagship/app/${APP_ID}/invite`, env));
    expect(r?.status).toBe(200);
  });

  it("contextNote: rendered in preview response BEFORE consumption is allowed", async () => {
    const psk = makeKey();
    const store = new InMemoryAppInviteStore();
    const handler = buildInviteHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, store });
    const note = "from harry's phone — work";
    const env = issueEnvelope({
      appId: APP_ID,
      contextNote: note,
      issuedAt: Date.now(),
      psk,
    });
    const issued = await handler(makeReq("POST", `/.flagship/app/${APP_ID}/invite`, env));
    expect(issued?.status).toBe(200);
    const ib = JSON.parse(String(issued!.body)) as { secret: string };
    const secretHash = createHash("sha256")
      .update(Buffer.from(ib.secret, "hex"))
      .digest("hex");
    const preview = await handler(
      makeReq("GET", `/.flagship/app/${APP_ID}/invite/preview?h=${secretHash}`),
    );
    expect(preview?.status).toBe(200);
    const pb = JSON.parse(String(preview!.body)) as {
      appId: string;
      role: string;
      contextNote: string | null;
      preBound: boolean;
    };
    expect(pb.appId).toBe(APP_ID);
    expect(pb.role).toBe("reader");
    expect(pb.contextNote).toBe(note);
    expect(pb.preBound).toBe(false);
  });

  it("contextNote: HTML page fetches /invite/preview to render the note before letting the consumer accept", () => {
    const psk = makeKey();
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store: new InMemoryAppInviteStore(),
    });
    // Synchronously render the page.
    return handler(makeReq("GET", "/invite")).then((r) => {
      expect(r?.status).toBe(200);
      const html = String(r!.body);
      // The accept button starts disabled and gets enabled only after
      // /invite/preview returns.
      expect(html).toMatch(/<button id="accept"[^>]*disabled[^>]*>/);
      expect(html).toContain("/invite/preview?h=");
      expect(html).toContain("context-note");
      // The page surfaces the bearer caution before any redemption.
      expect(html.toLowerCase()).toMatch(/anyone holding this link/);
    });
  });

  it("preview: rejects malformed hash", async () => {
    const psk = makeKey();
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store: new InMemoryAppInviteStore(),
    });
    const r = await handler(makeReq("GET", `/.flagship/app/${APP_ID}/invite/preview?h=nope`));
    expect(r?.status).toBe(400);
  });

  it("preview: returns 404 for unknown secret hash (no info leak about other invites)", async () => {
    const psk = makeKey();
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store: new InMemoryAppInviteStore(),
    });
    const r = await handler(
      makeReq("GET", `/.flagship/app/${APP_ID}/invite/preview?h=${"00".repeat(32)}`),
    );
    expect(r?.status).toBe(404);
  });

  it("preview: 410 once the invite has expired (clock-based, even if still pending)", async () => {
    const psk = makeKey();
    const store = new InMemoryAppInviteStore();
    let nowMs = 1_000_000_000_000;
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store,
      now: () => nowMs,
    });
    const env = issueEnvelope({
      appId: APP_ID,
      ttlMs: 60_000,
      issuedAt: nowMs,
      psk,
    });
    const issued = await handler(makeReq("POST", `/.flagship/app/${APP_ID}/invite`, env));
    expect(issued?.status).toBe(200);
    const ib = JSON.parse(String(issued!.body)) as { secret: string };
    const secretHash = createHash("sha256")
      .update(Buffer.from(ib.secret, "hex"))
      .digest("hex");
    // Advance past expiry.
    nowMs += 120_000;
    const r = await handler(
      makeReq("GET", `/.flagship/app/${APP_ID}/invite/preview?h=${secretHash}`),
    );
    expect(r?.status).toBe(410);
  });

  it("contextNote: notes longer than 280 chars are rejected (not silently clamped)", async () => {
    const psk = makeKey();
    const store = new InMemoryAppInviteStore();
    const handler = buildInviteHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, store });
    const long = "x".repeat(281);
    const env = issueEnvelope({
      appId: APP_ID,
      contextNote: long,
      issuedAt: Date.now(),
      psk,
    });
    const r = await handler(makeReq("POST", `/.flagship/app/${APP_ID}/invite`, env));
    expect(r?.status).toBe(400);
    expect(String(r!.body)).toContain("contextNote too long");
  });

  it("contextNote: exactly 280 chars is accepted", async () => {
    const psk = makeKey();
    const store = new InMemoryAppInviteStore();
    const handler = buildInviteHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, store });
    const justfits = "y".repeat(280);
    const env = issueEnvelope({
      appId: APP_ID,
      contextNote: justfits,
      issuedAt: Date.now(),
      psk,
    });
    const r = await handler(makeReq("POST", `/.flagship/app/${APP_ID}/invite`, env));
    expect(r?.status).toBe(200);
    const ib = JSON.parse(String(r!.body)) as { contextNote: string };
    expect(ib.contextNote.length).toBe(280);
  });
});
