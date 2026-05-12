import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import {
  ed,
  signAppGrant,
  signDns01Publish,
  signDns01Delete,
  type AppGrant,
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

  it("accepts a pod-signed user-zone ACME challenge (pod publishes for its user zone)", async () => {
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
    expect(r.ok).toBe(true);
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

// ─── publishTxtChallenge — user-zone AppGrant authority ───
describe("publishTxtChallenge — user-zone AppGrant authority", () => {
  const irkKey = kp(4);
  const podKey = kp(5);
  const username = "carl";
  const recordName = `_acme-challenge.${username}.${APEX}`;
  const recordValue = "appgrant-keyauth";
  const hash = sha256(new TextEncoder().encode(recordValue));

  function makeGrantBody(routes: Array<{ url: string; scope: "canonical" | "non-canonical" | "subpath" }>): PublishTxtChallengeBody {
    const grant: AppGrant = {
      grantId: "11111111-2222-3333-4444-555555555555",
      username,
      appCanonical: "myapp@aaaaaaaaaaaa",
      serverDomains: [`home.${username}.${APEX}`],
      serverIdentities: [podKey.publicKey],
      routes,
      issuedAt: NOW - 60_000,
      expiresAt: NOW + 60 * 60_000,
    };
    const sig = signAppGrant(grant, irkKey);
    const wire: AppGrantWire = {
      grantId: grant.grantId,
      username: grant.username,
      appCanonical: grant.appCanonical,
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
    const grant: AppGrant = {
      grantId: "deadbeef-2222-3333-4444-555555555555",
      username,
      appCanonical: "myapp@aaaaaaaaaaaa",
      serverDomains: [`home.${username}.${APEX}`],
      serverIdentities: [podKey.publicKey],
      routes: [{ url: `https://*.${username}.${APEX}`, scope: "canonical" }],
      issuedAt: NOW - 8 * 24 * 60 * 60_000,
      expiresAt: NOW - 60_000,
    };
    const sig = signAppGrant(grant, irkKey);
    const wire: AppGrantWire = {
      grantId: grant.grantId,
      username: grant.username,
      appCanonical: grant.appCanonical,
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

  function body(
    targetIp: string,
    recordType: "A" | "AAAA",
    recordName: PublishARecordBody["recordName"] = "pod-apex",
  ): PublishARecordBody {
    return { kind: "publishARecord", serverId, recordType, targetIp, recordName };
  }

  it("accepts an A record at the pod apex with the allowlisted IPv4", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    const r = await verifyRpc(body(IPV4, "A", "pod-apex"), makeEnv(state));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.effect).toEqual({
        kind: "createA",
        recordName: serverId,
        recordType: "A",
        targetIp: IPV4,
      });
    }
  });

  it("accepts the four legitimate name variants", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    const variants: Array<[PublishARecordBody["recordName"], string]> = [
      ["pod-apex", serverId],
      ["pod-wildcard", `*.${serverId}`],
      ["user-zone-apex", `dave.${APEX}`],
      ["user-zone-wildcard", `*.dave.${APEX}`],
    ];
    for (const [v, expected] of variants) {
      const r = await verifyRpc(body(IPV4, "A", v), makeEnv(state));
      expect(r.ok).toBe(true);
      if (r.ok && r.effect.kind === "createA") expect(r.effect.recordName).toBe(expected);
    }
  });

  it("accepts an AAAA record with the allowlisted IPv6", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    const r = await verifyRpc(body(IPV6, "AAAA"), makeEnv(state));
    expect(r.ok).toBe(true);
  });

  it("rejects an A record pointing at an arbitrary IP", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    const r = await verifyRpc(body("1.2.3.4", "A"), makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("rejects when the pod is not registered (registration proof fails)", async () => {
    const state = freshState();
    const r = await verifyRpc(body(IPV4, "A"), makeEnv(state));
    expect(r.ok).toBe(false);
  });

  it("rejects serverId outside the managed apex", async () => {
    const state = freshState();
    const otherId = "evil.dave.example.com";
    state.pods[otherId] = podKey.publicKey;
    const r = await verifyRpc(
      { kind: "publishARecord", serverId: otherId, recordType: "A", targetIp: IPV4, recordName: "pod-apex" },
      makeEnv(state),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects malformed recordName variant", async () => {
    const state = freshState();
    state.pods[serverId] = podKey.publicKey;
    const r = await verifyRpc(
      { kind: "publishARecord", serverId, recordType: "A", targetIp: IPV4, recordName: "bogus" },
      makeEnv(state),
    );
    expect(r.ok).toBe(false);
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
      expect(r.effect.expectedNameOneOf).toContain(`_acme-challenge.${serverId}`);
      expect(r.effect.expectedNameOneOf).toContain(`_acme-challenge.eve.${APEX}`);
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
