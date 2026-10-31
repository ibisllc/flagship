import { describe, expect, it } from "vitest";
import { EgressGateway } from "../src/egress/gateway.js";
import { parseCidr } from "../src/egress/policy.js";

/** A gateway that "enforces" on loopback, with the apps bridge standing in as 127.0.0.0/24 (no root, no firewall). */
function gateway() {
  const gw = new EgressGateway({} as never) as unknown as {
    state: { enforced: boolean };
    gateways: Record<string, string>;
    subnets: Record<string, unknown[]>;
    forwardOwnedPort(port: number, target: { host: string; port: number }, owner: string): Promise<boolean>;
    stop(): Promise<void>;
  };
  gw.state = { enforced: true };
  gw.gateways = { apps: "127.0.0.1" };
  gw.subnets = { apps: [parseCidr("127.0.0.0/24")] };
  return gw;
}

describe("the gateway's owned ports", () => {
  it("forward to the host's loopback (Docker) or to a container address on the apps bridge (Podman), and to nothing else", async () => {
    const gw = gateway();
    try {
      expect(await gw.forwardOwnedPort(15400, { host: "127.0.0.1", port: 41000 }, "svc-a")).toBe(true);
      expect(await gw.forwardOwnedPort(15401, { host: "127.0.0.7", port: 8080 }, "svc-a")).toBe(true);
      // Another network, a name, and a port outside the owned range are refused.
      expect(await gw.forwardOwnedPort(15403, { host: "10.0.0.5", port: 8080 }, "svc-a")).toBe(false);
      expect(await gw.forwardOwnedPort(15404, { host: "example.com", port: 8080 }, "svc-a")).toBe(false);
      expect(await gw.forwardOwnedPort(80, { host: "127.0.0.7", port: 8080 }, "svc-a")).toBe(false);
      // A port held by one app is not given to another.
      expect(await gw.forwardOwnedPort(15401, { host: "127.0.0.8", port: 8080 }, "svc-b")).toBe(false);
    } finally {
      await gw.stop();
    }
  });
});

describe("a container that started a moment ago", () => {
  it("is judged by a read of the bridge that began after it called, never by one already in flight", async () => {
    let t = 1_000;
    const starts: number[] = [];
    const gw = new EgressGateway({} as never) as unknown as {
      now: () => number;
      refreshing: Promise<void> | null;
      refreshStartedAt: number;
      lastRefresh: number;
      refreshApps(): Promise<void>;
      refreshAppsSince(since: number): Promise<void>;
    };
    gw.now = () => t;
    let release: () => void = () => {};
    gw.refreshApps = () => {
      if (gw.refreshing) return gw.refreshing;
      gw.refreshStartedAt = t;
      starts.push(t);
      gw.refreshing = new Promise<void>((r) => (release = r)).finally(() => {
        gw.lastRefresh = t;
        gw.refreshing = null;
      });
      return gw.refreshing;
    };
    void gw.refreshApps();
    t = 1_010;
    const caller = gw.refreshAppsSince(t);
    t = 1_400;
    release();
    // The caller must not settle on the old read: it waits (250 ms apart) and starts a fresh one.
    for (let i = 0; i < 100 && starts.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    release();
    await caller;
    expect(starts).toEqual([1_000, 1_400]);
    expect(gw.refreshStartedAt).toBeGreaterThanOrEqual(1_010);
  });
});
