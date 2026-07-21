/**
 * N0d-2 — install-policy push fan-out on a new server registration.
 * The phone owns install policy; .com only nudges the device family
 * with an empty-payload, category-only push, at-most-once per
 * registration, entirely best-effort.
 */
import { describe, expect, it } from "vitest";
import { handleServerRegister } from "../src/serverRegister.js";
import {
  ed,
  signAuthCode,
  signServerRegister,
  type AuthCode,
  type Keypair,
  type ServerRegisterRequest,
} from "@flagship/protocol";
import {
  InMemoryAuditEventStorage,
  InMemoryAuthCodeStorage,
  InMemoryInstallPolicyFanoutStorage,
  InMemoryPushTokenStorage,
  InMemoryServerStorage,
  type PushTokenRecord,
} from "@flagship/storage";

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

interface FanoutCall {
  targets: Array<{ tokenId: string; platform: string; providerToken: string }>;
  category: string;
  sealedPayloadHex: string;
}

function pushToken(username: string, tokenId: string): PushTokenRecord {
  return {
    tokenId,
    username,
    platform: "apns",
    providerToken: `provider-${tokenId}`,
    pushX25519PubHex: "ab".repeat(32),
    registrationSignatureHex: "cd".repeat(64),
    deviceId: tokenId,
    registeredAt: 1,
    lastSeenAt: 1,
  };
}

const ISSUED_AT = 2_000;

async function register(deps: {
  pushTokens?: InMemoryPushTokenStorage;
  installPolicyFanout?: InMemoryInstallPolicyFanoutStorage;
  forwardToProviders?: (a: FanoutCall) => Promise<{ ok: boolean; sent: number; failed: number }>;
  servers?: InMemoryServerStorage;
  auditEvents?: InMemoryAuditEventStorage;
}) {
  const irk = makeKey();
  const authCodes = new InMemoryAuthCodeStorage();
  const issued: AuthCode = {
    version: 1,
    serial: "abcd1234",
    username: "alice",
    serverName: "home",
    serverDomain: "home.alice.flagship.services",
    delegatedPubKey: makeKey().publicKey,
    userPubKey: irk.publicKey,
    issuedAt: 1_000,
    // 1h after issue — within the 24h server-side cap.
    expiresAt: 1_000 + 60 * 60_000,
  };
  const acSig = signAuthCode(issued, irk);
  await authCodes.put({
    serial: issued.serial,
    username: issued.username,
    serverName: issued.serverName,
    serverDomain: issued.serverDomain,
    delegatedPubKeyHex: hex(issued.delegatedPubKey),
    userPubKeyHex: hex(issued.userPubKey),
    userSignatureHex: hex(acSig),
    issuedAt: issued.issuedAt,
    expiresAt: issued.expiresAt,
    status: "active",
    recordedAt: issued.issuedAt,
  });
  const identity = makeKey();
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const reg: ServerRegisterRequest = {
    authCode: issued,
    authCodeUserSignature: acSig,
    serverIdentityPubKey: identity.publicKey,
    issuedAt: ISSUED_AT,
    nonce,
  };
  const sig = signServerRegister(reg, identity);
  return handleServerRegister(
    {
      authCodes,
      servers: deps.servers ?? new InMemoryServerStorage(),
      pushTokens: deps.pushTokens,
      installPolicyFanout: deps.installPolicyFanout,
      forwardToProviders: deps.forwardToProviders,
      auditEvents: deps.auditEvents,
      now: () => ISSUED_AT,
    },
    {
      request: {
        authCode: {
          ...issued,
          delegatedPubKey: hex(issued.delegatedPubKey),
          userPubKey: hex(issued.userPubKey),
        },
        authCodeUserSignature: hex(acSig),
        serverIdentityPubKey: hex(identity.publicKey),
        issuedAt: ISSUED_AT,
        nonce: hex(nonce),
      },
      signature: hex(sig),
    },
  );
}

describe("serverRegister — install-policy push fan-out (N0d-2)", () => {
  it("fans an empty-payload 'server-registered' push to all the user's devices + records it", async () => {
    const pushTokens = new InMemoryPushTokenStorage();
    await pushTokens.put(pushToken("alice", "t1"));
    await pushTokens.put(pushToken("alice", "t2"));
    await pushTokens.put(pushToken("bob", "t3")); // different user — excluded
    const installPolicyFanout = new InMemoryInstallPolicyFanoutStorage();
    const calls: FanoutCall[] = [];

    const r = await register({
      pushTokens,
      installPolicyFanout,
      forwardToProviders: async (a) => {
        calls.push(a);
        return { ok: true, sent: a.targets.length, failed: 0 };
      },
    });

    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.category).toBe("server-registered");
    expect(calls[0]!.sealedPayloadHex).toBe(""); // empty-payload invariant
    expect(calls[0]!.targets.map((t) => t.tokenId).sort()).toEqual(["t1", "t2"]);
    const rec = await installPolicyFanout.get("home.alice.flagship.services");
    expect(rec).toMatchObject({ username: "alice", fanoutCount: 2 });
  });

  it("is at-most-once: a re-submitted registration does not re-notify", async () => {
    const pushTokens = new InMemoryPushTokenStorage();
    await pushTokens.put(pushToken("alice", "t1"));
    const installPolicyFanout = new InMemoryInstallPolicyFanoutStorage();
    // Pre-seed the fan-out record as if a prior registration already
    // notified — recordOnce returns false ⇒ no push this time.
    await installPolicyFanout.recordOnce({
      serverDomain: "home.alice.flagship.services",
      username: "alice",
      registeredAt: 1,
      fanoutCount: 1,
      notifiedAt: 1,
    });
    const calls: FanoutCall[] = [];
    const r = await register({
      pushTokens,
      installPolicyFanout,
      forwardToProviders: async (a) => {
        calls.push(a);
        return { ok: true, sent: 1, failed: 0 };
      },
    });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("is best-effort: a forwarder throw does not fail registration", async () => {
    const pushTokens = new InMemoryPushTokenStorage();
    await pushTokens.put(pushToken("alice", "t1"));
    const servers = new InMemoryServerStorage();
    const r = await register({
      pushTokens,
      installPolicyFanout: new InMemoryInstallPolicyFanoutStorage(),
      forwardToProviders: async () => {
        throw new Error("APNs down");
      },
      servers,
    });
    expect(r.status).toBe(200);
    // Registration still durably recorded despite the push failure.
    expect(await servers.get("home.alice.flagship.services")).toBeTruthy();
  });

  it("no-ops cleanly when push deps are absent (still registers)", async () => {
    const servers = new InMemoryServerStorage();
    const r = await register({ servers });
    expect(r.status).toBe(200);
    expect(await servers.get("home.alice.flagship.services")).toBeTruthy();
  });

  it("records but does not call the forwarder when the user has no devices", async () => {
    const installPolicyFanout = new InMemoryInstallPolicyFanoutStorage();
    const calls: FanoutCall[] = [];
    const r = await register({
      pushTokens: new InMemoryPushTokenStorage(),
      installPolicyFanout,
      forwardToProviders: async (a) => {
        calls.push(a);
        return { ok: true, sent: 0, failed: 0 };
      },
    });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect((await installPolicyFanout.get("home.alice.flagship.services"))?.fanoutCount).toBe(0);
  });

  it("appends a 'server-created' audit row on first registration (Activity feed)", async () => {
    const auditEvents = new InMemoryAuditEventStorage();
    const r = await register({ auditEvents });
    expect(r.status).toBe(200);
    const rows = await auditEvents.list("alice", 0, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventKind).toBe("server-created");
    // Detail is the human server name (falls back to fqdn).
    expect(rows[0]!.detail).toBe("home");
  });

  it("never fails registration when the audit append throws", async () => {
    const auditEvents = new InMemoryAuditEventStorage();
    auditEvents.append = async () => {
      throw new Error("audit backend down");
    };
    const r = await register({ auditEvents });
    expect(r.status).toBe(200);
  });
});
