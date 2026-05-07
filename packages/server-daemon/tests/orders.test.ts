import { describe, expect, it } from "vitest";
import { ed, signPhoneOrder, type Keypair, type PhoneOrder } from "@flagship/protocol";
import { buildOrdersHandler, type OrderExecutor } from "../src/orders.js";

const SERVER_FQDN = "home.alice.flagship.services";

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

function envelope(order: PhoneOrder, psk: Keypair): { request: unknown; signature: string } {
  const sig = signPhoneOrder(order, psk);
  // Re-shape for wire format: hex-encode any byte fields.
  const r: Record<string, unknown> = { ...order };
  if ("newIdentityPubKey" in order) r.newIdentityPubKey = bytesToHex(order.newIdentityPubKey);
  if ("bakPubKey" in order) r.bakPubKey = bytesToHex(order.bakPubKey);
  return { request: r, signature: bytesToHex(sig) };
}

function makeReq(body: unknown) {
  return {
    method: "POST",
    path: "/api/orders-from-user",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

describe("orders-from-user handler", () => {
  it("accepts a valid noop", async () => {
    const psk = makeKey();
    const calls: string[] = [];
    const ex: OrderExecutor = { noop: () => void calls.push("noop") };
    const h = buildOrdersHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, executor: ex });
    const order: PhoneOrder = { type: "noop", serverId: SERVER_FQDN, issuedAt: Date.now() };
    const r = await h(makeReq(envelope(order, psk)));
    expect(r.status).toBe(200);
    expect(calls).toEqual(["noop"]);
  });

  it("dispatches set-backup-policy with the enabled flag", async () => {
    const psk = makeKey();
    let captured: { enabled?: boolean } = {};
    const ex: OrderExecutor = { setBackupPolicy: ({ enabled }) => void (captured = { enabled }) };
    const h = buildOrdersHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, executor: ex });
    const order: PhoneOrder = {
      type: "set-backup-policy",
      serverId: SERVER_FQDN,
      enabled: true,
      issuedAt: Date.now(),
    };
    const r = await h(makeReq(envelope(order, psk)));
    expect(r.status).toBe(200);
    expect(captured).toEqual({ enabled: true });
  });

  it("set-backup-policy actually toggles a real BackupLoop", async () => {
    const { BackupLoop } = await import("../src/backupLoop.js");
    const psk = makeKey();
    const swk = new Uint8Array(32);
    crypto.getRandomValues(swk);
    const loop = new BackupLoop({ swk, k: 3, n: 5 });
    expect(loop.status().enabled).toBe(false);

    const ex: OrderExecutor = {
      setBackupPolicy: ({ enabled }) => loop.setEnabled(enabled),
    };
    const h = buildOrdersHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, executor: ex });

    // Enable
    let r = await h(
      makeReq(
        envelope(
          { type: "set-backup-policy", serverId: SERVER_FQDN, enabled: true, issuedAt: Date.now() },
          psk,
        ),
      ),
    );
    expect(r.status).toBe(200);
    expect(loop.status().enabled).toBe(true);

    // Disable
    r = await h(
      makeReq(
        envelope(
          { type: "set-backup-policy", serverId: SERVER_FQDN, enabled: false, issuedAt: Date.now() },
          psk,
        ),
      ),
    );
    expect(r.status).toBe(200);
    expect(loop.status().enabled).toBe(false);
  });

  it("rejects an invalid signature (403)", async () => {
    const psk = makeKey();
    const attacker = makeKey();
    const ex: OrderExecutor = {};
    const h = buildOrdersHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, executor: ex });
    const order: PhoneOrder = { type: "noop", serverId: SERVER_FQDN, issuedAt: Date.now() };
    const r = await h(makeReq(envelope(order, attacker)));
    expect(r.status).toBe(403);
  });

  it("rejects an order for a different server (403)", async () => {
    const psk = makeKey();
    const h = buildOrdersHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      executor: {},
    });
    const order: PhoneOrder = {
      type: "noop",
      serverId: "home.bob.flagship.services",
      issuedAt: Date.now(),
    };
    const r = await h(makeReq(envelope(order, psk)));
    expect(r.status).toBe(403);
  });

  it("rejects a stale request (403)", async () => {
    const psk = makeKey();
    const h = buildOrdersHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      executor: {},
      maxAgeMs: 1000,
    });
    const order: PhoneOrder = { type: "noop", serverId: SERVER_FQDN, issuedAt: Date.now() - 60_000 };
    const r = await h(makeReq(envelope(order, psk)));
    expect(r.status).toBe(403);
  });

  it("rejects a captured noop replayed as a different order type", async () => {
    // Sign a noop, but submit an envelope claiming type=shut-down with the
    // same signature. Canonical bytes differ → verify must fail.
    const psk = makeKey();
    const h = buildOrdersHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, executor: {} });
    const noop: PhoneOrder = { type: "noop", serverId: SERVER_FQDN, issuedAt: Date.now() };
    const env = envelope(noop, psk);
    const tampered = { request: { ...(env.request as Record<string, unknown>), type: "shut-down" }, signature: env.signature };
    const r = await h(makeReq(tampered));
    expect(r.status).toBe(403);
  });

  it("returns 500 with a clear message when the executor throws", async () => {
    const psk = makeKey();
    const ex: OrderExecutor = {
      shutDown: () => {
        throw new Error("nope");
      },
    };
    const h = buildOrdersHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, executor: ex });
    const order: PhoneOrder = { type: "shut-down", serverId: SERVER_FQDN, issuedAt: Date.now() };
    const r = await h(makeReq(envelope(order, psk)));
    expect(r.status).toBe(500);
    const body = JSON.parse(String(r.body));
    expect(body.error).toBe("executor failed");
    expect(body.message).toBe("nope");
  });

  it("405 for non-POST requests", async () => {
    const psk = makeKey();
    const h = buildOrdersHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, executor: {} });
    const r = await h({ method: "GET", path: "/api/orders-from-user", headers: {}, body: Buffer.alloc(0) });
    expect(r.status).toBe(405);
  });

  it("dispatches browser-input-response (PSK-signed; daemon validates + pipes via CDP)", async () => {
    const psk = makeKey();
    let captured: {
      tabId?: string;
      inputKind?: string;
      value?: string;
      screenshotRef?: string;
    } = {};
    const ex: OrderExecutor = {
      browserInputResponse: (a) => void (captured = a),
    };
    const h = buildOrdersHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, executor: ex });
    const order: PhoneOrder = {
      type: "browser-input-response",
      serverId: SERVER_FQDN,
      tabId: "tab-abc-123",
      inputKind: "password",
      value: "hunter2!@#",
      screenshotRef: "shot-7f3a",
      issuedAt: Date.now(),
    };
    const r = await h(makeReq(envelope(order, psk)));
    expect(r.status).toBe(200);
    expect(captured).toEqual({
      tabId: "tab-abc-123",
      inputKind: "password",
      value: "hunter2!@#",
      screenshotRef: "shot-7f3a",
    });
  });

  it("rejects browser-input-response with an invalid inputKind", async () => {
    const psk = makeKey();
    const h = buildOrdersHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      executor: { browserInputResponse: () => {} },
    });
    // Build the order envelope manually so we can corrupt inputKind without
    // tripping our typed constructor.
    const wire = {
      request: {
        type: "browser-input-response",
        serverId: SERVER_FQDN,
        tabId: "t1",
        inputKind: "exec-arbitrary-code",
        value: "x",
        screenshotRef: "s1",
        issuedAt: Date.now(),
      },
      signature: "00".repeat(64),
    };
    const r = await h(makeReq(wire));
    expect(r.status).toBe(400);
  });

  it("rejects browser-input-response when the executor doesn't implement it", async () => {
    const psk = makeKey();
    const h = buildOrdersHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, executor: {} });
    const order: PhoneOrder = {
      type: "browser-input-response",
      serverId: SERVER_FQDN,
      tabId: "t1",
      inputKind: "otp",
      value: "123456",
      screenshotRef: "s1",
      issuedAt: Date.now(),
    };
    const r = await h(makeReq(envelope(order, psk)));
    // 500 because dispatch reaches a "not implemented" branch — the
    // signature was valid; the daemon just isn't wired for browser yet.
    expect(r.status).toBe(500);
  });

  it("captured browser-input-response signature does NOT verify if value is changed mid-flight", async () => {
    const psk = makeKey();
    const order: PhoneOrder = {
      type: "browser-input-response",
      serverId: SERVER_FQDN,
      tabId: "t1",
      inputKind: "password",
      value: "original",
      screenshotRef: "s1",
      issuedAt: Date.now(),
    };
    const env = envelope(order, psk);
    // Tamper with value after signing.
    (env.request as Record<string, unknown>).value = "tampered";
    const h = buildOrdersHandler({
      serverFqdn: SERVER_FQDN,
      pskPub: psk.publicKey,
      executor: { browserInputResponse: () => {} },
    });
    const r = await h(makeReq(env));
    expect(r.status).toBe(403);
    const body = JSON.parse(String(r.body));
    expect(body.error).toBe("invalid signature");
  });

  it("dispatches add-subscriber with appId + fqdn", async () => {
    const psk = makeKey();
    const calls: Array<{ appId: string; fqdn: string }> = [];
    const ex: OrderExecutor = {
      addSubscriber: (a) => {
        calls.push(a);
      },
    };
    const h = buildOrdersHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, executor: ex });
    const order: PhoneOrder = {
      type: "add-subscriber",
      serverId: SERVER_FQDN,
      appId: "alice--game1",
      fqdn: "home.bob.flagship.services",
      issuedAt: Date.now(),
    };
    const r = await h(makeReq(envelope(order, psk)));
    expect(r.status).toBe(200);
    expect(calls).toEqual([{ appId: "alice--game1", fqdn: "home.bob.flagship.services" }]);
  });

  it("dispatches remove-subscriber", async () => {
    const psk = makeKey();
    const calls: Array<{ appId: string; fqdn: string }> = [];
    const ex: OrderExecutor = {
      removeSubscriber: (a) => {
        calls.push(a);
      },
    };
    const h = buildOrdersHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, executor: ex });
    const order: PhoneOrder = {
      type: "remove-subscriber",
      serverId: SERVER_FQDN,
      appId: "alice--game1",
      fqdn: "home.bob.flagship.services",
      issuedAt: Date.now(),
    };
    const r = await h(makeReq(envelope(order, psk)));
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("dispatches add-paired-session with token + label", async () => {
    const psk = makeKey();
    const calls: Array<{ token: string; label: string }> = [];
    const ex: OrderExecutor = {
      addPairedSession: (a) => {
        calls.push(a);
      },
    };
    const h = buildOrdersHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, executor: ex });
    const order: PhoneOrder = {
      type: "add-paired-session",
      serverId: SERVER_FQDN,
      token: "a".repeat(64),
      label: "Harry's iPhone",
      issuedAt: Date.now(),
    };
    const r = await h(makeReq(envelope(order, psk)));
    expect(r.status).toBe(200);
    expect(calls[0]?.label).toBe("Harry's iPhone");
  });

  it("dispatches remove-paired-session", async () => {
    const psk = makeKey();
    const calls: Array<{ token: string }> = [];
    const ex: OrderExecutor = {
      removePairedSession: (a) => {
        calls.push(a);
      },
    };
    const h = buildOrdersHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, executor: ex });
    const order: PhoneOrder = {
      type: "remove-paired-session",
      serverId: SERVER_FQDN,
      token: "b".repeat(64),
      issuedAt: Date.now(),
    };
    const r = await h(makeReq(envelope(order, psk)));
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("dispatches backup-app, password optional", async () => {
    const psk = makeKey();
    const calls: Array<{
      creator: string;
      slug: string;
      includeUserData: boolean;
      password?: string;
    }> = [];
    const ex: OrderExecutor = {
      backupApp: async (a) => {
        calls.push(a);
      },
    };
    const h = buildOrdersHandler({ serverFqdn: SERVER_FQDN, pskPub: psk.publicKey, executor: ex });
    const o1: PhoneOrder = {
      type: "backup-app",
      serverId: SERVER_FQDN,
      creator: "alice",
      slug: "habits",
      includeUserData: true,
      password: "secret",
      issuedAt: Date.now(),
    };
    const r1 = await h(makeReq(envelope(o1, psk)));
    expect(r1.status).toBe(200);
    expect(calls[0]).toEqual({
      creator: "alice",
      slug: "habits",
      includeUserData: true,
      password: "secret",
    });
    // Sanity: no password works too
    const o2: PhoneOrder = {
      type: "backup-app",
      serverId: SERVER_FQDN,
      creator: "alice",
      slug: "habits",
      includeUserData: false,
      issuedAt: Date.now() + 1,
    };
    const r2 = await h(makeReq(envelope(o2, psk)));
    expect(r2.status).toBe(200);
    expect(calls[1]?.password).toBeUndefined();
  });
});
