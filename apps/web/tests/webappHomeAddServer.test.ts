// Home's "Add/Restore server" is the one way to bring a server into the
// account (Create / Co-manage / Restore), with or without servers, and only an
// admin device of the account sees it (docs/service-access-gating.md
// "Account members"). Mirrors iOS HomeAddServerTests and Android
// HomeAddServerTest.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADD_SERVERS_ADMIN_ONLY, canAddServers, renderEmptyServersList } from "../public/webapp/views/home.js";

const VIEW = readFileSync(resolve(__dirname, "..", "public", "webapp", "views", "home.js"), "utf8");

function fakeRoot() {
  const clicks = new Map<string, number>();
  return {
    innerHTML: "",
    clicks,
    querySelector(sel: string) {
      if (!this.innerHTML.includes(`id="${sel.replace(/^#/, "")}"`)) return null;
      return { addEventListener: () => clicks.set(sel, (clicks.get(sel) ?? 0) + 1) };
    },
  };
}

describe("who sees Add/Restore server", () => {
  it("a device holding the admin root does", () => {
    expect(canAddServers({ adminRootSeed: new Uint8Array(32) }, {})).toBe(true);
  });

  it("another device of the account does not", () => {
    expect(canAddServers({ adminRootSeed: null }, {})).toBe(false);
    expect(canAddServers({}, null)).toBe(false);
  });

  it("a demo account's device does (it holds no keys; the operator runs the account)", () => {
    expect(canAddServers({}, { demoServer: { fqdn: "home.demo.flagship.services" } })).toBe(true);
  });
});

describe("the empty Home", () => {
  it("offers an admin device the same Add/Restore server button, wired to the menu", () => {
    const root = fakeRoot();
    renderEmptyServersList(root, { reason: "no-servers", username: "plucky-avocet", canAdd: true });
    expect(root.innerHTML).toContain("Your account is ready");
    expect(root.innerHTML).toContain('id="home-add-server">+ Add/Restore server<');
    expect(root.innerHTML).not.toContain("empty-create-server");
    expect(root.innerHTML).not.toContain("empty-co-manage");
    expect(root.innerHTML).not.toContain("Co-manage a running server");
    expect(root.innerHTML).not.toContain("Add your first server<");
    expect(root.clicks.get("#home-add-server")).toBe(1);
  });

  it("gives a non-admin device no button and says why", () => {
    const root = fakeRoot();
    renderEmptyServersList(root, { reason: "no-servers", username: "plucky-avocet", canAdd: false });
    expect(root.innerHTML).toContain("No servers yet");
    expect(root.innerHTML).toContain(ADD_SERVERS_ADMIN_ONLY);
    expect(root.innerHTML).not.toContain("<button");
    expect(root.innerHTML).not.toContain("Your account is ready");
    expect(root.clicks.size).toBe(0);
  });

  it("with no account yet still opens the account first", () => {
    const root = fakeRoot();
    renderEmptyServersList(root, { reason: "unpaired", canAdd: false });
    expect(root.innerHTML).toContain('id="empty-create-server">Create a server<');
    expect(root.innerHTML).not.toContain("home-add-server");
  });
});

describe("the populated list", () => {
  it("shows Add/Restore server and Take over only to an admin device", () => {
    expect(VIEW).toMatch(
      /\$\{canAddServers\(\) \? `<button class="secondary" id="home-add-server">\$\{escapeHtml\(ADD_IMPORT_LABEL\)\}<\/button>\s*<button class="linklike mt-1" id="home-take-over">/,
    );
  });

  it("both states open the one menu: Create, Co-manage, Import", () => {
    const wire = VIEW.slice(VIEW.indexOf("function wireAddServer"));
    const body = wire.slice(0, wire.indexOf("\n}\n"));
    expect(body).toContain("openAddOrRestore({");
    expect(body).toContain("enterCreateServer");
    expect(body).toContain("promptShareLink");
    expect(VIEW.match(/wireAddServer\((root|list)\);/g)).toEqual(["wireAddServer(root);", "wireAddServer(list);"]);
  });
});
