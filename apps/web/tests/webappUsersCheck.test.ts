// Plan A — webapp PWA mirror of the iOS / Android DemoServerBlock
// tests. Pins the `/api/users/check` extension contract on the JS
// side (apps/web/public/webapp/lib/usersCheck.js):
//   - When a typed username matches a `demo_users` row, the response
//     carries a `demoServer` block (fqdn + status + ttlIdleMinutes).
//   - When the username carries ONLY a `testAccount` block (legacy),
//     the `demoServer` field is null and the renderer falls back to
//     the legacy path.
//   - The connect-and-wait helpers POST `/connect`, then poll
//     `/users/check` until the lifecycle flips to `up`.

import { describe, expect, it, vi } from "vitest";

import {
  applyScopeGateToButton,
  checkUsername,
  connectDemoServer,
  DEVICE_SCOPES,
  demoLifecycle,
  demoPodStatus,
  deviceCapabilityAllows,
  deviceCapabilityChipText,
  deviceCapabilityScopeSet,
  isDeviceFullyScoped,
  pollUntilDemoServerUp,
  samplePodFromDemoServer,
} from "../public/webapp/lib/usersCheck.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("webapp usersCheck — Plan A demoServer parsing", () => {
  it("parses a response WITHOUT a demoServer block (legacy testAccount-only)", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      username: "play-reviewer-q2",
      available: false,
      reason: "test account",
      testAccount: { display: "Play Reviewer (Q2)", ttlHours: 6 },
    }));
    const r = await checkUsername("play-reviewer-q2", { fetch: fakeFetch as any });
    expect(r.available).toBe(false);
    expect(r.testAccount?.display).toBe("Play Reviewer (Q2)");
    expect(r.demoServer).toBeUndefined();
  });

  it("parses a response WITH a demoServer block (Plan A live demo)", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      username: "demoalice",
      available: false,
      reason: "test account",
      testAccount: { display: "Demo Alice", ttlHours: 24 },
      demoServer: {
        fqdn: "home.demoalice.flagship.services",
        status: "none",
        ttlIdleMinutes: 30,
      },
    }));
    const r = await checkUsername("demoalice", { fetch: fakeFetch as any });
    expect(r.demoServer?.fqdn).toBe("home.demoalice.flagship.services");
    expect(r.demoServer?.status).toBe("none");
    expect(r.demoServer?.ttlIdleMinutes).toBe(30);
  });

  it("demoLifecycle collapses unknown future values to 'provisioning' (forward-compat)", () => {
    expect(demoLifecycle({ fqdn: "x.flagship.services", status: "up", ttlIdleMinutes: 30 })).toBe("up");
    expect(demoLifecycle({ fqdn: "x.flagship.services", status: "none", ttlIdleMinutes: 30 })).toBe("none");
    expect(demoLifecycle({ fqdn: "x.flagship.services", status: "provisioning", ttlIdleMinutes: 30 })).toBe("provisioning");
    expect(demoLifecycle({ fqdn: "x.flagship.services", status: "weird-future", ttlIdleMinutes: 30 })).toBe("provisioning");
    expect(demoLifecycle(null)).toBeNull();
    expect(demoLifecycle(undefined)).toBeNull();
  });

  it("demoLifecycle derives from the canonical phase when present (single source)", () => {
    // The canonical phase is authoritative: `live` → up regardless of a stale
    // coarse status; any other ladder/terminal phase → provisioning.
    expect(
      demoLifecycle({ fqdn: "x", status: "provisioning", phase: "live", ttlIdleMinutes: 30 } as any),
    ).toBe("up");
    expect(
      demoLifecycle({ fqdn: "x", status: "up", phase: "installing", ttlIdleMinutes: 30 } as any),
    ).toBe("provisioning");
    // A terminal error is NOT a torn-down pod (the daemon retries) → provisioning.
    expect(
      demoLifecycle({ fqdn: "x", status: "up", phase: "error", ttlIdleMinutes: 30 } as any),
    ).toBe("provisioning");
  });

  it("demoPodStatus maps lifecycle to pod-status label", () => {
    expect(demoPodStatus({ fqdn: "x", status: "up", ttlIdleMinutes: 30 })).toBe("online");
    expect(demoPodStatus({ fqdn: "x", status: "provisioning", ttlIdleMinutes: 30 })).toBe("pending");
    expect(demoPodStatus({ fqdn: "x", status: "none", ttlIdleMinutes: 30 })).toBe("pending");
    expect(demoPodStatus(null)).toBeNull();
  });

  it("samplePodFromDemoServer builds ONE pod with status mapped from lifecycle", () => {
    const block = {
      fqdn: "home.demoalice.flagship.services",
      status: "up" as const,
      ttlIdleMinutes: 30,
    };
    const pod = samplePodFromDemoServer(block, "demoalice");
    expect(pod.podId).toBe("demo-server-demoalice");
    expect(pod.name).toBe("Home");
    expect(pod.fqdn).toBe("home.demoalice.flagship.services");
    expect(pod.status).toBe("online");

    const stillProvisioning = samplePodFromDemoServer(
      { ...block, status: "none" },
      "demoalice",
    );
    expect(stillProvisioning.status).toBe("pending");
  });

  it("connectDemoServer POSTs to /api/dev/sample-user/{u}/connect", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await connectDemoServer("demoalice", { fetch: fakeFetch as any });
    const [calledUrl, calledInit] = fakeFetch.mock.calls[0]!;
    expect(calledUrl).toBe("https://flagshipserver.com/api/dev/sample-user/demoalice/connect");
    expect(calledInit.method).toBe("POST");
    expect(calledInit.body).toBe("{}");
  });

  it("connectDemoServer surfaces non-2xx as an error", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );
    await expect(connectDemoServer("demoalice", { fetch: fakeFetch as any }))
      .rejects.toThrow(/429/);
  });

  it("pollUntilDemoServerUp returns the up-block when status flips", async () => {
    let i = 0;
    const responses = [
      jsonResponse(200, {
        username: "demoalice",
        available: false,
        reason: "test account",
        demoServer: { fqdn: "home.demoalice.flagship.services", status: "provisioning", ttlIdleMinutes: 30 },
      }),
      jsonResponse(200, {
        username: "demoalice",
        available: false,
        reason: "test account",
        demoServer: { fqdn: "home.demoalice.flagship.services", status: "up", ttlIdleMinutes: 30 },
      }),
    ];
    const fakeFetch = vi.fn().mockImplementation(() => responses[i++] || responses[responses.length - 1]);
    const block = await pollUntilDemoServerUp("demoalice", {
      fetch: fakeFetch as any,
      pollIntervalMs: 0,
      timeoutMs: 1000,
      sleep: () => Promise.resolve(),
    });
    expect(block.status).toBe("up");
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("pollUntilDemoServerUp throws timedOut when stuck provisioning", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      username: "demoalice",
      available: false,
      reason: "test account",
      demoServer: { fqdn: "home.demoalice.flagship.services", status: "provisioning", ttlIdleMinutes: 30 },
    }));
    let timeNow = 0;
    const realNow = Date.now;
    // Force the deadline to elapse by faking sleep advancing time.
    const sleep = (ms: number) => { timeNow += ms; return Promise.resolve(); };
    Date.now = () => timeNow;
    try {
      await expect(pollUntilDemoServerUp("demoalice", {
        fetch: fakeFetch as any,
        pollIntervalMs: 10,
        timeoutMs: 5,
        sleep,
      })).rejects.toMatchObject({ code: "timedOut", lastStatus: "provisioning" });
    } finally {
      Date.now = realNow;
    }
  });

  it("pollUntilDemoServerUp throws demoServerWentAway when block disappears", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      username: "demoalice",
      available: false,
      reason: "test account",
    }));
    await expect(pollUntilDemoServerUp("demoalice", {
      fetch: fakeFetch as any,
      pollIntervalMs: 0,
      timeoutMs: 1000,
      sleep: () => Promise.resolve(),
    })).rejects.toMatchObject({ code: "demoServerWentAway" });
  });
});

describe("webapp usersCheck — v2 device-addressing deviceCapability", () => {
  it("parses a response WITH a deviceCapability block (browse-only reviewer)", async () => {
    // Wire shape mirrors packages/control-plane/src/usersCheck.ts.
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      username: "demoalice.reviewer",
      available: false,
      reason: "device capability",
      demoServer: {
        fqdn: "home.demoalice.flagship.services",
        status: "up",
        ttlIdleMinutes: 30,
      },
      deviceCapability: {
        label: "reviewer",
        devicePubKey: "0".repeat(64),
        scopes: ["browse"],
        grantId: "00000000-0000-4000-8000-000000000001",
        expiresAt: 9_999_999_999_999,
        signature: "0".repeat(128),
      },
    }));
    const r = await checkUsername("demoalice.reviewer", { fetch: fakeFetch as any });
    expect(r.deviceCapability?.label).toBe("reviewer");
    expect(r.deviceCapability?.scopes).toEqual(["browse"]);
    expect(r.demoServer?.fqdn).toBe("home.demoalice.flagship.services");
  });

  it("DEVICE_SCOPES exports the canonical list (mirror of protocol/auth.ts)", () => {
    expect(DEVICE_SCOPES).toEqual([
      "browse",
      "install-service",
      "vibe-code",
      "add-device",
      "manage-services",
      "revoke-others",
      "demo-provision",
    ]);
  });

  it("deviceCapabilityScopeSet drops unknown future scope strings (forward-compat)", () => {
    const block = {
      label: "reviewer",
      devicePubKey: "0".repeat(64),
      scopes: ["browse", "new-future-scope"],
      grantId: "g",
      expiresAt: 0,
      signature: "0".repeat(128),
    };
    const set = deviceCapabilityScopeSet(block);
    expect(set).toEqual(new Set(["browse"]));
  });

  it("isDeviceFullyScoped is true only when every canonical scope is present", () => {
    expect(isDeviceFullyScoped(null)).toBe(false);
    expect(isDeviceFullyScoped({
      label: "r", devicePubKey: "0", scopes: ["browse"], grantId: "g",
      expiresAt: 0, signature: "0",
    })).toBe(false);
    expect(isDeviceFullyScoped({
      label: "primary", devicePubKey: "0", scopes: [...DEVICE_SCOPES], grantId: "g",
      expiresAt: 0, signature: "0",
    })).toBe(true);
  });

  it("deviceCapabilityChipText returns null for null / fully-scoped (no chip)", () => {
    expect(deviceCapabilityChipText(null)).toBeNull();
    expect(deviceCapabilityChipText(undefined)).toBeNull();
    expect(deviceCapabilityChipText({
      label: "primary", devicePubKey: "0", scopes: [...DEVICE_SCOPES], grantId: "g",
      expiresAt: 0, signature: "0",
    })).toBeNull();
  });

  it("deviceCapabilityChipText renders 'browse-only' for the reviewer canonical state", () => {
    expect(deviceCapabilityChipText({
      label: "reviewer",
      devicePubKey: "0",
      scopes: ["browse"],
      grantId: "g",
      expiresAt: 0,
      signature: "0",
    })).toBe("Device: reviewer · browse-only");
  });

  it("deviceCapabilityChipText renders 'N scopes' for partial-but-multi sets", () => {
    expect(deviceCapabilityChipText({
      label: "work-laptop",
      devicePubKey: "0",
      scopes: ["browse", "install-service", "vibe-code"],
      grantId: "g",
      expiresAt: 0,
      signature: "0",
    })).toBe("Device: work-laptop · 3 scopes");
  });

  it("deviceCapabilityAllows lets every action through when the block is absent (legacy IRK)", () => {
    expect(deviceCapabilityAllows(null, "install-service")).toBe(true);
    expect(deviceCapabilityAllows(undefined, "vibe-code")).toBe(true);
  });

  it("deviceCapabilityAllows gates per-scope when the block is present", () => {
    const cap = {
      label: "reviewer",
      devicePubKey: "0",
      scopes: ["browse"],
      grantId: "g",
      expiresAt: 0,
      signature: "0",
    };
    expect(deviceCapabilityAllows(cap, "browse")).toBe(true);
    expect(deviceCapabilityAllows(cap, "install-service")).toBe(false);
    expect(deviceCapabilityAllows(cap, "vibe-code")).toBe(false);
  });

  it("applyScopeGateToButton disables a button + sets tooltip when scope absent", () => {
    // Minimal DOM stub — JSDom isn't in the vitest config, so we mock
    // the surface the helper actually touches (disabled property + a
    // small attribute store).
    const attrs: Record<string, string> = {};
    const fakeButton = {
      disabled: false,
      setAttribute: (k: string, v: string) => { attrs[k] = v; },
      removeAttribute: (k: string) => { delete attrs[k]; },
    };
    const cap = {
      label: "reviewer",
      devicePubKey: "0",
      scopes: ["browse"],
      grantId: "g",
      expiresAt: 0,
      signature: "0",
    };
    applyScopeGateToButton(
      fakeButton as any,
      cap,
      "install-service",
      "This device cannot install services. Use a primary device.",
    );
    expect(fakeButton.disabled).toBe(true);
    expect(attrs["aria-disabled"]).toBe("true");
    expect(attrs["title"]).toBe("This device cannot install services. Use a primary device.");
    expect(attrs["data-device-restricted"]).toBe("install-service");
  });

  it("applyScopeGateToButton re-enables when the gate is open (legacy / scope present)", () => {
    const attrs: Record<string, string> = {
      "aria-disabled": "true",
      "title": "stale",
      "data-device-restricted": "install-service",
    };
    const fakeButton = {
      disabled: true,
      setAttribute: (k: string, v: string) => { attrs[k] = v; },
      removeAttribute: (k: string) => { delete attrs[k]; },
    };
    // Null block → every scope allowed (legacy single-IRK).
    applyScopeGateToButton(fakeButton as any, null, "install-service", "ignored");
    expect(fakeButton.disabled).toBe(false);
    expect(attrs["aria-disabled"]).toBeUndefined();
    expect(attrs["title"]).toBeUndefined();
    expect(attrs["data-device-restricted"]).toBeUndefined();
  });

  it("applyScopeGateToButton is a no-op on null buttons", () => {
    // Don't throw when the caller passes a missing element.
    expect(() => applyScopeGateToButton(null, null, "install-service", "x")).not.toThrow();
  });
});
