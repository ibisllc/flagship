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

  // SEC N02 / E01: every textual form of a loopback or private address.
  it("judges the bytes, not the spelling", () => {
    const refused = [
      "::", "::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "0::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::FFFF:7F00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:a00:1",
      "::ffff:10.1.2.3", "::ffff:c0a8:101", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe",
      "::127.0.0.1", "::10.0.0.1",
      "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b:1::1",
      "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "febf::1", "fec0::1", "ff02::1", "ff00::",
      "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "2002:7f00:1::1", "2002:a00:1::", "3fff::1",
      "100::1", "5f00::1", "4000::1", "8000::1",
      "not an address", "", "1.2.3", "1.2.3.4.5", "256.1.1.1", "010.0.0.1", "1.1.1.1%eth0", "0x7f.0.0.1", "2130706433",
      "1:2:3:4:5:6:7:8:9", "1::2::3", "::ffff:999.1.1.1",
      "192.88.99.1", "255.255.255.255", "198.19.0.1",
    ];
    for (const ip of refused) expect(isPublicAddress(ip), JSON.stringify(ip)).toBe(false);
    const allowed = [
      "1.1.1.1", "8.8.8.8", "140.82.112.3", "172.32.0.1", "11.0.0.1", "100.63.255.255", "100.128.0.1",
      "2606:4700:4700::1111", "2606:4700::6810:222", "2001:4860:4860::8888", "2a00:1450:4001::200e",
      "::ffff:8.8.8.8", "::ffff:808:808",
    ];
    for (const ip of allowed) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("agrees with a brute-force reference across mapped IPv4 space", () => {
    const sample = (n: number) => `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    for (let i = 0; i < 4000; i++) {
      const n = (Math.imul(i, 2654435761) ^ (i << 7)) >>> 0;
      const v4 = sample(n);
      const hex = `::ffff:${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
      expect(isPublicAddress(hex), `${v4} as ${hex}`).toBe(isPublicAddress(v4));
    }
  });
});
