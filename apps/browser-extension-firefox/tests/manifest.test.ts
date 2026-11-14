import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { messagesFor, toFirefoxMessage } from "../../../scripts/i18n-browser-extension.mjs";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(EXT, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

describe("manifest", () => {
  it("is a Firefox MV3 manifest with a fixed add-on id and no data collection", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.browser_specific_settings.gecko.id).toBe("firefox-extension@flagshipserver.com");
    expect(manifest.browser_specific_settings.gecko.data_collection_permissions).toEqual({ required: ["none"] });
    expect(manifest.background.scripts).toEqual(["src/background.js"]);
  });

  it("asks for the pin check's permissions and nothing broader", () => {
    expect(manifest.permissions.sort()).toEqual(["storage", "webRequest", "webRequestBlocking"]);
    expect(manifest.host_permissions).toEqual(["*://*.flagship.services/*", "*://*.fshp.app/*"]);
    expect(JSON.stringify(manifest)).not.toMatch(/<all_urls>|"tabs"|cookies|scripting/);
  });

  it("names only files that exist", () => {
    const files = [
      ...manifest.background.scripts,
      manifest.action.default_popup,
      manifest.action.default_icon,
      ...Object.values(manifest.icons),
      ...manifest.content_scripts.flatMap((c: { js: string[] }) => c.js),
    ];
    for (const f of files) expect(fs.existsSync(path.join(EXT, f as string)), f as string).toBe(true);
  });

  it("has a version AMO accepts", () => {
    expect(manifest.version).toMatch(/^\d+(?:\.\d+){0,3}$/);
  });
});

describe("_locales", () => {
  it("writes Firefox placeholders and escapes a literal dollar", () => {
    expect(toFirefoxMessage("{0} served {1}")).toBe("$1 served $2");
    expect(toFirefoxMessage("costs $5")).toBe("costs $$5");
  });

  it("has every ga language, each with every key, built from i18n/browser-extension", () => {
    const en = JSON.parse(messagesFor("en"));
    for (const dir of ["en", "es", "fr", "de", "pt_BR", "ja", "zh_CN"]) {
      const f = path.join(EXT, "_locales", dir, "messages.json");
      const msgs = JSON.parse(fs.readFileSync(f, "utf8"));
      expect(Object.keys(msgs).sort(), dir).toEqual(Object.keys(en).sort());
    }
  });

  it("passes the surface's i18n check", () => {
    const r = spawnSync("node", [path.join(ROOT, "scripts/i18n-browser-extension.mjs"), "check"], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toContain("i18n-browser-extension: ok");
    expect(r.status).toBe(0);
  });
});

describe("QR encoder copy", () => {
  it("stays in step with the website's", () => {
    const body = (f: string) => fs.readFileSync(f, "utf8").split("\n").slice(2).join("\n");
    expect(body(path.join(EXT, "src/lib/qrEncoder.js"))).toBe(body(path.join(ROOT, "apps/web/public/qrEncoder.js")));
  });
});
