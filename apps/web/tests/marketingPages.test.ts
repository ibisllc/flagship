import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("marketing surface — design system v2 (dark+teal)", () => {
  it("/tokens.css exposes the v2 design-system custom properties", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/tokens.css" });
    expect(r.statusCode).toBe(200);
    // v2 canonical teal accent + legacy --accent / --primary aliases.
    expect(r.body).toMatch(/--teal:\s+#14B8A6/);
    expect(r.body).toContain("--accent");
    expect(r.body).toContain("--primary");
    expect(r.body).toContain("--font-sans");
    expect(r.body).toContain("--space-4");
    expect(r.body).toContain("--radius-md");
  });

  it("/components.css ships the primitive classes", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/components.css" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(".btn");
    expect(r.body).toContain(".card");
    expect(r.body).toContain(".pill");
    expect(r.body).toContain(".nav");
    expect(r.body).toContain(".colophon");
  });

  for (const path of ["/how-it-works.html"]) {
    it(`${path} loads the design tokens + components stylesheets`, async () => {
      const app = buildServer();
      const r = await app.inject({ method: "GET", url: path });
      expect(r.statusCode).toBe(200);
      // Either direct load or via /site.css which @imports them.
      expect(r.body).toMatch(/href="\/(tokens|site)\.css"/);
    });
  }

  for (const path of ["/"]) {
    it(`${path} carries the Flagship brand in the chrome`, async () => {
      const app = buildServer();
      const r = await app.inject({ method: "GET", url: path });
      // Pages may use either the new `.nav` chrome or the legacy
      // `.topbar` (which v2 components.css restyles into the new look).
      expect(r.body).toMatch(/class="(nav|topbar)"/);
      expect(r.body).toContain("Flagship");
    });
  }

  it("/blog/ ships a landing page that links the RSS feed", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/blog/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('href="/blog/rss.xml"');
    expect(r.body).toContain("Flagship");
  });

  it("/blog/rss.xml is well-formed RSS 2.0 with the canonical channel link", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/blog/rss.xml" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<?xml version="1.0"');
    expect(r.body).toContain('<rss version="2.0"');
    expect(r.body).toContain("<title>Flagship blog</title>");
    expect(r.body).toContain("<link>https://flagshipserver.com/blog/</link>");
  });

  it("/open-source.html lists the BUSL-1.1 license + 2030 Change Date", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/open-source.html" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("BUSL-1.1");
    expect(r.body).toContain("2030");
    expect(r.body).toContain("Apache 2.0");
    expect(r.body).toContain("github.com/ibisllc/flagship");
  });

  it("the landing page leads with the new positioning headline + honest beta CTAs", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.body).toContain("Your stuff");
    expect(r.body).toContain("hardware");
    expect(r.body).toContain("real green padlock");
    expect(r.body).toContain("Use web app");
    expect(r.body).toContain("iOS soon");
    expect(r.body).toContain("Android soon");
    expect(r.body).toContain('aria-disabled="true"');
    expect(r.body).toContain('data-studio-platform="mac"');
    expect(r.body).toContain('href="/download/mac"');
    expect(r.body).toContain('data-studio-platform="windows"');
    expect(r.body).toContain('href="/download/windows"');
    expect(r.body).toContain("userAgentData?.platform");
  });

  it("every app-promotion fallback points to the live web app without dead native links", async () => {
    const app = buildServer();
    for (const path of ["/", "/open/"]) {
      const r = await app.inject({ method: "GET", url: path });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('href="https://webapp.flagshipserver.com/"');
      expect(r.body).toContain("iOS soon");
      expect(r.body).toContain("Android soon");
      expect(r.body).not.toMatch(/href="#install-(ios|android)"/);
    }
    const home = await app.inject({ method: "GET", url: "/" });
    expect(home.body).toContain('target="_blank"');

    const notFound = await app.inject({ method: "GET", url: "/404.html" });
    expect(notFound.statusCode).toBe(200);
    expect(notFound.body).toContain('href="https://webapp.flagshipserver.com/"');
    expect(notFound.body).not.toContain("Get the mobile app");
  });

  it("the homepage and the open-in-app page take their store buttons from /app-stores.js", async () => {
    const app = buildServer();
    for (const path of ["/", "/open/"]) {
      const r = await app.inject({ method: "GET", url: path });
      expect(r.body, path).toContain('<script src="/app-stores.js"></script>');
      expect(r.body, path).toContain('data-app-store="ios"');
      expect(r.body, path).toContain('data-app-store="android"');
    }
    const stores = await app.inject({ method: "GET", url: "/app-stores.js" });
    expect(stores.statusCode).toBe(200);
    expect(stores.body).toContain("[data-app-store]");
  });

  it("the open-in-app page puts the webapp behind an opt-in link carrying the whole app link", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/open/" });
    expect(r.body).toContain('id="web-alt" hidden');
    expect(r.body).toContain("path + location.search + location.hash");
    // Every path the Worker serves this page at (APP_LINK_PATHS) has its copy.
    const route = readFileSync(join(__dirname, "../../com/src/route.ts"), "utf8");
    const list = /APP_LINK_PATHS[^=]*=\s*new Set\(\s*\[([^\]]*)\]/.exec(route)?.[1] ?? "";
    const paths = [...list.matchAll(/"(\/[a-z-]+)"/g)].map((m) => m[1]!);
    expect(paths).toContain("/join");
    for (const path of paths) expect(r.body).toContain(`"${path}": {`);
    // The old desktop QR login's /qr is no longer an app link.
    expect(r.body).not.toContain('"/qr": {');
  });

  it("never promotes one available desktop build without the other", async () => {
    const app = buildServer();
    for (const path of ["/", "/studio/"]) {
      const r = await app.inject({ method: "GET", url: path });
      expect(r.statusCode, path).toBe(200);
      expect(r.body, path).toContain("/download/mac");
      expect(r.body, path).toContain("/download/windows");
    }
  });

  it("shows the patent-pending notice across public site footers", async () => {
    const app = buildServer();
    const paths = [
      "/",
      "/404.html",
      "/abuse.html",
      "/adapters.html",
      "/blog/",
      "/coming-soon.html",
      "/docs/",
      "/faq.html",
      "/help.html",
      "/open-source.html",
      "/privacy.html",
      "/security.html",
      "/status/",
      "/terms.html",
    ];

    for (const path of paths) {
      const r = await app.inject({ method: "GET", url: path });
      expect(r.statusCode, path).toBe(200);
      expect(r.body, path).toContain("Patent Pending");
    }
  });

  it("the landing page no longer advertises /build/ or /pricing", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.body).not.toMatch(/href="\/build\/?"/);
    expect(r.body).not.toMatch(/href="\/pricing"/);
  });

  it("/how-it-works.html is now a redirect stub pointing at /docs#how-it-works", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/how-it-works.html" });
    // The standalone page was folded into /docs; the static file is a thin
    // client-side redirect (meta-refresh + location.replace).
    expect(r.body).toContain("/docs#how-it-works");
    expect(r.body).toMatch(/location\.replace|http-equiv="refresh"/);
  });

  it("the four-step flow now lives in /docs (folded from how-it-works)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/docs/index.html" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Pair");
    expect(r.body).toMatch(/scan|QR|deliver/i);
    expect(r.body).toMatch(/boot|unlock/i);
  });

  it("/docs has no placeholder sections: the manifest, recovery and app API sections say what they cover", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/docs/index.html" });
    expect(r.body).not.toMatch(/\bTODO\b/);
    expect(r.body).toContain("Manifest reference");
    expect(r.body).toContain("<code>runtime</code>");
    expect(r.body).toContain(".flagshipkey");
    expect(r.body).toContain("X-Flagship-Visitor");
    expect(r.body).toContain("/__flagship/sign-in?next=/path");
    expect(r.body).not.toContain("object store / KV");
  });

  it("the standalone /how-to.html explainer is deleted (no longer a served page)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/how-to.html" });
    // Fastify static returns 404 for the removed file. (In production the
    // Worker 302s /how-to + /how-to.html → /docs before the asset binding;
    // that redirect is covered in apps/com route tests.)
    expect(r.statusCode).toBe(404);
  });

  it("/docs folds in the 'assemble your server' section with centralized ISO recs", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/docs/index.html" });
    expect(r.statusCode).toBe(200);
    // Deep-link anchors preserved from the old how-to.html page.
    expect(r.body).toContain('id="certificate"');
    expect(r.body).toContain('id="recommended-linux"');
    expect(r.body).toContain('id="booting-process"');
    // The top-level folded section + its TOC entry.
    expect(r.body).toContain('id="burn"');
    // Debian 13 netinst is the recommended image, centralized here.
    expect(r.body).toContain(
      "https://cdimage.debian.org/cdimage/archive/13.6.0/amd64/iso-cd/debian-13.6.0-amd64-netinst.iso",
    );
    expect(r.body).toMatch(/Debian 13/);
  });

  it("/pricing.html is retired (Worker SPA-fallback returns the homepage)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/pricing.html" });
    // Acceptable: either a true 404 or a graceful 200 that serves the
    // landing as fallback. We only assert it isn't a dedicated pricing
    // page anymore (no "Tiny / Standard / Pro" wording).
    expect(r.body).not.toMatch(/<h1[^>]*>\s*Pricing/);
  });

  it("the report form lives in the #report section of /security", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/security.html" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/<section id="report">[\s\S]*<form id="report-form">/);
  });

  for (const path of ["/faq.html", "/privacy.html", "/terms.html", "/help.html", "/docs/index.html", "/disambiguate.html"]) {
    it(`${path} loads the design tokens + has the Flagship chrome`, async () => {
      const app = buildServer();
      const r = await app.inject({ method: "GET", url: path });
      expect(r.statusCode).toBe(200);
      expect(r.body).toMatch(/href="\/(tokens|site)\.css"/);
      expect(r.body).toMatch(/class="(nav|topbar)"/);
      expect(r.body).toContain("Flagship");
    });
  }

  it("faq covers the major topic groups", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/faq.html" });
    const groups = ["Setup", "Privacy", "Services", "money", "company"];
    const hits = groups.filter((g) => r.body.toLowerCase().includes(g.toLowerCase()));
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it("/adapters.html explains the public, anonymous index and how a repo owner opts out", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/adapters.html" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/class="(nav|topbar)"/);
    expect(r.body).toContain("mailto:legal@flagshipserver.com");
    expect(r.body).toContain('id="opt-out"');
    expect(r.body).toContain("Control how your repo runs on Flagship");
    expect(r.body).toContain("https://github.com/ibisllc/flagship-adapters");
    expect(r.body).toContain("do-not-adapt.txt");
    expect(r.body).toContain('id="problems"');
    expect(r.body).toMatch(/3 problems are reported/);
    const priv = await app.inject({ method: "GET", url: "/privacy.html" });
    expect(priv.body).toContain('id="repo-adaptations"');
    expect(priv.body).toContain('href="/adapters');
  });

  it("every footer with the Open column links the repo adapters page", async () => {
    const app = buildServer();
    for (const path of ["/", "/404.html", "/abuse.html", "/adapters.html", "/blog/", "/docs/", "/faq.html", "/help.html", "/open-source.html", "/privacy.html", "/security.html", "/status/", "/terms.html"]) {
      const r = await app.inject({ method: "GET", url: path });
      expect(r.body, path).toContain('<li><a href="/adapters.html">Repo adapters</a></li>');
    }
  });

  it("privacy §2.8 describes Flagship Inference plainly, with no provider placeholder", async () => {
    const app = buildServer();
    const priv = (await app.inject({ method: "GET", url: "/privacy.html" })).body;
    expect(priv).toContain('<h3 id="flagship-inference">2.8 Flagship Inference</h3>');
    expect(priv).toContain("a third-party hosted model provider chosen by us, which may change");
    expect(priv).toContain("We don't keep anything.");
    expect(priv).toContain("We anonymize requests.");
    expect(priv).toContain("aren't responsible for how it behaves");
    expect(priv).toContain("We may change provider at any time");
    expect(priv).not.toMatch(/to be named|to be confirmed|free AI/i);
    expect(priv).toContain("Last updated: 2026-10-20");
  });

  it("privacy + terms include real contact addresses", async () => {
    const app = buildServer();
    const priv = await app.inject({ method: "GET", url: "/privacy.html" });
    const terms = await app.inject({ method: "GET", url: "/terms.html" });
    expect(priv.body).toContain("@flagship");
    expect(terms.body).toContain("@flagship");
  });

  it("disambiguation page is a static fallback (no client-side resolver call)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/disambiguate.html" });
    expect(r.body).toContain("No service here");
    expect(r.body).not.toContain("/api/aliases/");
  });
});

describe("Studio platforms that have not passed a hardware run say so", () => {
  const pub = join(__dirname, "../public");
  it("the Windows downloads on the home page and /studio, and the Linux AppImage, are labelled Experimental", () => {
    const home = readFileSync(join(pub, "index.html"), "utf8");
    const windowsLinks = home.match(/data-studio-platform="windows"[^>]*>[^<]*<span class="studio-tag">Experimental<\/span>/g) ?? [];
    expect(windowsLinks.length).toBe(2);
    expect(home).not.toMatch(/data-studio-platform="mac"[^>]*>[^<]*Experimental/);
    const studio = readFileSync(join(pub, "studio/index.html"), "utf8");
    expect(studio).toMatch(/Download for Windows <em class="tag">Experimental<\/em>/);
    expect(studio).toMatch(/Get the AppImage<\/a> <em class="tag">Experimental<\/em>/);
    expect(studio).not.toMatch(/Download for macOS[^]{0,40}Experimental/);
  });
  it("the floors on /studio are the ones the owner set: Windows 11, Node.js 22", () => {
    const studio = readFileSync(join(pub, "studio/index.html"), "utf8");
    expect(studio).not.toContain("Windows 10");
    expect(studio).toContain("Windows 11");
    expect(studio).toContain("Node.js 22");
    expect(studio).not.toContain("Node.js 20");
  });
  it("the Windows and Linux window titles carry the label", () => {
    const root = join(__dirname, "../../");
    expect(readFileSync(join(root, "builder-windows/src/MainWindow.xaml"), "utf8")).toContain('Title="Flagship Studio (Experimental)"');
    expect(readFileSync(join(root, "builder-linux/wizard.py"), "utf8")).toContain('window.set_title("Flagship Studio (Experimental)")');
  });
});

describe("public claims match what the product does (GA review, B7)", () => {
  const pub = join(__dirname, "../public");
  const page = (p: string) => readFileSync(join(pub, p), "utf8");
  it("nobody is told that only a username can leak, or that every key is in the Secure Enclave", () => {
    for (const p of ["faq.html", "index.html", "docs/index.html", "security.html"]) {
      const t = page(p);
      expect(t, p).not.toMatch(/worst thing leaked|all we can leak is your username/);
      expect(t, p).not.toMatch(/every key sits in the Secure Enclave/);
      expect(t, p).not.toMatch(/holds the only key\./);
    }
    expect(page("faq.html")).toContain("metadata");
  });
  it("the FAQ sells nothing and promises nothing we have not built", () => {
    const t = page("faq.html");
    expect(t).not.toMatch(/Stripe|refund|prorate|peer-backup pool|pre-built box|self-hosting playbook|escrow/i);
    expect(t).not.toMatch(/id="money"|Money &amp; subscriptions/);
  });
  it("privacy names the metadata we see, the relay's AI path, and no longer says BYOK goes directly", () => {
    const t = page("privacy.html");
    expect(t).toContain('id="metadata"');
    expect(t).toContain('id="outbound-ai"');
    expect(t).not.toContain("prompts go directly from your daemon");
    expect(t).not.toMatch(/SNI hostname; bytes in\/out/);
  });
  it("the abuse page says what to do about a connection that seems to come from the relay's address", () => {
    const t = page("abuse.html");
    expect(t).toContain("149.248.216.86");
    expect(t).toContain("security@flagshipserver.com");
  });
});
