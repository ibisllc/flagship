// Settings tab (owner, 2026-10-15): the lock and sign-out buttons share one
// box, the Danger zone is a box of red buttons like a server page's with no
// explainer text (the confirmations carry the warnings), and Browser sessions
// lists only browsers docked through Remote, never the account's own devices.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WEBAPP = join(__dirname, "..", "public", "webapp");
const INDEX = readFileSync(join(WEBAPP, "index.html"), "utf8");

function section(id: string): string {
  const start = INDEX.indexOf(`<section id="${id}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  return INDEX.slice(start, INDEX.indexOf("</section>", start));
}

function card(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf("</div>", start));
}

describe("Settings tab session and danger boxes", () => {
  const tab = section("view-settings-tab");

  it("puts Lock the app and Sign out in one box, styled like iOS's red-outline buttons", () => {
    const box = card(tab, "settings-session-card");
    expect(box).toContain('<button class="danger-outline full-width" id="settings-pin-lock">Lock the app</button>');
    expect(box).toContain('<button class="danger-outline full-width" id="settings-signout">Sign out</button>');
    expect(box).not.toContain("<p");
  });

  it("groups both Danger zone actions as red buttons in one box, without explainer text", () => {
    const box = card(tab, "settings-danger-zone-card");
    expect(box).toContain('<button class="danger-outline full-width" id="settings-reset">Remove this device from account</button>');
    expect(box).toContain('<button class="danger-outline full-width" id="settings-tab-account-delete">Delete account</button>');
    expect(box).not.toContain("<p");
    expect(INDEX).not.toContain('id="settings-tab-reset"');
  });

  it("the AI keys page no longer carries its own Session and Danger zone cards", () => {
    const providers = section("view-settings");
    expect(providers).not.toContain("settings-signout");
    expect(providers).not.toContain("settings-reset");
    expect(providers).not.toContain("Danger zone");
  });

  it("refreshes the recovery gate whenever the tab opens", () => {
    const app = readFileSync(join(WEBAPP, "app.js"), "utf8");
    expect(app).toContain("void refreshSessionGates();");
  });
});

describe("Browser sessions", () => {
  const load = async () =>
    import(pathToFileURL(resolve(WEBAPP, "views", "paired-sessions.js")).href);

  it("lists Remote browsers only, never the account's own devices (this phone included)", async () => {
    const { browserSessions } = await load();
    const rows = [
      { tokenPrefix: "phone", current: true, kind: "device" },
      { tokenPrefix: "tablet", current: false, kind: "device" },
      { tokenPrefix: "laptop", current: false, kind: "remote" },
    ];
    expect(browserSessions(rows).map((r: { tokenPrefix: string }) => r.tokenPrefix)).toEqual(["laptop"]);
  });

  it("on a box that doesn't say which kind, at least this device is left out", async () => {
    const { browserSessions } = await load();
    const rows = [
      { tokenPrefix: "phone", current: true },
      { tokenPrefix: "other", current: false },
    ];
    expect(browserSessions(rows).map((r: { tokenPrefix: string }) => r.tokenPrefix)).toEqual(["other"]);
    expect(browserSessions(undefined)).toEqual([]);
  });
});
