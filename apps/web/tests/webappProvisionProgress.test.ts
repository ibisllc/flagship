// Webapp mirror of the protocol provision-progress model + the cancel
// client + the device-metadata wire decode. Keeps the four surfaces
// byte-aligned: the fraction, the four-group labels, and the per-step
// states must match packages/protocol/src/provisionProgress.ts and the
// iOS / Android renderers.

import { describe, expect, it, vi } from "vitest";

import {
  PROVISION_LADDER,
  PROVISION_STEP_GROUPS,
  INSTALLED_DONE_DETAIL,
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
  it("0 for null/unknown, 1 for live, 0 for bare error", () => {
    expect(provisionFraction(null)).toBe(0);
    expect(provisionFraction("nope")).toBe(0);
    expect(provisionFraction("live")).toBe(1);
    expect(provisionFraction("error")).toBe(0);
  });

  it("monotonic along the canonical ladder", () => {
    let prev = -1;
    for (const p of PROVISION_LADDER) {
      const f = provisionFraction(p);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });

  it("the ladder is the canonical 9-phase vocabulary in MONOTONIC wire order (downloading after installing, installed after sealing)", () => {
    expect(PROVISION_LADDER).toEqual([
      "booting",
      "partitioning",
      "installing",
      "downloading",
      "registering",
      "sealing",
      "installed",
      "pairing",
      "live",
    ]);
    const idx = (p: string) => PROVISION_LADDER.indexOf(p);
    expect(idx("downloading")).toBeGreaterThan(idx("installing"));
    expect(idx("installed")).toBeGreaterThan(idx("sealing"));
  });
});

describe("webapp PROVISION_STEP_GROUPS", () => {
  it("matches the canonical group projection + labels (design §1.2) — `installed` is its own rung after Securing", () => {
    expect(PROVISION_STEP_GROUPS.map((g) => g.label)).toEqual([
      "Booting",
      "Installing",
      "Registering",
      "Securing (TLS certificate)",
      "Install complete — unplug the USB",
      "Ready",
    ]);
    // `installed` is now its own rendered rung, positioned after Securing.
    expect(PROVISION_STEP_GROUPS.some((g) => g.key === "installed")).toBe(true);
    const installing = PROVISION_STEP_GROUPS.find((g) => g.key === "installing")!;
    expect(installing.phases).toEqual(["installing", "downloading"]);
    const installed = PROVISION_STEP_GROUPS.find((g) => g.key === "installed")!;
    expect(installed.phases).toEqual(["installed"]);
    // `installed` sorts after `securing`.
    const keys = PROVISION_STEP_GROUPS.map((g) => g.key);
    expect(keys.indexOf("installed")).toBeGreaterThan(keys.indexOf("securing"));
  });

  it("keeps `installed` a valid WIRE phase + push milestone", () => {
    expect(PROVISION_LADDER).toContain("installed");
  });
});

describe("webapp provisionStepStates", () => {
  it("a registering phase activates the Registering group with its title", () => {
    const v = provisionStepStates("registering");
    // 6 rendered groups now (installed is its own rung after Securing):
    // Booting + Installing done; Registering active; Securing + Installed +
    // Ready pending.
    expect(v.map((s) => s.state)).toEqual([
      "done", "done", "active", "pending", "pending", "pending",
    ]);
    expect(v[2]!.detail).toBe("Registering with Flagship");
  });

  it("the 'installed' phase is its own ACTIVE rung (after Securing) carrying the unplug-and-power-on instruction", () => {
    const v = provisionStepStates("installed");
    // Booting…Securing DONE; Installed active (action needed); Ready pending.
    expect(v.map((s) => s.state)).toEqual([
      "done", "done", "done", "done", "active", "pending",
    ]);
    // The Installed row carries the action detail.
    const installed = v.find((s) => s.key === "installed")!;
    expect(installed.state).toBe("active");
    expect(installed.detail).toBe(INSTALLED_DONE_DETAIL);
    expect(installed.detail).toBe(
      "Install complete — unplug the USB, then power the box back on.",
    );
    // `installed` IS a standalone rendered rung now.
    expect(v.some((s) => s.key === "installed")).toBe(true);
  });

  it("error surfaces lastError on the first group with no hint", () => {
    const v = provisionStepStates("error", "boom");
    expect(v[0]!.state).toBe("failed");
    expect(v[0]!.detail).toBe("boom");
  });

  it("an error break AT `installed` fails the Installed group (its own rung)", () => {
    const v = provisionStepStates("error", "disk full", "installed");
    // Booting…Securing done; Installed failed; Ready pending.
    expect(v.map((s) => s.state)).toEqual([
      "done", "done", "done", "done", "failed", "pending",
    ]);
    const installed = v.find((s) => s.key === "installed")!;
    expect(installed.state).toBe("failed");
    expect(installed.detail).toBe("disk full");
  });
});

describe("webapp shouldShowProgressBar (list-bar visibility)", () => {
  it("shows for provisioning / mid-phase, hides for live / none / absent", () => {
    expect(shouldShowProgressBar(null)).toBe(false);
    expect(shouldShowProgressBar({ status: "none" })).toBe(false);
    expect(shouldShowProgressBar({ status: "up", phase: "live" })).toBe(false);
    expect(shouldShowProgressBar({ status: "up", phase: null })).toBe(false);
    expect(shouldShowProgressBar({ status: "provisioning", phase: "installing" })).toBe(true);
    expect(shouldShowProgressBar({ status: "provisioning", phase: null })).toBe(true);
    expect(shouldShowProgressBar({ status: "provisioning", phase: "error" })).toBe(true);
  });
});

describe("webapp render helpers", () => {
  it("renderListProgressBar emits a sized bar pre-live and '' when live", () => {
    const bar = renderListProgressBar({ status: "provisioning", phase: "registering" });
    expect(bar).toContain("demo-progress-fill");
    expect(bar).toContain("role=\"progressbar\"");
    expect(renderListProgressBar({ status: "up", phase: "live" })).toBe("");
  });

  it("renderProgressDetail includes the canonical groups + device info + escapes error", () => {
    const html = renderProgressDetail({
      phase: "error",
      lastError: "<bad> & ugly",
      ip: "1.2.3.4",
      region: "fsn1",
      image: "debian-12",
      serverType: "cx22",
    });
    expect(html).toContain("Booting");
    expect(html).toContain("Installing");
    expect(html).toContain("Securing (TLS certificate)");
    expect(html).toContain("1.2.3.4");
    expect(html).toContain("debian-12");
    expect(html).toContain("retrying");
    expect(html).toContain("&lt;bad&gt;");
    expect(html).not.toContain("<bad>");
  });
});

describe("webapp metadata wire decode", () => {
  it("parses ip / region / serverType / image + canonical phase off the demoServer block", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      username: "demoalice",
      available: false,
      demoServer: {
        fqdn: "home.demoalice.flagship.services",
        status: "provisioning",
        ttlIdleMinutes: 30,
        phase: "sealing",
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
    expect(r.demoServer?.phase).toBe("sealing");
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
