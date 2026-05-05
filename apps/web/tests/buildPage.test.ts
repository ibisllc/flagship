import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("/build/ static surface", () => {
  it("serves /build/index.html with the form fields the build flow expects", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/build/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="username"');
    expect(r.body).toContain('id="serverName"');
    expect(r.body).toContain('id="goBtn"');
    expect(r.body).toContain('src="/build/build.js"');
  });

  it("serves /build/build.js with the trailer constants the personalizer uses", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/build/build.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("FLAGSHIP-BOOT");
    expect(r.body).toContain("FLAGSHIP-END");
    expect(r.body).toContain("flagship/install-blob/v1");
    expect(r.body).toContain("flagship/auth-code/v1");
  });

  it("the build page references the same protocol tags as the TS install-blob signer", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/build/build.js" });
    const expected = [
      "flagship/auth-code/v1",
      "flagship/install-blob/v1",
      "flagship/claim-username/v1",
      "/api/username/claim",
      "/api/auth-code/issue",
      "/api/build/iso-info",
    ];
    for (const e of expected) {
      expect(r.body).toContain(e);
    }
  });
});
