import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("/webapp PWA static surface", () => {
  it("serves /webapp/manifest.json with the right shape", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/manifest.json" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.start_url).toBe("/webapp/");
    expect(body.scope).toBe("/webapp/");
    expect(body.display).toBe("standalone");
  });

  it("serves /webapp/index.html and links the manifest + service worker", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('rel="manifest"');
    expect(r.body).toContain("/webapp/service-worker.js");
  });

  it("serves /webapp/service-worker.js with the correct scope hooks", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/service-worker.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("flagship-webapp-shell-");
    expect(r.body).toContain("self.addEventListener");
  });

  it("/webapp/app.js loads and imports keystore from a relative path", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/app.js" });
    expect(r.statusCode).toBe(200);
    // Relative imports resolve correctly in both browsers (relative to
    // /webapp/app.js → /webapp/keystore.js) and Node test loaders.
    expect(r.body).toContain('from "./keystore.js"');
    expect(r.body).toContain("bootstrapNewIdentity");
    expect(r.body).toContain("deriveIrkFromSeed");
  });

  it("/webapp/keystore.js exposes the wrap/unwrap surface used by app.js", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/keystore.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("export async function bootstrapNewIdentity");
    expect(r.body).toContain("export async function unlockUmk");
    expect(r.body).toContain("export async function deriveIrkFromSeed");
    expect(r.body).toContain("export async function deriveBakFromSeed");
  });

  it("never accidentally serves /webapp resources from the root scope", async () => {
    const app = buildServer();
    // Confirm the marketing root is NOT a manifest
    const r = await app.inject({ method: "GET", url: "/manifest.json" });
    expect(r.statusCode).toBe(404);
  });
});
