/**
 * SEC-BROWSER-001: the app browser is off. No Chromium container ships, its
 * shared profile is destroyed at boot, and the daemon does not wire the
 * browser API even if a CDP endpoint answers.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_BROWSER } from "../src/index.js";

const read = (rel: string) => readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("app browser containment", () => {
  it("is off in code", () => {
    expect(APP_BROWSER.enabled).toBe(false);
  });

  it("the compose stack has no chromium service and publishes no CDP port", async () => {
    const compose = await read("../../../installer/data-services/docker-compose.yml");
    const live = compose.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(live).not.toMatch(/chromium/i);
    expect(live).not.toMatch(/9222/);
  });

  it("init.sh deletes the shared profile and no longer recreates it", async () => {
    const init = await read("../../../installer/data-services/init.sh");
    expect(init).toMatch(/rm -rf "\$DATA_DIR\/chromium"/);
    expect(init).not.toMatch(/mkdir -p [^\n]*chromium/);
  });
});

describe("the app browser's launch, ready for when the owner turns it on", () => {
  it("runs Chromium alone on an internal network with exactly the egress flags the daemon expects", async () => {
    const { chromiumEgressFlags } = await import("../src/browser/egress.js");
    const { BROWSER_EGRESS } = await import("../src/index.js");
    const overlay = await read("../../../installer/data-services/app-browser.compose.yml");
    const flags = [...overlay.matchAll(/^\s+- (--\S.*)$/gm)].map((m) => m[1]!.trim());
    expect(flags).toEqual(chromiumEgressFlags(`http://${BROWSER_EGRESS.gateway}:${BROWSER_EGRESS.denyPort}`));
    expect(overlay).toMatch(/internal: true/);
    expect(overlay).toContain(`ipv4_address: ${BROWSER_EGRESS.browser}`);
    expect(overlay).toContain(`gateway: ${BROWSER_EGRESS.gateway}`);
    expect(overlay).not.toMatch(/^\s+ports:/m);
  });
});
