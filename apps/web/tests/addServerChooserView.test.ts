import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

/**
 * Webapp add-server chooser — the provision-vs-pair fork the native
 * apps already have. Adding a server is two different acts (mint a
 * fresh box vs. pair an already-running one); the webapp used to jump
 * straight into create-server, leaving pod-pair reachable only from a
 * Settings shortcut. These assert the static surface ships the chooser,
 * routes both destinations, and is wired into Home.
 */
describe("webapp /views/add-server-chooser.js", () => {
  it("is served and registers the chooser view", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/add-server-chooser.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-add-server-chooser")');
    expect(r.body).toContain("initAddServerChooserView");
    expect(r.body).toContain("enterAddServerChooser");
  });

  it("forks into both the provision and pair destinations", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/add-server-chooser.js" });
    expect(r.statusCode).toBe(200);
    // Provision → the existing create-server flow.
    expect(r.body).toContain("./create-server.js");
    expect(r.body).toContain("enterCreateServer");
    // Pair → the existing pod-pair flow (previously orphaned from Home).
    expect(r.body).toContain("./pod-pair.js");
    expect(r.body).toContain("enterPodPair");
  });

  it("index.html declares the chooser section + both choice buttons", async () => {
    const app = buildServer();
    const html = await app.inject({ method: "GET", url: "/webapp/index.html" });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('id="view-add-server-chooser"');
    expect(html.body).toContain('id="add-server-provision"');
    expect(html.body).toContain('id="add-server-pair"');
    expect(html.body).toContain('id="add-server-back"');
  });

  it("home.js routes both the zero-state CTA and the populated list into the chooser", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/home.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("./add-server-chooser.js");
    expect(r.body).toContain("enterAddServerChooser");
    expect(r.body).toContain("home-add-server");
  });
});
