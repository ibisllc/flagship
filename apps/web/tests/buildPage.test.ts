import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("/build/ static surface", () => {
  it("serves /build/index.html with the relay-driven UI (task #59)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/build/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="startBtn"');
    expect(r.body).toContain('id="qrHolder"');
    expect(r.body).toContain('id="matchDigits"');
    expect(r.body).toContain('src="/build/build.js"');
    // The old build-ticket UI is gone — the page no longer asks for a
    // pasted build code; the relay delivers the InstallBlob directly.
    expect(r.body).not.toMatch(/id="codeInput"\s/);
    expect(r.body).not.toMatch(/id="username"\s/);
    expect(r.body).not.toMatch(/id="serverName"\s/);
  });

  it("serves /build/build.js with the trailer constants and the relay path", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/build/build.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("FLAGSHIP-BOOT");
    expect(r.body).toContain("FLAGSHIP-END");
    expect(r.body).toContain("/api/build-relay/sessions");
    expect(r.body).toContain("/api/build/iso-info");
    // The page no longer redeems build tickets — it receives a
    // crypto_box_seal-encrypted InstallBlob via the WS relay.
    expect(r.body).not.toContain("/api/build-tickets/redeem");
  });

  it("the build page links to the phone simulator for users without the app", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/build/" });
    expect(r.body).toContain("/dev/create-server");
  });
});
