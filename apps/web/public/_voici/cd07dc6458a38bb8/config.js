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

const USERNAME = /^[a-z0-9](?:-?[a-z0-9]){0,31}$/;

/** "/alice" → {view:"page", username}; "/_/about" → {view:"about"}; anything else → {view:"missing"}. */
export function routeOf(pathname) {
  if (pathname === "/_/about" || pathname === "/_/about/") return { view: "about" };
  const m = /^\/([^/]+)\/?$/.exec(pathname);
  if (m && USERNAME.test(m[1])) return { view: "page", username: m[1] };
  return { view: "missing" };
}
