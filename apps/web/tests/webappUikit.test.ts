/**
 * WhatsApp-inspired UIKit primitives (apps/web/public/webapp/lib/uikit.js).
 *
 * Pure string-builder tests — the webapp test environment is `node` (no
 * jsdom), so we assert on the returned HTML the same way the rest of the
 * webapp view tests do. Coverage focuses on the security-relevant contract
 * (server-derived text is ALWAYS escaped), the teal-selected chip state, and
 * the iOS-mirrored `fsInitials` rule, plus the data-* hooks the views bind to.
 */
import { describe, expect, it } from "vitest";
import {
  fsInitials,
  chip,
  chipRow,
  searchField,
  monogram,
  profileCard,
  announcementCard,
  settingsRow,
  settingsGroup,
  listRow,
} from "../public/webapp/lib/uikit.js";

const XSS = '<img src=x onerror=alert(1)>';

describe("fsInitials — mirrors iOS Theme.fsInitials", () => {
  it("takes the first two alphanumerics, uppercased", () => {
    expect(fsInitials("harry")).toBe("HA");
    expect(fsInitials("demo1234")).toBe("DE");
    expect(fsInitials("a")).toBe("A");
  });
  it("skips non-alphanumerics when picking the two letters", () => {
    expect(fsInitials("a.b.c")).toBe("AB");
    expect(fsInitials("  jo")).toBe("JO");
    expect(fsInitials("9lives")).toBe("9L");
  });
  it("falls back to ? for an empty / symbol-only name", () => {
    expect(fsInitials("")).toBe("?");
    expect(fsInitials("…")).toBe("?");
    expect(fsInitials(null as unknown as string)).toBe("?");
  });
});

describe("chip / chipRow", () => {
  it("selected chip is teal-filled (is-selected) + aria-selected", () => {
    const html = chip({ value: "online", label: "Online", selected: true });
    expect(html).toContain("is-selected");
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-chip-value="online"');
  });
  it("unselected chip carries no is-selected", () => {
    const html = chip({ value: "all", label: "All", selected: false });
    expect(html).not.toContain("is-selected");
    expect(html).toContain('aria-selected="false"');
  });
  it("renders an optional count badge", () => {
    expect(chip({ value: "a", label: "All", count: 3 })).toContain("fs-chip-count");
    expect(chip({ value: "a", label: "All", count: 3 })).toContain(">3<");
    expect(chip({ value: "a", label: "All" })).not.toContain("fs-chip-count");
  });
  it("escapes a hostile label + value", () => {
    const html = chip({ value: XSS, label: XSS, selected: false });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
  it("chipRow marks exactly the selected value", () => {
    const html = chipRow({
      items: [
        { value: "all", label: "All" },
        { value: "online", label: "Online" },
      ],
      selected: "online",
    });
    // One selected, one not.
    expect((html.match(/is-selected/g) ?? []).length).toBe(1);
    expect(html).toContain('role="tablist"');
  });
});

describe("searchField", () => {
  it("shows the clear button only when there is text", () => {
    expect(searchField({ value: "x" })).not.toContain("fs-search-clear hidden");
    expect(searchField({ value: "" })).toContain("fs-search-clear hidden");
  });
  it("carries the data-search hook + escapes the value", () => {
    const html = searchField({ value: XSS, placeholder: "Search", id: "home-search" });
    expect(html).toContain("data-search");
    expect(html).toContain("data-search-clear");
    expect(html).toContain('id="home-search"');
    expect(html).not.toContain("<img src=x");
  });
});

describe("monogram", () => {
  it("renders the initials at the requested size class", () => {
    expect(monogram("Harry", { size: "lg" })).toContain("fs-monogram--lg");
    expect(monogram("Harry")).toContain(">HA<");
  });
});

describe("profileCard", () => {
  it("renders the username + a chevron + the data-profile-card hook", () => {
    const html = profileCard({ name: "harry", subtitle: "Your Flagship account" });
    expect(html).toContain("data-profile-card");
    expect(html).toContain("harry");
    expect(html).toContain("Your Flagship account");
    expect(html).toContain("fs-row-chevron");
  });
  it("falls back to 'Your account' for an empty name", () => {
    expect(profileCard({ name: "", subtitle: "Signed in" })).toContain("Your account");
  });
  it("escapes a hostile username", () => {
    expect(profileCard({ name: XSS, subtitle: "x" })).not.toContain("<img src=x");
  });
});

describe("announcementCard", () => {
  it("renders title/message/CTA + dismiss hooks (teal default)", () => {
    const html = announcementCard({
      icon: "<svg></svg>",
      title: "Back up your account",
      message: "One minute.",
      ctaLabel: "Secure",
    });
    expect(html).toContain("fs-announcement");
    expect(html).not.toContain("fs-announcement--danger");
    expect(html).toContain("data-ann-cta");
    expect(html).toContain("data-ann-dismiss");
    expect(html).toContain("Secure");
  });
  it("danger variant + no-CTA + non-dismissible", () => {
    const html = announcementCard({
      icon: "<svg></svg>",
      title: "Removed",
      message: "Sign in again.",
      ctaLabel: null,
      dismissible: false,
      tone: "danger",
    });
    expect(html).toContain("fs-announcement--danger");
    expect(html).not.toContain("data-ann-cta");
    expect(html).not.toContain("data-ann-dismiss");
  });
  it("escapes hostile title + message", () => {
    const html = announcementCard({ icon: "", title: XSS, message: XSS });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});

describe("settingsRow / settingsGroup", () => {
  it("row carries the action hook, value, badge, and chevron", () => {
    const html = settingsRow({
      icon: "<svg></svg>",
      title: "Recovery",
      subtitle: "Recover on a new device",
      value: "on",
      badge: 2,
      action: "recovery",
    });
    expect(html).toContain('data-row-action="recovery"');
    expect(html).toContain("Recovery");
    expect(html).toContain("fs-row-value");
    expect(html).toContain("fs-row-badge");
    expect(html).toContain("fs-row-chevron");
  });
  it("hides the badge at 0 and the chevron when chevron:false", () => {
    const html = settingsRow({ icon: "", title: "X", badge: 0, chevron: false });
    expect(html).not.toContain("fs-row-badge");
    expect(html).not.toContain("fs-row-chevron");
  });
  it("danger tone tints the icon square", () => {
    expect(settingsRow({ icon: "", title: "Reset", tone: "danger" })).toContain(
      "fs-row-icon--danger",
    );
  });
  it("group stitches rows under an optional header", () => {
    const html = settingsGroup({
      header: "ACCOUNT",
      rows: [settingsRow({ icon: "", title: "A" }), settingsRow({ icon: "", title: "B" })],
    });
    expect(html).toContain("fs-group-header");
    expect(html).toContain("ACCOUNT");
    expect((html.match(/fs-row/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("escapes a hostile row title", () => {
    expect(settingsRow({ icon: "", title: XSS })).not.toContain("<img src=x");
  });
});

describe("listRow", () => {
  it("icon leading uses the requested status tone", () => {
    const html = listRow({
      leading: { kind: "icon", svg: "<svg></svg>", tone: "success" },
      title: "blog.demo",
      subtitle: "2 apps",
      trailing: '<span class="pill ok">online</span>',
    });
    expect(html).toContain("fs-listrow-icon--success");
    expect(html).toContain("blog.demo");
    expect(html).toContain("fs-listrow-trailing");
    expect(html).toContain("pill ok");
  });
  it("trailingBelow stacks the status pill under the text, not floated right", () => {
    const html = listRow({
      leading: { kind: "icon", svg: "<svg></svg>", tone: "muted" },
      title: "blog.demo",
      subtitle: "0 apps",
      trailing: '<span class="pill">never came online</span>',
      trailingBelow: true,
    });
    // The stacked variant, not the right-floated one.
    expect(html).toContain("fs-listrow-trailing-below");
    expect(html).toContain("fs-listrow--stacked");
    expect(html).not.toContain('class="fs-listrow-trailing"');
    // …and it lives INSIDE the body (before the body span closes), so the long
    // label gets its own full-width line rather than crushing the title.
    const bodyStart = html.indexOf("fs-listrow-body");
    const trailIdx = html.indexOf("fs-listrow-trailing-below");
    expect(trailIdx).toBeGreaterThan(bodyStart);
    expect(html).toContain("never came online");
  });
  it("monogram leading derives initials", () => {
    const html = listRow({ leading: { kind: "monogram", name: "Harry" }, title: "x" });
    expect(html).toContain("fs-monogram");
    expect(html).toContain(">HA<");
  });
  it("tappable rows carry the action hook", () => {
    const html = listRow({
      leading: { kind: "icon", svg: "", tone: "teal" },
      title: "x",
      action: "open",
    });
    expect(html).toContain("fs-listrow--tappable");
    expect(html).toContain('data-row-action="open"');
  });
  it("escapes a hostile title + subtitle + detail", () => {
    const html = listRow({
      leading: { kind: "icon", svg: "", tone: "teal" },
      title: XSS,
      subtitle: XSS,
      detail: XSS,
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
