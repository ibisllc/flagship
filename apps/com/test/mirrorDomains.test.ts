import { describe, expect, it } from "vitest";
import { route, type RouteEnv } from "../src/route.js";
import { matchMirror, rewriteMirrorHtml } from "../src/mirrorDomains.js";

const PAGE = `<!doctype html><html><head>
<title>Flagship — flagshipserver.com</title>
<link rel="canonical" href="https://flagshipserver.com/faq.html">
<style>/* flagshipserver.com */</style>
<script>fetch("https://flagshipserver.com/api/health")</script>
</head><body>
<p>Open webapp.flagshipserver.com or home.alice.flagship.services.</p>
<a href="mailto:support@flagshipserver.com">support@flagshipserver.com</a>
<p>Not notflagshipserver.com nor flagship.services-like.</p>
</body></html>`;

function makeEnv(): RouteEnv {
  return {
    SERVICES_BASE_URL: "https://flagship.services",
    SITE_PUBLIC: "1",
    ASSETS: {
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path.endsWith(".js")) {
          return new Response(`const d = "x.y.flagship.services";`, {
            headers: { "content-type": "text/javascript" },
          });
        }
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    },
  } as RouteEnv;
}

describe("mirror domain (fshp.tech)", () => {
  it("matches only the mirror zone: fshp.app is the direct domain, not a mirror", () => {
    expect(matchMirror("fshp.tech")).toEqual({ apex: "fshp.tech", sub: "" });
    expect(matchMirror("A.B.FSHP.TECH")).toEqual({ apex: "fshp.tech", sub: "a.b" });
    expect(matchMirror("fshp.app")).toBeNull();
    expect(matchMirror("game--alice.fshp.app")).toBeNull();
    expect(matchMirror("notfshp.tech")).toBeNull();
    expect(matchMirror("flagshipserver.com")).toBeNull();
  });

  it("rewrites visible mentions but not scripts, styles or emails", () => {
    const out = rewriteMirrorHtml(PAGE, "fshp.tech", "flagshipserver.com", "flagship.services");
    expect(out).toContain("<title>Flagship — fshp.tech</title>");
    expect(out).toContain('href="https://fshp.tech/faq.html"');
    expect(out).toContain("Open webapp.fshp.tech or home.alice.fshp.tech.");
    expect(out).toContain("/* flagshipserver.com */");
    expect(out).toContain('fetch("https://flagshipserver.com/api/health")');
    expect(out).toContain('mailto:support@flagshipserver.com">support@flagshipserver.com<');
    expect(out).toContain("notflagshipserver.com nor flagship.services-like");
  });

  for (const apex of ["fshp.tech"]) {
    it(`serves ${apex} as the apex, re-skinned`, async () => {
      const res = await route(new Request(`https://${apex}/faq.html`), makeEnv());
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(`<title>Flagship — ${apex}</title>`);
      expect(body).not.toContain("<p>Open webapp.flagshipserver.com");
    });
  }

  it("passes non-HTML assets through byte-identical", async () => {
    const res = await route(new Request("https://fshp.tech/x.js"), makeEnv());
    expect(await res.text()).toBe(`const d = "x.y.flagship.services";`);
  });

  it("keeps apex redirects on the mirror", async () => {
    const res = await route(new Request("https://fshp.tech/build"), makeEnv());
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/studio");
  });

  it("www redirects to the bare mirror apex", async () => {
    const res = await route(new Request("https://www.fshp.tech/docs?x=1"), makeEnv());
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://fshp.tech/docs?x=1");
  });

  it("Cloudflare-served subhosts redirect to their control-apex twin", async () => {
    const res = await route(new Request("https://webapp.fshp.tech/foo?a=b"), makeEnv());
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://webapp.flagshipserver.com/foo?a=b");
  });

  it("the direct domain's bare apex only points at the site; its names never mirror", async () => {
    for (const host of ["fshp.app", "www.fshp.app"]) {
      const res = await route(new Request(`https://${host}/faq.html`), makeEnv());
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("https://flagshipserver.com/");
    }
    const name = await route(new Request("https://game--alice.fshp.app/"), makeEnv());
    expect(name.headers.get("location") ?? "").not.toContain("flagship.services");
  });

  it("every other host redirects to flagship.services", async () => {
    const res = await route(new Request("https://home.alice.fshp.tech/app/x?y=1"), makeEnv());
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://home.alice.flagship.services/app/x?y=1");
  });
});
