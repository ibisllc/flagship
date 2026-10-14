import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

/** Opening someone else's share link lives on the Add-a-server page, not Home. */
describe("co-manage entry", () => {
  const get = async (url: string) => (await buildServer().inject({ method: "GET", url })).body;

  it("the create-server page offers it and wires it to the share-link prompt", async () => {
    expect(await get("/webapp/index.html")).toMatch(/id="cs-co-manage"[^>]*>Co-manage a server from another user</);
    const js = await get("/webapp/views/create-server.js");
    expect(js).toContain('$("cs-co-manage")');
    expect(js).toContain("promptShareLink");
  });

  it("Home no longer carries a paste-link button, and an empty Shared with me renders nothing", async () => {
    const js = await get("/webapp/views/shared-server.js");
    expect(js).not.toContain("shared-paste-link");
    expect(js).toContain('if (!rows.length) return "";');
  });

  it("the empty-account hint is one sentence", async () => {
    const js = await get("/webapp/views/home.js");
    expect(js).not.toContain("any servers yet");
    expect(js).toContain('"Add your first server to start running your own services."');
  });
});
