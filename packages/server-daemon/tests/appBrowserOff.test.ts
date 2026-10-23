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
