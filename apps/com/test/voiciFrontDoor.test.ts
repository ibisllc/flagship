/**
 * voi.ci's front door (docs/voici-front-door.md) through the Worker's router: `GET voi.ci/` is a static page in the
 * visitor's language, filled for its environment, with voi.ci's headers, that reads no storage at all (so it loads
 * while D1 is down); an unknown name stays the 404 shell; before VOICI_ENABLED is on, `/` is the empty 404 it was.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { route, type RouteEnv } from "../src/route.js";
import { pickVoiciFrontLanguage } from "../src/voiciFrontDoor.js";
import { VOICI_SITE_SHELL_404 } from "../src/voiciSiteBuild.generated.js";

const broken = new Proxy(
  {},
  {
    get() {
      throw new Error("the front door must not touch storage");
    },
  },
);

function world(over: Record<string, unknown> = {}) {
  const env = {
    SERVICES_BASE_URL: "https://services.invalid",
    ASSETS: { fetch: async () => new Response("nf", { status: 404 }) },
    DB: broken,
    VOICI: broken,
    VOICI_ENABLED: "on",
    SITE_PUBLIC: "1",
    ...over,
  } as unknown as RouteEnv;
  return (path: string, init: RequestInit & { host?: string } = {}) =>
    route(new Request(`https://${init.host ?? "voi.ci"}${path}`, { redirect: "manual", ...init }), env, { waitUntil: () => {} });
}

const vectors = (url: URL) => JSON.parse(readFileSync(url, "utf8")) as { cases: Array<{ accept: string; expect: string }> };

describe("voi.ci's front door", () => {
  it("serves a static page in the visitor's language with no storage at all", async () => {
    const call = world();
    const r = await call("/", { headers: { "accept-language": "fr-CI,fr;q=0.9" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("content-language")).toBe("fr");
    expect(r.headers.get("vary")).toBe("Accept-Language");
    const html = await r.text();
    expect(html).toContain('<html lang="fr"');
    expect(html).toContain("Une page bien à vous.");
    expect(html).not.toContain("%ORIGIN%");
    expect(html).not.toContain("%APEX%");
    expect(html).toContain('<link rel="canonical" href="https://voi.ci/?lang=fr">');
    expect(html).toContain('href="https://flagshipserver.com/app/page-editor"');
    expect(html).toContain('href="https://webapp.flagshipserver.com/"');
  });

  it("carries voi.ci's CSP and headers, so it runs no script", async () => {
    const r = await world()("/");
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await r.text()).not.toMatch(/<script/i);
  });

  it("?lang= picks a shipped language and ignores anything else", async () => {
    const call = world();
    expect((await call("/?lang=de", { headers: { "accept-language": "fr" } })).headers.get("content-language")).toBe("de");
    expect((await call("/?lang=xx", { headers: { "accept-language": "ja" } })).headers.get("content-language")).toBe("ja");
    expect((await call("/?lang=%3Cscript%3E")).headers.get("content-language")).toBe("en");
  });

  it("fills in the gym's own origin and apex", async () => {
    const call = world({ VOICI_WEB_ORIGIN: "https://gym.voi.ci", CONTROL_APEX: "gym.flagshipserver.com" });
    const html = await (await call("/", { host: "gym.voi.ci" })).text();
    expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://gym.voi.ci/">');
    expect(html).toContain('href="https://gym.flagshipserver.com/terms"');
    expect(html).toContain('href="https://webapp.gym.flagshipserver.com/"');
  });

  it("HEAD has the headers and no body", async () => {
    const r = await world()("/", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
  });

  it("loads with no database binding at all, where every name needs one", async () => {
    const call = world({ DB: undefined });
    expect((await call("/")).status).toBe(200);
    expect((await call("/alice")).status).toBe(503);
  });

  it("voi.ci's 404 shell (an unknown name) stays out of search results", () => {
    expect(VOICI_SITE_SHELL_404).toContain('<meta name="robots" content="noindex">');
  });

  it("before VOICI_ENABLED is on, / is the empty 404 it was", async () => {
    const r = await world({ VOICI_ENABLED: "off", DB: undefined })("/");
    expect(r.status).not.toBe(200);
    expect(await r.text()).toBe("");
  });

  it("chooses the language by the shared rule, then French for a French reader (test-vectors)", () => {
    for (const c of vectors(new URL("../../../test-vectors/language-negotiation.json", import.meta.url)).cases) expect(pickVoiciFrontLanguage(c.accept), c.accept).toBe(c.expect);
    for (const c of vectors(new URL("../../../test-vectors/voici-front-language.json", import.meta.url)).cases) expect(pickVoiciFrontLanguage(c.accept), c.accept).toBe(c.expect);
  });
});
