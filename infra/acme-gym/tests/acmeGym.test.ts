import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

describe("the gym's Pebble app", () => {
  it("publishes the root and intermediate but never the CA's private keys", () => {
    const caddy = read("Caddyfile");
    expect(caddy).toMatch(/@roots path \/roots\/0 \/intermediates\/0\n/);
    expect(caddy.replace(/^\s*#.*$/gm, "")).not.toMatch(/root-keys|intermediate-keys|set-renewal-info|add-revocation|cert-status/);
    expect(caddy).toMatch(/handle \{\n\t\trespond 404/);
    const cfg = JSON.parse(read("pebble-config.json")).pebble;
    expect(cfg.listenAddress).toMatch(/^127\.0\.0\.1:/);
    expect(cfg.managementListenAddress).toMatch(/^127\.0\.0\.1:/);
  });

  it("pins its images by digest and keeps one machine always on", () => {
    const from = read("Dockerfile").split("\n").filter((l) => l.startsWith("FROM "));
    expect(from).toHaveLength(2);
    for (const l of from) expect(l).toMatch(/@sha256:[0-9a-f]{64}/);
    const fly = read("fly.acme-gym.toml");
    expect(fly).toMatch(/auto_stop_machines = "off"/);
    expect(fly).toMatch(/app = "flagship-acme-gym"/);
  });

  it("checks DNS-01 against the real zone and does not skip validation", () => {
    const start = read("start.sh");
    expect(start).toMatch(/-dnsserver 1\.1\.1\.1:53/);
    expect(start).toMatch(/PEBBLE_VA_NOSLEEP=1/);
    expect(start).not.toMatch(/PEBBLE_VA_ALWAYS_VALID/);
  });
});
