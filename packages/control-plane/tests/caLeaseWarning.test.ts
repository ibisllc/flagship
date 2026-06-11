import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import {
  CA_LEASE_WARN_THRESHOLD_MS,
  CA_LEASE_AUDIT_USERNAME,
  computeCaLeaseStatus,
  runCaLeaseWarningCheck,
  handleCaLeaseStatus,
} from "../src/caLeaseWarning.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

describe("computeCaLeaseStatus", () => {
  it("returns 'none' when there are no active leases", () => {
    const s = computeCaLeaseStatus([], NOW);
    expect(s.severity).toBe("none");
    expect(s.hasActiveLease).toBe(false);
    expect(s.soonestNotAfterMs).toBeNull();
  });

  it("returns 'ok' when the soonest lease is comfortably in the future", () => {
    const s = computeCaLeaseStatus([NOW + 30 * DAY], NOW);
    expect(s.severity).toBe("ok");
    expect(s.msUntilExpiry).toBe(30 * DAY);
  });

  it("returns 'warn' inside the 7-day threshold", () => {
    const s = computeCaLeaseStatus([NOW + 3 * DAY], NOW);
    expect(s.severity).toBe("warn");
  });

  it("returns 'expired' once notAfter has passed", () => {
    const s = computeCaLeaseStatus([NOW - 1], NOW);
    expect(s.severity).toBe("expired");
    expect(s.msUntilExpiry).toBeLessThan(0);
  });

  it("uses the soonest of multiple leases", () => {
    const s = computeCaLeaseStatus([NOW + 30 * DAY, NOW + 2 * DAY], NOW);
    expect(s.severity).toBe("warn");
    expect(s.soonestNotAfterMs).toBe(NOW + 2 * DAY);
  });
});

describe("runCaLeaseWarningCheck", () => {
  it("does NOT alert when the lease is healthy", async () => {
    const storage = new InMemoryStorage();
    const r = await runCaLeaseWarningCheck({
      activeLeaseNotAfterMs: () => [NOW + 30 * DAY],
      auditEvents: storage.auditEvents,
      now: () => NOW,
    });
    expect(r.alerted).toBe(false);
    const audit = await storage.auditEvents.list(
      CA_LEASE_AUDIT_USERNAME,
      0,
      100,
    );
    expect(audit).toEqual([]);
  });

  it("emits a high-severity audit event + invokes notifyOperator on warn", async () => {
    const storage = new InMemoryStorage();
    let notified = false;
    const r = await runCaLeaseWarningCheck({
      activeLeaseNotAfterMs: () => [NOW + 2 * DAY],
      auditEvents: storage.auditEvents,
      now: () => NOW,
      notifyOperator: async () => {
        notified = true;
      },
    });
    expect(r.alerted).toBe(true);
    expect(r.status.severity).toBe("warn");
    expect(notified).toBe(true);
    const audit = await storage.auditEvents.list(
      CA_LEASE_AUDIT_USERNAME,
      0,
      100,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toContain("ca-lease warn");
  });

  it("alerts on expired and survives a throwing notifyOperator", async () => {
    const storage = new InMemoryStorage();
    const r = await runCaLeaseWarningCheck({
      activeLeaseNotAfterMs: () => [NOW - 1],
      auditEvents: storage.auditEvents,
      now: () => NOW,
      notifyOperator: async () => {
        throw new Error("pager down");
      },
    });
    // Audit write still lands despite the notify throw.
    expect(r.alerted).toBe(true);
    expect(r.status.severity).toBe("expired");
    const audit = await storage.auditEvents.list(
      CA_LEASE_AUDIT_USERNAME,
      0,
      100,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toContain("ca-lease expired");
  });

  it("respects a custom threshold", async () => {
    const storage = new InMemoryStorage();
    const r = await runCaLeaseWarningCheck({
      activeLeaseNotAfterMs: () => [NOW + 10 * DAY],
      auditEvents: storage.auditEvents,
      now: () => NOW,
      thresholdMs: 14 * DAY,
    });
    expect(r.alerted).toBe(true); // 10d < 14d threshold
  });
});

describe("handleCaLeaseStatus", () => {
  it("returns the lease status with an ISO timestamp", async () => {
    const r = await handleCaLeaseStatus({
      activeLeaseNotAfterMs: () => [NOW + 3 * DAY],
      now: () => NOW,
    });
    expect(r.status).toBe(200);
    expect(r.body.severity).toBe("warn");
    expect(r.body.soonestNotAfterIso).toBe(
      new Date(NOW + 3 * DAY).toISOString(),
    );
    expect(r.body.thresholdMs).toBe(CA_LEASE_WARN_THRESHOLD_MS);
  });

  it("reports 'none' with a null ISO when no lease is active", async () => {
    const r = await handleCaLeaseStatus({
      activeLeaseNotAfterMs: () => [],
      now: () => NOW,
    });
    expect(r.body.severity).toBe("none");
    expect(r.body.soonestNotAfterIso).toBeNull();
  });
});
