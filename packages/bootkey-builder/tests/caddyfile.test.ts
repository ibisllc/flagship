import { describe, expect, it } from "vitest";
import { renderCaddyfile, caddyfileConfigFile, type CaddyAppEntry } from "../src/caddyfile.js";
import type { AppManifest } from "@flagship/protocol";

function manifest(over: Partial<AppManifest> = {}): AppManifest {
  return {
    schema_version: 1,
    name: "habit-tracker",
    description: "Track family habits",
    version: "0.1.0",
    runtime: { image: "ghcr.io/x/habit-tracker:0.1.0", port: 8080 },
    data: { path: "/data" },
    network: { subdomain: "habits" },
    access: { enabled: true, default_role: "viewer" },
    migration: { verification: "standard" },
    ...over,
  };
}

function entry(over: Partial<CaddyAppEntry> = {}): CaddyAppEntry {
  return {
    appId: "habit-tracker",
    manifest: manifest(),
    containerHost: "app-habit-tracker.flagship.local",
    ...over,
  };
}

describe("renderCaddyfile", () => {
  it("emits a per-app site block at <subdomain>.<user>.flagship.services", () => {
    const out = renderCaddyfile({ username: "harry" }, [entry()]);
    expect(out).toContain("habits.harry.flagship.services {");
  });

  it("strips client-supplied X-Flagship-* headers (defense against header injection)", () => {
    const out = renderCaddyfile({ username: "harry" }, [entry()]);
    expect(out).toContain("request_header -X-Flagship-User");
    expect(out).toContain("request_header -X-Flagship-Role");
    expect(out).toContain("request_header -X-Flagship-Signature");
    expect(out).toContain("request_header -X-Flagship-Member");
  });

  it("calls forward_auth into the local daemon's /identity/decide", () => {
    const out = renderCaddyfile({ username: "harry" }, [entry({ appId: "habit-tracker" })]);
    expect(out).toMatch(/forward_auth "127\.0\.0\.1:9090" \{/);
    expect(out).toContain("uri /apps/habit-tracker/identity/decide");
    expect(out).toContain(
      "copy_headers X-Flagship-User X-Flagship-Role X-Flagship-Signature X-Flagship-Member",
    );
  });

  it("forwards to the app container at the manifest's port when host has no :port", () => {
    const out = renderCaddyfile({ username: "harry" }, [
      entry({ containerHost: "app-x.local", manifest: manifest({ runtime: { image: "x", port: 9999 } }) }),
    ]);
    expect(out).toContain('reverse_proxy "app-x.local:9999"');
  });

  it("respects an explicit container host:port without re-appending the manifest port", () => {
    const out = renderCaddyfile({ username: "harry" }, [
      entry({ containerHost: "app-x.local:1234" }),
    ]);
    expect(out).toContain('reverse_proxy "app-x.local:1234"');
  });

  it("emits a catch-all 404 for unknown subdomains under the user's namespace", () => {
    const out = renderCaddyfile({ username: "harry" }, []);
    expect(out).toContain("*.harry.flagship.services {");
    expect(out).toContain('respond "app not found" 404');
  });

  it("uses `tls internal` when no cert paths are supplied (dev mode)", () => {
    const out = renderCaddyfile({ username: "harry" }, [entry()]);
    expect(out).toContain("tls internal");
  });

  it("references the supplied cert + key paths when provided (production mode)", () => {
    const out = renderCaddyfile(
      {
        username: "harry",
        tls: { certPath: "/var/flagship/tls/cert.pem", keyPath: "/var/flagship/tls/key.pem" },
      },
      [entry()],
    );
    expect(out).toContain('tls "/var/flagship/tls/cert.pem" "/var/flagship/tls/key.pem"');
    expect(out).not.toContain("tls internal");
  });

  it("renders multiple apps as independent site blocks", () => {
    const out = renderCaddyfile({ username: "harry" }, [
      entry({ appId: "habits", manifest: manifest({ network: { subdomain: "habits" } }) }),
      entry({
        appId: "blog",
        manifest: manifest({ name: "blog", network: { subdomain: "blog" } }),
        containerHost: "app-blog.local",
      }),
    ]);
    expect(out).toContain("habits.harry.flagship.services {");
    expect(out).toContain("blog.harry.flagship.services {");
  });

  it("turns off Caddy's auto-HTTPS so the SNI passthrough is the only termination point", () => {
    const out = renderCaddyfile({ username: "harry" }, []);
    expect(out).toContain("auto_https off");
  });
});

describe("caddyfileConfigFile", () => {
  it("emits to /etc/caddy/Caddyfile with mode 0644", () => {
    const cf = caddyfileConfigFile({ username: "harry" }, []);
    expect(cf.path).toBe("/etc/caddy/Caddyfile");
    expect(cf.mode).toBe(0o644);
    expect(cf.content).toContain("harry.flagship.services");
  });
});
