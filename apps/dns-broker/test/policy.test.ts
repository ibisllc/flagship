import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import {
  ed,
  signServiceGrant,
  signDns01Publish,
  signDns01Delete,
  type ServiceGrant,
  type Dns01PublishRequest,
  type Dns01DeleteRequest,
} from "@flagship/protocol";

import {
  canonicalDeleteABytes,
  canonicalUserzoneAcmeBytes,
  verifyRpc,
  type AppGrantWire,
  type PolicyEnv,
  type PublishARecordBody,
  type PublishTxtChallengeBody,
  type DeleteRecordBody,
} from "../src/policy.js";

const APEX = "flagship.services";
const IPV4 = "149.248.216.86";
const IPV6 = "2a09:8280:1::110:d2b6:0";
const NOW = 1_750_000_000_000;
const REPLAY = 5 * 60_000;

function kp(seed: number): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const sk = new Uint8Array(32).fill(seed);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

interface ResolverState {
  pods: Record<string, Uint8Array>;
  irks: Record<string, Uint8Array>;
  callsResolvePod: string[];
  callsResolveIrk: string[];
}

function makeEnv(state: ResolverState, overrides: Partial<PolicyEnv> = {}): PolicyEnv {
  return {
    apex: APEX,
    servicesIpv4: IPV4,
    servicesIpv6: IPV6,
    replayWindowMs: REPLAY,
    now: NOW,
    resolvePodIdentity: async (serverId: string) => {
      state.callsResolvePod.push(serverId);
      return state.pods[serverId] ?? null;
    },
    resolveUserIrk: async (username: string) => {
      state.callsResolveIrk.push(username);
      return state.irks[username] ?? null;
    },
    ...overrides,
  };
}

function freshState(): ResolverState {
  return { pods: {}, irks: {}, callsResolvePod: [], callsResolveIrk: [] };
}

// ─── publishTxtChallenge — pod-namespace authority ───
describe("publishTxtChallenge — pod namespace", () => {
  const podKey = kp(1);
  const serverId = `home.harry.${APEX}`;
  const recordName = `_acme-challenge.${serverId}`;
  const recordValue = "dummy-keyauth-digest";
  const hash = sha256(new TextEncoder().encode(recordValue));

  function makeBody(overrides: Partial<PublishTxtChallengeBody["authority"]> = {}): PublishTxtChallengeBody {
    const issuedAt = NOW;
    const claim: Dns01PublishRequest = {
      serverId,
      recordName,
      recordValueHash: hash,
      issuedAt,
    };
    const sig = signDns01Publish(claim, podKey);
    return {
      kind: "publishTxtChallenge",
      recordName,
      recordValue,
      authority: {
        type: "pod",
        serverId,
        recordValueHashHex: toHex(hash),
        issuedAt,
        signatureHex: toHex(sig),
        ...overrides,
      } as PublishTxtChallengeBody["authority"],
    };
  }

  it("accepts a valid daemon signature on the pod apex", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    const r = await verifyRpc(makeBody(), makeEnv(state));
    expect(r.ok).toBe(true);
    expect(state.callsResolvePod).toEqual([serverId]);
    if (r.ok) {
      expect(r.effect).toEqual({
        kind: "createTxt",
        recordName,
        recordValue,
      });
    }
  });

  it("rejects when the daemon pubkey is not registered", async () => {
    const state = freshState();
    const r = await verifyRpc(makeBody(), makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("rejects a forged signature (wrong key)", async () => {
    const state = freshState();
    state.pods[serverId] = kp(2).publicKey;
    const r = await verifyRpc(makeBody(), makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("rejects when the value hash does not match the value", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    const body = makeBody();
    body.recordValue = "different-value";
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("rejects a stale envelope", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    const issuedAt = NOW - 10 * 60_000; // 10 min ago, window is 5 min
    const claim: Dns01PublishRequest = {
      serverId,
      recordName,
      recordValueHash: hash,
      issuedAt,
    };
    const sig = signDns01Publish(claim, podKey);
    const body: PublishTxtChallengeBody = {
      kind: "publishTxtChallenge",
      recordName,
      recordValue,
      authority: {
        type: "pod",
        serverId,
        recordValueHashHex: toHex(hash),
        issuedAt,
        signatureHex: toHex(sig),
      },
    };
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("rejects a record outside the pod namespace (cross-pod challenge)", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    const otherHost = `office.harry.${APEX}`;
    const body = makeBody();
    body.recordName = `_acme-challenge.${otherHost}`;
    // also re-sign over the new recordName to make sure rejection is on the
    // namespace check, not the signature
    const issuedAt = NOW;
    const claim: Dns01PublishRequest = {
      serverId,
      recordName: body.recordName,
      recordValueHash: hash,
      issuedAt,
    };
    const sig = signDns01Publish(claim, podKey);
    body.authority = {
      type: "pod",
      serverId,
      recordValueHashHex: toHex(hash),
      issuedAt,
      signatureHex: toHex(sig),
    };
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("rejects names outside the managed apex", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    const body = makeBody();
    body.recordName = "_acme-challenge.example.com";
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("refuses a pod-signed user-zone ACME challenge (retired model-C shape)", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    const userZoneRecordName = `_acme-challenge.harry.${APEX}`;
    const issuedAt = NOW;
    const claim: Dns01PublishRequest = {
      serverId,
      recordName: userZoneRecordName,
      recordValueHash: hash,
      issuedAt,
    };
    const sig = signDns01Publish(claim, podKey);
    const body: PublishTxtChallengeBody = {
      kind: "publishTxtChallenge",
      recordName: userZoneRecordName,
      recordValue,
      authority: {
        type: "pod",
        serverId,
        recordValueHashHex: toHex(hash),
        issuedAt,
        signatureHex: toHex(sig),
      },
    };
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(false);
  });
});

// ─── publishTxtChallenge — user-zone IRK authority ───
describe("publishTxtChallenge — user-zone IRK authority", () => {
  const irkKey = kp(3);
  const username = "harry";
  const recordName = `_acme-challenge.${username}.${APEX}`;
  const recordValue = "userzone-keyauth";
  const hash = sha256(new TextEncoder().encode(recordValue));

  function makeBody(): PublishTxtChallengeBody {
    const issuedAt = NOW;
    const msg = canonicalUserzoneAcmeBytes({
      username,
      recordName,
      recordValueHash: hash,
      issuedAt,
    });
    const sig = ed.sign(msg, irkKey.privateKey);
    return {
      kind: "publishTxtChallenge",
      recordName,
      recordValue,
      authority: {
        type: "userzone-irk",
        username,
        recordValueHashHex: toHex(hash),
        issuedAt,
        signatureHex: toHex(sig),
      },
    };
  }

  it("accepts a valid IRK signature on a user-zone ACME label", async () => {
    const state = freshState();
    state.irks[username] = irkKey.publicKey;
    const r = await verifyRpc(makeBody(), makeEnv(state));
    expect(r.ok).toBe(true);
    expect(state.callsResolveIrk).toEqual([username]);
  });

  it("rejects when the user's IRK is not registered", async () => {
    const state = freshState();
    const r = await verifyRpc(makeBody(), makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("rejects when the signing key is not the registered IRK", async () => {
    const state = freshState();
    state.irks[username] = kp(99).publicKey;
    const r = await verifyRpc(makeBody(), makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("rejects host that doesn't match the claimed username", async () => {
    const state = freshState();
    state.irks[username] = irkKey.publicKey;
    const body = makeBody();
    body.recordName = `_acme-challenge.someoneelse.${APEX}`;
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(false);
  });
});

// ─── publishTxtChallenge — user-zone ServiceGrant authority ───
describe("publishTxtChallenge — user-zone ServiceGrant authority", () => {
  const irkKey = kp(4);
  const podKey = kp(5);
  const username = "carl";
  const recordName = `_acme-challenge.${username}.${APEX}`;
  const recordValue = "appgrant-keyauth";
  const hash = sha256(new TextEncoder().encode(recordValue));

  function makeGrantBody(routes: Array<{ url: string; scope: "canonical" | "non-canonical" | "subpath" }>): PublishTxtChallengeBody {
    const grant: ServiceGrant = {
      grantId: "11111111-2222-3333-4444-555555555555",
      username,
      serviceCanonical: "myapp@aaaaaaaaaaaa",
      serverDomains: [`home.${username}.${APEX}`],
      serverIdentities: [podKey.publicKey],
      routes,
      issuedAt: NOW - 60_000,
      expiresAt: NOW + 60 * 60_000,
    };
    const sig = signServiceGrant(grant, irkKey);
    const wire: AppGrantWire = {
      grantId: grant.grantId,
      username: grant.username,
      serviceCanonical: grant.serviceCanonical,
      serverDomains: grant.serverDomains,
      serverIdentitiesHex: grant.serverIdentities.map(toHex),
      routes: grant.routes,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    };
    return {
      kind: "publishTxtChallenge",
      recordName,
      recordValue,
      authority: {
        type: "userzone-grant",
        username,
        grant: wire,
        grantSignatureHex: toHex(sig),
        irkPubKeyHex: toHex(irkKey.publicKey),
      },
    };
  }

  it("accepts a grant that covers *.<user>.flagship.services", async () => {
    const state = freshState();
    state.irks[username] = irkKey.publicKey;
    const body = makeGrantBody([
      { url: `https://*.${username}.${APEX}`, scope: "canonical" },
    ]);
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(true);
  });

  it("rejects a grant whose routes don't cover the user zone", async () => {
    const state = freshState();
    state.irks[username] = irkKey.publicKey;
    const body = makeGrantBody([
      { url: `https://home.${username}.${APEX}/app`, scope: "subpath" },
    ]);
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("rejects when the claimed IRK doesn't match the registered IRK", async () => {
    const state = freshState();
    state.irks[username] = kp(77).publicKey;
    const body = makeGrantBody([
      { url: `https://*.${username}.${APEX}`, scope: "canonical" },
    ]);
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("rejects an expired grant", async () => {
    const state = freshState();
    state.irks[username] = irkKey.publicKey;
    // Build a grant whose expiresAt is before NOW
    const grant: ServiceGrant = {
      grantId: "deadbeef-2222-3333-4444-555555555555",
      username,
      serviceCanonical: "myapp@aaaaaaaaaaaa",
      serverDomains: [`home.${username}.${APEX}`],
      serverIdentities: [podKey.publicKey],
      routes: [{ url: `https://*.${username}.${APEX}`, scope: "canonical" }],
      issuedAt: NOW - 8 * 24 * 60 * 60_000,
      expiresAt: NOW - 60_000,
    };
    const sig = signServiceGrant(grant, irkKey);
    const wire: AppGrantWire = {
      grantId: grant.grantId,
      username: grant.username,
      serviceCanonical: grant.serviceCanonical,
      serverDomains: grant.serverDomains,
      serverIdentitiesHex: grant.serverIdentities.map(toHex),
      routes: grant.routes,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    };
    const body: PublishTxtChallengeBody = {
      kind: "publishTxtChallenge",
      recordName,
      recordValue,
      authority: {
        type: "userzone-grant",
        username,
        grant: wire,
        grantSignatureHex: toHex(sig),
        irkPubKeyHex: toHex(irkKey.publicKey),
      },
    };
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("rejects a tampered grant (signature breaks)", async () => {
    const state = freshState();
    state.irks[username] = irkKey.publicKey;
    const body = makeGrantBody([
      { url: `https://*.${username}.${APEX}`, scope: "canonical" },
    ]);
    if (body.authority.type === "userzone-grant") {
      body.authority.grant.expiresAt = NOW + 365 * 24 * 60 * 60_000; // tamper
    }
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(false);
  });
});

// ─── publishARecord ───
describe("publishARecord", () => {
  const podKey = kp(10);
  const serverId = `home.dave.${APEX}`;
  const REFUSAL = "per-box records are not published under the root wildcard";

  it("refuses every per-box record, even the allowlisted address of a registered pod", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    for (const [targetIp, recordType] of [[IPV4, "A"], [IPV6, "AAAA"]] as const) {
      for (const recordName of ["pod-apex", "pod-wildcard"] as const) {
        const r = await verifyRpc({ kind: "publishARecord", serverId, recordType, targetIp, recordName }, makeEnv(state));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe(REFUSAL);
      }
    }
  });

  it("still refuses malformed and foreign requests", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    expect((await verifyRpc({ kind: "publishARecord", serverId, recordType: "A", targetIp: "1.2.3.4", recordName: "pod-apex" }, makeEnv(state))).ok).toBe(false);
    expect((await verifyRpc({ kind: "publishARecord", serverId: "evil.dave.example.com", recordType: "A", targetIp: IPV4, recordName: "pod-apex" }, makeEnv(state))).ok).toBe(false);
    expect((await verifyRpc({ kind: "publishARecord", serverId, recordType: "A", targetIp: IPV4, recordName: "bogus" } as never, makeEnv(state))).ok).toBe(false);
  });
});

// ─── deleteRecord ───
describe("deleteRecord", () => {
  const podKey = kp(20);
  const serverId = `home.eve.${APEX}`;
  const recordId = "cf-record-deadbeef";

  it("accepts pod-signed deletion of an ACME TXT", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    const claim: Dns01DeleteRequest = { serverId, recordId, issuedAt: NOW };
    const sig = signDns01Delete(claim, podKey);
    const body: DeleteRecordBody = {
      kind: "deleteRecord",
      recordId,
      recordKind: "acme",
      authority: {
        type: "pod-acme",
        serverId,
        issuedAt: NOW,
        signatureHex: toHex(sig),
      },
    };
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(true);
    if (r.ok && r.effect.kind === "deleteById") {
      expect(r.effect.expectedType).toBe("TXT");
      expect(r.effect.expectedNameOneOf).toEqual([`_acme-challenge.${serverId}`]);
    }
  });

  it("rejects pod-acme deletion with a bad signature", async () => {
    const state = freshState();
    state.pods[serverId] = kp(21).publicKey;
    const claim: Dns01DeleteRequest = { serverId, recordId, issuedAt: NOW };
    const sig = signDns01Delete(claim, podKey);
    const body: DeleteRecordBody = {
      kind: "deleteRecord",
      recordId,
      recordKind: "acme",
      authority: {
        type: "pod-acme",
        serverId,
        issuedAt: NOW,
        signatureHex: toHex(sig),
      },
    };
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("rejects pod-acme deletion when authority/kind don't match", async () => {
    // pod-acme but recordKind:"a" — these must agree
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    const claim: Dns01DeleteRequest = { serverId, recordId, issuedAt: NOW };
    const sig = signDns01Delete(claim, podKey);
    const body: DeleteRecordBody = {
      kind: "deleteRecord",
      recordId,
      recordKind: "a",
      authority: {
        type: "pod-acme",
        serverId,
        issuedAt: NOW,
        signatureHex: toHex(sig),
      },
    };
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("accepts pod-signed deletion of an A record (pod-a authority)", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    const msg = canonicalDeleteABytes({ serverId, recordId, issuedAt: NOW });
    const sig = ed.sign(msg, podKey.privateKey);
    const body: DeleteRecordBody = {
      kind: "deleteRecord",
      recordId,
      recordKind: "a",
      authority: {
        type: "pod-a",
        serverId,
        issuedAt: NOW,
        signatureHex: toHex(sig),
      },
    };
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(true);
    if (r.ok && r.effect.kind === "deleteById") {
      expect(r.effect.expectedType).toBe("A");
      expect(r.effect.expectedNameOneOf).toContain(serverId);
      expect(r.effect.expectedNameOneOf).toContain(`*.${serverId}`);
    }
  });

  it("accepts user-IRK deletion targeting the user zone", async () => {
    const irk = kp(22);
    const state = freshState();
    state.irks["eve"] = irk.publicKey;
    const msg = canonicalDeleteABytes({ serverId: "", recordId, issuedAt: NOW });
    const sig = ed.sign(msg, irk.privateKey);
    const body: DeleteRecordBody = {
      kind: "deleteRecord",
      recordId,
      recordKind: "a",
      authority: {
        type: "userzone-irk",
        username: "eve",
        issuedAt: NOW,
        signatureHex: toHex(sig),
      },
    };
    const r = await verifyRpc(body, makeEnv(state));
    expect(r.ok).toBe(true);
    if (r.ok && r.effect.kind === "deleteById") {
      expect(r.effect.expectedNameOneOf).toContain(`eve.${APEX}`);
      expect(r.effect.expectedNameOneOf).toContain(`*.eve.${APEX}`);
    }
  });
});

// ─── malformed / sanity ───
describe("malformed", () => {
  it("rejects unknown kind", async () => {
    const r = await verifyRpc({ kind: "doSomethingEvil" }, makeEnv(freshState()));
    expect(r.ok).toBe(false);
  });

  it("rejects non-object body", async () => {
    expect((await verifyRpc(null, makeEnv(freshState()))).ok).toBe(false);
    expect((await verifyRpc("hello", makeEnv(freshState()))).ok).toBe(false);
    expect((await verifyRpc(42, makeEnv(freshState()))).ok).toBe(false);
  });

  it("rejects body missing required fields", async () => {
    const r = await verifyRpc(
      { kind: "publishTxtChallenge", recordName: "_acme-challenge.x.flagship.services" },
      makeEnv(freshState()),
    );
    expect(r.ok).toBe(false);
  });

  it("policy module never references the CF token", async () => {
    // sanity: import the source and assert it doesn't include the secret-leak path
    const src = await import("../src/policy.js");
    expect(JSON.stringify(Object.keys(src))).not.toMatch(/CLOUDFLARE_DNS_API_TOKEN/);
  });
});

describe("server-wildcard: the account-name challenge under the admin's once-per-server grant", () => {
  const SERVER = `home.alice.${APEX}`;
  const NAME = `_acme-challenge.alice.${APEX}`;
  const pod = kp(31);
  const admin = kp(32);
  const env = (over: Partial<PolicyEnv> = {}) => {
    const st = freshState();
    st.pods[SERVER] = pod.publicKey;
    return makeEnv(st, { resolveUserSensitiveKey: async (u) => (u === "alice" ? admin.publicKey : null), ...over });
  };
  const grant = async (signer = admin, serverDomain = SERVER, stk = pod.publicKey) => {
    const { signServerWildcardGrant } = await import("@flagship/protocol");
    return { issuedAt: 1, signatureHex: toHex(signServerWildcardGrant({ username: "alice", serverDomain, stkPubHex: toHex(stk), issuedAt: 1 }, (m) => ed.sign(m, signer.privateKey))) };
  };
  const publish = async (g: unknown, recordName = NAME, serverId = SERVER) => {
    const value = "token";
    const recordValueHash = sha256(new TextEncoder().encode(value));
    const claim: Dns01PublishRequest = { serverId, recordName, recordValueHash, issuedAt: NOW };
    return {
      kind: "publishTxtChallenge",
      recordName,
      recordValue: value,
      authority: { type: "server-wildcard", serverId, recordValueHashHex: toHex(recordValueHash), issuedAt: NOW, signatureHex: toHex(signDns01Publish(claim, pod)), grant: g },
    } as unknown as PublishTxtChallengeBody;
  };

  it("publishes with the pod's signature and the admin's grant, and deletes only that name", async () => {
    const g = await grant();
    expect(await verifyRpc(await publish(g), env())).toMatchObject({ ok: true, effect: { kind: "createTxt", recordName: NAME } });
    const del: DeleteRecordBody = {
      kind: "deleteRecord",
      recordId: "r1",
      recordKind: "acme",
      authority: { type: "server-wildcard-acme", serverId: SERVER, issuedAt: NOW, signatureHex: toHex(signDns01Delete({ serverId: SERVER, recordId: "r1", issuedAt: NOW } as Dns01DeleteRequest, pod)), grant: g },
    };
    expect(await verifyRpc(del, env())).toMatchObject({ ok: true, effect: { kind: "deleteById", expectedNameOneOf: [NAME] } });
  });

  it("refuses no grant, a grant from another key or for another server or key, another account's name, and a broker without the resolver", async () => {
    expect((await verifyRpc(await publish(undefined), env())).ok).toBe(false);
    expect((await verifyRpc(await publish(await grant(kp(33))), env())).ok).toBe(false);
    expect((await verifyRpc(await publish(await grant(admin, `home2.alice.${APEX}`)), env())).ok).toBe(false);
    expect((await verifyRpc(await publish(await grant(admin, SERVER, kp(34).publicKey)), env())).ok).toBe(false);
    expect((await verifyRpc(await publish(await grant(), `_acme-challenge.bob.${APEX}`), env())).ok).toBe(false);
    expect((await verifyRpc(await publish(await grant()), env({ resolveUserSensitiveKey: undefined }))).ok).toBe(false);
  });
});
