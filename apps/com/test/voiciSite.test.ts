// voi.ci's own files (apps/com/src/voiciSite.ts, chunk C): the shell from the generated build, and only this build's
// listed files under /_/<dir>/, immutable; everything else under /_/ is a 404, never the assets SPA fallback.
import { describe, expect, it } from "vitest";
import { voiciShellResponse, voiciSiteFile } from "../src/voiciSite.js";
import { VOICI_SITE_DIR, VOICI_SITE_FILES, VOICI_SITE_SHELL } from "../src/voiciSiteBuild.generated.js";

const H: [string, string][] = [["content-security-policy", "default-src 'none'"]];
const seen: string[] = [];
const assets = {
  fetch: async (req: Request) => {
    seen.push(new URL(req.url).pathname);
    return new Response("<html>spa fallback</html>", { status: 200 });
  },
};
const req = (p: string) => new Request(`https://voi.ci${p}`);

describe("voi.ci site files", () => {
  it("serves the shell for pages and /_/about, with the site headers", async () => {
    const r = voiciShellResponse(req("/alice"), H);
    expect([r.status, await r.text(), r.headers.get("content-type"), r.headers.get("content-security-policy")]).toEqual([200, VOICI_SITE_SHELL, "text/html; charset=utf-8", "default-src 'none'"]);
    expect(voiciShellResponse(req("/alice"), H, 410).status).toBe(410);
    expect(await (await voiciSiteFile(req("/_/about"), assets, "about", H)).text()).toBe(VOICI_SITE_SHELL);
    expect(VOICI_SITE_SHELL).toContain(`/_/${VOICI_SITE_DIR}/app.js`);
  });

  it("serves only listed files of this build", async () => {
    expect(VOICI_SITE_FILES.has("app.js") && VOICI_SITE_FILES.has("MANIFEST.json")).toBe(true);
    const ok = await voiciSiteFile(req(`/_/${VOICI_SITE_DIR}/app.js`), assets, `${VOICI_SITE_DIR}/app.js`, H);
    expect([ok.status, ok.headers.get("content-type"), ok.headers.get("cache-control")]).toEqual([200, "text/javascript; charset=utf-8", "public, max-age=31536000, immutable"]);
    expect(seen.at(-1)).toBe(`/_voici/${VOICI_SITE_DIR}/app.js`);
    const n = seen.length;
    for (const rest of [`${VOICI_SITE_DIR}/nope.js`, `0000000000000000/app.js`, "app.js", `${VOICI_SITE_DIR}/../index.html`, "shell", ""]) {
      expect((await voiciSiteFile(req(`/_/${rest}`), assets, rest, H)).status, rest).toBe(404);
    }
    expect(seen.length).toBe(n);
  });

  it("serves this build's reply-alert service worker at the fixed /_/sw.js, never cached", async () => {
    expect(VOICI_SITE_FILES.has("sw.js")).toBe(true);
    const sw = await voiciSiteFile(req("/_/sw.js"), assets, "sw.js", H);
    expect([sw.status, sw.headers.get("content-type"), sw.headers.get("cache-control"), sw.headers.get("content-security-policy")]).toEqual([
      200,
      "text/javascript; charset=utf-8",
      "no-cache",
      "default-src 'none'",
    ]);
    expect(seen.at(-1)).toBe(`/_voici/${VOICI_SITE_DIR}/sw.js`);
    expect(VOICI_SITE_SHELL).not.toContain("sw.js");
  });
});
