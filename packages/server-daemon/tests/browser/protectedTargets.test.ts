import { describe, expect, it } from "vitest";
import { buildBrowserProtected, METADATA_ADDRESSES } from "../../src/browser/protectedTargets.js";
import { BrowserGrants, BrowserJudge } from "../../src/browser/policy/index.js";

describe("what the app browser may never reach on a live box", () => {
  it("names this server and everything under it, .com, the relay, and every own and metadata address", async () => {
    const p = buildBrowserProtected({
      serverFqdn: "home.alice.flagship.services",
      controlPlaneBaseUrl: "https://flagshipserver.com",
      relayUrl: "wss://flagship-services.fly.dev:8443/tunnel",
      extraAddresses: ["172.31.250.1"],
      interfaces: () => ({ eth0: [{ address: "192.168.1.40", family: "IPv4" } as never], lo: [{ address: "fe80::1%lo0", family: "IPv6" } as never] }),
      resolve: async (h) => (h === "flagship.services" ? ["149.248.216.86"] : h === "flagship-services.fly.dev" ? ["2a09:8280:1::110:d2b6:0"] : []),
    });
    await p.refresh();
    const h = p.hosts();
    expect(h.zones).toEqual(["home.alice.flagship.services", "flagshipserver.com"]);
    expect(h.names).toEqual(expect.arrayContaining(["flagship-services.fly.dev", "flagship.services"]));
    expect(p.addresses()).toEqual(expect.arrayContaining(["192.168.1.40", "fe80::1", "172.31.250.1", "149.248.216.86", "2a09:8280:1::110:d2b6:0", ...METADATA_ADDRESSES]));

    const grants = new BrowserGrants();
    grants.approve({ serviceId: "app", capabilities: ["navigate"], origins: ["*.flagship.services", "*.flagshipserver.com", "shop.example.com"], localNetwork: { kind: "whole-lan" }, duration: "service" });
    const judge = new BrowserJudge({ grants, protectedHosts: p.hosts, resolve: async (host) => (host === "shop.example.com" ? ["93.184.216.34"] : host === "nas.lan" ? ["192.168.1.40"] : ["203.0.113.9"]) });
    for (const url of ["https://home.alice.flagship.services/", "https://notes.home.alice.flagship.services./", "https://HOME.alice.flagship.services/", "https://webapp.flagshipserver.com/", "https://flagship.services/", "http://nas.lan/"]) {
      expect(await judge.judge({ serviceId: "app", url, kind: "document" }), url).toMatchObject({ allow: false, code: "protected-destination" });
    }
    expect(await judge.judge({ serviceId: "app", url: "https://shop.example.com/", kind: "document" })).toMatchObject({ allow: true });
  });
});
