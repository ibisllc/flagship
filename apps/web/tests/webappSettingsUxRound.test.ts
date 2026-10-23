// The owner's UI round of 2026-10-23, webapp side (iOS is the reference):
// "Add a server first" on Services and Activity, "AI API keys" as compact
// rows, Cloud recovery's help behind (?), and shorter Account security copy.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WEBAPP = resolve(__dirname, "..", "public", "webapp");
const read = (p: string) => readFileSync(resolve(WEBAPP, p), "utf8");
const load = (p: string) => import(pathToFileURL(resolve(WEBAPP, p)).href);
const INDEX = read("index.html");

describe("no server yet", () => {
  it("one card, Services' wording, for Services and Activity", async () => {
    const { noServerCardHtml } = await load("lib/noServerCard.js");
    const html = noServerCardHtml();
    expect(html).toContain("Add a server first");
    expect(html).toContain("Services run on your own server. Add one to start building.");
    expect(read("views/services-list.js")).toMatch(/inventoryOk && podSwitcherPods\.length === 0[\s\S]*noServerCardHtml\(\)/);
    const activity = read("views/activity.js");
    expect(activity).toMatch(/const noServer = inventoryOk && activityPods\.length === 0/);
    expect(activity).toContain("noServerSlot.innerHTML = noServer ? noServerCardHtml()");
    expect(activity).toContain('$("activity-with-server")?.toggleAttribute("hidden", noServer)');
  });

  it("Activity keeps Server approvals above the hidden feed", () => {
    const view = INDEX.slice(INDEX.indexOf('id="view-activity"'), INDEX.indexOf('id="view-account-audit"'));
    expect(view.indexOf('id="activity-no-server"')).toBeLessThan(view.indexOf('id="activity-approvals"'));
    expect(view.indexOf('id="activity-approvals"')).toBeLessThan(view.indexOf('id="activity-with-server"'));
    expect(view.indexOf('id="activity-with-server"')).toBeLessThan(view.indexOf('id="activity-feed"'));
  });
});

describe("AI API keys", () => {
  it("is the label of the row, the page and Home's heading", () => {
    expect(INDEX).toContain('<span class="fs-row-title">AI API keys</span>');
    expect(INDEX).toContain("<h2>AI API keys</h2>");
    expect(INDEX).not.toMatch(/>AI keys</);
    expect(INDEX).not.toContain("<h2>AI providers</h2>");
  });

  it("each saved key is one compact row; its settings open from the ⋯ button", async () => {
    const src = read("views/settings.js");
    const loop = src.slice(src.indexOf("for (const e of stored.entries)"), src.indexOf("list.querySelectorAll('[data-action=\"set-active\"]')"));
    expect(loop).toContain('class="key-row-main"');
    expect(loop).toContain("${keyIcon}");
    expect(loop).toContain('<div class="key-row-tail mono">${escapeHtml(tail)}</div>');
    expect(loop).toContain('tr("Default")');
    expect(loop).toMatch(/data-action="more" aria-expanded="false" aria-controls=/);
    expect(loop).toMatch(/class="key-row-more" id="\$\{moreId\}" hidden/);
    expect(loop).toContain('tr("Make default")');
    expect(loop).toContain('tr("Delete key")');
    const { keyRowName } = await load("views/settings.js").catch(() => ({ keyRowName: null }));
    if (keyRowName) {
      expect(keyRowName({ provider: "anthropic", label: "anthropic" })).toBe("anthropic");
      expect(keyRowName({ provider: "openai", label: "Work" })).toBe("Work · openai");
    }
  });
});

describe("Cloud recovery", () => {
  it("puts How this works behind a (?) at the top right, in a dialog", () => {
    const view = INDEX.slice(INDEX.indexOf('id="view-recovery"'));
    const head = view.slice(0, view.indexOf("</div>"));
    expect(head).toContain('class="detail-head"');
    expect(head).toContain('id="recovery-help" aria-label="How this works"');
    expect(INDEX).not.toContain("<p><strong>How this works</strong></p>");
    // Made on demand: the lock sweep removes every <dialog> in the page.
    expect(INDEX).not.toContain('id="recovery-help-dialog"');
    const rec = read("views/recovery.js");
    expect(rec).toMatch(/export function openRecoveryHelp\(\)[\s\S]*Flagship cannot read it or reset your passphrase\.[\s\S]*dlg\.showModal\(\)/);
    expect(rec).toContain('help?.addEventListener("click", openRecoveryHelp)');
    expect(rec).toContain("helpCircleIcon");
  });
});

describe("Account security", () => {
  it("keeps every fact in fewer words", () => {
    const src = read("views/account-security.js");
    expect(src).toContain("Recovery needs a 6-digit authenticator code (or a recovery code) and a 24-hour wait.");
    expect(src).toContain("Recovery needs a recovery credential, then a 3-day wait. Your other devices are alerted but can't cancel it.");
    expect(src).toContain(
      "Makes a new admin key and removes admin from every other device. They stay signed in as members but can't wipe, transfer or decommission your servers until they recover.",
    );
    expect(src).toContain("Servers switch on their next check-in.");
    expect(src).toContain("Refused while other trusted devices exist.");
    expect(src).not.toContain("Rotating mints a brand-new admin key");
    expect(INDEX).not.toContain("Manage recovery protection and account-level security.");
  });
});
