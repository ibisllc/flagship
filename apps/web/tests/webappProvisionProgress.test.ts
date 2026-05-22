// Webapp mirror of the protocol provision-progress model + the cancel
// client + the device-metadata wire decode. Keeps the four surfaces
// byte-aligned: the fraction, the four-group labels, and the per-step
// states must match packages/protocol/src/provisionProgress.ts and the
// iOS / Android renderers.

import { describe, expect, it, vi } from "vitest";

import {
  PROVISION_LADDER,
  PROVISION_STEP_GROUPS,
  provisionFraction,
  provisionStepStates,
  shouldShowProgressBar,
  renderListProgressBar,
  renderProgressDetail,
} from "../public/webapp/lib/provisionProgress.js";

import { checkUsername, cancelDemoServer } from "../public/webapp/lib/usersCheck.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("webapp provisionFraction", () => {
  it("0 for null/unknown, 1 for ready, 0 for bare failed", () => {
    expect(provisionFraction(null)).toBe(0);
    expect(provisionFraction("nope")).toBe(0);
    expect(provisionFraction("ready")).toBe(1);
    expect(provisionFraction("failed")).toBe(0);
  });

  it("monotonic along the ladder", () => {
    let prev = -1;
    for (const p of PROVISION_LADDER) {
      const f = provisionFraction(p);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });
});

describe("webapp PROVISION_STEP_GROUPS", () => {
  it("matches the canonical four groups + labels", () => {
    expect(PROVISION_STEP_GROUPS.map((g) => g.label)).toEqual([
      "Booting",
      "Registering",
      "Securing (TLS certificate)",
      "Ready",
    ]);
  });
});

describe("webapp provisionStepStates", () => {
  it("ACME sub-phase activates securing with its title", () => {
    const v = provisionStepStates("dns01-propagation-wait");
    expect(v.map((s) => s.state)).toEqual(["done", "done", "active", "pending"]);
    expect(v[2]!.detail).toBe("Waiting for DNS");
  });

  it("failed surfaces lastError on the first group with no hint", () => {
    const v = provisionStepStates("failed", "boom");
    expect(v[0]!.state).toBe("failed");
    expect(v[0]!.detail).toBe("boom");
  });
});

describe("webapp shouldShowProgressBar (list-bar visibility)", () => {
  it("shows for provisioning / mid-phase, hides for ready / none / absent", () => {
    expect(shouldShowProgressBar(null)).toBe(false);
    expect(shouldShowProgressBar({ status: "none" })).toBe(false);
    expect(shouldShowProgressBar({ status: "up", phase: "ready" })).toBe(false);
    expect(shouldShowProgressBar({ status: "up", phase: null })).toBe(false);
    expect(shouldShowProgressBar({ status: "provisioning", phase: "deps" })).toBe(true);
    expect(shouldShowProgressBar({ status: "provisioning", phase: null })).toBe(true);
    expect(shouldShowProgressBar({ status: "provisioning", phase: "failed" })).toBe(true);
  });
});

describe("webapp render helpers", () => {
  it("renderListProgressBar emits a sized bar pre-ready and '' when ready", () => {
    const bar = renderListProgressBar({ status: "provisioning", phase: "registered" });
    expect(bar).toContain("demo-progress-fill");
    expect(bar).toContain("role=\"progressbar\"");
    expect(renderListProgressBar({ status: "up", phase: "ready" })).toBe("");
  });

  it("renderProgressDetail includes the four steps + device info + escapes error", () => {
    const html = renderProgressDetail({
      phase: "failed",
      lastError: "<bad> & ugly",
      ip: "1.2.3.4",
      region: "fsn1",
      image: "debian-12",
      serverType: "cx22",
    });
    expect(html).toContain("Booting");
    expect(html).toContain("Securing (TLS certificate)");
    expect(html).toContain("1.2.3.4");
    expect(html).toContain("debian-12");
    expect(html).toContain("retrying");
    expect(html).toContain("&lt;bad&gt;");
    expect(html).not.toContain("<bad>");
  });
});

describe("webapp metadata wire decode", () => {
  it("parses ip / region / serverType / image off the demoServer block", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      username: "demoalice",
      available: false,
      demoServer: {
        fqdn: "home.demoalice.flagship.services",
        status: "provisioning",
        ttlIdleMinutes: 30,
        phase: "acme-validating",
        phaseAt: 12345,
        ip: "1.2.3.4",
        region: "fsn1",
        serverType: "cx22",
        image: "debian-12",
      },
    }));
    const r = await checkUsername("demoalice", { fetch: fakeFetch as any });
    expect(r.demoServer?.ip).toBe("1.2.3.4");
    expect(r.demoServer?.region).toBe("fsn1");
    expect(r.demoServer?.serverType).toBe("cx22");
    expect(r.demoServer?.image).toBe("debian-12");
    expect(r.demoServer?.phase).toBe("acme-validating");
  });
});

describe("webapp cancelDemoServer", () => {
  it("POSTs /cancel and returns the parsed body", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, { username: "demoalice", cancelled: true, state: "none" }),
    );
    const r = await cancelDemoServer("demoalice", { fetch: fakeFetch as any });
    expect(r.cancelled).toBe(true);
    expect(r.state).toBe("none");
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(String(url)).toContain("/api/dev/sample-user/demoalice/cancel");
    expect(init.method).toBe("POST");
  });

  it("throws on a non-2xx", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(502, { error: "x" }));
    await expect(cancelDemoServer("demoalice", { fetch: fakeFetch as any })).rejects.toThrow(
      /cancel failed/,
    );
  });
});
