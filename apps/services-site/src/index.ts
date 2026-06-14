/**
 * flagship-services-site — Worker entry for the flagship.services apex.
 *
 * ⚠️ TEMPORARY. Today this Worker only fronts the former operator's static
 * marketing site (unpacked old_website.zip → ./public, served via the
 * ASSETS binding). The one dynamic route is /api/health: the bare [assets]
 * site used to fall back to index.html for every unknown path, so
 * https://flagship.services/api/health returned HTTP 200 + marketing HTML
 * — a soft success that lies to uptime monitors. Now it returns real JSON.
 *
 * TODO(marketplace): when the former-operator transition completes and this
 * placeholder is decommissioned (see README.md + wrangler.toml), the
 * flagship.services APEX becomes the home of the Flagship MARKETPLACE.
 * That surface will host:
 *   - the marketplace listings UI (browse / search / install apps),
 *   - the GitHub-equivalent code host (Forgejo) for app source + releases,
 *   - the marketplace security-scan service: pull the app's docker image,
 *     run Trivy + custom checks, post back marketplace_listings.scan_grade
 *     + an R2 report (today scan_grade ships NULL — see docs/build-tasks.md
 *     item 4 "Marketplace security scan service").
 * When that lands, replace this static-asset Worker with the real
 * marketplace app and EXTEND /api/health to also report scanner + Forgejo
 * liveness (not just "the apex Worker is up").
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json(
        {
          ok: true,
          service: "flagship.services",
          // Distinguishes this from the data-plane / .com surfaces so a
          // monitor can tell it's the apex placeholder, not a pod.
          surface: "apex-placeholder",
          note:
            "Temporary transition site for the former operator of this URL. " +
            "User traffic is SNI passthrough on per-pod <server>.<user> subdomains; " +
            "this apex will become the Flagship marketplace home (see TODO in src/index.ts).",
          now: new Date().toISOString(),
        },
        { headers: { "cache-control": "no-store" } },
      );
    }

    // Everything else: the static marketing site. The ASSETS binding honors
    // not_found_handling = "single-page-application", so unknown paths still
    // resolve to index.html as before.
    return env.ASSETS.fetch(request);
  },
};
