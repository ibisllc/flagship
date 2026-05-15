import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ed,
  signAppAccessAcceptance,
  type AppAccessAcceptance,
  type Keypair,
} from "@flagship/protocol";
import {
  buildInviteHandler,
  canonicalIssueInvite,
  canonicalRevokeAccess,
  InMemoryAppInviteStore,
  signIssueInvite,
  signRevokeAccess,
} from "../src/inviteHandler.js";

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

function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

function makeReq(method: string, path: string, body?: unknown) {
  return {
    method,
    path,
    headers: { "content-type": "application/json" },
    body: Buffer.from(body === undefined ? "" : JSON.stringify(body)),
  };
}

function fixedRandom(b: Uint8Array): (n: number) => Uint8Array {
  let cursor = 0;
  return (n: number) => {
    if (cursor + n > b.length) {
      // wrap so multiple calls in a test don't run out
      cursor = 0;
    }
    const out = b.subarray(cursor, cursor + n);
    cursor += n;
    return new Uint8Array(out);
  };
}

function issueEnvelope(args: {
  serverFqdn: string;
  appId: string;
  role: string;
  opaqueTag: Uint8Array;
  expectedIrkPubKey?: Uint8Array | null;
  contextNote?: string | null;
  ttlMs?: number;
  issuedAt: number;
  psk: Keypair;
}) {
  const f = {
    serverId: args.serverFqdn,
    appId: args.appId,
    role: args.role,
    opaqueTag: args.opaqueTag,
    expectedIrkPubKey: args.expectedIrkPubKey ?? null,
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
      expectedIrkPubKey: f.expectedIrkPubKey ? bytesToHex(f.expectedIrkPubKey) : null,
      contextNote: f.contextNote,
      ttlMs: f.ttlMs,
      issuedAt: f.issuedAt,
    },
    signature: bytesToHex(sig),
  };
}

function acceptEnvelope(args: {
  inviteId: string;
  secret: Uint8Array;
  consumer: Keypair;
  acceptedAt: number;
}) {
  const acceptance: AppAccessAcceptance = {
    inviteId: args.inviteId,
    secretHash: sha256Hex(args.secret),
    consumerIrkPubKey: args.consumer.publicKey,
    acceptedAt: args.acceptedAt,
    nonce: new Uint8Array([1, 2, 3, 4]),
  };
  const sig = signAppAccessAcceptance(acceptance, args.consumer);
  return {
    request: {
      inviteId: acceptance.inviteId,
      secretHash: acceptance.secretHash,
      consumerIrkPubKey: bytesToHex(acceptance.consumerIrkPubKey),
      acceptedAt: acceptance.acceptedAt,
      nonce: bytesToHex(acceptance.nonce),
    },
    signature: bytesToHex(sig),
  };
}

describe("invite handler — issue → accept → revoke", () => {
  it("happy path: PSK issues, IRK consumes, granted access row exists", async () => {
    const psk = makeKey();
    const consumer = makeKey();
    const store = new InMemoryAppInviteStore();
    const buf = new Uint8Array(256);
    crypto.getRandomValues(buf);
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store,
      randomBytes: fixedRandom(buf),
    });

    const opaqueTag = new Uint8Array(16);
    crypto.getRandomValues(opaqueTag);
    const issued = await handler(
      makeReq(
        "POST",
        `/.flagship/app/${APP_ID}/invite`,
        issueEnvelope({
          serverFqdn: SERVER_FQDN,
          appId: APP_ID,
          role: "reader",
          opaqueTag,
          contextNote: "John (work email)",
          issuedAt: Date.now(),
          psk,
        }),
      ),
    );
    expect(issued?.status).toBe(200);
    const ibody = JSON.parse(String(issued!.body)) as {
      ok: boolean;
      inviteId: string;
      secret: string;
      secretHash: string;
      expiresAt: number;
      contextNote: string;
    };
    expect(ibody.ok).toBe(true);
    expect(ibody.contextNote).toBe("John (work email)");
    expect(ibody.expiresAt).toBeGreaterThan(Date.now());
    expect(ibody.expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000 + 1);

    const secretBytes = new Uint8Array(ibody.secret.length / 2);
    for (let i = 0; i < secretBytes.length; i++) {
      secretBytes[i] = parseInt(ibody.secret.slice(i * 2, i * 2 + 2), 16);
    }

    const accepted = await handler(
      makeReq(
        "POST",
        `/.flagship/app/${APP_ID}/invite/accept`,
        acceptEnvelope({
          inviteId: ibody.inviteId,
          secret: secretBytes,
          consumer,
          acceptedAt: Date.now(),
        }),
      ),
    );
    expect(accepted?.status).toBe(200);
    const abody = JSON.parse(String(accepted!.body)) as {
      ok: boolean;
      role: string;
      sessionToken: string;
    };
    expect(abody.ok).toBe(true);
    expect(abody.role).toBe("reader");
    expect(abody.sessionToken.length).toBe(64);

    // Authorized: access lookup via token returns the row.
    const accRow = await store.findAccessByToken(abody.sessionToken);
    expect(accRow).not.toBeNull();
    expect(accRow!.appId).toBe(APP_ID);
    expect(accRow!.revokedAt).toBeNull();
  });

  it("bearer model: any consumer IRK can redeem when expectedIrkPubKey is null", async () => {
    const psk = makeKey();
    const someConsumer = makeKey();
    const otherConsumer = makeKey();
    const store = new InMemoryAppInviteStore();
    void someConsumer; // we'll deliberately use the OTHER consumer
    const buf = new Uint8Array(256);
    crypto.getRandomValues(buf);
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store,
      randomBytes: fixedRandom(buf),
    });
    const opaqueTag = new Uint8Array(16);
    const issued = await handler(
      makeReq(
        "POST",
        `/.flagship/app/${APP_ID}/invite`,
        issueEnvelope({
          serverFqdn: SERVER_FQDN,
          appId: APP_ID,
          role: "member",
          opaqueTag,
          expectedIrkPubKey: null,
          issuedAt: Date.now(),
          psk,
        }),
      ),
    );
    const ibody = JSON.parse(String(issued!.body)) as { inviteId: string; secret: string };
    const secret = new Uint8Array(ibody.secret.length / 2);
    for (let i = 0; i < secret.length; i++)
      secret[i] = parseInt(ibody.secret.slice(i * 2, i * 2 + 2), 16);
    const accepted = await handler(
      makeReq(
        "POST",
        `/.flagship/app/${APP_ID}/invite/accept`,
        acceptEnvelope({
          inviteId: ibody.inviteId,
          secret,
          consumer: otherConsumer,
          acceptedAt: Date.now(),
        }),
      ),
    );
    expect(accepted?.status).toBe(200);
  });

  it("expectedIrkPubKey enforced: non-matching IRK is rejected", async () => {
    const psk = makeKey();
    const intended = makeKey();
    const attacker = makeKey();
    const store = new InMemoryAppInviteStore();
    const buf = new Uint8Array(256);
    crypto.getRandomValues(buf);
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store,
      randomBytes: fixedRandom(buf),
    });
    const issued = await handler(
      makeReq(
        "POST",
        `/.flagship/app/${APP_ID}/invite`,
        issueEnvelope({
          serverFqdn: SERVER_FQDN,
          appId: APP_ID,
          role: "reader",
          opaqueTag: new Uint8Array(16),
          expectedIrkPubKey: intended.publicKey,
          issuedAt: Date.now(),
          psk,
        }),
      ),
    );
    const ibody = JSON.parse(String(issued!.body)) as { inviteId: string; secret: string };
    const secret = new Uint8Array(ibody.secret.length / 2);
    for (let i = 0; i < secret.length; i++)
      secret[i] = parseInt(ibody.secret.slice(i * 2, i * 2 + 2), 16);
    const reject = await handler(
      makeReq(
        "POST",
        `/.flagship/app/${APP_ID}/invite/accept`,
        acceptEnvelope({
          inviteId: ibody.inviteId,
          secret,
          consumer: attacker,
          acceptedAt: Date.now(),
        }),
      ),
    );
    expect(reject?.status).toBe(403);
    expect(String(reject!.body)).toContain("expectedIrkPubKey");

    // The intended consumer still succeeds.
    const ok = await handler(
      makeReq(
        "POST",
        `/.flagship/app/${APP_ID}/invite/accept`,
        acceptEnvelope({
          inviteId: ibody.inviteId,
          secret,
          consumer: intended,
          acceptedAt: Date.now(),
        }),
      ),
    );
    expect(ok?.status).toBe(200);
  });

  it("single-use enforced: second redemption returns 409", async () => {
    const psk = makeKey();
    const c1 = makeKey();
    const c2 = makeKey();
    const store = new InMemoryAppInviteStore();
    const buf = new Uint8Array(256);
    crypto.getRandomValues(buf);
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store,
      randomBytes: fixedRandom(buf),
    });
    const issued = await handler(
      makeReq(
        "POST",
        `/.flagship/app/${APP_ID}/invite`,
        issueEnvelope({
          serverFqdn: SERVER_FQDN,
          appId: APP_ID,
          role: "reader",
          opaqueTag: new Uint8Array(16),
          issuedAt: Date.now(),
          psk,
        }),
      ),
    );
    const ibody = JSON.parse(String(issued!.body)) as { inviteId: string; secret: string };
    const secret = new Uint8Array(ibody.secret.length / 2);
    for (let i = 0; i < secret.length; i++)
      secret[i] = parseInt(ibody.secret.slice(i * 2, i * 2 + 2), 16);
    const first = await handler(
      makeReq(
        "POST",
        `/.flagship/app/${APP_ID}/invite/accept`,
        acceptEnvelope({ inviteId: ibody.inviteId, secret, consumer: c1, acceptedAt: Date.now() }),
      ),
    );
    expect(first?.status).toBe(200);
    const second = await handler(
      makeReq(
        "POST",
        `/.flagship/app/${APP_ID}/invite/accept`,
        acceptEnvelope({ inviteId: ibody.inviteId, secret, consumer: c2, acceptedAt: Date.now() }),
      ),
    );
    expect(second?.status).toBe(409);
  });

  it("revoke kicks the consumer out", async () => {
    const psk = makeKey();
    const consumer = makeKey();
    const store = new InMemoryAppInviteStore();
    const buf = new Uint8Array(256);
    crypto.getRandomValues(buf);
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store,
      randomBytes: fixedRandom(buf),
    });
    const issued = await handler(
      makeReq(
        "POST",
        `/.flagship/app/${APP_ID}/invite`,
        issueEnvelope({
          serverFqdn: SERVER_FQDN,
          appId: APP_ID,
          role: "reader",
          opaqueTag: new Uint8Array(16),
          issuedAt: Date.now(),
          psk,
        }),
      ),
    );
    const ibody = JSON.parse(String(issued!.body)) as { inviteId: string; secret: string };
    const secret = new Uint8Array(ibody.secret.length / 2);
    for (let i = 0; i < secret.length; i++)
      secret[i] = parseInt(ibody.secret.slice(i * 2, i * 2 + 2), 16);
    await handler(
      makeReq(
        "POST",
        `/.flagship/app/${APP_ID}/invite/accept`,
        acceptEnvelope({ inviteId: ibody.inviteId, secret, consumer, acceptedAt: Date.now() }),
      ),
    );

    const consumerHex = bytesToHex(consumer.publicKey);
    const fields = {
      serverId: SERVER_FQDN,
      appId: APP_ID,
      irkPubKey: consumer.publicKey,
      issuedAt: Date.now(),
    };
    const revSig = signRevokeAccess(fields, psk);
    const revoked = await handler(
      makeReq("POST", `/.flagship/app/${APP_ID}/access/${consumerHex}/revoke`, {
        request: {
          serverId: fields.serverId,
          appId: fields.appId,
          irkPubKey: bytesToHex(fields.irkPubKey),
          issuedAt: fields.issuedAt,
        },
        signature: bytesToHex(revSig),
      }),
    );
    expect(revoked?.status).toBe(200);
    const row = await store.findAccess(APP_ID, consumerHex);
    expect(row).not.toBeNull();
    expect(row!.revokedAt).not.toBeNull();
  });

  it("rejects mismatched serverId on issue", async () => {
    const psk = makeKey();
    const store = new InMemoryAppInviteStore();
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store,
    });
    const env = issueEnvelope({
      serverFqdn: "other.alice.flagship.services",
      appId: APP_ID,
      role: "reader",
      opaqueTag: new Uint8Array(16),
      issuedAt: Date.now(),
      psk,
    });
    const r = await handler(makeReq("POST", `/.flagship/app/${APP_ID}/invite`, env));
    expect(r?.status).toBe(403);
    expect(String(r!.body)).toContain("serverId");
  });

  it("rejects forged PSK signature on issue", async () => {
    const psk = makeKey();
    const attacker = makeKey();
    const store = new InMemoryAppInviteStore();
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store,
    });
    const env = issueEnvelope({
      serverFqdn: SERVER_FQDN,
      appId: APP_ID,
      role: "reader",
      opaqueTag: new Uint8Array(16),
      issuedAt: Date.now(),
      psk: attacker,
    });
    const r = await handler(makeReq("POST", `/.flagship/app/${APP_ID}/invite`, env));
    expect(r?.status).toBe(403);
    expect(String(r!.body)).toContain("invalid signature");
  });

  it("rejects acceptance against unknown invite", async () => {
    const psk = makeKey();
    const consumer = makeKey();
    const store = new InMemoryAppInviteStore();
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store,
    });
    const r = await handler(
      makeReq(
        "POST",
        `/.flagship/app/${APP_ID}/invite/accept`,
        acceptEnvelope({
          inviteId: "x".repeat(32),
          secret: new Uint8Array(32),
          consumer,
          acceptedAt: Date.now(),
        }),
      ),
    );
    expect(r?.status).toBe(404);
  });

  it("isKnownApp gate returns 404 for unknown app", async () => {
    const psk = makeKey();
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store: new InMemoryAppInviteStore(),
      isKnownApp: (id) => id === APP_ID,
    });
    const r = await handler(makeReq("POST", `/.flagship/app/nope-app/invite`, {}));
    expect(r?.status).toBe(404);
  });

  it("returns null for paths the handler doesn't own (chain fallthrough)", async () => {
    const psk = makeKey();
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store: new InMemoryAppInviteStore(),
    });
    expect(await handler(makeReq("GET", "/api/health"))).toBeNull();
    expect(await handler(makeReq("POST", "/some/other/path"))).toBeNull();
  });

  it("GET /invite serves the consumer-facing HTML page", async () => {
    const psk = makeKey();
    const handler = buildInviteHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      store: new InMemoryAppInviteStore(),
    });
    const r = await handler(makeReq("GET", "/invite"));
    expect(r?.status).toBe(200);
    expect(String(r!.headers!["content-type"])).toContain("text/html");
    const body = String(r!.body);
    // #83.3: contextNote rendered (page reads from fragment)
    expect(body).toContain("flagshipSignAcceptance");
    expect(body).toContain("/.flagship/app/");
    // Single-use bearer-model caution
    expect(body.toLowerCase()).toContain("single-use");
  });

  it("canonical envelope round-trips through sign/verify", () => {
    const psk = makeKey();
    const fields = {
      serverId: SERVER_FQDN,
      appId: APP_ID,
      role: "admin",
      opaqueTag: new Uint8Array(16).fill(7),
      expectedIrkPubKey: null,
      contextNote: "test",
      ttlMs: 3600_000,
      issuedAt: 1234567890,
    };
    const sig = signIssueInvite(fields, psk);
    const canonical = canonicalIssueInvite(fields);
    expect(ed.verify(sig, canonical, psk.publicKey)).toBe(true);

    const revF = {
      serverId: SERVER_FQDN,
      appId: APP_ID,
      irkPubKey: new Uint8Array(32).fill(3),
      issuedAt: 1234567890,
    };
    const revSig = signRevokeAccess(revF, psk);
    expect(ed.verify(revSig, canonicalRevokeAccess(revF), psk.publicKey)).toBe(true);
  });
});
