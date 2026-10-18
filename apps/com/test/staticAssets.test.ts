/**
 * Static assets on the Workers Free plan. Every request that runs the `.com`
 * Worker counts against 100,000 a day; a file the assets layer answers on its own
 * is free. apps/com/wrangler.toml therefore says `run_worker_first = ["/*", "!/file"...]`
 * and these tests hold that list to account (scripts/static-assets.ts is the reader
 * the predeploy guard also uses):
 *
 *   - no path the Worker must see (API, redirects, app links, the AASA file, the gate,
 *     recovery.'s files, voi.ci codes) is answered by the assets layer;
 *   - every listed file really exists, so a deleted page cannot leave a dead pattern;
 *   - the `_headers` file carries exactly the headers the Worker would have added;
 *   - the webapp Worker's assets directory is the webapp, its fonts and qrEncoder.js,
 *     with the shell CSP, and flagship-com no longer owns webapp. / remote.;
 *   - the gym Worker, which serves everything itself, is untouched.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_HEADER_RULES,
  MAX_WORKER_FIRST_ENTRIES,
  MUST_REACH_WORKER,
  buildWebappAssets,
  checkStaticAssets,
  countHeaderRules,
  directPatterns,
  globToRegExp,
  listFiles,
  reachesWorker,
  readWorkerFirst,
  siteHeadersFile,
  webappHeadersFile,
} from "../../../scripts/static-assets.js";
import { route, type RouteEnv } from "../src/route.js";
import { securityHeaders } from "../src/securityHeaders.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const comToml = readFileSync(join(root, "apps/com/wrangler.toml"), "utf8");
const gymToml = readFileSync(join(root, "apps/com/wrangler.gym.toml"), "utf8");
const patterns = readWorkerFirst(comToml);

describe("Cloudflare's run_worker_first rule", () => {
  it("* is deep, everything else literal, negatives win", () => {
    expect(globToRegExp("/fonts/*").test("/fonts/a/b.woff2")).toBe(true);
    expect(globToRegExp("/fonts/*").test("/fonts")).toBe(false);
    expect(globToRegExp("/a.b").test("/aXb")).toBe(false);
    expect(reachesWorker(["/*", "!/x/*"], "/x/y")).toBe(false);
    expect(reachesWorker(["/*", "!/x/*"], "/y")).toBe(true);
    expect(reachesWorker(["/api/*"], "/docs")).toBe(false);
  });

  it("reads the list out of the [assets] table, comments and all", () => {
    expect(readWorkerFirst('[assets]\ndirectory = "x"\nrun_worker_first = [\n  "/*", # all\n  "!/a",\n]\n\n[vars]\n')).toEqual(["/*", "!/a"]);
    expect(readWorkerFirst('[assets]\nrun_worker_first = true\n')).toEqual(["/*"]);
  });
});

describe("apps/com/wrangler.toml", () => {
  it("passes the guard the predeploy script runs", () => {
    expect(checkStaticAssets(root)).toEqual([]);
  });

  it("starts from /* and stays inside Cloudflare's limits", () => {
    expect(patterns[0]).toBe("/*");
    expect(patterns.length).toBeLessThanOrEqual(MAX_WORKER_FIRST_ENTRIES);
    expect(directPatterns(patterns).length).toBeGreaterThan(20);
  });

  it("sends every path the Worker handles to the Worker", () => {
    const shadowed = MUST_REACH_WORKER.filter((p) => !reachesWorker(patterns, p));
    expect(shadowed).toEqual([]);
  });

  it("sends the Worker's own routes there even if someone lists a broader static pattern", () => {
    // the guard's reason for existing: these must fail if a negative pattern is widened
    const widened = [...patterns, "!/*.js"];
    expect(["/recovery.js", "/app.js", "/lib/api.js"].every((p) => !reachesWorker(widened, p))).toBe(true);
    const f = MUST_REACH_WORKER.filter((p) => !reachesWorker(widened, p));
    expect(f.length).toBeGreaterThan(0);
  });

  it("every file it serves directly exists, and its bytes are what recovery. also expects", () => {
    expect(checkStaticAssets(root).filter((x) => /stale|recovery\./.test(x.message))).toEqual([]);
  });

  it("serves the real marketing site's files directly and its dynamic pages through the Worker", () => {
    for (const p of ["/site.css", "/fonts/Geist-Variable.woff2", "/docs/", "/docs", "/faq", "/privacy.html", "/status/", "/downloads/FlagshipVMAppliance-amd64.json", "/.well-known/security.txt"]) {
      expect(reachesWorker(patterns, p), p).toBe(false);
    }
    for (const p of ["/", "/studio", "/api/health", "/.well-known/apple-app-site-association", "/join", "/abc123"]) {
      expect(reachesWorker(patterns, p), p).toBe(true);
    }
  });

  it("keeps the coming-soon gate off, which direct files skip", () => {
    expect(comToml).toMatch(/^SITE_PUBLIC\s*=\s*"1"/m);
  });

  it("does not own webapp. or remote. any more, and keeps the other hosts", () => {
    const routes = comToml.match(/^routes\s*=\s*\[([\s\S]*?)^\]/m)![1]!;
    expect(routes).not.toMatch(/webapp\.flagshipserver\.com|remote\.flagshipserver\.com/);
    for (const h of ["flagshipserver.com/*", "voi.ci/*", "www.voi.ci/*", "recovery.flagshipserver.com", "boot.flagshipserver.com", "www.flagshipserver.com"]) {
      expect(routes).toContain(h);
    }
  });

  it("the gym Worker still runs first for everything (it serves webapp.gym. itself)", () => {
    expect(readWorkerFirst(gymToml)).toEqual(["/*"]);
  });
});

describe("the guard refuses a bad list", () => {
  const withPattern = (extra: string) => comToml.replace('  "/*",\n', `  "/*",\n  ${JSON.stringify(extra)},\n`);
  const messages = (toml: string) => checkStaticAssets(root, toml).map((f) => f.message);

  it("a pattern that shadows an API path, a redirect or recovery.'s files", () => {
    expect(messages(withPattern("!/api/*")).join("\n")).toMatch(/\/api\/health is served as a static file/);
    expect(messages(withPattern("!/*.js")).join("\n")).toMatch(/\/recovery\.js is served as a static file/);
    expect(messages(withPattern("!/studio")).join("\n")).toMatch(/\/studio is served as a static file/);
    expect(messages(withPattern("!/.well-known/*")).join("\n")).toMatch(/apple-app-site-association is served/);
    expect(messages(withPattern("!/*")).join("\n")).toMatch(/is served as a static file/);
  });

  it("a pattern that matches no file, or names the Worker's own folders", () => {
    expect(messages(withPattern("!/gone.css")).join("\n")).toMatch(/gone\.css: matches no file/);
    expect(messages(withPattern("!/recovery/*")).join("\n")).toMatch(/that folder is the Worker's/);
  });

  it("a list the _headers file no longer matches", () => {
    // a real file, newly listed, with no rule written for it yet
    expect(messages(withPattern("!/grain.svg.bak")).join("\n")).toMatch(/out of date/);
    expect(messages(withPattern("!/404.html")).join("\n")).toMatch(/out of date/);
  });

  it("the gate armed, or the SPA fallback turned off, or the list not starting from /*", () => {
    expect(messages(comToml.replace(/^SITE_PUBLIC = "1"/m, 'SITE_PUBLIC = "0"')).join("\n")).toMatch(/SITE_PUBLIC is not "1"/);
    expect(messages(comToml.replace(/^not_found_handling = "single-page-application"/m, 'not_found_handling = "404-page"')).join("\n")).toMatch(/not_found_handling/);
    expect(messages(comToml.replace('  "/*",\n', "")).join("\n")).toMatch(/must start from/);
  });

  it("webapp. listed as a route of flagship-com again", () => {
    expect(messages(comToml.replace("routes = [", 'routes = [\n  { pattern = "webapp.flagshipserver.com", custom_domain = true },')).join("\n")).toMatch(/routes of flagship-webapp/);
  });
});

describe("apps/web/public/_headers", () => {
  const file = readFileSync(join(root, "apps/web/public/_headers"), "utf8");

  it("is exactly what run_worker_first generates, within 100 rules", () => {
    expect(file).toBe(siteHeadersFile(patterns));
    expect(countHeaderRules(file)).toBe(directPatterns(patterns).length);
    expect(countHeaderRules(file)).toBeLessThanOrEqual(MAX_HEADER_RULES);
  });

  it("carries the headers the Worker adds to a site page, value for value", async () => {
    const env = {
      SERVICES_BASE_URL: "https://flagship-services.fly.dev:8443",
      SITE_PUBLIC: "1",
      ASSETS: { fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }) },
    } as unknown as RouteEnv;
    const res = await route(new Request("https://flagshipserver.com/zzz-not-listed"), env);
    const workerSide = Object.fromEntries(
      ["content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "strict-transport-security"].map((n) => [n, res.headers.get(n)]),
    );
    const rule = file.split("\n").slice(file.split("\n").indexOf("/site.css") + 1, file.split("\n").indexOf("/site.css") + 6);
    const fileSide = Object.fromEntries(rule.map((l) => l.trim().split(/:\s(.+)/)).map(([n, v]) => [n!.toLowerCase(), v]));
    expect(fileSide).toEqual(workerSide);
    expect(securityHeaders("site", { apex: "flagshipserver.com", services: "flagship.services", https: true }).length).toBe(5);
  });
});

describe("the static-only webapp Worker", () => {
  const toml = readFileSync(join(root, "apps/webapp-static/wrangler.toml"), "utf8");

  it("owns webapp. and remote. as custom domains, has no run_worker_first, and falls back to index.html", () => {
    expect(toml).toMatch(/pattern = "webapp\.flagshipserver\.com", custom_domain = true/);
    expect(toml).toMatch(/pattern = "remote\.flagshipserver\.com", custom_domain = true/);
    expect(toml).not.toMatch(/^run_worker_first/m);
    expect(toml).toMatch(/not_found_handling = "single-page-application"/);
    expect(toml).toMatch(/compatibility_date = "20(2[5-9]|[3-9]\d)-/);
  });

  it("builds the webapp at the root with the shared fonts, qrEncoder.js and the shell headers", async () => {
    const out = mkdtempSync(join(tmpdir(), "webapp-assets-"));
    try {
      const { files } = await buildWebappAssets(out);
      const built = listFiles(out);
      const webapp = listFiles(join(root, "apps/web/public/webapp"));
      for (const f of webapp) expect(built, f).toContain(f);
      expect(built).toContain("qrEncoder.js");
      expect(built.filter((f) => f.startsWith("fonts/")).length).toBeGreaterThanOrEqual(2);
      expect(built).toContain("_headers");
      expect(files).toBe(built.length);
      const headers = readFileSync(join(out, "_headers"), "utf8");
      expect(headers).toBe(webappHeadersFile());
      expect(headers).toContain("Content-Security-Policy: default-src 'self'; script-src 'self'");
      expect(headers).toContain("frame-ancestors 'none'");
      expect(headers).toContain("X-Frame-Options: DENY");
      expect(headers).toContain("Referrer-Policy: no-referrer");
      expect(headers).toContain("Strict-Transport-Security: max-age=31536000");
      // the service worker and its page are in the shell
      expect(existsSync(join(out, "service-worker.js"))).toBe(true);
      expect(existsSync(join(out, "index.html"))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("serves the shell CSP the Worker serves on webapp. (one source of truth)", async () => {
    const env = {
      SERVICES_BASE_URL: "https://flagship-services.fly.dev:8443",
      SITE_PUBLIC: "1",
      ASSETS: { fetch: async () => new Response("x", { headers: { "content-type": "text/html" } }) },
    } as unknown as RouteEnv;
    const res = await route(new Request("https://webapp.flagshipserver.com/"), env);
    const csp = res.headers.get("content-security-policy")!;
    expect(webappHeadersFile()).toContain(csp);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
