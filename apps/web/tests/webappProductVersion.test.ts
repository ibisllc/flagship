// The webapp's About shows the one product version (release/version.json),
// with the shell build beside it. Product version is not a wire version.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const WEBAPP = resolve(__dirname, "../public/webapp");
const shared = JSON.parse(readFileSync(resolve(__dirname, "../../../release/version.json"), "utf8"));

describe("webapp About version", () => {
  it("names the product version and label from release/version.json, then the shell build", async () => {
    const info = await import(pathToFileURL(resolve(WEBAPP, "lib/buildInfo.js")).href);
    expect(info.PRODUCT_VERSION).toBe(shared.product);
    expect(info.PRODUCT_LABEL).toBe(shared.label);
    expect(info.aboutVersionLine()).toBe(`Flagship ${shared.product} ${shared.label} (web build ${info.WEB_BUILD})`);
  });

  it("has a Version row in About that app.js fills", () => {
    const html = readFileSync(resolve(WEBAPP, "index.html"), "utf8");
    expect(html).toMatch(/<span class="label">Version<\/span><span class="value" id="about-version"/);
    const app = readFileSync(resolve(WEBAPP, "app.js"), "utf8");
    expect(app).toContain('$("about-version")');
  });

  it("leaves the protocol level alone", async () => {
    const info = await import(pathToFileURL(resolve(WEBAPP, "lib/buildInfo.js")).href);
    expect(info.PROTOCOL_LEVEL).toBe(1);
  });
});
