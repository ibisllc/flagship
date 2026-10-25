/**
 * SEC-BROWSER-001/002: the app browser is on only when the release says so
 * (release/box-release.json `appBrowser`, which the release gym decides). The
 * data layer never ships a Chromium container, the old shared profile is
 * destroyed at boot, and Chromium runs only from its own policed overlay.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BOX_RELEASE } from "@flagship/protocol";
import { APP_BROWSER } from "../src/index.js";

const read = (rel: string) => readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("app browser containment", () => {
  it("follows the release setting, which says on or off in so many words", async () => {
    const rel = JSON.parse(await read("../../../release/box-release.json")) as { appBrowser?: unknown };
    expect(typeof rel.appBrowser).toBe("boolean");
    expect(BOX_RELEASE.appBrowser).toBe(rel.appBrowser);
    expect(APP_BROWSER.enabled).toBe(BOX_RELEASE.appBrowser);
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

describe("init.sh starts the app browser's Chromium exactly when the release turns it on", () => {
  it("adds the overlay to every compose call only when release/box-release.json says appBrowser: true", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const init = await read("../../../installer/data-services/init.sh");
    const block = init.slice(init.indexOf('APP_BROWSER_COMPOSE="'), init.indexOf("\nfi\n", init.indexOf('APP_BROWSER_COMPOSE="')) + 4);
    for (const engine of ["podman compose", "docker compose", "docker-compose"]) {
      expect(init).toContain(`compose() { ${engine} -f "$COMPOSE" \${WITH_BROWSER:+-f "$APP_BROWSER_COMPOSE"} --env-file "$SECRETS_FILE" "$@"; }`);
    }
    const run = (appBrowser: boolean) => {
      const root = mkdtempSync(join(tmpdir(), "init-browser-"));
      mkdirSync(join(root, "installer/data-services"), { recursive: true });
      mkdirSync(join(root, "release"));
      writeFileSync(join(root, "installer/data-services/docker-compose.yml"), "services: {}\n");
      writeFileSync(join(root, "installer/data-services/app-browser.compose.yml"), "services: {}\n");
      writeFileSync(join(root, "release/box-release.json"), JSON.stringify({ appBrowser }));
      const script = `COMPOSE=${join(root, "installer/data-services/docker-compose.yml")}\n${block}\nprintf '%s ' -f "$COMPOSE" \${WITH_BROWSER:+-f "$APP_BROWSER_COMPOSE"}`;
      return execFileSync("sh", ["-c", script], { encoding: "utf8" });
    };
    expect(run(true)).toMatch(/-f \S+docker-compose\.yml -f \S+app-browser\.compose\.yml/);
    expect(run(false)).not.toMatch(/app-browser/);
  });
});

