/**
 * Server-migration orchestration handlers (docs/server-migration.md).
 *
 * Covers: the full happy-path phase walk; the server-side invariants (take-over
 * rejected before freeze / before the final-delta barrier; wipe-confirm —
 * markNewAcked — set ONLY by take-over; abort allowed at every pre-take-over
 * phase and REJECTED after; abort keeps the old box authoritative, deleting an
 * unconsumed eviction); the auth model (forged / non-admin / wrong-account /
 * replayed-against-a-new-tenant orders rejected; gate-open accounts require the
 * admin master root); and the new-box attach checks (same account, directory-
 * bound STK, single box).
 */
import { describe, expect, it } from "vitest";
import {
  ed,
  signDeviceEndpointClaim,
  signServerDecommission,
  signServerMigrationAck,
  signServerMigrationAttach,
  signServerMigrationControl,
  signServerMigrationOrder,
  type DeviceEndpointClaim,
  type Keypair,
  type ServerDecommission,
  type ServerMigrationAck,
  type ServerMigrationAttach,
  type ServerMigrationControl,
  type ServerMigrationOrder,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handlePostEpochComplete, handlePostAckOld } from "../src/serverDecommission.js";
import {
  handleGetMigration,
  handleGetMigrationAssignment,
  handlePostMigrationAbort,
  handlePostMigrationAttach,
  handlePostMigrationConfirmReady,
  handlePostMigrationFreeze,
  handlePostMigrationPreSeeded,
  handlePostMigrationStart,
  handlePostMigrationTakeOver,
  type ServerMigrationDeps,
} from "../src/serverMigration.js";

const HOST = "home.alice.flagship.services";
const NEW_POD = "attic.alice.flagship.services";
const USERNAME = "alice";

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
  irk: Keypair;       // owner membership IRK (legacy authority when no admin root)
  oldStk: Keypair;    // the migrating (old) box's registered identity
  newStk: Keypair;    // the new box's registered identity
}

async function setup(opts?: { adminRoot?: Keypair; skipNewPod?: boolean }): Promise<World> {
  const storage = new InMemoryStorage();
  const irk = makeKey();
  const oldStk = makeKey();
  const newStk = makeKey();
  await storage.usernames.put({
    username: USERNAME,
    irkPubHex: hex(irk.publicKey),
    claimedAt: 1,
    ...(opts?.adminRoot ? { adminRootPubHex: hex(opts.adminRoot.publicKey) } : {}),
  });
  await storage.servers.put({
    serverDomain: HOST,
    username: USERNAME,
    identityPubKeyHex: hex(oldStk.publicKey),
    registeredAt: 2,
  });
  if (!opts?.skipNewPod) {
    await storage.servers.put({
      serverDomain: NEW_POD,
      username: USERNAME,
      identityPubKeyHex: hex(newStk.publicKey),
      registeredAt: 3,
    });
  }
  return { storage, irk, oldStk, newStk };
}

function deps(w: World): ServerMigrationDeps {
  return {
    servers: w.storage.servers,
    usernames: w.storage.usernames,
    serverMigrations: w.storage.serverMigrations,
    serverEvictions: w.storage.serverEvictions,
    grants: w.storage.deviceCapabilityGrants,
    mailbox: {
      servers: w.storage.servers,
      usernames: w.storage.usernames,
      secretMailbox: w.storage.secretMailbox,
      boxSealedLeases: w.storage.boxSealedLeases,
    },
  };
}

function freezeDeps(w: World) {
  return { ...deps(w), decommission: { ...deps(w), mailbox: deps(w).mailbox } };
}

function mailboxAuth(irk: Keypair, opts?: { username?: string }) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 120_000;
  const nonce = rand(32);
  const claim: DeviceEndpointClaim = {
    username: opts?.username ?? USERNAME,
    endpointLabel: "phone",
    phoneIrkPub: irk.publicKey,
    issuedAt,
    expiresAt,
    nonce,
  };
  const sig = signDeviceEndpointClaim(claim, irk);
  return {
    auth: {
      username: claim.username,
      endpointLabel: claim.endpointLabel,
      phoneIrkPub: hex(claim.phoneIrkPub),
      issuedAt,
      expiresAt,
      nonce: hex(nonce),
    },
    authSignature: hex(sig),
  };
}

function startBody(w: World, over?: Partial<ServerMigrationOrder> & { signWith?: Keypair; authIrk?: Keypair }) {
  const order: ServerMigrationOrder = {
    serverDomain: over?.serverDomain ?? HOST,
    oldStkPubHex: over?.oldStkPubHex ?? hex(w.oldStk.publicKey),
    diskDisposition: over?.diskDisposition ?? "wipe-after-handoff",
    nonce: over?.nonce ?? hex(rand(32)),
    issuedAt: over?.issuedAt ?? Date.now(),
  };
  const sig = signServerMigrationOrder(order, over?.signWith ?? w.irk);
  return { ...mailboxAuth(over?.authIrk ?? w.irk), order, signature: hex(sig) };
}

function attachBody(w: World, over?: Partial<ServerMigrationAttach> & { signWith?: Keypair }) {
  const attach: ServerMigrationAttach = {
    serverDomain: over?.serverDomain ?? HOST,
    newServerDomain: over?.newServerDomain ?? NEW_POD,
    newStkPubHex: over?.newStkPubHex ?? hex(w.newStk.publicKey),
    issuedAt: over?.issuedAt ?? Date.now(),
  };
  const sig = signServerMigrationAttach(attach, over?.signWith ?? w.newStk);
  return { attach, signatureHex: hex(sig) };
}

function ackBody(w: World, phase: ServerMigrationAck["phase"], over?: Partial<ServerMigrationAck> & { signWith?: Keypair }) {
  const ack: ServerMigrationAck = {
    serverDomain: over?.serverDomain ?? HOST,
    stkPubHex: over?.stkPubHex ?? hex(w.newStk.publicKey),
    phase,
    issuedAt: over?.issuedAt ?? Date.now(),
  };
  const sig = signServerMigrationAck(ack, over?.signWith ?? w.newStk);
  return { ack, signatureHex: hex(sig) };
}

function controlBody(w: World, action: ServerMigrationControl["action"], over?: { signWith?: Keypair; authIrk?: Keypair }) {
  const control: ServerMigrationControl = {
    serverDomain: HOST,
    action,
    nonce: hex(rand(32)),
    issuedAt: Date.now(),
  };
  const sig = signServerMigrationControl(control, over?.signWith ?? w.irk);
  return { ...mailboxAuth(over?.authIrk ?? w.irk), control, signature: hex(sig) };
}

function freezeBody(w: World, over?: Partial<ServerDecommission> & { signWith?: Keypair }) {
  const order: ServerDecommission = {
    podCanonical: over?.podCanonical ?? HOST,
    retiredStkPubHex: over?.retiredStkPubHex ?? hex(w.oldStk.publicKey),
    finalBackup: over?.finalBackup ?? true,
    diskDisposition: over?.diskDisposition ?? "wipe-after-handoff",
    backupEpoch: over?.backupEpoch ?? 1,
    nonce: over?.nonce ?? hex(rand(32)),
    issuedAt: over?.issuedAt ?? Date.now(),
  };
  const sig = signServerDecommission(order, over?.signWith ?? w.irk);
  return { ...mailboxAuth(w.irk), order, signature: hex(sig) };
}

/** Drive a world to the given phase along the happy path. */
async function advanceTo(
  w: World,
  phase: "initiated" | "provisioned" | "pre-seeded" | "ready" | "freezing" | "final-delta" | "taken-over",
): Promise<void> {
  const d = deps(w);
  expect((await handlePostMigrationStart(d, HOST, startBody(w))).status).toBe(200);
  if (phase === "initiated") return;
  expect((await handlePostMigrationAttach(d, HOST, attachBody(w))).status).toBe(200);
  if (phase === "provisioned") return;
  expect((await handlePostMigrationPreSeeded(d, HOST, ackBody(w, "pre-seeded"))).status).toBe(200);
  if (phase === "pre-seeded") return;
  expect((await handlePostMigrationConfirmReady(d, HOST, controlBody(w, "confirm-ready"))).status).toBe(200);
  if (phase === "ready") return;
  expect((await handlePostMigrationFreeze(freezeDeps(w), HOST, freezeBody(w))).status).toBe(200);
  if (phase === "freezing") return;
  expect(
    (await handlePostEpochComplete(deps(w), HOST, { stk: hex(w.oldStk.publicKey) })).status,
  ).toBe(200);
  if (phase === "final-delta") return;
  expect((await handlePostMigrationTakeOver(d, HOST, ackBody(w, "take-over"))).status).toBe(200);
}

describe("server-migration happy path", () => {
  it("walks initiate → attach → pre-seed → ready → freeze → final delta → take-over → done", async () => {
    const w = await setup();
    const d = deps(w);

    // 1. initiate
    const start = await handlePostMigrationStart(d, HOST, startBody(w));
    expect(start.status).toBe(200);
    let s = await handleGetMigration(d, HOST);
    expect((s.body as { phase: string }).phase).toBe("initiated");

    // 2. the new box discovers its assignment by its OWN pod name
    const assign = await handleGetMigrationAssignment(d, NEW_POD);
    expect(assign.status).toBe(200);
    expect((assign.body as { serverDomain: string }).serverDomain).toBe(HOST);

    // ...and attaches
    expect((await handlePostMigrationAttach(d, HOST, attachBody(w))).status).toBe(200);
    s = await handleGetMigration(d, HOST);
    expect((s.body as { phase: string; newServerDomain: string }).phase).toBe("provisioned");
    expect((s.body as { newServerDomain: string }).newServerDomain).toBe(NEW_POD);

    // 3. pre-seed complete
    expect((await handlePostMigrationPreSeeded(d, HOST, ackBody(w, "pre-seeded"))).status).toBe(200);

    // 4. phone confirms ready
    expect(
      (await handlePostMigrationConfirmReady(d, HOST, controlBody(w, "confirm-ready"))).status,
    ).toBe(200);

    // 5. freeze — the decommission deposit rides the eviction lane
    expect((await handlePostMigrationFreeze(freezeDeps(w), HOST, freezeBody(w))).status).toBe(200);
    const ev = await w.storage.serverEvictions.getEviction(HOST, hex(w.oldStk.publicKey));
    expect(ev).toBeDefined();
    expect(ev?.newAckedAt).toBeNull();

    // ...old box flushes the final delta (§9 barrier)
    expect(
      (await handlePostEpochComplete(deps(w), HOST, { stk: hex(w.oldStk.publicKey) })).status,
    ).toBe(200);
    s = await handleGetMigration(d, HOST);
    expect((s.body as { finalDeltaAt: number | null }).finalDeltaAt).not.toBeNull();

    // 6. take-over — rebinds the directory + opens the old box's wipe gate
    expect((await handlePostMigrationTakeOver(d, HOST, ackBody(w, "take-over"))).status).toBe(200);
    const reg = await w.storage.servers.get(HOST);
    expect(reg?.identityPubKeyHex).toBe(hex(w.newStk.publicKey));
    const ev2 = await w.storage.serverEvictions.getEviction(HOST, hex(w.oldStk.publicKey));
    expect(ev2?.newAckedAt).not.toBeNull();

    // 7. old box closes out (wipe + ack-old) → derived done
    expect(
      (await handlePostAckOld(deps(w), HOST, { stk: hex(w.oldStk.publicKey) })).status,
    ).toBe(200);
    s = await handleGetMigration(d, HOST);
    expect((s.body as { phase: string; done: boolean }).phase).toBe("taken-over");
    expect((s.body as { done: boolean }).done).toBe(true);
  });

  it("re-depositing the SAME order while active is idempotent; a DIFFERENT one conflicts", async () => {
    const w = await setup();
    const d = deps(w);
    const body = startBody(w);
    expect((await handlePostMigrationStart(d, HOST, body)).status).toBe(200);
    expect((await handlePostMigrationStart(d, HOST, body)).status).toBe(200);
    expect((await handlePostMigrationStart(d, HOST, startBody(w))).status).toBe(409);
  });

  it("phase acks are idempotent and never downgrade the phase", async () => {
    const w = await setup();
    const d = deps(w);
    await advanceTo(w, "ready");
    // a re-polled pre-seeded ack after the phone confirmed ready
    const res = await handlePostMigrationPreSeeded(d, HOST, ackBody(w, "pre-seeded"));
    expect(res.status).toBe(200);
    expect((await handleGetMigration(d, HOST)).body).toMatchObject({ phase: "ready" });
    // a re-attach by the same box
    expect((await handlePostMigrationAttach(d, HOST, attachBody(w))).status).toBe(200);
    expect((await handleGetMigration(d, HOST)).body).toMatchObject({ phase: "ready" });
  });
});

describe("server-migration invariants (server-side enforcement)", () => {
  it("take-over is rejected in every phase before freezing (release-before-claim)", async () => {
    for (const phase of ["provisioned", "pre-seeded", "ready"] as const) {
      const w = await setup();
      await advanceTo(w, phase);
      const res = await handlePostMigrationTakeOver(deps(w), HOST, ackBody(w, "take-over"));
      expect(res.status).toBe(409);
      // the wipe gate never opened
      const ev = await w.storage.serverEvictions.getEviction(HOST, hex(w.oldStk.publicKey));
      expect(ev?.newAckedAt ?? null).toBeNull();
      // the directory identity is untouched
      expect((await w.storage.servers.get(HOST))?.identityPubKeyHex).toBe(hex(w.oldStk.publicKey));
    }
  });

  it("take-over is rejected while frozen until the final delta is flushed (no data loss)", async () => {
    const w = await setup();
    await advanceTo(w, "freezing");
    const res = await handlePostMigrationTakeOver(deps(w), HOST, ackBody(w, "take-over"));
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/final delta/);
    // flush the delta → take-over now succeeds
    await handlePostEpochComplete(deps(w), HOST, { stk: hex(w.oldStk.publicKey) });
    expect((await handlePostMigrationTakeOver(deps(w), HOST, ackBody(w, "take-over"))).status).toBe(200);
  });

  it("freeze is rejected before confirm-ready", async () => {
    const w = await setup();
    await advanceTo(w, "pre-seeded");
    const res = await handlePostMigrationFreeze(freezeDeps(w), HOST, freezeBody(w));
    expect(res.status).toBe(409);
  });

  it("freeze rejects a decommission that mismatches the session (wrong STK / no final backup / disposition drift)", async () => {
    const w = await setup();
    await advanceTo(w, "ready");
    const other = makeKey();
    expect(
      (await handlePostMigrationFreeze(freezeDeps(w), HOST, freezeBody(w, { retiredStkPubHex: hex(other.publicKey) }))).status,
    ).toBe(409);
    expect(
      (await handlePostMigrationFreeze(freezeDeps(w), HOST, freezeBody(w, { finalBackup: false }))).status,
    ).toBe(409);
    expect(
      (await handlePostMigrationFreeze(freezeDeps(w), HOST, freezeBody(w, { diskDisposition: "keep" }))).status,
    ).toBe(409);
  });

  it("abort at each pre-take-over phase leaves the old box authoritative", async () => {
    for (const phase of ["initiated", "provisioned", "pre-seeded", "ready", "freezing"] as const) {
      const w = await setup();
      await advanceTo(w, phase);
      const res = await handlePostMigrationAbort(deps(w), HOST, controlBody(w, "abort"));
      expect(res.status).toBe(200);
      // directory identity unchanged — the old box still IS the server
      expect((await w.storage.servers.get(HOST))?.identityPubKeyHex).toBe(hex(w.oldStk.publicKey));
      // a frozen migration's unconsumed eviction order is withdrawn
      expect(
        await w.storage.serverEvictions.getEviction(HOST, hex(w.oldStk.publicKey)),
      ).toBeUndefined();
      // no post-abort progress: attach + take-over + freeze all refuse
      expect((await handlePostMigrationAttach(deps(w), HOST, attachBody(w))).status).toBe(409);
      expect((await handlePostMigrationTakeOver(deps(w), HOST, ackBody(w, "take-over"))).status).toBe(409);
      expect((await handlePostMigrationFreeze(freezeDeps(w), HOST, freezeBody(w))).status).toBe(409);
    }
  });

  it("abort after take-over is rejected — the point of no return", async () => {
    const w = await setup();
    await advanceTo(w, "taken-over");
    const res = await handlePostMigrationAbort(deps(w), HOST, controlBody(w, "abort"));
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/point of no return/);
  });

  it("a new initiate can start over a terminal (aborted) session", async () => {
    const w = await setup();
    await advanceTo(w, "initiated");
    expect((await handlePostMigrationAbort(deps(w), HOST, controlBody(w, "abort"))).status).toBe(200);
    expect((await handlePostMigrationStart(deps(w), HOST, startBody(w))).status).toBe(200);
    expect((await handleGetMigration(deps(w), HOST)).body).toMatchObject({ phase: "initiated" });
  });
});

describe("server-migration auth", () => {
  it("rejects a forged order signature", async () => {
    const w = await setup();
    const res = await handlePostMigrationStart(deps(w), HOST, startBody(w, { signWith: makeKey() }));
    expect(res.status).toBe(403);
  });

  it("rejects a deposit whose mailbox-auth is not the owning account", async () => {
    const w = await setup();
    const mallory = makeKey();
    await w.storage.usernames.put({ username: "mallory", irkPubHex: hex(mallory.publicKey), claimedAt: 1 });
    const body = { ...startBody(w), ...mailboxAuth(mallory, { username: "mallory" }) };
    const res = await handlePostMigrationStart(deps(w), HOST, body);
    expect(res.status).toBe(403);
  });

  it("rejects an order that does not name the CURRENT instance (replay against a new tenant)", async () => {
    const w = await setup();
    const stale = makeKey(); // a previous tenant's STK
    const res = await handlePostMigrationStart(deps(w), HOST, startBody(w, { oldStkPubHex: hex(stale.publicKey) }));
    expect(res.status).toBe(409);
  });

  it("rejects wipe-now as a migration disposition", async () => {
    const w = await setup();
    const body = startBody(w) as unknown as { order: Record<string, unknown> };
    body.order.diskDisposition = "wipe-now";
    const res = await handlePostMigrationStart(deps(w), HOST, body as unknown);
    expect(res.status).toBe(400);
  });

  it("gate OPEN (admin root pinned): an owner-IRK-signed order is rejected; the admin root signs", async () => {
    const adminRoot = makeKey();
    const w = await setup({ adminRoot });
    // owner-IRK-signed → refused (the membership IRK is never a master admin)
    expect((await handlePostMigrationStart(deps(w), HOST, startBody(w))).status).toBe(403);
    // admin-root-signed → accepted
    expect(
      (await handlePostMigrationStart(deps(w), HOST, startBody(w, { signWith: adminRoot }))).status,
    ).toBe(200);
    // controls ride the same gate
    expect(
      (await handlePostMigrationAbort(deps(w), HOST, controlBody(w, "abort"))).status,
    ).toBe(403);
    expect(
      (await handlePostMigrationAbort(deps(w), HOST, controlBody(w, "abort", { signWith: adminRoot }))).status,
    ).toBe(200);
  });

  it("attach: a box from another account is rejected", async () => {
    const w = await setup();
    await advanceTo(w, "initiated");
    const foreignStk = makeKey();
    await w.storage.usernames.put({ username: "bob", irkPubHex: hex(makeKey().publicKey), claimedAt: 1 });
    await w.storage.servers.put({
      serverDomain: "den.bob.flagship.services",
      username: "bob",
      identityPubKeyHex: hex(foreignStk.publicKey),
      registeredAt: 4,
    });
    const res = await handlePostMigrationAttach(
      deps(w),
      HOST,
      attachBody(w, { newServerDomain: "den.bob.flagship.services", newStkPubHex: hex(foreignStk.publicKey), signWith: foreignStk }),
    );
    expect(res.status).toBe(403);
  });

  it("attach: the claimed STK must be the directory-bound identity of the new pod", async () => {
    const w = await setup();
    await advanceTo(w, "initiated");
    const impostor = makeKey();
    const res = await handlePostMigrationAttach(
      deps(w),
      HOST,
      attachBody(w, { newStkPubHex: hex(impostor.publicKey), signWith: impostor }),
    );
    expect(res.status).toBe(403);
  });

  it("attach: a second box cannot displace the attached one", async () => {
    const w = await setup();
    await advanceTo(w, "provisioned");
    const second = makeKey();
    await w.storage.servers.put({
      serverDomain: "shed.alice.flagship.services",
      username: USERNAME,
      identityPubKeyHex: hex(second.publicKey),
      registeredAt: 5,
    });
    const res = await handlePostMigrationAttach(
      deps(w),
      HOST,
      attachBody(w, { newServerDomain: "shed.alice.flagship.services", newStkPubHex: hex(second.publicKey), signWith: second }),
    );
    expect(res.status).toBe(409);
  });

  it("attach: the migrating server itself cannot attach as its own successor", async () => {
    const w = await setup();
    await advanceTo(w, "initiated");
    const res = await handlePostMigrationAttach(
      deps(w),
      HOST,
      attachBody(w, { newServerDomain: HOST, newStkPubHex: hex(w.oldStk.publicKey), signWith: w.oldStk }),
    );
    expect(res.status).toBe(403);
  });

  it("acks: only the attached box's STK verifies; a forged ack is rejected", async () => {
    const w = await setup();
    await advanceTo(w, "provisioned");
    const stranger = makeKey();
    expect(
      (await handlePostMigrationPreSeeded(deps(w), HOST, ackBody(w, "pre-seeded", { signWith: stranger }))).status,
    ).toBe(403);
    expect(
      (
        await handlePostMigrationPreSeeded(
          deps(w),
          HOST,
          ackBody(w, "pre-seeded", { stkPubHex: hex(stranger.publicKey), signWith: stranger }),
        )
      ).status,
    ).toBe(403);
    // a stale ack is refused
    expect(
      (
        await handlePostMigrationPreSeeded(
          deps(w),
          HOST,
          ackBody(w, "pre-seeded", { issuedAt: Date.now() - 60 * 60_000 }),
        )
      ).status,
    ).toBe(403);
  });
});

describe("server-migration assignment lookup", () => {
  it("finds the unattached session for a fresh same-account pod; 404 otherwise", async () => {
    const w = await setup();
    expect((await handleGetMigrationAssignment(deps(w), NEW_POD)).status).toBe(404);
    await advanceTo(w, "initiated");
    expect((await handleGetMigrationAssignment(deps(w), NEW_POD)).status).toBe(200);
    // the migrating box itself never sees the session as ITS assignment
    expect((await handleGetMigrationAssignment(deps(w), HOST)).status).toBe(404);
    // an unknown pod gets nothing
    expect((await handleGetMigrationAssignment(deps(w), "ghost.alice.flagship.services")).status).toBe(404);
  });

  it("after attach, only the attached pod sees the session; an aborted session is invisible", async () => {
    const w = await setup();
    await advanceTo(w, "provisioned");
    const second = makeKey();
    await w.storage.servers.put({
      serverDomain: "shed.alice.flagship.services",
      username: USERNAME,
      identityPubKeyHex: hex(second.publicKey),
      registeredAt: 5,
    });
    expect((await handleGetMigrationAssignment(deps(w), NEW_POD)).status).toBe(200);
    expect((await handleGetMigrationAssignment(deps(w), "shed.alice.flagship.services")).status).toBe(404);
    await handlePostMigrationAbort(deps(w), HOST, controlBody(w, "abort"));
    expect((await handleGetMigrationAssignment(deps(w), NEW_POD)).status).toBe(404);
  });
});
