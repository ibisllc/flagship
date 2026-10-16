import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

/** Opening someone else's share link lives in Home's Add/Import a server menu. */
describe("co-manage entry", () => {
  const get = async (url: string) => (await buildServer().inject({ method: "GET", url })).body;

  it("the Add/Import menu offers it, wired to the share-link prompt", async () => {
    const menu = await get("/webapp/views/import-backup.js");
    expect(menu).toContain("data-choice-add>Create a new server<");
    expect(menu).toContain("data-choice-co-manage>Co-manage a running server<");
    expect(menu).not.toContain("Add a new server");
    expect(menu).not.toContain("To clone a server under a new name");
    const home = await get("/webapp/views/home.js");
    expect(home).toContain("onCoManage");
    expect(home).toContain("promptShareLink");
  });

  it("an account with no servers yet reaches it from the empty state", async () => {
    const home = await get("/webapp/views/home.js");
    expect(home).toMatch(/id="empty-co-manage">Co-manage a running server</);
    expect(home).toContain('$("empty-co-manage")');
  });

  it("the create-server page no longer carries the co-manage button", async () => {
    expect(await get("/webapp/index.html")).not.toContain("cs-co-manage");
    expect(await get("/webapp/views/create-server.js")).not.toContain("cs-co-manage");
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
