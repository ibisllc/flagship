import { describe, expect, it, vi } from "vitest";
import {
  normalizeOrderSerial,
  reportProvisionStatus,
  type ProvisionStatusPhase,
} from "../src/index.js";

const SERIAL = "01HXAFORDER0001";
const BASE = "https://flagshipserver.com";

describe("normalizeOrderSerial", () => {
  it("trims + accepts a well-formed serial", () => {
    expect(normalizeOrderSerial(`  ${SERIAL}\n`)).toBe(SERIAL);
  });
  it("returns null for absent / blank / malformed serials", () => {
    expect(normalizeOrderSerial(null)).toBeNull();
    expect(normalizeOrderSerial(undefined)).toBeNull();
    expect(normalizeOrderSerial("")).toBeNull();
    expect(normalizeOrderSerial("short")).toBeNull(); // < 8 chars
    expect(normalizeOrderSerial("has spaces in it!!")).toBeNull();
  });
});

describe("reportProvisionStatus", () => {
  it("POSTs {phase} to the per-order status URL", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await reportProvisionStatus({
      serial: SERIAL,
      controlPlaneBaseUrl: BASE,
      phase: "live",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/order/${SERIAL}/status`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ phase: "live" });
  });

  it("includes detail when supplied and strips a trailing slash on the base", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await reportProvisionStatus({
      serial: SERIAL,
      controlPlaneBaseUrl: `${BASE}/`,
      phase: "error",
      detail: "boom",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/order/${SERIAL}/status`);
    expect(JSON.parse(init.body as string)).toEqual({ phase: "error", detail: "boom" });
  });

  it("is fail-open: a rejecting fetch never throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      reportProvisionStatus({
        serial: SERIAL,
        controlPlaneBaseUrl: BASE,
        phase: "live",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/**
 * Mirrors the daemon's `reportStatus` closure (index.ts main()): one POST
 * per phase transition, gated on a baked serial. This is the
 * "compute + post live once serving" logic — onCertIssued fires on every
 * cert acquisition + renewal, so `live` must post exactly once.
 */
function makeReporter(serial: string | null, fetchImpl: typeof fetch) {
  const reported = new Set<string>();
  return (phase: ProvisionStatusPhase, detail?: string) => {
    if (!serial) return;
    if (reported.has(phase)) return;
    reported.add(phase);
    return reportProvisionStatus({
      serial,
      controlPlaneBaseUrl: BASE,
      phase,
      ...(detail !== undefined ? { detail } : {}),
      fetchImpl,
    });
  };
}

describe("daemon status reporter (compute + post live once serving)", () => {
  it("posts `live` exactly once across repeated cert-issued events", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const serial = normalizeOrderSerial(SERIAL);
    const reportStatus = makeReporter(serial, fetchImpl);

    // First successful serve (cert lands).
    await reportStatus("live");
    // Cert renewal — onCertIssued fires again; must NOT re-POST `live`.
    await reportStatus("live");
    await reportStatus("live");

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const init = calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ phase: "live" });
  });

  it("posts `pairing` then `live` as distinct transitions", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const reportStatus = makeReporter(normalizeOrderSerial(SERIAL), fetchImpl);

    await reportStatus("pairing");
    await reportStatus("live");
    await reportStatus("pairing"); // already sent — dropped

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(JSON.parse((calls[0]![1] as RequestInit).body as string)).toEqual({
      phase: "pairing",
    });
    expect(JSON.parse((calls[1]![1] as RequestInit).body as string)).toEqual({
      phase: "live",
    });
  });

  it("no baked serial → reporter is a no-op (never fetches)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const reportStatus = makeReporter(normalizeOrderSerial(null), fetchImpl);

    await reportStatus("live");
    await reportStatus("pairing");

    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
