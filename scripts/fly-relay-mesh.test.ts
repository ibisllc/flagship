// The production relay-mesh Fly profiles (journal I3, docs/runbooks/final-deploy.md 8e-8f): the Rust relay as `iad1`
// (fly.relay.mesh.toml) and its TS-hub rollback (fly.mesh.toml) keep fly.toml's app, ports and handlers, run ONE
// machine (one relay id = one machine), and carry the same relay id, kind and feed. Plus the prod DNS planner.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { planMeshDns } from "../tools/live-e2e/lib/meshDns.js";
import { addressMismatch, PROD_APEX, PROD_RELAY_ID, wranglerRelayAddresses } from "./prod-mesh-dns.js";

const ROOT = resolve(__dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const strip = (t: string) => t.replace(/^\s*#.*$/gm, "");

/** `[[services]]` blocks as {internal, ports: [{port, handlers, force}]} (enough TOML for these files). */
function services(t: string) {
  return strip(t)
    .split(/^\[\[services\]\]$/m)
    .slice(1)
    .map((b) => ({
      internal: Number(/internal_port = (\d+)/.exec(b)?.[1]),
      min: Number(/min_machines_running = (\d+)/.exec(b)?.[1]),
      autoStop: /auto_stop_machines = "(\w+)"/.exec(b)?.[1],
      ports: b
        .split(/\[\[services\.ports\]\]/)
        .slice(1)
        .map((p) => ({
          port: Number(/port = (\d+)/.exec(p)?.[1]),
          handlers: /handlers = (\[[^\]]*\])/.exec(p)?.[1]?.replace(/\s/g, ""),
          force: /force_https = true/.test(p),
        })),
    }));
}
const env = (t: string, k: string) => new RegExp(`^\\s*${k} = "([^"]*)"`, "m").exec(strip(t))?.[1];
const ports = (t: string) => services(t).map((s) => ({ internal: s.internal, ports: s.ports }));

describe("production relay mesh Fly profiles", () => {
  const base = read("fly.toml");
  for (const [file, dockerfile] of [["fly.relay.mesh.toml", "Dockerfile.relay"], ["fly.mesh.toml", "Dockerfile"]] as const) {
    it(`${file}: fly.toml's app, ports and handlers, one machine, iad1 full on the feed`, () => {
      const t = read(file);
      expect(/^app = "flagship-services"$/m.test(t)).toBe(true);
      expect(/^primary_region = "iad"$/m.test(t)).toBe(true);
      expect(new RegExp(`dockerfile = "${dockerfile}"`).test(strip(t))).toBe(true);
      expect(ports(t)).toEqual(ports(base));
      expect(services(t).map((s) => s.internal)).toEqual([8443, 3000, 3001]);
      for (const s of services(t)) {
        expect(s.min).toBe(1);
        expect(s.autoStop).toBe("off");
      }
      expect(/strategy = "rolling"/.test(strip(t))).toBe(true);
      expect(strip(t)).not.toMatch(/immediate|bluegreen|canary/);
      expect(env(t, "FLAGSHIP_MESH")).toBe("on");
      expect(env(t, "FLAGSHIP_RELAY_ID")).toBe("iad1");
      expect(env(t, "FLAGSHIP_RELAY_KIND")).toBe("full");
      expect(env(t, "FLAGSHIP_RELAY_FEED_URL")).toBe("https://feed.flagshipserver.com/v1");
      expect(env(t, "RELAY_ECHO_PORT")).toBe("3001");
      expect(env(t, "TUNNEL_TCP_PORT")).toBe("8443");
      expect(env(t, "PORT")).toBe("3000");
      // production defaults, never the gym's
      expect(strip(t)).not.toMatch(/gym|FLAGSHIP_SERVICES_APEX|FLAGSHIP_COM_BASE_URL|FLAGSHIP_RELAY_MAINTAINER_PIN|FLAGSHIP_MESH_(REBALANCE|MIN_MOVE)/);
      // nothing secret lives in a Fly file
      expect(strip(t)).not.toMatch(/KEY_SEED|SECRET/);
    });
  }

  it("the TS rollback names the CA key of the newest production lease (what .com signs the directory with)", () => {
    const dir = join(ROOT, ".maintainers/ca-endorsements");
    const leases = readdirSync(dir)
      .filter((f) => /^\d{8}T\d{6}-[0-9a-f]+\.json$/.test(f))
      .sort();
    const newest = JSON.parse(readFileSync(join(dir, leases.at(-1)!), "utf8")) as { caPubkey?: string; endorsement?: { caPubkey?: string } };
    const ca = newest.caPubkey ?? newest.endorsement?.caPubkey;
    expect(ca).toMatch(/^[0-9a-f]{64}$/);
    expect(env(read("fly.mesh.toml"), "FLAGSHIP_MESH_CA_KEYS")).toBe(ca);
    expect(env(read("fly.mesh.toml"), "FLAGSHIP_SURFACE")).toBe("services");
  });

  it("the Rust image ships the maintainer chain the Rust relay checks under", () => {
    expect(read("Dockerfile.relay")).toMatch(/COPY \.maintainers \/app\/\.maintainers/);
    expect(env(read("fly.relay.mesh.toml"), "FLAGSHIP_RELAY_MAINTAINERS_DIR")).toBe("/app/.maintainers");
  });
});

describe("prod-mesh-dns", () => {
  const repo = wranglerRelayAddresses(read("apps/com/wrangler.toml"));

  it("reads the relay's addresses from wrangler.toml and refuses a Fly list that differs", () => {
    expect(repo).toEqual({ ipv4: ["149.248.216.86"], ipv6: ["2a09:8280:1::110:d2b6:0"] });
    expect(addressMismatch({ ipv4: ["149.248.216.86"], ipv6: ["2a09:8280:1::110:d2b6:0"] }, repo)).toBeNull();
    expect(addressMismatch({ ipv4: ["149.248.216.86", "1.2.3.4"], ipv6: ["2a09:8280:1::110:d2b6:0"] }, repo)).toMatch(/disagree|says/);
    expect(addressMismatch({ ipv4: [], ipv6: [] }, repo)).not.toBeNull();
    expect(addressMismatch({ ipv4: ["1.1.1.1"], ipv6: [] }, { ipv4: [], ipv6: [] })).toMatch(/no SERVICES_PASSTHROUGH_IPV4/);
  });

  it("plans the direct and balanced names at the relay plus the two challenge CNAMEs, and touches nothing else", () => {
    const existing = [
      { id: "w", type: "A", name: "*.flagship.services", content: "149.248.216.86" },
      { id: "p", type: "A", name: "tunnel.flagship.services", content: "149.248.216.86", proxied: true },
    ];
    const plan = planMeshDns(existing, {
      apex: PROD_APEX,
      relays: [{ relayId: PROD_RELAY_ID, ...repo }],
      balanced: true,
      acme: { "iad1.tunnel.flagship.services": "iad1.tunnel.flagship.services.xyz.flydns.net", "tunnel.flagship.services": "tunnel.flagship.services.xyz.flydns.net" },
    });
    const c = plan.create.map((r) => `${r.type} ${r.name} ${r.content}`).sort();
    expect(c).toEqual([
      "A iad1.tunnel.flagship.services 149.248.216.86",
      "A tunnel.flagship.services 149.248.216.86",
      "AAAA iad1.tunnel.flagship.services 2a09:8280:1::110:d2b6:0",
      "AAAA tunnel.flagship.services 2a09:8280:1::110:d2b6:0",
      "CNAME _acme-challenge.iad1.tunnel.flagship.services iad1.tunnel.flagship.services.xyz.flydns.net",
      "CNAME _acme-challenge.tunnel.flagship.services tunnel.flagship.services.xyz.flydns.net",
    ]);
    // a proxied record at the balanced name is replaced (TLS must end on the relay, never at Cloudflare); the root
    // wildcard is never touched
    expect(plan.delete.map((r) => r.id)).toEqual(["p"]);
    expect([...plan.delete, ...plan.keep].some((r) => r.id === "w")).toBe(false);
  });
});
