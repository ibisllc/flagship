// Where this copy of the site is running, decided by its own hostname only (docs/voici-and-messages.md §4).
// Production voi.ci and the gym's gym.voi.ci are fixed here; nothing a visitor or a page can send changes them.
// localhost (apps/voici-site/dev/serve.mjs) reads a dev meta tag the dev server writes into its shell.

const ENVS = {
  "voi.ci": {
    origin: "https://voi.ci",
    host: "voi.ci",
    apex: "flagshipserver.com",
    services: "flagship.services",
    files: "https://files.voi.ci",
  },
  "gym.voi.ci": {
    origin: "https://gym.voi.ci",
    host: "gym.voi.ci",
    apex: "gym.flagshipserver.com",
    services: "gym.flagship.services",
    files: "https://files.gym.voi.ci",
  },
};

const DEV_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function siteConfig(loc = globalThis.location, doc = globalThis.document) {
  const env = ENVS[loc.hostname];
  if (env) return { ...env, apiBase: `https://${env.apex}`, secure: true, dev: false };
  if (!DEV_HOSTS.has(loc.hostname)) return null;
  try {
    const c = JSON.parse(doc.querySelector('meta[name="voici-dev"]')?.getAttribute("content") ?? "null");
    if (!c || typeof c !== "object") return null;
    return {
      origin: String(c.origin),
      host: String(c.host),
      apex: String(c.apex),
      services: String(c.services),
      files: String(c.files),
      apiBase: String(c.apiBase),
      secure: c.secure !== false,
      dev: true,
    };
  } catch {
    return null;
  }
}

// The username format (docs/voici-namespace-spec.md D12): 3 to 63 of a-z 0-9 -, no leading, trailing or double hyphen.
const USERNAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * "/alice" → {view:"page", username}; "/-/about" → {view:"about"}; anything else → {view:"missing"}. `status` is the
 * shell's `voici-status` meta: `.com` serves the same shell as its 404 (unknown, unpublished, held) and its 410 (a
 * removed link or code), so the page can say which.
 */
export function routeOf(pathname, status = null) {
  if (status === "410") return { view: "gone" };
  if (status === "404") return { view: "missing" };
  if (pathname === "/-/about" || pathname === "/-/about/") return { view: "about" };
  const m = /^\/([^/]+)\/?$/.exec(pathname);
  if (m && USERNAME.test(m[1]) && !m[1].includes("--")) return { view: "page", username: m[1] };
  return { view: "missing" };
}
