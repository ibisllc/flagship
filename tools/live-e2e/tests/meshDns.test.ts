import { describe, expect, it } from "vitest";
import { flyAcmeTarget, flyAddresses, planMeshDns, type ZoneRecord } from "../lib/meshDns.js";
import { caddyfile, maintainerPin, provisionScript, relayEnvFile } from "../relay-c-cli.js";

const APEX = "gym.flagship.services";
const rec = (id: string, type: string, name: string, content: string, proxied = false): ZoneRecord => ({ id, type, name, content, proxied });

describe("gym mesh DNS plan", () => {
  it("writes each relay's direct name at exactly its addresses and the Fly DNS-01 CNAME, and nothing else", () => {
    const existing = [
      rec("1", "A", `gym-a.tunnel.${APEX}`, "137.66.62.214"),
      rec("2", "A", `gym-a.tunnel.${APEX}`, "198.51.100.99"), // stale
      rec("3", "AAAA", `gym-b.tunnel.${APEX}`, "2a09:8280:1::b", true), // proxied: replaced
      rec("4", "TXT", `_acme-challenge.gym-c.tunnel.${APEX}`, "caddy"), // Caddy's own challenge: left alone
      rec("5", "A", `home.alice.${APEX}`, "1.2.3.4"), // not ours
    ];
    const p = planMeshDns(existing, {
      apex: APEX,
      relays: [
        { relayId: "gym-a", ipv4: ["137.66.62.214"], ipv6: ["2A09:8280:1::A"] },
        { relayId: "gym-b", ipv4: [], ipv6: ["2a09:8280:1::b"] },
        { relayId: "gym-c", ipv4: ["203.0.113.30"], ipv6: [] },
      ],
      acme: { [`gym-a.tunnel.${APEX}`]: `gym-a.tunnel.${APEX}.x1y2.flydns.net.` },
    });
    expect(p.keep.map((r) => r.id)).toEqual(["1"]);
    expect(p.delete.map((r) => r.id).sort()).toEqual(["2", "3"]);
    expect(p.create).toEqual([
      { type: "AAAA", name: `gym-a.tunnel.${APEX}`, content: "2a09:8280:1::a" },
      { type: "AAAA", name: `gym-b.tunnel.${APEX}`, content: "2a09:8280:1::b" },
      { type: "A", name: `gym-c.tunnel.${APEX}`, content: "203.0.113.30" },
      { type: "CNAME", name: `_acme-challenge.gym-a.tunnel.${APEX}`, content: `gym-a.tunnel.${APEX}.x1y2.flydns.net` },
    ]);
  });

  it("removes a leaving relay's names and its addresses from the balanced name, keeping the others'", () => {
    const existing = [
      rec("1", "A", `gym-c.tunnel.${APEX}`, "203.0.113.30"),
      rec("2", "A", `tunnel.${APEX}`, "203.0.113.30"),
      rec("3", "A", `tunnel.${APEX}`, "137.66.62.214"),
      rec("4", "CNAME", `_acme-challenge.gym-c.tunnel.${APEX}`, "old.flydns.net"),
    ];
    const p = planMeshDns(existing, { apex: APEX, relays: [], remove: ["gym-c"], balanced: true });
    expect(p.delete.map((r) => r.id).sort()).toEqual(["1", "2", "4"]);
    expect(p.keep.map((r) => r.id)).toEqual(["3"]);
    expect(p.create).toEqual([]);
  });

  it("refuses to manage a name outside tunnel.<apex>", () => {
    expect(() => planMeshDns([], { apex: APEX, relays: [], acme: { [`home.alice.${APEX}`]: "x.flydns.net" } })).toThrow(/not under/);
  });

  it("reads flyctl's addresses and certificate target", () => {
    expect(
      flyAddresses([
        { Address: "137.66.62.214", Type: "v4" },
        { Address: "66.241.124.1", Type: "shared_v4" },
        { Address: "2A09:8280:1::12D:5999:0", Type: "v6" },
        { Address: "fdaa::3", Type: "private_v6" },
      ]),
    ).toEqual({ ipv4: ["137.66.62.214"], ipv6: ["2a09:8280:1::12d:5999:0"] });
    expect(flyAcmeTarget({ DNSValidationTarget: "gym-b.tunnel.gym.flagship.services.abc.flydns.net" })).toBe("gym-b.tunnel.gym.flagship.services.abc.flydns.net");
    expect(flyAcmeTarget({})).toBeNull();
  });
});

describe("gym-c provisioning", () => {
  const input = { seedHex: "ab".repeat(32), logPub: "cd".repeat(32), usageSecret: "s3cret", pin: "87f5ae60cd1cfc0629fdf10ab97a547d33bca68bf3a1426614096a3054d57ae7", apex: APEX, control: "gym.flagshipserver.com" };

  it("runs the Rust relay as gym-c with the mesh on, the gym chain and raw :443", () => {
    const env = relayEnvFile(input);
    for (const line of [
      "FLAGSHIP_MESH=on",
      "FLAGSHIP_RELAY_ID=gym-c",
      "TUNNEL_TCP_PORT=443",
      "RELAY_ECHO_PORT=3001",
      "FLAGSHIP_RELAY_FEED_URL=https://feed.gym.flagshipserver.com/v1",
      "FLAGSHIP_RELAY_MAINTAINERS_DIR=/opt/flagship-relay/.maintainers",
      `FLAGSHIP_RELAY_MAINTAINER_PIN=${input.pin}`,
      `FLAGSHIP_SERVICES_APEX=${APEX}`,
    ]) {
      expect(env.split("\n")).toContain(line);
    }
    expect(() => relayEnvFile({ ...input, logPub: "" })).toThrow(/log key/);
    expect(() => relayEnvFile({ ...input, usageSecret: "" })).toThrow(/USAGE_REPORT_SECRET/);
  });

  it("puts TLS for the direct and balanced names on :8443 and TLS + PROXY v2 on :8444", () => {
    const c = caddyfile(APEX);
    expect(c).toContain(`gym-c.tunnel.${APEX}:8443, tunnel.${APEX}:8443 {`);
    expect(c).toContain("dns cloudflare {env.CF_API_TOKEN}");
    expect(c).toContain("reverse_proxy 127.0.0.1:3000");
    expect(c).toMatch(/:8444 \{[\s\S]*tls[\s\S]*proxy_protocol v2[\s\S]*upstream 127\.0\.0\.1:3001/);
    expect(c).toContain("auto_https disable_redirects");
  });

  it("reads the pin from a source tree and never leaves the secrets on the VM's staging folder", () => {
    expect(maintainerPin('export const MAINTAINER_PINNED_MANDATE_HASH =\n  "87f5ae60cd1cfc0629fdf10ab97a547d33bca68bf3a1426614096a3054d57ae7";')).toBe(input.pin);
    expect(() => maintainerPin("nothing")).toThrow();
    const s = provisionScript();
    expect(s).toContain("rm -f /root/gym-c/relay.env /root/gym-c/caddy.env");
    expect(s).toContain("cargo build -q --release --locked -p flagship-relay");
    expect(s).toContain("systemctl enable --now chrony");
  });
});
