/**
 * A sample account's voi.ci page in the webapp (docs/sample-users.md "Example voi.ci page"): the operator publishes an
 * example page; the device reads it like any public page and shows it read-only on the Social tab (no editor, no
 * Page options, a disabled switch, one sentence and View page), and Home shows its "Your page" row, never the welcome
 * card.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pageHomeState } from "../public/webapp/lib/voiciPagePublic.js";
import { refreshWorld, world } from "../public/webapp/lib/voiciWorld.js";

const WEBAPP = join(__dirname, "..", "public", "webapp");
const HEADER_JS = readFileSync(join(WEBAPP, "views", "page-header.js"), "utf8");
const MESSAGES_JS = readFileSync(join(WEBAPP, "views", "messages.js"), "utf8");
const HOME_JS = readFileSync(join(WEBAPP, "views", "home.js"), "utf8");

describe("Home's pointer for a sample account", () => {
  it("is the compact row once .com answered, published or not, never the welcome card", () => {
    expect(pageHomeState({ sample: true, checked: true, published: true })).toBe("row");
    expect(pageHomeState({ sample: true, checked: true, published: false })).toBe("row");
    expect(pageHomeState({ sample: true, checked: false, published: false })).toBeNull();
    // A real account is unchanged.
    expect(pageHomeState({ hasAccount: true, checked: true, published: false })).toBe("card");
  });

  it("is wired for sample accounts", () => {
    expect(HOME_JS).toMatch(/const sample = Boolean\(session\?\.username\) && isDemoProfile\(getActiveProfile\(\)\);/);
    expect(HOME_JS).toMatch(/dismissed,\s*sample,\s*\}\);/);
  });
});

describe("the sample account's page read", () => {
  it("reads only the public page: no drafts, no state, no inbox, nothing signed", async () => {
    const page = { profile: { displayName: "playstore-test-0725" }, index: { seq: 2 } };
    const loadPublishedPage = vi.fn(async () => page);
    const loadDraftOps = vi.fn();
    const loadMessagesState = vi.fn();
    const loadInbox = vi.fn();
    await refreshWorld({ sample: true, loadPublishedPage, loadDraftOps, loadMessagesState, loadInbox });
    // No session in this test: no username, so nothing is fetched yet.
    expect(loadPublishedPage).not.toHaveBeenCalled();
    expect(world.sample).toBe(true);
  });

  it("keeps a failed read as an error, not as 'no page'", async () => {
    const { getSession } = await import("../public/webapp/lib/state.js");
    (getSession() as { username: string | null }).username = "playstore-test-0725";
    const loadDraftOps = vi.fn();
    const ok = await refreshWorld({ sample: true, loadPublishedPage: async () => ({ profile: { displayName: "x" } }), loadDraftOps });
    expect(ok.page).toEqual({ profile: { displayName: "x" } });
    expect(ok.pageLoaded).toBe(true);
    expect(loadDraftOps).not.toHaveBeenCalled();
    const failed = await refreshWorld({ sample: true, loadPublishedPage: async () => { throw new Error("offline"); } });
    expect(failed.pageError).toBeInstanceOf(Error);
  });
});

describe("the read-only header", () => {
  it("shows the page, a disabled switch, the sentence and View page; no editor, no photo picker", () => {
    const sample = HEADER_JS.slice(HEADER_JS.indexOf("function sampleHeaderHtml"), HEADER_JS.indexOf("let copiedTimer"));
    expect(sample).toContain('data-testid="messages-demo-page"');
    expect(sample).toMatch(/data-testid="demo-page-public-switch"[^>]* disabled>/);
    expect(sample).toContain('data-testid="demo-page-note"');
    expect(sample).toContain('tr("View page")');
    expect(sample).toContain('window.open(voiciPageUrl(pageUsername()), "_blank", "noopener,noreferrer")');
    expect(sample).toContain("void copyPageLink(root)");
    expect(sample).toContain(".textContent = p?.displayName || pageUsername()");
    for (const absent of ['id="ph-edit"', "ph-photo", "enterPageEditor", "addPageOp", "setPagePublic", "wirePublicSwitches"]) expect(sample).not.toContain(absent);
    expect(HEADER_JS).toContain('tr("This is a sample account. Its page is an example, so you can\'t change it.")');
    expect(MESSAGES_JS).toMatch(/if \(world\.sample\) \{\s*renderSamplePage\(\$\("social-profile"\)\);/);
  });

  it("hides the conversations, the switch and Page options for a sample account", () => {
    expect(MESSAGES_JS).toMatch(/\$\("social-switch"\)\?\.classList\.toggle\("hidden", world\.sample\)/);
    expect(MESSAGES_JS).toMatch(/const profile = side === "profile" \|\| world\.sample;/);
    const head = MESSAGES_JS.slice(MESSAGES_JS.indexOf("function renderHead"), MESSAGES_JS.indexOf("function renderNotes"));
    expect(head).toMatch(/world\.sample\s*\? ""/);
  });
});
