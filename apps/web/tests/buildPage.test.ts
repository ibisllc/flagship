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

  it("forwards every legacy arrival to the canonical Studio page", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/build/" });
    expect(r.body).toContain("/studio");
    expect(r.body).not.toContain("flagship:qr:recipe");
  });

  it("build.js is gone (the ISO personalizer is no longer served)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/build/build.js" });
    expect(r.statusCode).toBe(404);
  });
});
