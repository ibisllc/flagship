/**
 * New-box migration consumer (docs/server-migration.md) against a REAL
 * in-memory `.com` — the fake fetch routes straight into the actual
 * control-plane handlers, so the consumer's drive-through exercises the same
 * state machine production hits (attach → pre-seed → freeze wait → final
 * delta → take-over), including the server-side invariant rejections.
 */
import { describe, expect, it } from "vitest";
import {
  ed,
  signDeviceEndpointClaim,
  signServerDecommission,
  signServerMigrationOrder,
  type DeviceEndpointClaim,
  type Keypair,
  type ServerDecommission,
  type ServerMigrationOrder,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleGetMigration,
  handleGetMigrationAssignment,
  handlePostEpochComplete,
  handlePostMigrationAbort,
  handlePostMigrationAttach,
  handlePostMigrationConfirmReady,
  handlePostMigrationFreeze,
  handlePostMigrationPreSeeded,
  handlePostMigrationStart,
  handlePostMigrationTakeOver,
  type ServerMigrationDeps,
} from "@flagship/control-plane";
import {
  buildMigrationPoller,
  decodeAndVerifyMigrationOrder,
  memoryMigrationMarkerStore,
  pollMigrationAwareHandoffConfirm,
  runMigrationConsumer,
  type MigrationRestoreResult,
  type RunMigrationConsumerOptions,
} from "../src/migrationConsumer.js";

const HOST = "home.alice.flagship.services";
const NEW_POD = "attic.alice.flagship.services";
const USERNAME = "alice";
const BASE = "https://com.test";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function rand(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

interface World {
  storage: InMemoryStorage;
  irk: Keypair;
  oldStk: Keypair;
  newStk: Keypair;
  deps: ServerMigrationDeps;
  fetchImpl: typeof fetch;
}

async function setup(): Promise<World> {
  const storage = new InMemoryStorage();
  const irk = makeKey();
  const oldStk = makeKey();
  const newStk = makeKey();
  await storage.usernames.put({ username: USERNAME, irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  await storage.servers.put({
    serverDomain: HOST,
    username: USERNAME,
    identityPubKeyHex: hex(oldStk.publicKey),
    registeredAt: 2,
  });
  await storage.servers.put({
    serverDomain: NEW_POD,
    username: USERNAME,
    identityPubKeyHex: hex(newStk.publicKey),
    registeredAt: 3,
  });
  const deps: ServerMigrationDeps = {
    servers: storage.servers,
    usernames: storage.usernames,
    serverMigrations: storage.serverMigrations,
    serverEvictions: storage.serverEvictions,
    mailbox: {
      servers: storage.servers,
      usernames: storage.usernames,
      secretMailbox: storage.secretMailbox,
      boxSealedLeases: storage.boxSealedLeases,
    },
  };

  // A tiny in-proc `.com`: route the consumer's fetches into the REAL handlers.
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    const respond = (r: { status: number; body: unknown }) =>
      new Response(JSON.stringify(r.body), { status: r.status });

    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/api\/server\/([^/]+)\/migration-assignment$/)) && method === "GET") {
      return respond(await handleGetMigrationAssignment(deps, decodeURIComponent(m[1]!)));
    }
    if ((m = path.match(/^\/api\/server\/([^/]+)\/migration$/)) && method === "GET") {
      return respond(await handleGetMigration(deps, decodeURIComponent(m[1]!)));
    }
    if ((m = path.match(/^\/api\/server\/([^/]+)\/migration\/attach$/)) && method === "POST") {
      return respond(await handlePostMigrationAttach(deps, decodeURIComponent(m[1]!), body));
    }
    if ((m = path.match(/^\/api\/server\/([^/]+)\/migration\/pre-seeded$/)) && method === "POST") {
      return respond(await handlePostMigrationPreSeeded(deps, decodeURIComponent(m[1]!), body));
    }
    if ((m = path.match(/^\/api\/server\/([^/]+)\/migration\/take-over$/)) && method === "POST") {
      return respond(await handlePostMigrationTakeOver(deps, decodeURIComponent(m[1]!), body));
    }
    throw new Error(`unrouted ${method} ${path}`);
  }) as typeof fetch;

  return { storage, irk, oldStk, newStk, deps, fetchImpl };
}

function mailboxAuth(irk: Keypair) {
  const issuedAt = Date.now();
  const nonce = rand(32);
  const claim: DeviceEndpointClaim = {
    username: USERNAME,
    endpointLabel: "phone",
    phoneIrkPub: irk.publicKey,
    issuedAt,
    expiresAt: issuedAt + 120_000,
    nonce,
  };
  const sig = signDeviceEndpointClaim(claim, irk);
  return {
    auth: {
      username: USERNAME,
      endpointLabel: "phone",
      phoneIrkPub: hex(irk.publicKey),
      issuedAt,
      expiresAt: issuedAt + 120_000,
      nonce: hex(nonce),
    },
    authSignature: hex(sig),
  };
}

/** Phone-side actions driven directly against the handlers. */
async function phoneInitiate(w: World): Promise<void> {
  const order: ServerMigrationOrder = {
    serverDomain: HOST,
    oldStkPubHex: hex(w.oldStk.publicKey),
    diskDisposition: "wipe-after-handoff",
    nonce: hex(rand(32)),
    issuedAt: Date.now(),
  };
  const sig = signServerMigrationOrder(order, w.irk);
  const res = await handlePostMigrationStart(w.deps, HOST, {
    ...mailboxAuth(w.irk),
    order,
    signature: hex(sig),
  });
  expect(res.status).toBe(200);
}

async function phoneConfirmReady(w: World): Promise<void> {
  const control = { serverDomain: HOST, action: "confirm-ready" as const, nonce: hex(rand(32)), issuedAt: Date.now() };
  const { signServerMigrationControl } = await import("@flagship/protocol");
  const sig = signServerMigrationControl(control, w.irk);
  const res = await handlePostMigrationConfirmReady(w.deps, HOST, {
    ...mailboxAuth(w.irk),
    control,
    signature: hex(sig),
  });
  expect(res.status).toBe(200);
}

async function phoneFreeze(w: World): Promise<void> {
  const order: ServerDecommission = {
    podCanonical: HOST,
    retiredStkPubHex: hex(w.oldStk.publicKey),
    finalBackup: true,
    diskDisposition: "wipe-after-handoff",
    backupEpoch: 1,
    nonce: hex(rand(32)),
    issuedAt: Date.now(),
  };
  const sig = signServerDecommission(order, w.irk);
  const res = await handlePostMigrationFreeze(
    {
      ...w.deps,
      decommission: {
        servers: w.deps.servers,
        usernames: w.deps.usernames,
        serverEvictions: w.deps.serverEvictions,
        mailbox: w.deps.mailbox,
      },
    },
    HOST,
    { ...mailboxAuth(w.irk), order, signature: hex(sig) },
  );
  expect(res.status).toBe(200);
}

async function phoneAbort(w: World): Promise<void> {
  const control = { serverDomain: HOST, action: "abort" as const, nonce: hex(rand(32)), issuedAt: Date.now() };
  const { signServerMigrationControl } = await import("@flagship/protocol");
  const sig = signServerMigrationControl(control, w.irk);
  const res = await handlePostMigrationAbort(w.deps, HOST, {
    ...mailboxAuth(w.irk),
    control,
    signature: hex(sig),
  });
  expect(res.status).toBe(200);
}

async function oldBoxFlushFinalDelta(w: World): Promise<void> {
  const res = await handlePostEpochComplete(w.deps, HOST, { stk: hex(w.oldStk.publicKey) });
  expect(res.status).toBe(200);
}

function consumerOpts(
  w: World,
  over: Partial<RunMigrationConsumerOptions> & {
    restoreResults?: MigrationRestoreResult[];
    restoreCalls?: Array<{ serverId: string }>;
  } = {},
): RunMigrationConsumerOptions & { restoreCalls: Array<{ serverId: string }> } {
  const restoreCalls = over.restoreCalls ?? [];
  const results = over.restoreResults ?? [];
  return {
    myServerDomain: NEW_POD,
    myStk: w.newStk,
    ownerIrkPub: w.irk.publicKey,
    username: USERNAME,
    controlPlaneBaseUrl: BASE,
    restore: async (args) => {
      restoreCalls.push(args);
      return results.shift() ?? { complete: true };
    },
    markerStore: memoryMigrationMarkerStore(),
    fetchImpl: w.fetchImpl,
    ...over,
    restoreCalls,
  };
}

describe("migration consumer — fresh-box drive-through", () => {
  it("attaches, pre-seeds, waits for the phone, restores the final delta, and takes over", async () => {
    const w = await setup();
    const takeOvers: string[] = [];
    const opts = consumerOpts(w, {
      onTakeOver: ({ serverDomain }) => {
        takeOvers.push(serverDomain);
      },
    });

    // Nothing yet.
    expect((await runMigrationConsumer(opts)).status).toBe("no-assignment");

    await phoneInitiate(w);
    expect((await runMigrationConsumer(opts)).status).toBe("attached");
    // Pre-seed restore runs against the MIGRATING serverId (the old name).
    expect((await runMigrationConsumer(opts)).status).toBe("pre-seeded");
    expect(opts.restoreCalls).toEqual([{ serverId: HOST }]);

    // Phone hasn't confirmed — the consumer just waits, never skips ahead.
    expect(await runMigrationConsumer(opts)).toEqual({ status: "waiting", phase: "pre-seeded" });

    await phoneConfirmReady(w);
    expect(await runMigrationConsumer(opts)).toEqual({ status: "waiting", phase: "ready" });

    await phoneFreeze(w);
    // Frozen but the final delta hasn't landed — still waiting (invariant:
    // never take over on stale data).
    expect(await runMigrationConsumer(opts)).toEqual({ status: "waiting", phase: "freezing" });

    await oldBoxFlushFinalDelta(w);
    expect((await runMigrationConsumer(opts)).status).toBe("taken-over");
    expect(opts.restoreCalls).toHaveLength(2); // pre-seed + final delta
    expect(takeOvers).toEqual([HOST]);

    // Directory rebound to THIS box; the old box's wipe gate is open.
    expect((await w.storage.servers.get(HOST))?.identityPubKeyHex).toBe(hex(w.newStk.publicKey));
    expect(
      (await w.storage.serverEvictions.getEviction(HOST, hex(w.oldStk.publicKey)))?.newAckedAt,
    ).not.toBeNull();

    // Subsequent polls are done, and onTakeOver does not re-fire.
    expect((await runMigrationConsumer(opts)).status).toBe("done");
    expect(takeOvers).toEqual([HOST]);
  });

  it("an incomplete restore reports 'restoring' and never acks pre-seeded", async () => {
    const w = await setup();
    const opts = consumerOpts(w, {
      restoreResults: [{ complete: false, detail: "2 of 9 chunks missing" }, { complete: true }],
    });
    await phoneInitiate(w);
    expect((await runMigrationConsumer(opts)).status).toBe("attached");
    expect(await runMigrationConsumer(opts)).toMatchObject({ status: "restoring" });
    // .com still shows provisioned — no ack went out.
    expect((await handleGetMigration(w.deps, HOST)).body).toMatchObject({ phase: "provisioned" });
    expect((await runMigrationConsumer(opts)).status).toBe("pre-seeded");
  });

  it("resumes idempotently after a crash mid-phase (fresh marker store, same .com state)", async () => {
    const w = await setup();
    const opts1 = consumerOpts(w);
    await phoneInitiate(w);
    expect((await runMigrationConsumer(opts1)).status).toBe("attached");
    expect((await runMigrationConsumer(opts1)).status).toBe("pre-seeded");

    // "Crash": a brand-new consumer with an EMPTY marker store. The .com phase
    // is authoritative — it re-discovers via the assignment read and continues
    // without re-attaching or double-acking.
    const opts2 = consumerOpts(w);
    expect(await runMigrationConsumer(opts2)).toEqual({ status: "waiting", phase: "pre-seeded" });

    await phoneConfirmReady(w);
    await phoneFreeze(w);
    await oldBoxFlushFinalDelta(w);
    expect((await runMigrationConsumer(opts2)).status).toBe("taken-over");

    // Crash AFTER the take-over ack: another fresh consumer discovers the
    // taken-over session and fires its own re-home hook exactly once.
    const takeOvers: string[] = [];
    const opts3 = consumerOpts(w, { onTakeOver: ({ serverDomain }) => void takeOvers.push(serverDomain) });
    expect((await runMigrationConsumer(opts3)).status).toBe("done");
    expect(takeOvers).toEqual([HOST]);
    expect((await runMigrationConsumer(opts3)).status).toBe("done");
    expect(takeOvers).toEqual([HOST]);
  });

  it("stands down on an aborted session and never takes over after it", async () => {
    const w = await setup();
    const opts = consumerOpts(w);
    await phoneInitiate(w);
    expect((await runMigrationConsumer(opts)).status).toBe("attached");
    await phoneAbort(w);
    expect((await runMigrationConsumer(opts)).status).toBe("aborted");
    // Old box still authoritative.
    expect((await w.storage.servers.get(HOST))?.identityPubKeyHex).toBe(hex(w.oldStk.publicKey));
  });

  it("REJECTS a session whose order is not admin/owner-signed (.com is not a trust anchor)", async () => {
    const w = await setup();
    // Forge: a session row .com could have invented (signed by a random key).
    const mallory = makeKey();
    const order: ServerMigrationOrder = {
      serverDomain: HOST,
      oldStkPubHex: hex(w.oldStk.publicKey),
      diskDisposition: "wipe-after-handoff",
      nonce: hex(rand(32)),
      issuedAt: Date.now(),
    };
    await w.storage.serverMigrations.putSession({
      serverDomain: HOST,
      username: USERNAME,
      oldStkPubHex: hex(w.oldStk.publicKey),
      orderJson: JSON.stringify(order),
      orderSignatureHex: hex(signServerMigrationOrder(order, mallory)),
      disposition: "wipe-after-handoff",
      phase: "initiated",
      initiatedAt: Date.now(),
      newServerDomain: null,
      newStkPubHex: null,
      attachedAt: null,
      preSeededAt: null,
      readyAt: null,
      freezeAt: null,
      takenOverAt: null,
      abortedAt: null,
    });
    const opts = consumerOpts(w);
    const out = await runMigrationConsumer(opts);
    expect(out.status).toBe("rejected");
    expect(opts.restoreCalls).toHaveLength(0);
  });

  it("gate OPEN box-side: an owner-IRK-signed order is refused when an admin root is pinned", async () => {
    const w = await setup();
    await phoneInitiate(w); // owner-IRK-signed (gate closed on .com in this world)
    const adminRoot = makeKey();
    const opts = consumerOpts(w, { adminRootPub: adminRoot.publicKey });
    expect((await runMigrationConsumer(opts)).status).toBe("rejected");
    // The same order signed BY the admin root is accepted.
    const w2 = await setup();
    const order: ServerMigrationOrder = {
      serverDomain: HOST,
      oldStkPubHex: hex(w2.oldStk.publicKey),
      diskDisposition: "keep",
      nonce: hex(rand(32)),
      issuedAt: Date.now(),
    };
    await w2.storage.serverMigrations.putSession({
      serverDomain: HOST,
      username: USERNAME,
      oldStkPubHex: hex(w2.oldStk.publicKey),
      orderJson: JSON.stringify(order),
      orderSignatureHex: hex(signServerMigrationOrder(order, adminRoot)),
      disposition: "keep",
      phase: "initiated",
      initiatedAt: Date.now(),
      newServerDomain: null,
      newStkPubHex: null,
      attachedAt: null,
      preSeededAt: null,
      readyAt: null,
      freezeAt: null,
      takenOverAt: null,
      abortedAt: null,
    });
    const opts2 = consumerOpts(w2, { adminRootPub: adminRoot.publicKey });
    expect((await runMigrationConsumer(opts2)).status).toBe("attached");
  });

  it("stands down when ANOTHER box is attached (not-mine)", async () => {
    const w = await setup();
    await phoneInitiate(w);
    // An unattached pod simply never sees the session once another box owns
    // it (the assignment read filters it out)…
    const second = makeKey();
    await w.storage.servers.put({
      serverDomain: "shed.alice.flagship.services",
      username: USERNAME,
      identityPubKeyHex: hex(second.publicKey),
      registeredAt: 4,
    });
    const { signServerMigrationAttach } = await import("@flagship/protocol");
    const attach = {
      serverDomain: HOST,
      newServerDomain: "shed.alice.flagship.services",
      newStkPubHex: hex(second.publicKey),
      issuedAt: Date.now(),
    };
    const sig = signServerMigrationAttach(attach, second);
    expect(
      (await handlePostMigrationAttach(w.deps, HOST, { attach, signatureHex: hex(sig) })).status,
    ).toBe(200);
    expect((await runMigrationConsumer(consumerOpts(w))).status).toBe("no-assignment");

    // …and a consumer that THOUGHT it was attached (stale marker — e.g. the
    // session was aborted and re-run with a different box) stands down with
    // not-mine instead of acting on someone else's migration.
    const marker = memoryMigrationMarkerStore();
    await marker.save({ serverDomain: HOST, stage: "attached", updatedAt: Date.now() });
    const out = await runMigrationConsumer(consumerOpts(w, { markerStore: marker }));
    expect(out.status).toBe("not-mine");
  });

  it("the poller stops itself on a terminal outcome", async () => {
    const w = await setup();
    await phoneInitiate(w);
    const opts = consumerOpts(w);
    expect((await runMigrationConsumer(opts)).status).toBe("attached");
    await phoneAbort(w);
    const poller = buildMigrationPoller(opts);
    const out = await poller.pollOnce();
    expect(out.status).toBe("aborted");
    poller.start(); // must be inert after the terminal outcome
    poller.stop();
  });
});

describe("decodeAndVerifyMigrationOrder", () => {
  it("rejects junk JSON, missing fields, a bad signature length, and wipe-now", async () => {
    const w = await setup();
    const good: ServerMigrationOrder = {
      serverDomain: HOST,
      oldStkPubHex: hex(w.oldStk.publicKey),
      diskDisposition: "keep",
      nonce: "aa".repeat(32),
      issuedAt: 1,
    };
    const sig = hex(signServerMigrationOrder(good, w.irk));
    expect(() =>
      decodeAndVerifyMigrationOrder({ orderJson: "{nope", orderSignatureHex: sig, ownerIrkPub: w.irk.publicKey }),
    ).toThrow(/JSON/);
    expect(() =>
      decodeAndVerifyMigrationOrder({
        orderJson: JSON.stringify({ ...good, diskDisposition: "wipe-now" }),
        orderSignatureHex: sig,
        ownerIrkPub: w.irk.publicKey,
      }),
    ).toThrow(/missing required fields/);
    expect(() =>
      decodeAndVerifyMigrationOrder({
        orderJson: JSON.stringify(good),
        orderSignatureHex: "ff",
        ownerIrkPub: w.irk.publicKey,
      }),
    ).toThrow(/64 bytes/);
    expect(() =>
      decodeAndVerifyMigrationOrder({
        orderJson: JSON.stringify(good),
        orderSignatureHex: "00".repeat(64),
        ownerIrkPub: w.irk.publicKey,
      }),
    ).toThrow(/not authorized/);
    expect(
      decodeAndVerifyMigrationOrder({
        orderJson: JSON.stringify(good),
        orderSignatureHex: sig,
        ownerIrkPub: w.irk.publicKey,
      }),
    ).toEqual(good);
  });
});

describe("old-box migration-aware handoff confirm", () => {
  function confirmArgs(w: World, over: Partial<Parameters<typeof pollMigrationAwareHandoffConfirm>[0]> = {}) {
    return {
      serverDomain: HOST,
      myStkHex: hex(w.oldStk.publicKey),
      controlPlaneBaseUrl: BASE,
      maxAttempts: 3,
      intervalMs: 1,
      fallback: async () => false,
      fetchImpl: w.fetchImpl,
      sleep: async () => {},
      ...over,
    };
  }

  it("confirms ONLY on taken-over", async () => {
    const w = await setup();
    await phoneInitiate(w);
    // Session exists but is nowhere near take-over → budget exhausts → false.
    expect(await pollMigrationAwareHandoffConfirm(confirmArgs(w))).toBe(false);

    // Drive to taken-over via the consumer.
    const opts = consumerOpts(w);
    await runMigrationConsumer(opts); // attach
    await runMigrationConsumer(opts); // pre-seed
    await phoneConfirmReady(w);
    await phoneFreeze(w);
    await oldBoxFlushFinalDelta(w);
    await runMigrationConsumer(opts); // take-over
    expect(await pollMigrationAwareHandoffConfirm(confirmArgs(w))).toBe(true);
  });

  it("denies immediately on an aborted migration (data preserved)", async () => {
    const w = await setup();
    await phoneInitiate(w);
    await phoneAbort(w);
    expect(await pollMigrationAwareHandoffConfirm(confirmArgs(w, { maxAttempts: 100 }))).toBe(false);
  });

  it("falls back to the replacement heuristic when no migration session exists", async () => {
    const w = await setup();
    let fellBack = false;
    expect(
      await pollMigrationAwareHandoffConfirm(
        confirmArgs(w, {
          fallback: async () => {
            fellBack = true;
            return true;
          },
        }),
      ),
    ).toBe(true);
    expect(fellBack).toBe(true);
  });
});
