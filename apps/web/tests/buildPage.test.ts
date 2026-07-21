import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("/build/ is retired (recipe + Builder replaced the ISO flow)", () => {
  it("serves a retirement stub, not the old personalize-and-write-ISO UI", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/build/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("This page has moved");
    // The old relay/ISO build UI is gone.
    expect(r.body).not.toContain('id="startBtn"');
    expect(r.body).not.toContain('id="qrHolder"');
    expect(r.body).not.toContain('src="/build/build.js"');
  });

  it("forwards a pending recipe / the ?via=qr hand-off to /ready/", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/build/" });
    // The client-side stub redirects to /ready/ when a recipe is pending or
    // the old QR hand-off query is present.
    expect(r.body).toContain("/ready/");
    expect(r.body).toContain("flagship:qr:recipe");
  });

  it("build.js is gone (the ISO personalizer is no longer served)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/build/build.js" });
    expect(r.statusCode).toBe(404);
  });
});
