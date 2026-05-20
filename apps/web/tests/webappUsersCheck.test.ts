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
  checkUsername,
  connectDemoServer,
  demoLifecycle,
  demoPodStatus,
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
      username: "demo-alice",
      available: false,
      reason: "test account",
      testAccount: { display: "Demo Alice", ttlHours: 24 },
      demoServer: {
        fqdn: "home.demo-alice.flagship.services",
        status: "none",
        ttlIdleMinutes: 30,
      },
    }));
    const r = await checkUsername("demo-alice", { fetch: fakeFetch as any });
    expect(r.demoServer?.fqdn).toBe("home.demo-alice.flagship.services");
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

  it("demoPodStatus maps lifecycle to pod-status label", () => {
    expect(demoPodStatus({ fqdn: "x", status: "up", ttlIdleMinutes: 30 })).toBe("online");
    expect(demoPodStatus({ fqdn: "x", status: "provisioning", ttlIdleMinutes: 30 })).toBe("pending");
    expect(demoPodStatus({ fqdn: "x", status: "none", ttlIdleMinutes: 30 })).toBe("pending");
    expect(demoPodStatus(null)).toBeNull();
  });

  it("samplePodFromDemoServer builds ONE pod with status mapped from lifecycle", () => {
    const block = {
      fqdn: "home.demo-alice.flagship.services",
      status: "up" as const,
      ttlIdleMinutes: 30,
    };
    const pod = samplePodFromDemoServer(block, "demo-alice");
    expect(pod.podId).toBe("demo-server-demo-alice");
    expect(pod.name).toBe("Home");
    expect(pod.fqdn).toBe("home.demo-alice.flagship.services");
    expect(pod.status).toBe("online");

    const stillProvisioning = samplePodFromDemoServer(
      { ...block, status: "none" },
      "demo-alice",
    );
    expect(stillProvisioning.status).toBe("pending");
  });

  it("connectDemoServer POSTs to /api/dev/sample-user/{u}/connect", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await connectDemoServer("demo-alice", { fetch: fakeFetch as any });
    const [calledUrl, calledInit] = fakeFetch.mock.calls[0]!;
    expect(calledUrl).toBe("https://flagshipserver.com/api/dev/sample-user/demo-alice/connect");
    expect(calledInit.method).toBe("POST");
    expect(calledInit.body).toBe("{}");
  });

  it("connectDemoServer surfaces non-2xx as an error", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );
    await expect(connectDemoServer("demo-alice", { fetch: fakeFetch as any }))
      .rejects.toThrow(/429/);
  });

  it("pollUntilDemoServerUp returns the up-block when status flips", async () => {
    let i = 0;
    const responses = [
      jsonResponse(200, {
        username: "demo-alice",
        available: false,
        reason: "test account",
        demoServer: { fqdn: "home.demo-alice.flagship.services", status: "provisioning", ttlIdleMinutes: 30 },
      }),
      jsonResponse(200, {
        username: "demo-alice",
        available: false,
        reason: "test account",
        demoServer: { fqdn: "home.demo-alice.flagship.services", status: "up", ttlIdleMinutes: 30 },
      }),
    ];
    const fakeFetch = vi.fn().mockImplementation(() => responses[i++] || responses[responses.length - 1]);
    const block = await pollUntilDemoServerUp("demo-alice", {
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
      username: "demo-alice",
      available: false,
      reason: "test account",
      demoServer: { fqdn: "home.demo-alice.flagship.services", status: "provisioning", ttlIdleMinutes: 30 },
    }));
    let timeNow = 0;
    const realNow = Date.now;
    // Force the deadline to elapse by faking sleep advancing time.
    const sleep = (ms: number) => { timeNow += ms; return Promise.resolve(); };
    Date.now = () => timeNow;
    try {
      await expect(pollUntilDemoServerUp("demo-alice", {
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
      username: "demo-alice",
      available: false,
      reason: "test account",
    }));
    await expect(pollUntilDemoServerUp("demo-alice", {
      fetch: fakeFetch as any,
      pollIntervalMs: 0,
      timeoutMs: 1000,
      sleep: () => Promise.resolve(),
    })).rejects.toMatchObject({ code: "demoServerWentAway" });
  });
});
