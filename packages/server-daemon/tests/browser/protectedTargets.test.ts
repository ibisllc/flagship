import { describe, expect, it } from "vitest";
import { buildBrowserProtected, METADATA_ADDRESSES, RELAY_PUBLIC_PORTS } from "../../src/browser/protectedTargets.js";
import { BrowserGrants, BrowserJudge } from "../../src/browser/policy/index.js";

const RELAY_V4 = "149.248.216.86";
const RELAY_V6 = "2a09:8280:1::110:d2b6:0";

function world() {
  const p = buildBrowserProtected({
    serverFqdn: "home.alice.flagship.services",
    controlPlaneBaseUrl: "https://flagshipserver.com",
    relayUrl: "wss://flagship-services.fly.dev:8443/tunnel",
    extraAddresses: ["172.31.250.1"],
    interfaces: () => ({ eth0: [{ address: "192.168.1.40", family: "IPv4" } as never], lo: [{ address: "fe80::1%lo0", family: "IPv6" } as never] }),
    resolve: async (h) => (h === "flagship.services" ? [RELAY_V4] : h === "flagship-services.fly.dev" ? [RELAY_V6] : []),
  });
  const grants = new BrowserGrants();
  grants.approve({
    serviceId: "app",
    capabilities: ["navigate"],
    origins: ["*.flagship.services", "*.flagshipserver.com", "shop.example.com", "*.fly.dev", "flagship-services.internal", "relay.example.com"],
    ports: [80, 443, 8443, 8444],
    schemes: ["https", "http"],
    localNetwork: { kind: "whole-lan" },
    duration: "service",
  });
  const dns: Record<string, string[]> = { "shop.example.com": ["93.184.216.34"], "nas.lan": ["192.168.1.40"], "relay.example.com": [RELAY_V4] };
  const judge = new BrowserJudge({
    grants,
    protectedHosts: p.hosts,
    // The services zone's wildcard sends every name under it to the relay.
    resolve: async (host) => dns[host] ?? (host.endsWith(".flagship.services") ? [RELAY_V4, RELAY_V6] : ["203.0.113.9"]),
  });
  return { p, judge };
}

describe("what the app browser may never reach on a live box", () => {
  it("names this server and everything under it, .com, the relay's own names, and every own and metadata address", async () => {
    const { p } = world();
    await p.refresh();
    const h = p.hosts();
    expect(h.zones).toEqual(expect.arrayContaining(["home.alice.flagship.services", "flagshipserver.com", "internal", "flycast"]));
    expect(h.zones).not.toContain("flagship.services");
    expect(h.names).toEqual(expect.arrayContaining(["flagship-services.fly.dev", "flagship.services"]));
    expect(h.labelPrefixes).toEqual([{ prefix: "broadcast--", zone: "flagship.services" }]);
    expect(p.addresses()).toEqual(expect.arrayContaining(["192.168.1.40", "fe80::1", "172.31.250.1", ...METADATA_ADDRESSES]));
    // The relay carries other people's apps: its addresses are limited to the web ports, not refused outright.
    expect(p.addresses()).not.toContain(RELAY_V4);
    expect(p.portLimited()).toEqual({ addresses: expect.arrayContaining([RELAY_V4, RELAY_V6]), zones: ["flagship.services"], ports: RELAY_PUBLIC_PORTS });
  });

  it("refuses this server's names, .com, the relay's own names and services, and private and metadata space", async () => {
    const { p, judge } = world();
    await p.refresh();
    for (const url of [
      "https://home.alice.flagship.services/",
      "https://notes.home.alice.flagship.services./",
      "https://HOME.alice.flagship.services/",
      "https://webapp.flagshipserver.com/",
      "https://flagshipserver.com/api/health",
      "https://flagship.services/",
      "https://flagship-services.fly.dev/",
      "https://broadcast--bob.flagship.services/",
      "https://flagship-services.internal/",
      "http://nas.lan/",
      // The relay's tunnel hub and API (8443) and address echo (8444), by any name or by address.
      "https://chess.bob.flagship.services:8443/tunnel",
      "https://chess.bob.flagship.services:8444/",
      "https://relay.example.com:8443/",
      `https://${RELAY_V4}:8444/`,
      `https://[${RELAY_V6}]:8443/`,
    ]) {
      expect(await judge.judge({ serviceId: "app", url, kind: "document" }), url).toMatchObject({ allow: false, code: "protected-destination" });
    }
  });

  it("lets another person's Flagship app through like any public site, the owner's other servers too (owner decision 2026-10-24)", async () => {
    const { p, judge } = world();
    await p.refresh();
    for (const url of [
      "https://chess.bob.flagship.services/",
      "https://chess--bob.flagship.services/",
      "https://notes.home2.alice.flagship.services/",
      "http://chess.bob.flagship.services/",
      "https://relay.example.com/",
      "https://shop.example.com/",
    ]) {
      expect(await judge.judge({ serviceId: "app", url, kind: "document" }), url).toMatchObject({ allow: true });
    }
  });

  it("refuses a name under the services apex on a relay-only port even before the relay's addresses are known", async () => {
    const { judge } = world();
    expect(await judge.judge({ serviceId: "app", url: "https://chess.bob.flagship.services:8443/", kind: "document" })).toMatchObject({ allow: false, code: "protected-destination" });
    expect(await judge.judge({ serviceId: "app", url: "https://chess.bob.flagship.services/", kind: "document" })).toMatchObject({ allow: true });
  });
});
