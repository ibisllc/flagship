/**
 * Server-side Certificate Transparency (CT) monitoring tests.
 *
 * Covers the four required cases with a mocked CT source + mocked
 * daemon_status baseline + mocked push fan-out:
 *   (a) CT cert matching the baseline                 → no alert
 *   (b) CT cert NOT in baseline (baseline present)    → one push + one
 *       audit, and a SECOND scan does NOT re-alert (dedup)
 *   (c) no baseline yet                               → audit-only, no push
 *   (d) crt.sh failure                                → no throw, no alert
 *
 * Plus: the newer-than-earliest-report guard (an A′-shaped cert that
 * predates the first baseline report is not alarmed), the A′ SAN-shape
 * rule (a cert that is not a registered box's `[apex, *.apex]` pair —
 * e.g. an old-style model-C `[<user>, *.<user>]` wildcard — is flagged
 * with NO predates-baseline exemption), normalization (colons/case),
 * and the per-run domain/query caps.
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryStorage,
  type DaemonStatusRecord,
  type PushTokenRecord,
  type ServerRecord,
} from "@flagship/storage";
import {
  runCtScan,
  normalizeSha256,
  createCrtShSource,
  type CtObservedCert,
  type CtSource,
  type V12PushFanout,
} from "../src/index.js";

const USER = "alice";
const FIXED_NOW = 1_700_000_000_000;
const SERVER_FQDN = "home.alice.flagship.services";

function server(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    serverDomain: SERVER_FQDN,
    username: USER,
    identityPubKeyHex: "11".repeat(32),
    registeredAt: FIXED_NOW - 86_400_000,
    ...overrides,
  };
}

function daemon(certSha256: string | null, lastReported: number): DaemonStatusRecord {
  return {
    serverDomain: SERVER_FQDN,
    certSha256,
    certValidUntil: FIXED_NOW + 30 * 86_400_000,
    certIssuer: "Let's Encrypt",
    servicesServedJson: "[]",
    lastReported,
  };
}

function pushToken(): PushTokenRecord {
  return {
    tokenId: "ff".repeat(8),
    username: USER,
    platform: "apns",
    providerToken: "device-token-abc",
    pushX25519PubHex: "22".repeat(32),
    registrationSignatureHex: "33".repeat(64),
    label: "Alice's iPhone",
    registeredAt: FIXED_NOW - 86_400_000,
    lastSeenAt: FIXED_NOW,
  };
}

/** A′-shaped cert: the registered box's `[apex, *.apex]` SAN pair. */
function observed(sha256: string, notBefore: number): CtObservedCert {
  return observedWithSans(sha256, notBefore, [SERVER_FQDN, `*.${SERVER_FQDN}`]);
}

function observedWithSans(
  sha256: string,
  notBefore: number,
  sanNames: string[],
): CtObservedCert {
  return {
    sha256,
    notBefore,
    issuer: "Let's Encrypt",
    sanNames,
  };
}

/** A recording push fan-out + a CT source returning a fixed list. */
function harness(opts: {
  ctCerts?: CtObservedCert[];
  ctThrows?: boolean;
}) {
  const storage = new InMemoryStorage();
  const pushes: Array<{ username: string; category: string; body: string }> = [];
  const pushFanout: V12PushFanout = async (args) => {
    pushes.push({
      username: args.username,
      category: args.payload.category,
      body: args.payload.body,
    });
  };
  const ctSource: CtSource = async () => {
    if (opts.ctThrows) {
      // The real crt.sh client swallows errors itself; the scan must
      // also be robust if a source ever rejects. We simulate the
      // contract-honoring source (returns []) UNLESS ctThrows.
      throw new Error("crt.sh unreachable");
    }
    return opts.ctCerts ?? [];
  };
  return { storage, pushes, pushFanout, ctSource };
}

async function auditRows(storage: InMemoryStorage) {
  return storage.auditEvents.list(USER, 0, 100);
}

describe("normalizeSha256", () => {
  it("strips colons + whitespace and lowercases", () => {
    expect(normalizeSha256("AB:CD:ef 01")).toBe("abcdef01");
    expect(normalizeSha256("  DEADbeef\n")).toBe("deadbeef");
  });
});

describe("runCtScan — (a) cert matches baseline → no alert", () => {
  it("does not push or audit when the observed cert is the box's cert", async () => {
    const baselineSha = "aa".repeat(32);
    const { storage, pushes, pushFanout, ctSource } = harness({
      // Same sha, even with colons/uppercase to prove normalization.
      ctCerts: [observed("AA:".repeat(31) + "AA", FIXED_NOW)],
    });
    await storage.servers.put(server());
    await storage.daemonStatus.put(daemon(baselineSha, FIXED_NOW - 3_600_000));
    await storage.pushTokens.put(pushToken());

    const res = await runCtScan({
      servers: storage.servers,
      daemonStatus: storage.daemonStatus,
      auditEvents: storage.auditEvents,
      ctAlerts: storage.ctAlerts,
      ctSource,
      pushTokens: storage.pushTokens,
      pushFanout,
      now: () => FIXED_NOW,
    });

    expect(res.usersScanned).toBe(1);
    expect(res.alerted).toBe(0);
    expect(pushes).toHaveLength(0);
    expect(await auditRows(storage)).toHaveLength(0);
  });
});

describe("runCtScan — (b) unexpected cert (baseline present) → push + audit + dedup", () => {
  it("alerts once and does not re-alert on a second scan", async () => {
    const baselineSha = "aa".repeat(32);
    const rogueSha = "bb".repeat(32);
    const { storage, pushes, pushFanout, ctSource } = harness({
      // Rogue cert minted AFTER the earliest baseline report.
      ctCerts: [observed(rogueSha, FIXED_NOW)],
    });
    await storage.servers.put(server());
    await storage.daemonStatus.put(daemon(baselineSha, FIXED_NOW - 3_600_000));
    await storage.pushTokens.put(pushToken());

    const deps = {
      servers: storage.servers,
      daemonStatus: storage.daemonStatus,
      auditEvents: storage.auditEvents,
      ctAlerts: storage.ctAlerts,
      ctSource,
      pushTokens: storage.pushTokens,
      pushFanout,
      now: () => FIXED_NOW,
    };

    const res1 = await runCtScan(deps);
    expect(res1.alerted).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.category).toBe("ct-unexpected-cert");
    expect(pushes[0]?.body).toContain("none of your devices requested");
    const audits1 = await auditRows(storage);
    expect(audits1).toHaveLength(1);
    expect(audits1[0]?.eventKind).toBe("ct-unexpected-cert");
    expect(audits1[0]?.detail).toContain(rogueSha);
    expect(await storage.ctAlerts.has(USER, rogueSha)).toBe(true);

    // Second scan: SAME rogue cert observed again → no re-alert.
    const res2 = await runCtScan(deps);
    expect(res2.alerted).toBe(0);
    expect(pushes).toHaveLength(1); // still just the one push
    expect(await auditRows(storage)).toHaveLength(1); // no extra audit
  });

  it("audit-only (no push) when no push provider is wired", async () => {
    const baselineSha = "aa".repeat(32);
    const rogueSha = "bb".repeat(32);
    const { storage, ctSource } = harness({
      ctCerts: [observed(rogueSha, FIXED_NOW)],
    });
    await storage.servers.put(server());
    await storage.daemonStatus.put(daemon(baselineSha, FIXED_NOW - 3_600_000));
    await storage.pushTokens.put(pushToken());

    const res = await runCtScan({
      servers: storage.servers,
      daemonStatus: storage.daemonStatus,
      auditEvents: storage.auditEvents,
      ctAlerts: storage.ctAlerts,
      ctSource,
      // no pushFanout
      now: () => FIXED_NOW,
    });

    // Still counts as alerted (slot claimed + audited); just no device push.
    expect(res.alerted).toBe(1);
    expect(await auditRows(storage)).toHaveLength(1);
  });

  it("does NOT alarm an A′-shaped cert that predates the earliest baseline report", async () => {
    const baselineSha = "aa".repeat(32);
    const oldLegitSha = "cc".repeat(32);
    const { storage, pushes, pushFanout, ctSource } = harness({
      // notBefore is BEFORE the earliest daemon report.
      ctCerts: [observed(oldLegitSha, FIXED_NOW - 10 * 86_400_000)],
    });
    await storage.servers.put(server());
    await storage.daemonStatus.put(daemon(baselineSha, FIXED_NOW - 3_600_000));
    await storage.pushTokens.put(pushToken());

    const res = await runCtScan({
      servers: storage.servers,
      daemonStatus: storage.daemonStatus,
      auditEvents: storage.auditEvents,
      ctAlerts: storage.ctAlerts,
      ctSource,
      pushTokens: storage.pushTokens,
      pushFanout,
      now: () => FIXED_NOW,
    });

    expect(res.alerted).toBe(0);
    expect(pushes).toHaveLength(0);
    expect(await auditRows(storage)).toHaveLength(0);
  });
});

describe("runCtScan — A′ SAN shape: a non-per-box cert is always flagged", () => {
  it("flags an old-style per-user wildcard cert even when it predates the baseline", async () => {
    const baselineSha = "aa".repeat(32);
    const oldStyleSha = "ee".repeat(32);
    const { storage, pushes, pushFanout, ctSource } = harness({
      // Model-C shape `[<user>, *.<user>]`, notBefore long BEFORE the
      // earliest daemon report. Under A′ this shape can never be legit, so
      // the predates-baseline exemption must NOT apply.
      ctCerts: [
        observedWithSans(oldStyleSha, FIXED_NOW - 10 * 86_400_000, [
          `${USER}.flagship.services`,
          `*.${USER}.flagship.services`,
        ]),
      ],
    });
    await storage.servers.put(server());
    await storage.daemonStatus.put(daemon(baselineSha, FIXED_NOW - 3_600_000));
    await storage.pushTokens.put(pushToken());

    const res = await runCtScan({
      servers: storage.servers,
      daemonStatus: storage.daemonStatus,
      auditEvents: storage.auditEvents,
      ctAlerts: storage.ctAlerts,
      ctSource,
      pushTokens: storage.pushTokens,
      pushFanout,
      now: () => FIXED_NOW,
    });

    expect(res.alerted).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.category).toBe("ct-unexpected-cert");
    const audits = await auditRows(storage);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toContain(oldStyleSha);
  });

  it("flags a cert that pairs a box SAN with a foreign name, even predating the baseline", async () => {
    const baselineSha = "aa".repeat(32);
    const mixedSha = "ab".repeat(32);
    const { storage, pushes, pushFanout, ctSource } = harness({
      ctCerts: [
        observedWithSans(mixedSha, FIXED_NOW - 10 * 86_400_000, [
          SERVER_FQDN,
          "attacker.example",
        ]),
      ],
    });
    await storage.servers.put(server());
    await storage.daemonStatus.put(daemon(baselineSha, FIXED_NOW - 3_600_000));
    await storage.pushTokens.put(pushToken());

    const res = await runCtScan({
      servers: storage.servers,
      daemonStatus: storage.daemonStatus,
      auditEvents: storage.auditEvents,
      ctAlerts: storage.ctAlerts,
      ctSource,
      pushTokens: storage.pushTokens,
      pushFanout,
      now: () => FIXED_NOW,
    });

    expect(res.alerted).toBe(1);
    expect(pushes).toHaveLength(1);
  });
});

describe("runCtScan — (c) no baseline yet → audit-only, no push", () => {
  it("audit-logs the observed cert but never pushes before any box reports", async () => {
    const legitSha = "dd".repeat(32);
    const { storage, pushes, pushFanout, ctSource } = harness({
      ctCerts: [observed(legitSha, FIXED_NOW)],
    });
    await storage.servers.put(server());
    // daemon row with NO certSha256 (or none at all) → no baseline.
    await storage.daemonStatus.put(daemon(null, FIXED_NOW - 3_600_000));
    await storage.pushTokens.put(pushToken());

    const res = await runCtScan({
      servers: storage.servers,
      daemonStatus: storage.daemonStatus,
      auditEvents: storage.auditEvents,
      ctAlerts: storage.ctAlerts,
      ctSource,
      pushTokens: storage.pushTokens,
      pushFanout,
      now: () => FIXED_NOW,
    });

    expect(res.alerted).toBe(0);
    expect(pushes).toHaveLength(0);
    const audits = await auditRows(storage);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.eventKind).toBe("ct-unexpected-cert");
    expect(audits[0]?.detail).toContain("no baseline yet");
    // Crucially: no alert slot claimed → a later scan (with a baseline)
    // can still escalate this cert to a push.
    expect(await storage.ctAlerts.has(USER, legitSha)).toBe(false);
  });
});

describe("runCtScan — (d) crt.sh failure → no throw, no alert", () => {
  it("swallows a throwing source and completes the run", async () => {
    const baselineSha = "aa".repeat(32);
    const { storage, pushes, pushFanout, ctSource } = harness({ ctThrows: true });
    await storage.servers.put(server());
    await storage.daemonStatus.put(daemon(baselineSha, FIXED_NOW - 3_600_000));
    await storage.pushTokens.put(pushToken());

    // runCtScan isolates per-user errors, so a throwing source must not
    // bubble out, and must produce no alert.
    const res = await runCtScan({
      servers: storage.servers,
      daemonStatus: storage.daemonStatus,
      auditEvents: storage.auditEvents,
      ctAlerts: storage.ctAlerts,
      ctSource,
      pushTokens: storage.pushTokens,
      pushFanout,
      now: () => FIXED_NOW,
      log: () => {}, // silence the isolated-failure log line in tests
    });

    expect(res.alerted).toBe(0);
    expect(pushes).toHaveLength(0);
    expect(await auditRows(storage)).toHaveLength(0);
  });
});

describe("createCrtShSource", () => {
  it("returns [] on a non-ok response (never throws)", async () => {
    const src = createCrtShSource({
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => [] }),
    });
    await expect(src("alice.flagship.services")).resolves.toEqual([]);
  });

  it("returns [] when fetch rejects (network error)", async () => {
    const src = createCrtShSource({
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(src("alice.flagship.services")).resolves.toEqual([]);
  });

  it("parses crt.sh rows into observed certs", async () => {
    const src = createCrtShSource({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => [
          {
            serial_number: "04AB",
            not_before: "2026-01-02T03:04:05",
            issuer_name: "C=US, O=Let's Encrypt",
            common_name: "alice.flagship.services",
            name_value: "alice.flagship.services\n*.alice.flagship.services",
          },
        ],
      }),
    });
    const certs = await src("alice.flagship.services");
    expect(certs).toHaveLength(1);
    expect(certs[0]?.sha256).toBe("04ab");
    expect(certs[0]?.sanNames).toContain("alice.flagship.services");
    expect(certs[0]?.notBefore).toBe(Date.parse("2026-01-02T03:04:05Z"));
  });
});

describe("runCtScan — bounded / capped", () => {
  it("caps the number of users scanned per run and reports the overflow", async () => {
    const storage = new InMemoryStorage();
    const ctSource: CtSource = async () => [];
    // Three distinct users, all with one server.
    for (const u of ["u1", "u2", "u3"]) {
      await storage.servers.put({
        serverDomain: `home.${u}.flagship.services`,
        username: u,
        identityPubKeyHex: "11".repeat(32),
        registeredAt: FIXED_NOW,
      });
    }
    const res = await runCtScan({
      servers: storage.servers,
      daemonStatus: storage.daemonStatus,
      auditEvents: storage.auditEvents,
      ctAlerts: storage.ctAlerts,
      ctSource,
      maxUsersPerRun: 2,
      now: () => FIXED_NOW,
      log: () => {},
    });
    expect(res.usersScanned).toBe(2);
    expect(res.usersSkippedForCap).toBe(1);
  });

  it("skips revoked servers' users", async () => {
    const storage = new InMemoryStorage();
    const ctSource: CtSource = async () => [];
    await storage.servers.put({
      serverDomain: "home.revoked.flagship.services",
      username: "revoked",
      identityPubKeyHex: "11".repeat(32),
      registeredAt: FIXED_NOW,
      revokedAt: FIXED_NOW,
    });
    const res = await runCtScan({
      servers: storage.servers,
      daemonStatus: storage.daemonStatus,
      auditEvents: storage.auditEvents,
      ctAlerts: storage.ctAlerts,
      ctSource,
      now: () => FIXED_NOW,
      log: () => {},
    });
    expect(res.usersScanned).toBe(0);
  });
});
