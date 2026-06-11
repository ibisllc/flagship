/**
 * Hero-screen redesign (Home / Services / Settings) + bottom-tab routing.
 *
 * The WhatsApp-style restyle adds: a large collapsing title, a search field,
 * filter chips (Home = All/Online/Pending/Offline mirroring the iOS
 * HomeStatusFilter buckets; Services = All/Yours/Shared), clean list rows, a
 * profile hero in Settings, and one announcement card folding the home
 * banners. These tests assert:
 *   - the pure bucket / filter / search predicates (Home + Services), which
 *     mirror the iOS bucket rules exactly;
 *   - static-source assertions that each view renders the hero + search +
 *     chips and still preserves its existing flows + data hooks;
 *   - the bottom tab bar still wires Home / Apps / Activity / Settings to the
 *     existing routes (the IA is unchanged — only the presentation moved).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOME_FILTERS,
  statusBucketForKind,
  homeFilterMatches,
  homeSearchMatches,
} from "../public/webapp/views/home.js";
import {
  APPS_FILTERS,
  appBucket,
  appsFilterMatches,
  appsSearchMatches,
} from "../public/webapp/views/services-list.js";

const read = (...p: string[]) => readFileSync(join(__dirname, "..", "public", "webapp", ...p), "utf8");
const HOME_JS = read("views", "home.js");
const SERVICES_JS = read("views", "services-list.js");
const APP_JS = read("app.js");
const INDEX_HTML = read("index.html");

describe("Home filter buckets — mirror iOS HomeStatusFilter", () => {
  it("exposes the All/Online/Pending/Offline chip set with the iOS labels", () => {
    expect(HOME_FILTERS.map((f) => f.label)).toEqual(["All", "Online", "Pending", "Offline"]);
  });

  it("buckets a classify kind the same way iOS HomeStatusFilter.matches does", () => {
    // Online bucket: strictly-live (and the still-trusted cert-expiring-soon).
    expect(statusBucketForKind("online")).toBe("online");
    expect(statusBucketForKind("cert-expiring-soon")).toBe("online");
    // Pending bucket: on-its-way-up boxes.
    expect(statusBucketForKind("waiting-for-approval")).toBe("pending");
    expect(statusBucketForKind("coming-online")).toBe("pending");
    // Offline bucket: dead / offline / revoked / cert-expired.
    expect(statusBucketForKind("never-seen")).toBe("offline");
    expect(statusBucketForKind("offline")).toBe("offline");
    expect(statusBucketForKind("revoked")).toBe("offline");
    expect(statusBucketForKind("cert-expired")).toBe("offline");
  });

  it("the All chip never filters; the others narrow to their bucket", () => {
    expect(homeFilterMatches("all", "offline")).toBe(true);
    expect(homeFilterMatches("online", "online")).toBe(true);
    expect(homeFilterMatches("online", "pending")).toBe(false);
  });

  it("search is a case-insensitive substring over name + fqdn", () => {
    const fields = { name: "blog", fqdn: "blog.demo.flagship.services" };
    expect(homeSearchMatches("", fields)).toBe(true);
    expect(homeSearchMatches("BLOG", fields)).toBe(true);
    expect(homeSearchMatches("demo", fields)).toBe(true);
    expect(homeSearchMatches("wiki", fields)).toBe(false);
  });
});

describe("Services filter buckets — All/Yours/Shared", () => {
  it("exposes the All/Yours/Shared chip set", () => {
    expect(APPS_FILTERS.map((f) => f.label)).toEqual(["All", "Yours", "Shared"]);
  });

  it("Yours = creator is the signed-in user; Shared = anyone else", () => {
    expect(appBucket({ creator: "harry" }, "harry")).toBe("yours");
    expect(appBucket({ creator: "Harry" }, "harry")).toBe("yours"); // case-insensitive
    expect(appBucket({ creator: "alice" }, "harry")).toBe("shared");
    expect(appBucket({ creator: "" }, "harry")).toBe("shared");
  });

  it("filter + search predicates behave", () => {
    expect(appsFilterMatches("all", "shared")).toBe(true);
    expect(appsFilterMatches("yours", "shared")).toBe(false);
    const app = { slug: "notes", summary: "a notes app", serviceId: "harry-notes" };
    expect(appsSearchMatches("", app)).toBe(true);
    expect(appsSearchMatches("NOTES", app)).toBe(true);
    expect(appsSearchMatches("photos", app)).toBe(false);
  });
});

describe("Home view renders the hero + search + chips and keeps its flows", () => {
  it("imports the uikit primitives", () => {
    expect(HOME_JS).toMatch(/from "\.\.\/lib\/uikit\.js"/);
    expect(HOME_JS).toContain("chipRow");
    expect(HOME_JS).toContain("searchField");
    expect(HOME_JS).toContain("listRow");
  });
  it("paints the large collapsing title + search + filter chips", () => {
    expect(HOME_JS).toContain("fs-hero-title");
    expect(HOME_JS).toContain("fs-hero-compact");
    expect(HOME_JS).toContain('id: "home-search"');
    expect(HOME_JS).toContain("renderServerCards");
  });
  it("folds the recovery + account-reset banners into announcement cards", () => {
    expect(HOME_JS).toContain("announcementCard");
    // The reset banner uses the danger tone.
    expect(HOME_JS).toMatch(/tone:\s*"danger"/);
  });
  it("preserves the delete-dead-server release flow", () => {
    expect(HOME_JS).toContain("js-delete-dead-server");
    expect(HOME_JS).toContain("deleteDeadServer");
  });
});

describe("Services view renders the hero + search + chips and keeps its flows", () => {
  it("imports the uikit primitives", () => {
    expect(SERVICES_JS).toMatch(/from "\.\.\/lib\/uikit\.js"/);
    expect(SERVICES_JS).toContain("chipRow");
  });
  it("paints the hero + search and keeps the per-service URL hydration + open", () => {
    expect(SERVICES_JS).toContain("fs-hero-title");
    expect(SERVICES_JS).toContain('id: "apps-search"');
    expect(SERVICES_JS).toContain("hydrateServiceLinks");
    expect(SERVICES_JS).toContain('data-action="open"');
    expect(SERVICES_JS).toContain("data-url-slot");
  });
});

describe("Settings tab — profile hero + grouped rounded sections", () => {
  it("the markup carries a profile-hero slot + grouped fs-row sections", () => {
    expect(INDEX_HTML).toContain('id="settings-profile-hero"');
    expect(INDEX_HTML).toContain("fs-group");
    expect(INDEX_HTML).toContain("fs-row");
    expect(INDEX_HTML).toContain("fs-group-header");
  });
  it("keeps every settings entry id so app.js wiring still resolves", () => {
    for (const id of [
      "settings-tab-providers",
      "settings-tab-account-security",
      "settings-tab-push",
      "settings-tab-recovery",
      "settings-tab-tier",
      "settings-tab-trusted-devices",
      "settings-tab-sessions",
      "settings-tab-peer-backup",
      "settings-tab-companion-dock",
      "settings-tab-companion-requests",
      "settings-tab-profiles",
      "settings-tab-reset",
      "companion-requests-badge",
    ]) {
      expect(INDEX_HTML).toContain(`id="${id}"`);
    }
  });
  it("app.js populates the profile hero + stamps the row icons", () => {
    expect(APP_JS).toContain("decorateSettingsTab");
    expect(APP_JS).toContain("profileCard");
    expect(APP_JS).toContain("settings-profile-hero");
    expect(APP_JS).toContain("SETTINGS_ROW_ICONS");
  });
});

describe("Bottom tab bar — still wires the four routes (IA unchanged)", () => {
  it("the markup has the four mobile tabs", () => {
    expect(INDEX_HTML).toContain('id="tab-bar"');
    for (const t of ["home", "apps", "activity", "settings"]) {
      expect(INDEX_HTML).toContain(`data-tab-target="${t}"`);
    }
  });
  it("app.js routes each tab to its enter-fn", () => {
    expect(APP_JS).toMatch(/tab === "home"\) await enterHome\(\)/);
    expect(APP_JS).toMatch(/tab === "apps"\) await enterServicesList\(\)/);
    expect(APP_JS).toMatch(/tab === "activity"\) await enterActivityTab\(\)/);
    expect(APP_JS).toMatch(/tab === "settings"\) await enterSettingsTab\(\)/);
  });
});

describe("Teal alignment — accent is teal, --ink is softened off pure black", () => {
  const TOKENS = read("..", "tokens.css");
  it("--ink is the warm near-black, not pure #000 (design-system §2)", () => {
    expect(TOKENS).toContain("--ink:             #14140F");
    expect(TOKENS).not.toMatch(/--ink:\s*#000000/);
  });
  it("--accent + --primary resolve to teal", () => {
    expect(TOKENS).toMatch(/--accent:\s*var\(--teal\)/);
    expect(TOKENS).toMatch(/--primary:\s*var\(--teal\)/);
    expect(TOKENS).toContain("--teal:            #14B8A6");
    expect(TOKENS).toContain("--teal-bright:     #2DD4BF");
  });
});
