import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

/**
 * Slice A — the three-way "Add a server" chooser is GONE. "Add a server" now
 * provisions directly; pairing is automatic (Slice B auto-pair); take-over is
 * the standalone /transfer deep-link + camera claim view (Slice C). These
 * assert the chooser is removed and its three entries are relocated.
 */
describe("webapp add-server chooser removed (Slice A)", () => {
  it("the chooser view module is no longer served", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/add-server-chooser.js" });
    expect(r.statusCode).toBe(404);
  });

  it("index.html no longer declares the chooser section", async () => {
    const app = buildServer();
    const html = await app.inject({ method: "GET", url: "/webapp/index.html" });
    expect(html.statusCode).toBe(200);
    expect(html.body).not.toContain('id="view-add-server-chooser"');
    expect(html.body).not.toContain('id="add-server-provision"');
    expect(html.body).not.toContain('id="add-server-claim"');
  });

  it("app.js no longer imports/wires the chooser", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/app.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("add-server-chooser.js");
    expect(r.body).not.toContain("initAddServerChooserView");
    // Auto-pair IS wired.
    expect(r.body).toContain("autoPairFromSnapshot");
  });

  it("home.js routes '+ Add a server' straight to create-server + take-over to transfer-claim", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/home.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("enterAddServerChooser");
    expect(r.body).toContain("./create-server.js");
    expect(r.body).toContain("home-add-server");
    expect(r.body).toContain("home-take-over");
    expect(r.body).toContain("./transfer-claim.js");
  });
});

describe("webapp take-over claim view (Slice C)", () => {
  it("the standalone transfer-claim view is served + verifies the offer before claiming", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/transfer-claim.js" });
    expect(r.statusCode).toBe(200);
    // Verifies the offer BEFORE the severe confirm / claim.
    expect(r.body).toContain("verifyTransferOffer");
    // Severe tiered confirm: type-to-confirm the server domain.
    expect(r.body).toContain("data-confirm-input");
    // Camera scan with graceful paste fallback.
    expect(r.body).toContain("scanWithCamera");
    expect(r.body).toContain("submitTransferClaim");
  });

  it("deepLink.js ingests a /transfer deep link into the claim view", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/deepLink.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("transferLinkFromLocation");
    expect(r.body).toContain("transfer-claim.js");
  });
});
