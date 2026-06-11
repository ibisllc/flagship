import { describe, expect, it } from "vitest";
import {
  appFqdn,
  caddyfileConfigFile,
  renderCaddyfile,
  serverFqdn,
  serverWildcardSelector,
  type CaddyAppEntry,
  type CaddyContext,
} from "../src/caddyfile.js";
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
    serviceId: "habit-tracker",
    manifest: manifest(),
    containerHost: "app-habit-tracker.flagship.local",
    ...over,
  };
}

const ctx: CaddyContext = { username: "harry", serverName: "home-box" };

describe("serverFqdn / appFqdn / serverWildcardSelector", () => {
  it("serverFqdn composes <server>.<user>.flagship.services (the per-box cert apex)", () => {
    expect(serverFqdn(ctx)).toBe("home-box.harry.flagship.services");
  });

  it("composes the canonical <app>.<server>.<user>.flagship.services (model A′)", () => {
    expect(appFqdn(ctx, "habits")).toBe("habits.home-box.harry.flagship.services");
  });

  it("the wildcard selector is THIS BOX's zone — a sibling box gets a different one", () => {
    expect(serverWildcardSelector(ctx)).toBe("*.home-box.harry.flagship.services");
    // Per-box wildcard cert (A′): each box terminates only its own zone.
    const sibling = serverWildcardSelector({ ...ctx, serverName: "chillout" });
    expect(sibling).toBe("*.chillout.harry.flagship.services");
  });
});

describe("renderCaddyfile", () => {
  it("emits a per-app site block at <subdomain>.<server>.<user>.flagship.services", () => {
    const out = renderCaddyfile(ctx, [entry()]);
    expect(out).toContain("habits.home-box.harry.flagship.services {");
  });

  it("strips client-supplied X-Flagship-* headers (defense against header injection)", () => {
    const out = renderCaddyfile(ctx, [entry()]);
    expect(out).toContain("request_header -X-Flagship-User");
    expect(out).toContain("request_header -X-Flagship-Role");
    expect(out).toContain("request_header -X-Flagship-Signature");
    expect(out).toContain("request_header -X-Flagship-Member");
  });

  it("calls forward_auth into the local daemon's /identity/decide", () => {
    const out = renderCaddyfile(ctx, [entry({ serviceId: "habit-tracker" })]);
    expect(out).toMatch(/forward_auth "127\.0\.0\.1:9090" \{/);
    expect(out).toContain("uri /apps/habit-tracker/identity/decide");
    expect(out).toContain(
      "copy_headers X-Flagship-User X-Flagship-Role X-Flagship-Signature X-Flagship-Member",
    );
  });

  it("forwards to the app container at the manifest's port when host has no :port", () => {
    const out = renderCaddyfile(ctx, [
      entry({ containerHost: "app-x.local", manifest: manifest({ runtime: { image: "x", port: 9999 } }) }),
    ]);
    expect(out).toContain('reverse_proxy "app-x.local:9999"');
  });

  it("respects an explicit container host:port without re-appending the manifest port", () => {
    const out = renderCaddyfile(ctx, [entry({ containerHost: "app-x.local:1234" })]);
    expect(out).toContain('reverse_proxy "app-x.local:1234"');
  });

  it("catch-all 404 covers the box apex + the box zone `*.<server>.<user>` (model A′)", () => {
    const out = renderCaddyfile(ctx, []);
    expect(out).toContain(
      "home-box.harry.flagship.services, *.home-box.harry.flagship.services {",
    );
    expect(out).toContain('respond "app not found" 404');
    // The retired user-zone wildcard must be gone — it would claim names the
    // per-box cert can't cover.
    expect(out).not.toContain("*.harry.flagship.services");
  });

  it("uses `tls internal` when no cert paths are supplied (dev mode)", () => {
    const out = renderCaddyfile(ctx, [entry()]);
    expect(out).toContain("tls internal");
  });

  it("references the supplied cert + key paths when provided (production mode)", () => {
    const out = renderCaddyfile(
      { ...ctx, tls: { certPath: "/var/flagship/tls/cert.pem", keyPath: "/var/flagship/tls/key.pem" } },
      [entry()],
    );
    expect(out).toContain('tls "/var/flagship/tls/cert.pem" "/var/flagship/tls/key.pem"');
    expect(out).not.toContain("tls internal");
  });

  it("renders multiple apps as independent site blocks under the box zone", () => {
    const out = renderCaddyfile(ctx, [
      entry({ serviceId: "habits", manifest: manifest({ network: { subdomain: "habits" } }) }),
      entry({
        serviceId: "blog",
        manifest: manifest({ name: "blog", network: { subdomain: "blog" } }),
        containerHost: "app-blog.local",
      }),
    ]);
    expect(out).toContain("habits.home-box.harry.flagship.services {");
    expect(out).toContain("blog.home-box.harry.flagship.services {");
  });

  it("turns off Caddy's auto-HTTPS so the SNI passthrough is the only termination point", () => {
    const out = renderCaddyfile(ctx, []);
    expect(out).toContain("auto_https off");
  });
});

describe("caddyfileConfigFile", () => {
  it("emits to /etc/caddy/Caddyfile with mode 0644 and the box-zone FQDN inside", () => {
    const cf = caddyfileConfigFile(ctx, []);
    expect(cf.path).toBe("/etc/caddy/Caddyfile");
    expect(cf.mode).toBe(0o644);
    expect(cf.content).toContain("home-box.harry.flagship.services");
  });
});
