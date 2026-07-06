// Bug 4 regression guard — the global top slivers (teal ops bar + red trust
// bar) must reserve REAL space on the root app container, not just offset the
// sticky <header>. Otherwise any non-header chrome (view content above the
// fold, overlay buttons, modal titles) is COVERED when a bar appears.
//
// jsdom isn't in the repo (the other webapp DOM tests assert on source too),
// so this pins the CSS mechanism: the `body` rule shrinks the whole viewport
// by --ops-bar-h + --trust-bar-h via padding-top, and the runtime modules set
// those vars when a bar shows. That's the push-down contract (mirrors
// iOS/Android), so a regression back to header-only offset fails here.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CSS = readFileSync(
  resolve(__dirname, "../public/webapp/style.css"),
  "utf8",
);
const OPS_BAR_JS = readFileSync(
  resolve(__dirname, "../public/webapp/lib/operationsBar.js"),
  "utf8",
);
const TRUST_JS = readFileSync(
  resolve(__dirname, "../public/webapp/lib/trustSliver.js"),
  "utf8",
);

/** Extract the first `<selector> { ... }` block body from the stylesheet. */
function ruleBody(selector: string): string {
  const re = new RegExp(
    `(^|[};]\\s*)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "m",
  );
  const m = CSS.match(re);
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[2];
}

describe("ops/trust bar layout — push-down (Bug 4)", () => {
  it("the body container reserves real space for BOTH bars via padding-top", () => {
    // Grab the 640px reading-column body rule (the one that sets max-width),
    // not the html,body reset.
    const re =
      /body\s*\{[^}]*max-width:\s*640px[^}]*\}/m;
    const m = CSS.match(re);
    expect(m, "the 640px body rule must exist").not.toBeNull();
    const body = m![0];
    expect(body).toMatch(/padding-top:\s*calc\(/);
    expect(body).toContain("var(--ops-bar-h");
    expect(body).toContain("var(--trust-bar-h");
  });

  it("the reserve is NOT only on the sticky header", () => {
    // The header still offsets (so it pins flush below the bars on scroll),
    // but the body reserve above is what actually keeps content uncovered.
    const header = ruleBody("header");
    expect(header).toContain("var(--ops-bar-h");
    expect(header).toContain("var(--trust-bar-h");
    // The body — not just the header — carries the reserve.
    const re = /body\s*\{[^}]*max-width:\s*640px[^}]*\}/m;
    expect(CSS.match(re)![0]).toMatch(/padding-top:\s*calc\(/);
  });

  it("the ops bar sets --ops-bar-h when shown and clears it when empty", () => {
    expect(OPS_BAR_JS).toContain('setProperty("--ops-bar-h", "44px")');
    expect(OPS_BAR_JS).toContain('setProperty("--ops-bar-h", "0px")');
  });

  it("the trust bar drives --trust-bar-h from its line count and clears it", () => {
    expect(TRUST_JS).toMatch(/setProperty\("--trust-bar-h", `?\$\{?/);
    expect(TRUST_JS).toContain('setProperty("--trust-bar-h", "0px")');
  });
});
