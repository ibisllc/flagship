// The marketplace is off in 0.4 (owner, 2026-11-19; release/version.json "marketplace": false):
// no screen links to it, its links open Home, and a build offers no "Publish this app".
// The views stay in the shell so 0.5 only flips the switch.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const WEBAPP = resolve(__dirname, "..", "public", "webapp");
const read = (...p: string[]) => readFileSync(resolve(WEBAPP, ...p), "utf8");
const load = (...p: string[]) => import(pathToFileURL(resolve(WEBAPP, ...p)).href);
const SWITCH = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "..", "release", "version.json"), "utf8")).marketplace;

/** The opening tag of the element with this id. */
function tagOf(html: string, id: string): string {
  const m = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`).exec(html);
  expect(m, id).not.toBeNull();
  return m![0];
}

describe("webapp: marketplace switch", () => {
  it("follows release/version.json", async () => {
    const { MARKETPLACE_ENABLED } = await load("lib", "buildInfo.js");
    expect(MARKETPLACE_ENABLED).toBe(SWITCH);
  });

  it("ships the Marketplace, Developer and build-chooser entries hidden; only the switch shows them", () => {
    const html = read("index.html");
    for (const id of ["services-list-open-marketplace", "services-list-open-developer", "build-src-market"]) {
      const tag = tagOf(html, id);
      expect(tag).toMatch(/class="[^"]*\bhidden\b/);
      expect(tag).toContain("data-marketplace");
    }
    // Vibe-code stays on the Services card.
    expect(tagOf(html, "services-list-open-vibe-code")).not.toMatch(/\bhidden\b/);
    const app = read("app.js");
    expect(app).toMatch(/if \(!MARKETPLACE_ENABLED\) return;\s*for \(const el of document\.querySelectorAll\("\[data-marketplace\]"\)\) el\.classList\.remove\("hidden"\);/);
    expect(read("views", "build-source.js")).toContain('if (MARKETPLACE_ENABLED) $("build-src-market")');
  });

  it("the wizard's last step offers no Browse marketplace while off", () => {
    const src = read("views", "wizard.js");
    expect(src).toMatch(/\$\{MARKETPLACE_ENABLED \? `<button id="wizard-go-demo"/);
  });

  it.runIf(!SWITCH)("a deployed build offers no Publish this app", async () => {
    const { deployedMarkup } = await load("views", "vibe-code.js");
    const html: string = deployedMarkup("https://app.example", false, { canonical: "alice--notes", slug: null });
    expect(html).not.toContain("vc-publish");
    expect(html).not.toMatch(/marketplace/i);
    expect(deployedMarkup("https://app.example", false, { canonical: "alice--notes", slug: "notes" })).not.toMatch(/marketplace/i);
  });

  describe("links", () => {
    const g = globalThis as unknown as { window?: unknown };
    const saved = g.window;
    afterEach(() => {
      g.window = saved;
    });

    it.runIf(!SWITCH)("?view=marketplace, developer and their view ids open Home", async () => {
      const { parseViewQuery } = await load("lib", "router.js");
      for (const v of ["marketplace", "developer", "view-marketplace", "view-developer", "Marketplace"]) {
        g.window = { location: { search: `?view=${v}` } };
        expect(parseViewQuery()?.view, v).toBe("view-home");
      }
      g.window = { location: { search: "?view=activity" } };
      expect(parseViewQuery()?.view).toBe("view-activity");
      expect(read("lib", "deepLink.js")).toContain('q.view === "view-marketplace" && MARKETPLACE_ENABLED');
    });
  });
});
