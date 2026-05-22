/**
 * Tests for POST /api/users/:u/devices/admit — the vouched cross-device
 * admit (Phase 3b). The admin (holding the account's current IRK) signs
 * a DeviceAdmit binding the incoming device's fresh pubkey; the incoming
 * device presents it on register; the Worker verifies under the
 * registered IRK and admits the device QUARANTINED.
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signDeviceAdmit,
  type DeviceAdmit,
  type Keypair,
} from "@flagship/protocol";
import {
  InMemoryAuditEventStorage,
  InMemoryPushTokenStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import { handleVouchedDeviceAdmit, QUARANTINE_MS } from "../src/push.js";

const FIXED_NOW = 1_700_000_000_000;

function makeIrk(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
async function seed(usernames: InMemoryUsernameStorage, name: string, irk: Keypair) {
  await usernames.put({
    username: name,
    irkPubHex: bytesToHex(irk.publicKey),
    claimedAt: FIXED_NOW,
  });
}

const NEW_DEVICE_PUB_HEX = "ab".repeat(32);
const SAMPLE_PUSH_PUB_HEX = (() => {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = i;
  return bytesToHex(b);
})();

interface Setup {
  usernames: InMemoryUsernameStorage;
  pushTokens: InMemoryPushTokenStorage;
  auditEvents: InMemoryAuditEventStorage;
  irk: Keypair;
}

async function setup(name = "alice"): Promise<Setup> {
  const usernames = new InMemoryUsernameStorage();
  const pushTokens = new InMemoryPushTokenStorage();
  const auditEvents = new InMemoryAuditEventStorage();
  const irk = makeIrk();
  await seed(usernames, name, irk);
  return { usernames, pushTokens, auditEvents, irk };
}

function admitBody(opts: {
  admit: DeviceAdmit;
  admitSig: Uint8Array;
  registerUsername?: string;
  issuedAt?: number;
}) {
  return {
    admit: {
      username: opts.admit.username,
      newDevicePubHex: opts.admit.newDevicePubHex,
      issuedAt: opts.admit.issuedAt,
    },
    admitSig: bytesToHex(opts.admitSig),
    request: {
      username: opts.registerUsername ?? opts.admit.username,
      platform: "fcm" as const,
      providerToken: "fcm-collab-device",
      pushX25519Pub: SAMPLE_PUSH_PUB_HEX,
      label: "Collaborator's Pixel",
      issuedAt: opts.issuedAt ?? FIXED_NOW,
    },
    // The incoming device's PushTokenRegister signature is carried for
    // storage but NOT verified by the admit path (the admit is the IRK
    // consent). A throwaway value is fine here.
    signature: "00".repeat(64),
  };
}

describe("POST /api/users/:u/devices/admit", () => {
  it("valid admit → device quarantined + 200 with quarantineUntil", async () => {
    const { usernames, pushTokens, auditEvents, irk } = await setup();
    const admit: DeviceAdmit = {
      username: "alice",
      newDevicePubHex: NEW_DEVICE_PUB_HEX,
      issuedAt: FIXED_NOW,
    };
    const sig = signDeviceAdmit(admit, irk);
    const r = await handleVouchedDeviceAdmit(
      { usernames, pushTokens, auditEvents, now: () => FIXED_NOW },
      "alice",
      admitBody({ admit, admitSig: sig }),
    );
    expect(r.status).toBe(200);
    expect((r.body as { quarantineUntil: number }).quarantineUntil).toBe(
      FIXED_NOW + QUARANTINE_MS,
    );
    const all = await pushTokens.listByUser("alice");
    expect(all.length).toBe(1);
    expect(all[0]?.quarantineUntil).toBe(FIXED_NOW + QUARANTINE_MS);
    expect(all[0]?.label).toBe("Collaborator's Pixel");
  });

  it("valid admit emits a device-added audit event", async () => {
    const { usernames, pushTokens, auditEvents, irk } = await setup();
    const admit: DeviceAdmit = {
      username: "alice",
      newDevicePubHex: NEW_DEVICE_PUB_HEX,
      issuedAt: FIXED_NOW,
    };
    const sig = signDeviceAdmit(admit, irk);
    await handleVouchedDeviceAdmit(
      { usernames, pushTokens, auditEvents, now: () => FIXED_NOW },
      "alice",
      admitBody({ admit, admitSig: sig }),
    );
    const events = await auditEvents.list("alice", 0, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKind).toBe("device-added");
    expect(events[0]?.quarantineUntil).toBe(FIXED_NOW + QUARANTINE_MS);
  });

  it("rejects a bad admit signature (401)", async () => {
    const { usernames, pushTokens, auditEvents, irk } = await setup();
    const admit: DeviceAdmit = {
      username: "alice",
      newDevicePubHex: NEW_DEVICE_PUB_HEX,
      issuedAt: FIXED_NOW,
    };
    const sig = signDeviceAdmit(admit, irk);
    // Corrupt the signature.
    sig[0] = sig[0]! ^ 0xff;
    const r = await handleVouchedDeviceAdmit(
      { usernames, pushTokens, auditEvents, now: () => FIXED_NOW },
      "alice",
      admitBody({ admit, admitSig: sig }),
    );
    expect(r.status).toBe(401);
    expect(await pushTokens.listByUser("alice")).toHaveLength(0);
  });

  it("rejects an admit signed by the wrong IRK (401)", async () => {
    const { usernames, pushTokens, auditEvents } = await setup();
    const evil = makeIrk();
    const admit: DeviceAdmit = {
      username: "alice",
      newDevicePubHex: NEW_DEVICE_PUB_HEX,
      issuedAt: FIXED_NOW,
    };
    const sig = signDeviceAdmit(admit, evil); // not alice's IRK
    const r = await handleVouchedDeviceAdmit(
      { usernames, pushTokens, auditEvents, now: () => FIXED_NOW },
      "alice",
      admitBody({ admit, admitSig: sig }),
    );
    expect(r.status).toBe(401);
    expect(await pushTokens.listByUser("alice")).toHaveLength(0);
  });

  it("rejects a stale admit (401)", async () => {
    const { usernames, pushTokens, auditEvents, irk } = await setup();
    const staleIssuedAt = FIXED_NOW - 10 * 60_000; // 10 min old, > 5 min window
    const admit: DeviceAdmit = {
      username: "alice",
      newDevicePubHex: NEW_DEVICE_PUB_HEX,
      issuedAt: staleIssuedAt,
    };
    const sig = signDeviceAdmit(admit, irk);
    const r = await handleVouchedDeviceAdmit(
      { usernames, pushTokens, auditEvents, now: () => FIXED_NOW },
      "alice",
      admitBody({ admit, admitSig: sig }),
    );
    expect(r.status).toBe(401);
    expect(await pushTokens.listByUser("alice")).toHaveLength(0);
  });

  it("rejects when the admit username does not match the URL (403)", async () => {
    const { usernames, pushTokens, auditEvents, irk } = await setup();
    const admit: DeviceAdmit = {
      username: "alice",
      newDevicePubHex: NEW_DEVICE_PUB_HEX,
      issuedAt: FIXED_NOW,
    };
    const sig = signDeviceAdmit(admit, irk);
    const r = await handleVouchedDeviceAdmit(
      { usernames, pushTokens, auditEvents, now: () => FIXED_NOW },
      "bob", // URL says bob, admit says alice
      admitBody({ admit, admitSig: sig }),
    );
    expect(r.status).toBe(403);
    expect(await pushTokens.listByUser("alice")).toHaveLength(0);
  });

  it("rejects when the register body username disagrees with the admit (403)", async () => {
    const { usernames, pushTokens, auditEvents, irk } = await setup();
    const admit: DeviceAdmit = {
      username: "alice",
      newDevicePubHex: NEW_DEVICE_PUB_HEX,
      issuedAt: FIXED_NOW,
    };
    const sig = signDeviceAdmit(admit, irk);
    const r = await handleVouchedDeviceAdmit(
      { usernames, pushTokens, auditEvents, now: () => FIXED_NOW },
      "alice",
      admitBody({ admit, admitSig: sig, registerUsername: "mallory" }),
    );
    expect(r.status).toBe(403);
    expect(await pushTokens.listByUser("alice")).toHaveLength(0);
  });

  it("404 when the username is not registered", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const auditEvents = new InMemoryAuditEventStorage();
    const irk = makeIrk();
    const admit: DeviceAdmit = {
      username: "ghost",
      newDevicePubHex: NEW_DEVICE_PUB_HEX,
      issuedAt: FIXED_NOW,
    };
    const sig = signDeviceAdmit(admit, irk);
    const r = await handleVouchedDeviceAdmit(
      { usernames, pushTokens, auditEvents, now: () => FIXED_NOW },
      "ghost",
      admitBody({ admit, admitSig: sig }),
    );
    expect(r.status).toBe(404);
  });

  it("400 on a malformed admit (missing fields)", async () => {
    const { usernames, pushTokens, auditEvents } = await setup();
    const r = await handleVouchedDeviceAdmit(
      { usernames, pushTokens, auditEvents, now: () => FIXED_NOW },
      "alice",
      { admit: { username: "alice" }, admitSig: "00".repeat(64) } as never,
    );
    expect(r.status).toBe(400);
  });

  it("400 on a malformed newDevicePubHex (wrong length)", async () => {
    const { usernames, pushTokens, auditEvents, irk } = await setup();
    // Sign a valid admit but submit a short newDevicePubHex in the body.
    const admit: DeviceAdmit = {
      username: "alice",
      newDevicePubHex: NEW_DEVICE_PUB_HEX,
      issuedAt: FIXED_NOW,
    };
    const sig = signDeviceAdmit(admit, irk);
    const body = admitBody({ admit, admitSig: sig });
    body.admit.newDevicePubHex = "deadbeef";
    const r = await handleVouchedDeviceAdmit(
      { usernames, pushTokens, auditEvents, now: () => FIXED_NOW },
      "alice",
      body,
    );
    expect(r.status).toBe(400);
  });
});
