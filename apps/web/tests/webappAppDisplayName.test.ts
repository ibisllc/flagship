// The name an app is shown under: the box's own name, else its slug in words ("Chess Club", not
// "chess-club"). Same cases as iOS AppDisplayNameTests and Android AppDisplayNameTest.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appDisplayName, appNameFromServiceId, appNameFromSlug } from "../public/webapp/lib/appDisplayName.js";

describe("webapp app display name", () => {
  it("reads a slug as words", () => {
    expect(appNameFromSlug("chess-club")).toBe("Chess Club");
    expect(appNameFromSlug("notes")).toBe("Notes");
    expect(appNameFromSlug("my_app-2")).toBe("My App 2");
    expect(appNameFromSlug("-")).toBe("-");
    expect(appNameFromServiceId("river-otter--chess-club")).toBe("Chess Club");
    expect(appNameFromServiceId("budget")).toBe("Budget");
  });

  it("prefers the box's own name", () => {
    const app = { serviceId: "a--chess-club", slug: "chess-club" };
    expect(appDisplayName(app)).toBe("Chess Club");
    expect(appDisplayName({ ...app, name: "Club d'échecs" })).toBe("Club d'échecs");
    expect(appDisplayName({ ...app, name: "  " })).toBe("Chess Club");
    expect(appDisplayName({ serviceId: "a--budget" })).toBe("Budget");
  });

  it("the apps list, the app page and its access page title the app by it", () => {
    const read = (f: string) => readFileSync(join(__dirname, "..", "public", "webapp", "views", f), "utf8");
    expect(read("services-list.js")).toContain("escapeHtml(appDisplayName(s))");
    expect(read("service-detail.js")).toContain('<div class="card-title">${escapeHtml(appDisplayName(s))}');
    expect(read("service-access.js")).toContain("appDisplayName({ serviceId: serviceRef, ...service })");
    for (const f of ["services-list.js", "service-detail.js", "service-access.js"]) {
      expect(read(f)).not.toMatch(/escapeHtml\(s(ervice)?\.slug/);
    }
  });
});
