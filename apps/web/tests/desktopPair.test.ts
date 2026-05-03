import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { deriveIRK } from "@flagship/protocol";
import { signRebuildRequest } from "@flagship/protocol";
import { registerDesktopPair, type DesktopPairOptions } from "../src/routes/desktopPair.js";
import { bytesToHex } from "../src/lib/hex.js";

const umk = { seed: new Uint8Array(32).fill(77) };
const irk = deriveIRK(umk);
const userId = "harry";

function makeApp(opts: DesktopPairOptions = {}) {
  const app = Fastify({ logger: false });
  registerDesktopPair(app, {
    resolveIrkPubKey: (uid) => (uid === userId ? irk.publicKey : null),
    ...opts,
  });
  return app;
}

function randomPubKey(): Uint8Array {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return k;
}

async function startSession(app: ReturnType<typeof makeApp>, desktopPub: Uint8Array) {
  const res = await app.inject({
    method: "POST",
    url: "/api/desktop/pair/start",
    payload: { desktopPubKey: bytesToHex(desktopPub) },
  });
  return JSON.parse(res.body);
}

function signPairing(opts: {
  sessionId: string;
  desktopPubKey: Uint8Array;
  phonePubKey: Uint8Array;
  issuedAt: number;
  signWith?: { privateKey: Uint8Array; publicKey: Uint8Array };
}): string {
  const claim = {
    userId,
    newServerId: `desktop-pair:${opts.sessionId}`,
    wifiSsid: bytesToHex(opts.desktopPubKey),
    wifiPskHash: opts.phonePubKey,
    shareRatio: 0,
    issuedAt: opts.issuedAt,
  };
  const signer = opts.signWith ?? irk;
  return bytesToHex(signRebuildRequest(claim, signer));
}

describe("POST /api/desktop/pair/start", () => {
  it("creates a session and returns a flagship:// QR payload", async () => {
    const app = makeApp();
    const desktopPub = randomPubKey();
    const res = await app.inject({
      method: "POST",
      url: "/api/desktop/pair/start",
      payload: { desktopPubKey: bytesToHex(desktopPub) },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessionId).toMatch(/^[0-9a-f]{16}$/);
    expect(body.qrPayload).toMatch(/^flagship:\/\/desktop\//);
    expect(body.qrPayload).toContain(bytesToHex(desktopPub));
  });

  it("returns a base64 PNG data URI for the QR (browser-renderable)", async () => {
    const app = makeApp();
    const desktopPub = randomPubKey();
    const res = await app.inject({
      method: "POST",
      url: "/api/desktop/pair/start",
      payload: { desktopPubKey: bytesToHex(desktopPub) },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.qrDataUri).toMatch(/^data:image\/png;base64,/);
    // Must contain at least a few hundred bytes of base64 — a real QR.
    expect(body.qrDataUri.length).toBeGreaterThan(500);
  });

  it("rejects a non-32-byte desktopPubKey", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/desktop/pair/start",
      payload: { desktopPubKey: "00".repeat(16) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/desktop/pair/confirm — IRK signature gate", () => {
  it("transitions to paired with a valid IRK signature", async () => {
    const app = makeApp();
    const desktopPub = randomPubKey();
    const phonePub = randomPubKey();
    const start = await startSession(app, desktopPub);
    const issuedAt = Date.now();
    const sig = signPairing({ sessionId: start.sessionId, desktopPubKey: desktopPub, phonePubKey: phonePub, issuedAt });

    const res = await app.inject({
      method: "POST",
      url: "/api/desktop/pair/confirm",
      payload: {
        sessionId: start.sessionId,
        userId,
        phonePubKey: bytesToHex(phonePub),
        irkSignature: sig,
        issuedAt,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("paired");
  });

  it("REJECTS a signature from a different IRK (the entire trust hinge)", async () => {
    const app = makeApp();
    const desktopPub = randomPubKey();
    const phonePub = randomPubKey();
    const start = await startSession(app, desktopPub);
    const issuedAt = Date.now();
    const otherIrk = deriveIRK({ seed: new Uint8Array(32).fill(99) });
    const sig = signPairing({
      sessionId: start.sessionId,
      desktopPubKey: desktopPub,
      phonePubKey: phonePub,
      issuedAt,
      signWith: otherIrk,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/desktop/pair/confirm",
      payload: {
        sessionId: start.sessionId,
        userId,
        phonePubKey: bytesToHex(phonePub),
        irkSignature: sig,
        issuedAt,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a stale claim (>5 min old)", async () => {
    const app = makeApp();
    const desktopPub = randomPubKey();
    const phonePub = randomPubKey();
    const start = await startSession(app, desktopPub);
    const issuedAt = Date.now() - 10 * 60_000;
    const sig = signPairing({ sessionId: start.sessionId, desktopPubKey: desktopPub, phonePubKey: phonePub, issuedAt });

    const res = await app.inject({
      method: "POST",
      url: "/api/desktop/pair/confirm",
      payload: {
        sessionId: start.sessionId,
        userId,
        phonePubKey: bytesToHex(phonePub),
        irkSignature: sig,
        issuedAt,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects when the userId has no registered IRK", async () => {
    const app = makeApp();
    const desktopPub = randomPubKey();
    const phonePub = randomPubKey();
    const start = await startSession(app, desktopPub);
    const issuedAt = Date.now();
    const sig = signPairing({ sessionId: start.sessionId, desktopPubKey: desktopPub, phonePubKey: phonePub, issuedAt });

    const res = await app.inject({
      method: "POST",
      url: "/api/desktop/pair/confirm",
      payload: {
        sessionId: start.sessionId,
        userId: "stranger",
        phonePubKey: bytesToHex(phonePub),
        irkSignature: sig,
        issuedAt,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects double-confirm (409)", async () => {
    const app = makeApp();
    const desktopPub = randomPubKey();
    const phonePub = randomPubKey();
    const start = await startSession(app, desktopPub);
    const issuedAt = Date.now();
    const sig = signPairing({ sessionId: start.sessionId, desktopPubKey: desktopPub, phonePubKey: phonePub, issuedAt });
    const payload = {
      sessionId: start.sessionId,
      userId,
      phonePubKey: bytesToHex(phonePub),
      irkSignature: sig,
      issuedAt,
    };
    const first = await app.inject({ method: "POST", url: "/api/desktop/pair/confirm", payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/api/desktop/pair/confirm", payload });
    expect(second.statusCode).toBe(409);
  });
});

describe("inbox/poll relay (opaque to server)", () => {
  async function paired() {
    const app = makeApp();
    const desktopPub = randomPubKey();
    const phonePub = randomPubKey();
    const start = await startSession(app, desktopPub);
    const issuedAt = Date.now();
    const sig = signPairing({ sessionId: start.sessionId, desktopPubKey: desktopPub, phonePubKey: phonePub, issuedAt });
    await app.inject({
      method: "POST",
      url: "/api/desktop/pair/confirm",
      payload: { sessionId: start.sessionId, userId, phonePubKey: bytesToHex(phonePub), irkSignature: sig, issuedAt },
    });
    return { app, sessionId: start.sessionId };
  }

  it("phone posts ciphertext, desktop polls and receives it", async () => {
    const { app, sessionId } = await paired();
    const ct = bytesToHex(new Uint8Array([0xab, 0xcd, 0xef, 0x01, 0x02]));
    await app.inject({
      method: "POST",
      url: "/api/desktop/session/inbox",
      payload: { sessionId, from: "phone", ciphertext: ct },
    });
    const poll = await app.inject({
      method: "GET",
      url: `/api/desktop/session/${sessionId}/poll?for=desktop`,
    });
    expect(poll.statusCode).toBe(200);
    const body = JSON.parse(poll.body);
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].from).toBe("phone");
    expect(body.messages[0].ciphertext).toBe(ct);
  });

  it("messages destined for desktop are not delivered to phone polls and vice versa", async () => {
    const { app, sessionId } = await paired();
    const ct = bytesToHex(new Uint8Array([1, 2, 3]));
    await app.inject({
      method: "POST",
      url: "/api/desktop/session/inbox",
      payload: { sessionId, from: "desktop", ciphertext: ct },
    });
    const desktopPoll = await app.inject({
      method: "GET",
      url: `/api/desktop/session/${sessionId}/poll?for=desktop`,
    });
    expect(JSON.parse(desktopPoll.body).messages.length).toBe(0);

    const phonePoll = await app.inject({
      method: "GET",
      url: `/api/desktop/session/${sessionId}/poll?for=phone`,
    });
    expect(JSON.parse(phonePoll.body).messages.length).toBe(1);
  });

  it("rejects oversized ciphertext blobs", async () => {
    const { app, sessionId } = await paired();
    const huge = "ab".repeat(70_000); // > 64 KiB cap
    const res = await app.inject({
      method: "POST",
      url: "/api/desktop/session/inbox",
      payload: { sessionId, from: "phone", ciphertext: huge },
    });
    expect(res.statusCode).toBe(413);
  });

  it("revoked sessions cannot send/receive", async () => {
    const { app, sessionId } = await paired();
    await app.inject({
      method: "POST",
      url: "/api/desktop/session/revoke",
      payload: { sessionId },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/desktop/session/inbox",
      payload: { sessionId, from: "phone", ciphertext: "ab" },
    });
    expect(res.statusCode).toBe(409);
  });
});
