// Webapp surfaces iOS removed, kept gone: the post-recovery choice screen
// (iOS 76288f42: recovery is the takeover), the raw "Members" list on an
// app's page (Access control's Members replaced it), and the unreachable
// URL-controller view.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "public", "webapp");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("removed webapp surfaces stay removed", () => {
  it("no post-recovery choice: recovery goes straight to the takeover", () => {
    expect(existsSync(resolve(ROOT, "views/post-recovery-choice.js"))).toBe(false);
    expect(existsSync(resolve(ROOT, "lib/postRecoveryChoice.js"))).toBe(false);
    expect(read("index.html")).not.toContain("view-post-recovery-choice");
    expect(read("app.js")).not.toContain("post-recovery-choice");
    expect(read("views/bootstrap.js")).not.toContain("chooseDisposition");
    expect(read("lib/loginTakeover.js")).not.toMatch(/chooseDisposition|runKeepBoth/);
  });

  it("an app's page has no raw Members list (Access control holds members)", () => {
    const view = read("views/service-detail.js");
    expect(view).not.toContain('<h2 class="mt-4">Members</h2>');
    expect(view).not.toContain("stableIdPrefix");
    expect(view).toContain('id="sd-access"');
  });

  it("no URL-controller view or replay route", () => {
    expect(existsSync(resolve(ROOT, "views/url-controller.js"))).toBe(false);
    expect(read("service-worker.js")).not.toContain("url-controller");
  });
});
