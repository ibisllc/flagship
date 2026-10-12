import { describe, expect, it } from "vitest";
import { accessListFromEgressHosts, parseAccessList } from "@flagship/protocol";
import {
  BUILD_REGISTRY_HOSTS,
  classifySource,
  decide,
  hostMatches,
  isPublicAddress,
  normalizeHost,
  parseCidr,
  type EgressPolicyState,
} from "../../src/egress/policy.js";

/** Per app: hosts (become `allow` lines) or a list's text. */
const state = (lists: Record<string, string[] | string> = {}): EgressPolicyState => ({
  subnets: {
    build: [parseCidr("172.20.0.0/16")!],
    staging: [parseCidr("172.21.0.0/16")!],
    apps: [parseCidr("172.22.0.0/16")!],
  },
  appByIp: new Map([
    ["172.22.0.2", "harry-weather"],
    ["172.22.0.3", "harry-notes"],
  ]),
  accessRules: (id) => {
    const l = lists[id];
    return parseAccessList(l === undefined ? "" : typeof l === "string" ? l : accessListFromEgressHosts(l)).rules;
  },
});

describe("egress policy", () => {
  it("classifies sources by bridge subnet and app container", () => {
    const s = state();
    expect(classifySource(s, "172.20.5.9")).toEqual({ kind: "build" });
    expect(classifySource(s, "172.21.0.2")).toEqual({ kind: "staging" });
    expect(classifySource(s, "172.22.0.2")).toEqual({ kind: "apps", serviceId: "harry-weather" });
    expect(classifySource(s, "::ffff:172.22.0.3")).toEqual({ kind: "apps", serviceId: "harry-notes" });
    expect(classifySource(s, "172.22.0.99")).toEqual({ kind: "apps", serviceId: null });
    expect(classifySource(s, "192.168.1.10")).toEqual({ kind: "unknown" });
    expect(classifySource(s, "fe80::1")).toEqual({ kind: "unknown" });
  });

  it("builds reach the package registries and nothing else", () => {
    const s = state();
    for (const h of ["registry.npmjs.org", "files.pythonhosted.org", "deb.debian.org", "github.com", "proxy.golang.org", "index.crates.io", "REGISTRY.NPMJS.ORG."]) {
      expect(decide(s, "172.20.0.2", h).allow, h).toBe(true);
    }
    for (const h of ["example.com", "evil.registry.npmjs.org", "gist.github.com", "registry-1.docker.io", "c2VjcmV0.attacker.example"]) {
      expect(decide(s, "172.20.0.2", h).allow, h).toBe(false);
    }
    expect(BUILD_REGISTRY_HOSTS.every((h) => !h.startsWith("*."))).toBe(true);
  });

  it("staging reaches nothing, even a registry", () => {
    const d = decide(state({ "harry-weather": ["api.github.com"] }), "172.21.0.2", "registry.npmjs.org");
    expect(d).toMatchObject({ allow: false, why: "staging has no internet" });
  });

  it("apps reach only their own approved hosts", () => {
    const s = state({ "harry-weather": ["api.open-meteo.com", "*.tile.openstreetmap.org"] });
    expect(decide(s, "172.22.0.2", "api.open-meteo.com").allow).toBe(true);
    expect(decide(s, "172.22.0.2", "a.tile.openstreetmap.org").allow).toBe(true);
    expect(decide(s, "172.22.0.2", "tile.openstreetmap.org").allow).toBe(false);
    expect(decide(s, "172.22.0.2", "registry.npmjs.org").allow).toBe(false);
    expect(decide(s, "172.22.0.3", "api.open-meteo.com").allow).toBe(false);
    expect(decide(s, "172.22.0.99", "api.open-meteo.com")).toMatchObject({ allow: false, why: "unknown app container" });
    expect(decide(s, "10.0.0.5", "api.open-meteo.com").allow).toBe(false);
  });

  it("refuses things that aren't host names", () => {
    const s = state({ "harry-weather": ["api.github.com"] });
    for (const h of ["", "1.2.3.4", "::1", "a b.com", "a..b", `${"a".repeat(64)}.com`]) {
      expect(decide(s, "172.22.0.2", h).allow, h).toBe(false);
    }
    expect(normalizeHost("API.GitHub.com.")).toBe("api.github.com");
  });

  it("wildcards match subdomains only", () => {
    expect(hostMatches("*.example.com", "a.example.com")).toBe(true);
    expect(hostMatches("*.example.com", "a.b.example.com")).toBe(true);
    expect(hostMatches("*.example.com", "example.com")).toBe(false);
    expect(hostMatches("*.example.com", "badexample.com")).toBe(false);
  });

  it("an app's list decides top to bottom; only a host no rule matched is a request", () => {
    const s = state({ "harry-weather": "deny ads.example.com\nallow *.example.com\n# c\n#allow all\n" });
    expect(decide(s, "172.22.0.2", "api.example.com")).toEqual({ allow: true, who: "app harry-weather" });
    expect(decide(s, "172.22.0.2", "ads.example.com")).toEqual({
      allow: false,
      who: "app harry-weather",
      why: "the app's access list denies this host",
    });
    expect(decide(s, "172.22.0.2", "API.GitHub.com.")).toEqual({
      allow: false,
      who: "app harry-weather",
      why: "no rule in the app's access list allows this host",
      unmatched: { serviceId: "harry-weather", host: "api.github.com" },
    });
    const all = state({ "harry-weather": "deny dell.com\nallow all\n" });
    expect(decide(all, "172.22.0.2", "anything.example").allow).toBe(true);
    expect(decide(all, "172.22.0.2", "dell.com")).not.toHaveProperty("unmatched");
    expect(decide(state({ "harry-weather": "deny all\n" }), "172.22.0.2", "a.com")).not.toHaveProperty("unmatched");
  });

  it("never connects to loopback, private, link-local or multicast addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["1.1.1.1", "140.82.112.3", "172.32.0.1", "2606:4700::6810:222"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });
});
