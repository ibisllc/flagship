import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("/build/ static surface", () => {
  it("serves /build/index.html with the code-input UI (not the old form)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/build/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="codeInput"');
    expect(r.body).toContain('id="goBtn"');
    expect(r.body).toContain('src="/build/build.js"');
    expect(r.body).not.toMatch(/id="username"\s/);
    expect(r.body).not.toMatch(/id="serverName"\s/);
  });

  it("serves /build/build.js with the trailer constants and the redeem path", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/build/build.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("FLAGSHIP-BOOT");
    expect(r.body).toContain("FLAGSHIP-END");
    expect(r.body).toContain("/api/build-tickets/redeem");
    expect(r.body).toContain("/api/build/iso-info");
    expect(r.body).not.toContain("/api/username/claim");
    expect(r.body).not.toContain("/api/auth-code/issue");
  });

  it("the build page links to the phone simulator for users without the app", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/build/" });
    expect(r.body).toContain("/dev/create-server");
  });
});
