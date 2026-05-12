import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ed,
  signAppAccessAcceptance,
  type AppAccessAcceptance,
  type Keypair,
} from "@flagship/protocol";
import {
  buildAccessModeHandler,
  canonicalAccessMode,
  denialResponse,
  evaluateAccess,
  InMemoryAccessModeStore,
  signAccessMode,
} from "../src/appAccessGate.js";
import {
  buildInviteHandler,
  InMemoryAppInviteStore,
  signIssueInvite,
} from "../src/inviteHandler.js";

const SERVER_FQDN = "home.alice.flagship.services";
const APP_ID = "alice--chat";

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

async function mintAccessToken(
  inviteStore: InMemoryAppInviteStore,
  psk: Keypair,
  consumer: Keypair,
): Promise<string> {
  const buf = new Uint8Array(256);
  crypto.getRandomValues(buf);
  let cursor = 0;
  const rand = (n: number) => {
    if (cursor + n > buf.length) cursor = 0;
    const out = buf.subarray(cursor, cursor + n);
    cursor += n;
    return new Uint8Array(out);
  };
  const handler = buildInviteHandler({
    serverFqdn: SERVER_FQDN,
    pskPub: psk.publicKey,
    store: inviteStore,
    randomBytes: rand,
  });
  const issueFields = {
    serverId: SERVER_FQDN,
    appId: APP_ID,
    role: "reader",
    opaqueTag: new Uint8Array(16),
    expectedIrkPubKey: null,
    contextNote: null,
    ttlMs: 24 * 60 * 60_000,
    issuedAt: Date.now(),
  };
  const issueSig = signIssueInvite(issueFields, psk);
  const issuedR = await handler(
    makeReq("POST", `/.flagship/app/${APP_ID}/invite`, {
      request: {
        serverId: issueFields.serverId,
        appId: issueFields.appId,
        role: issueFields.role,
        opaqueTag: bytesToHex(issueFields.opaqueTag),
        expectedIrkPubKey: null,
        contextNote: null,
        ttlMs: issueFields.ttlMs,
        issuedAt: issueFields.issuedAt,
      },
      signature: bytesToHex(issueSig),
    }),
  );
  const ib = JSON.parse(String(issuedR!.body)) as {
    inviteId: string;
    secret: string;
    secretHash: string;
  };
  const secret = Buffer.from(ib.secret, "hex");
  const acceptance: AppAccessAcceptance = {
    inviteId: ib.inviteId,
    secretHash: sha256Hex(secret),
    consumerIrkPubKey: consumer.publicKey,
    acceptedAt: Date.now(),
    nonce: new Uint8Array([1, 2, 3, 4]),
  };
  const accSig = signAppAccessAcceptance(acceptance, consumer);
  const accR = await handler(
    makeReq("POST", `/.flagship/app/${APP_ID}/invite/accept`, {
      request: {
        inviteId: acceptance.inviteId,
        secretHash: acceptance.secretHash,
        consumerIrkPubKey: bytesToHex(acceptance.consumerIrkPubKey),
        acceptedAt: acceptance.acceptedAt,
        nonce: bytesToHex(acceptance.nonce),
      },
      signature: bytesToHex(accSig),
    }),
  );
  const ab = JSON.parse(String(accR!.body)) as { sessionToken: string };
  return ab.sessionToken;
}

describe("appAccessGate.evaluateAccess (#84)", () => {
  it("public mode: unauthenticated request passes", async () => {
    const inviteStore = new InMemoryAppInviteStore();
    const modeStore = new InMemoryAccessModeStore();
    const decision = await evaluateAccess({
      appId: APP_ID,
      modeStore,
      inviteStore,
      headers: {},
    });
    expect(decision.pass).toBe(true);
    expect(decision.matched).toBeNull();
  });

  it("protected mode: unauthenticated request is denied (403)", async () => {
    const inviteStore = new InMemoryAppInviteStore();
    const modeStore = new InMemoryAccessModeStore();
    await modeStore.set(APP_ID, true);
    const decision = await evaluateAccess({
      appId: APP_ID,
      modeStore,
      inviteStore,
      headers: {},
    });
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain("session token required");

    const resp = denialResponse(decision, { accept: "application/json" });
    expect(resp.status).toBe(403);
    const body = JSON.parse(String(resp.body));
    expect(body.error).toContain("session token");
  });

  it("protected mode: HTML 403 includes /invite hint", async () => {
    const decision = {
      pass: false,
      reason: "session token required",
      matched: null,
    };
    const r = denialResponse(decision, { accept: "text/html,application/xhtml+xml" });
    expect(r.status).toBe(403);
    expect(String(r.body)).toContain("/invite");
    expect(String(r.body).toLowerCase()).toContain("protect content");
  });

  it("protected mode: valid Authorization header passes", async () => {
    const psk = makeKey();
    const consumer = makeKey();
    const inviteStore = new InMemoryAppInviteStore();
    const modeStore = new InMemoryAccessModeStore();
    await modeStore.set(APP_ID, true);
    const token = await mintAccessToken(inviteStore, psk, consumer);

    const decision = await evaluateAccess({
      appId: APP_ID,
      modeStore,
      inviteStore,
      headers: { authorization: `Flagship-App-Session ${token}` },
    });
    expect(decision.pass).toBe(true);
    expect(decision.matched?.appId).toBe(APP_ID);
    expect(decision.matched?.role).toBe("reader");
  });

  it("protected mode: valid cookie passes", async () => {
    const psk = makeKey();
    const consumer = makeKey();
    const inviteStore = new InMemoryAppInviteStore();
    const modeStore = new InMemoryAccessModeStore();
    await modeStore.set(APP_ID, true);
    const token = await mintAccessToken(inviteStore, psk, consumer);

    const decision = await evaluateAccess({
      appId: APP_ID,
      modeStore,
      inviteStore,
      headers: { cookie: `other=foo; Flagship-App-Session=${token}; trailing=bar` },
    });
    expect(decision.pass).toBe(true);
  });

  it("protected mode: token bound to a different app is denied", async () => {
    const psk = makeKey();
    const consumer = makeKey();
    const inviteStore = new InMemoryAppInviteStore();
    const modeStore = new InMemoryAccessModeStore();
    await modeStore.set(APP_ID, true);
    await modeStore.set("alice--photos", true);
    const token = await mintAccessToken(inviteStore, psk, consumer);

    const decision = await evaluateAccess({
      appId: "alice--photos",
      modeStore,
      inviteStore,
      headers: { authorization: `Flagship-App-Session ${token}` },
    });
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain("different app");
  });

  it("protected mode: revoked access row is denied", async () => {
    const psk = makeKey();
    const consumer = makeKey();
    const inviteStore = new InMemoryAppInviteStore();
    const modeStore = new InMemoryAccessModeStore();
    await modeStore.set(APP_ID, true);
    const token = await mintAccessToken(inviteStore, psk, consumer);

    await inviteStore.revokeAccess({
      appId: APP_ID,
      irkPubHex: bytesToHex(consumer.publicKey),
      revokedAt: Date.now(),
    });

    const decision = await evaluateAccess({
      appId: APP_ID,
      modeStore,
      inviteStore,
      headers: { authorization: `Flagship-App-Session ${token}` },
    });
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain("revoked");
  });

  it("protected mode: unknown token is denied", async () => {
    const inviteStore = new InMemoryAppInviteStore();
    const modeStore = new InMemoryAccessModeStore();
    await modeStore.set(APP_ID, true);
    const decision = await evaluateAccess({
      appId: APP_ID,
      modeStore,
      inviteStore,
      headers: { authorization: `Flagship-App-Session ${"00".repeat(32)}` },
    });
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain("unknown");
  });
});

describe("appAccessGate /access-mode handler (#84)", () => {
  it("PSK-signed flip false → true updates the store and warns about active sessions", async () => {
    const psk = makeKey();
    const consumer = makeKey();
    const inviteStore = new InMemoryAppInviteStore();
    const modeStore = new InMemoryAccessModeStore();
    // Mint two access rows to simulate "users already in the app".
    await mintAccessToken(inviteStore, psk, consumer);
    await mintAccessToken(inviteStore, psk, makeKey());

    const handler = buildAccessModeHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      modeStore,
      inviteStore,
    });
    const fields = {
      serverId: SERVER_FQDN,
      appId: APP_ID,
      protectContent: true,
      issuedAt: Date.now(),
    };
    const sig = signAccessMode(fields, psk);
    const r = await handler(
      makeReq("POST", `/.flagship/app/${APP_ID}/access-mode`, {
        request: fields,
        signature: bytesToHex(sig),
      }),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(String(r!.body));
    expect(body.protectContent).toBe(true);
    expect(body.prior).toBe(false);
    expect(body.warning).toEqual({ activeSessions: 2 });
    expect(await modeStore.get(APP_ID)).toBe(true);
  });

  it("PSK-signed flip true → false does not warn (no anonymous loss)", async () => {
    const psk = makeKey();
    const inviteStore = new InMemoryAppInviteStore();
    const modeStore = new InMemoryAccessModeStore();
    await modeStore.set(APP_ID, true);
    const handler = buildAccessModeHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      modeStore,
      inviteStore,
    });
    const fields = {
      serverId: SERVER_FQDN,
      appId: APP_ID,
      protectContent: false,
      issuedAt: Date.now(),
    };
    const sig = signAccessMode(fields, psk);
    const r = await handler(
      makeReq("POST", `/.flagship/app/${APP_ID}/access-mode`, {
        request: fields,
        signature: bytesToHex(sig),
      }),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(String(r!.body));
    expect(body.protectContent).toBe(false);
    expect(body.prior).toBe(true);
    expect(body.warning).toBeUndefined();
  });

  it("rejects an unsigned flip (forged PSK)", async () => {
    const psk = makeKey();
    const attacker = makeKey();
    const handler = buildAccessModeHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      modeStore: new InMemoryAccessModeStore(),
      inviteStore: new InMemoryAppInviteStore(),
    });
    const fields = {
      serverId: SERVER_FQDN,
      appId: APP_ID,
      protectContent: true,
      issuedAt: Date.now(),
    };
    const sig = signAccessMode(fields, attacker);
    const r = await handler(
      makeReq("POST", `/.flagship/app/${APP_ID}/access-mode`, {
        request: fields,
        signature: bytesToHex(sig),
      }),
    );
    expect(r?.status).toBe(403);
  });

  it("rejects mismatched serverId / appId", async () => {
    const psk = makeKey();
    const handler = buildAccessModeHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      modeStore: new InMemoryAccessModeStore(),
      inviteStore: new InMemoryAppInviteStore(),
    });
    const wrongServer = {
      serverId: "evil.alice.flagship.services",
      appId: APP_ID,
      protectContent: true,
      issuedAt: Date.now(),
    };
    const r1 = await handler(
      makeReq("POST", `/.flagship/app/${APP_ID}/access-mode`, {
        request: wrongServer,
        signature: bytesToHex(signAccessMode(wrongServer, psk)),
      }),
    );
    expect(r1?.status).toBe(403);

    const wrongApp = {
      serverId: SERVER_FQDN,
      appId: "different--app",
      protectContent: true,
      issuedAt: Date.now(),
    };
    const r2 = await handler(
      makeReq("POST", `/.flagship/app/${APP_ID}/access-mode`, {
        request: wrongApp,
        signature: bytesToHex(signAccessMode(wrongApp, psk)),
      }),
    );
    expect(r2?.status).toBe(400);
  });

  it("rejects stale issuedAt", async () => {
    const psk = makeKey();
    const handler = buildAccessModeHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      modeStore: new InMemoryAccessModeStore(),
      inviteStore: new InMemoryAppInviteStore(),
    });
    const fields = {
      serverId: SERVER_FQDN,
      appId: APP_ID,
      protectContent: true,
      issuedAt: Date.now() - 10 * 60_000,
    };
    const r = await handler(
      makeReq("POST", `/.flagship/app/${APP_ID}/access-mode`, {
        request: fields,
        signature: bytesToHex(signAccessMode(fields, psk)),
      }),
    );
    expect(r?.status).toBe(403);
    expect(String(r!.body)).toContain("stale");
  });

  it("returns null for paths it doesn't own", async () => {
    const psk = makeKey();
    const handler = buildAccessModeHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      modeStore: new InMemoryAccessModeStore(),
      inviteStore: new InMemoryAppInviteStore(),
    });
    expect(await handler(makeReq("POST", "/api/health"))).toBeNull();
    expect(await handler(makeReq("GET", `/.flagship/app/${APP_ID}/access-mode`))).toBeNull();
  });

  it("end-to-end: toggle authoritatively flips access decision", async () => {
    const psk = makeKey();
    const consumer = makeKey();
    const inviteStore = new InMemoryAppInviteStore();
    const modeStore = new InMemoryAccessModeStore();
    const token = await mintAccessToken(inviteStore, psk, consumer);

    // 1. Public default: anonymous request passes; even an unknown
    //    token passes because the gate is off.
    const before = await evaluateAccess({
      appId: APP_ID,
      modeStore,
      inviteStore,
      headers: {},
    });
    expect(before.pass).toBe(true);

    // 2. Flip ON.
    const handler = buildAccessModeHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      modeStore,
      inviteStore,
    });
    const fields = {
      serverId: SERVER_FQDN,
      appId: APP_ID,
      protectContent: true,
      issuedAt: Date.now(),
    };
    const flip = await handler(
      makeReq("POST", `/.flagship/app/${APP_ID}/access-mode`, {
        request: fields,
        signature: bytesToHex(signAccessMode(fields, psk)),
      }),
    );
    expect(flip?.status).toBe(200);

    // 3. Anonymous now denied.
    const anon = await evaluateAccess({
      appId: APP_ID,
      modeStore,
      inviteStore,
      headers: {},
    });
    expect(anon.pass).toBe(false);

    // 4. Authenticated still passes.
    const authed = await evaluateAccess({
      appId: APP_ID,
      modeStore,
      inviteStore,
      headers: { authorization: `Flagship-App-Session ${token}` },
    });
    expect(authed.pass).toBe(true);

    // 5. Flip back OFF.
    const fields2 = { ...fields, protectContent: false, issuedAt: Date.now() };
    const flip2 = await handler(
      makeReq("POST", `/.flagship/app/${APP_ID}/access-mode`, {
        request: fields2,
        signature: bytesToHex(signAccessMode(fields2, psk)),
      }),
    );
    expect(flip2?.status).toBe(200);

    // 6. Anonymous passes again.
    const after = await evaluateAccess({
      appId: APP_ID,
      modeStore,
      inviteStore,
      headers: {},
    });
    expect(after.pass).toBe(true);
  });

  it("canonical access-mode is sign/verify round-trippable", () => {
    const psk = makeKey();
    const fields = {
      serverId: SERVER_FQDN,
      appId: APP_ID,
      protectContent: true,
      issuedAt: 1234567890,
    };
    const sig = signAccessMode(fields, psk);
    expect(ed.verify(sig, canonicalAccessMode(fields), psk.publicKey)).toBe(true);
  });
});
