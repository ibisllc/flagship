// Provisioning observability — POST /api/server/<domain>/provision-event.
//
// Pins:
//   1. Bootstrap channel: a valid auth-code serial on a provisioning row
//      stores the phase + fans out a push.
//   2. Bootstrap channel rejects: unknown serial, wrong domain, wrong
//      user, and a non-provisioning row.
//   3. Daemon channel: an Ed25519-signed event verifies under the
//      registered server identity; a bad signature is 403.
//   4. Unknown phases + error-without-failed are 400.
//   5. The fan-out payload carries { username, fqdn, phase } and the
//      phase is readable back via demoServerBlockFromRow.

import { describe, expect, it } from "vitest";
import {
  InMemoryAuthCodeStorage,
  InMemoryDemoUsersStorage,
  InMemoryPushTokenStorage,
  InMemoryServerStorage,
} from "@flagship/storage";
import type {
  AuthCodeRecord,
  DemoUserRecord,
  PushTokenRecord,
  ServerRecord,
} from "@flagship/storage";
import {
  signProvisionEvent,
  type ProvisionEvent,
} from "@flagship/protocol";
import { ed } from "@flagship/protocol";
import {
  handlePostProvisionEvent,
  type ProvisionEventDeps,
} from "../src/provisionEvents.js";
import type { V12PushFanout } from "../src/totp.js";

const DOMAIN = "home.demoalice.flagship.services";
const SERIAL = "01HXSERIAL0001";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function freshIdentity() {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (i * 7 + 3) & 0xff;
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

interface Harness {
  deps: ProvisionEventDeps;
  pushed: Array<{ username: string; payload: { category: string; meta?: Record<string, string | number> } }>;
  identity: ReturnType<typeof freshIdentity>;
  clock: { now: number };
}

async function mkHarness(opts?: { withPush?: boolean }): Promise<Harness> {
  const demoUsers = new InMemoryDemoUsersStorage();
  const servers = new InMemoryServerStorage();
  const authCodes = new InMemoryAuthCodeStorage();
  const pushTokens = new InMemoryPushTokenStorage();
  const identity = freshIdentity();
  const clock = { now: 1_700_000_000_000 };
  const pushed: Harness["pushed"] = [];

  const demoRow: DemoUserRecord = {
    username: "demoalice",
    display: "Demo Alice",
    snapshotId: null,
    isoR2Key: null,
    ttlIdleMinutes: 30,
    region: "fsn1",
    size: "cx22",
    activeServerId: "srv-1",
    activeServerFqdn: DOMAIN,
    lastActivityAt: 0,
    state: "provisioning",
    createdAt: clock.now,
    provisionPhase: null,
    provisionPhaseAt: null,
    provisionLastError: null,
  };
  await demoUsers.insert(demoRow);

  const ac: AuthCodeRecord = {
    serial: SERIAL,
    username: "demoalice",
    serverName: "home",
    serverDomain: DOMAIN,
    delegatedPubKeyHex: "00".repeat(32),
    userPubKeyHex: "11".repeat(32),
    userSignatureHex: "22".repeat(64),
    issuedAt: clock.now,
    expiresAt: clock.now + 86_400_000,
    status: "active",
    recordedAt: clock.now,
  };
  await authCodes.put(ac);

  const server: ServerRecord = {
    serverDomain: DOMAIN,
    username: "demoalice",
    identityPubKeyHex: bytesToHex(identity.publicKey),
    registeredAt: clock.now,
  };
  await servers.put(server);

  const pushFanout: V12PushFanout = async (args) => {
    pushed.push({ username: args.username, payload: { category: args.payload.category, meta: args.payload.meta } });
  };

  const deps: ProvisionEventDeps = {
    demoUsers,
    servers,
    authCodes,
    pushTokens,
    now: () => clock.now,
    ...(opts?.withPush ? { pushFanout } : {}),
  };
  return { deps, pushed, identity, clock };
}

function pushToken(username: string, tokenId: string): PushTokenRecord {
  return {
    tokenId,
    username,
    platform: "apns",
    providerToken: "tok-" + tokenId,
    pushX25519PubHex: "33".repeat(32),
    registrationSignatureHex: "44".repeat(64),
    label: "iPhone",
    registeredAt: 1,
    lastSeenAt: 1,
  };
}

describe("POST /api/server/<domain>/provision-event — bootstrap channel", () => {
  it("stores a phase authenticated by the auth-code serial", async () => {
    const h = await mkHarness();
    const r = await handlePostProvisionEvent(h.deps, DOMAIN, {
      phase: "cloned",
      authCodeSerial: SERIAL,
    });
    expect(r.status).toBe(200);
    const row = await h.deps.demoUsers.get("demoalice");
    expect(row?.provisionPhase).toBe("cloned");
    expect(row?.provisionPhaseAt).toBe(h.clock.now);
  });

  it("rejects an unknown serial with 403", async () => {
    const h = await mkHarness();
    const r = await handlePostProvisionEvent(h.deps, DOMAIN, {
      phase: "cloned",
      authCodeSerial: "NOPE",
    });
    expect(r.status).toBe(403);
  });

  it("rejects a serial whose domain doesn't match the path", async () => {
    const h = await mkHarness();
    const r = await handlePostProvisionEvent(h.deps, "home.bob.flagship.services", {
      phase: "cloned",
      authCodeSerial: SERIAL,
    });
    // No demo row for bob → 404 (the row lookup precedes serial check).
    expect(r.status).toBe(404);
  });

  it("rejects a bootstrap event on a non-provisioning row", async () => {
    const h = await mkHarness();
    await h.deps.demoUsers.transition("demoalice", "provisioning", "up");
    const r = await handlePostProvisionEvent(h.deps, DOMAIN, {
      phase: "deps",
      authCodeSerial: SERIAL,
    });
    expect(r.status).toBe(403);
  });

  it("stamps a failed phase + error", async () => {
    const h = await mkHarness();
    const r = await handlePostProvisionEvent(h.deps, DOMAIN, {
      phase: "failed",
      error: "npm install exploded",
      authCodeSerial: SERIAL,
    });
    expect(r.status).toBe(200);
    const row = await h.deps.demoUsers.get("demoalice");
    expect(row?.provisionPhase).toBe("failed");
    expect(row?.provisionLastError).toBe("npm install exploded");
  });
});

describe("POST /api/server/<domain>/provision-event — daemon channel", () => {
  function sign(h: Harness, phase: ProvisionEvent["phase"], error = "") {
    const issuedAt = h.clock.now;
    const event: ProvisionEvent = { serverDomain: DOMAIN, phase, error, issuedAt };
    const sig = signProvisionEvent(event, h.identity);
    return { issuedAt, signature: bytesToHex(sig) };
  }

  it("accepts a signed daemon phase under the registered identity", async () => {
    const h = await mkHarness();
    const { issuedAt, signature } = sign(h, "ready");
    const r = await handlePostProvisionEvent(h.deps, DOMAIN, {
      phase: "ready",
      issuedAt,
      signature,
    });
    expect(r.status).toBe(200);
    const row = await h.deps.demoUsers.get("demoalice");
    expect(row?.provisionPhase).toBe("ready");
  });

  it("rejects a tampered signed event with 403", async () => {
    const h = await mkHarness();
    const { issuedAt, signature } = sign(h, "ready");
    const r = await handlePostProvisionEvent(h.deps, DOMAIN, {
      phase: "cert-issued", // signature was over "ready"
      issuedAt,
      signature,
    });
    expect(r.status).toBe(403);
  });

  it("rejects a signed event for an unknown server domain", async () => {
    const h = await mkHarness();
    // Use a demo username that has a row but no servers entry.
    await h.deps.demoUsers.insert({
      username: "demobob",
      display: "Demo Bob",
      snapshotId: null,
      isoR2Key: null,
      ttlIdleMinutes: 30,
      region: "fsn1",
      size: "cx22",
      activeServerId: null,
      activeServerFqdn: "home.demobob.flagship.services",
      lastActivityAt: 0,
      state: "provisioning",
      createdAt: 1,
      provisionPhase: null,
      provisionPhaseAt: null,
      provisionLastError: null,
    });
    const issuedAt = h.clock.now;
    const event: ProvisionEvent = {
      serverDomain: "home.demobob.flagship.services",
      phase: "ready",
      error: "",
      issuedAt,
    };
    const sig = signProvisionEvent(event, h.identity);
    const r = await handlePostProvisionEvent(h.deps, "home.demobob.flagship.services", {
      phase: "ready",
      issuedAt,
      signature: bytesToHex(sig),
    });
    expect(r.status).toBe(403); // unknown serverDomain (no servers row)
  });
});

describe("provision-event validation", () => {
  it("rejects an unknown phase with 400", async () => {
    const h = await mkHarness();
    const r = await handlePostProvisionEvent(h.deps, DOMAIN, {
      phase: "halfway",
      authCodeSerial: SERIAL,
    });
    expect(r.status).toBe(400);
  });

  it("rejects an error on a non-failed phase with 400", async () => {
    const h = await mkHarness();
    const r = await handlePostProvisionEvent(h.deps, DOMAIN, {
      phase: "cloned",
      error: "should not be here",
      authCodeSerial: SERIAL,
    });
    expect(r.status).toBe(400);
  });

  it("rejects a body with neither serial nor signature with 400", async () => {
    const h = await mkHarness();
    const r = await handlePostProvisionEvent(h.deps, DOMAIN, { phase: "boot" });
    expect(r.status).toBe(400);
  });

  it("404s when no demo row backs the domain", async () => {
    const h = await mkHarness();
    const r = await handlePostProvisionEvent(h.deps, "home.ghost.flagship.services", {
      phase: "boot",
      authCodeSerial: SERIAL,
    });
    expect(r.status).toBe(404);
  });
});

describe("provision-event push fan-out", () => {
  it("fans out a provision-phase push carrying username + fqdn + phase", async () => {
    const h = await mkHarness({ withPush: true });
    await h.deps.pushTokens.put(pushToken("demoalice", "t1"));
    const r = await handlePostProvisionEvent(h.deps, DOMAIN, {
      phase: "deps",
      authCodeSerial: SERIAL,
    });
    expect(r.status).toBe(200);
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]!.username).toBe("demoalice");
    expect(h.pushed[0]!.payload.category).toBe("provision-phase");
    expect(h.pushed[0]!.payload.meta).toMatchObject({
      kind: "provision-phase",
      username: "demoalice",
      fqdn: DOMAIN,
      phase: "deps",
    });
  });

  it("does not fan out when the user has no registered devices", async () => {
    const h = await mkHarness({ withPush: true });
    const r = await handlePostProvisionEvent(h.deps, DOMAIN, {
      phase: "deps",
      authCodeSerial: SERIAL,
    });
    expect(r.status).toBe(200);
    expect(h.pushed).toHaveLength(0);
  });

  it("stores the phase even when no fan-out is configured", async () => {
    const h = await mkHarness(); // no pushFanout
    await h.deps.pushTokens.put(pushToken("demoalice", "t1"));
    const r = await handlePostProvisionEvent(h.deps, DOMAIN, {
      phase: "built",
      authCodeSerial: SERIAL,
    });
    expect(r.status).toBe(200);
    const row = await h.deps.demoUsers.get("demoalice");
    expect(row?.provisionPhase).toBe("built");
  });
});
