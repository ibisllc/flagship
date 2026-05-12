/**
 * Detect "this URL is a repo page on a known provider" and synthesize the
 * raw-content URL we need to fetch the project's `.maintainers/` folder.
 *
 * Pure URL parsing; no DOM, no network. Easy to test.
 *
 * Supported providers:
 *  - github.com           → raw.githubusercontent.com/<owner>/<repo>/<branch>/...
 *  - codeberg.org         → codeberg.org/<owner>/<repo>/raw/branch/<branch>/...
 *  - gitlab.com           → gitlab.com/<owner>/<repo>/-/raw/<branch>/...
 *  - gitea.com (and any gitea-style host) → /<owner>/<repo>/raw/branch/<branch>/...
 *
 * The detector returns the branches we should try in order (default
 * "main" first, then "master" as a fallback). Adopters can pin a branch
 * later via extension settings.
 */
export type Provider = "github" | "codeberg" | "gitlab" | "gitea" | "unknown";

export interface RepoLocation {
  provider: Provider;
  host: string;
  owner: string;
  repo: string;
  /** Branches we will try, in order. */
  branches: string[];
  /** Page-level URL the user is viewing, normalized to the repo root. */
  repoUrl: string;
  /**
   * Build a raw-content URL for a given path inside the repo
   * (e.g., `.maintainers/policy.json`) and branch.
   */
  rawUrl(path: string, branch: string): string;
}

const REPO_PATH_RE = /^\/([^/]+)\/([^/]+)(?:\/|$)/;

/** Paths that look like a username or org page, not a repo. */
const RESERVED_OWNERS_GITHUB = new Set([
  "settings",
  "notifications",
  "marketplace",
  "explore",
  "topics",
  "trending",
  "collections",
  "events",
  "new",
  "organizations",
  "pricing",
  "about",
  "security",
  "login",
  "logout",
  "join",
  "sponsors",
  "issues",
  "pulls",
  "codespaces",
  "search",
]);

const RESERVED_OWNERS_GITLAB = new Set([
  "explore",
  "help",
  "users",
  "groups",
  "projects",
  "snippets",
  "dashboard",
  "admin",
  "search",
  "-",
]);

const RESERVED_OWNERS_GITEA = new Set([
  "explore",
  "issues",
  "pulls",
  "milestones",
  "notifications",
  "user",
  "org",
  "admin",
  "-",
]);

/**
 * Examine a URL and decide whether it's a repo page. Returns null if not.
 *
 * `extraWhitelist` enables matching on user-configured hosts (e.g., a
 * private gitea install at git.example.com). Whitelisted hosts are
 * treated as gitea-shaped — adopters can refine later.
 */
export function detectRepo(
  url: string,
  extraWhitelist: string[] = [],
): RepoLocation | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  const host = parsed.hostname.toLowerCase();
  const match = parsed.pathname.match(REPO_PATH_RE);
  if (!match) return null;
  const owner = match[1]!;
  const repo = match[2]!.replace(/\.git$/, "");

  // Classify the host
  const provider = classifyHost(host, extraWhitelist);
  if (provider === "unknown") return null;

  // Filter out reserved-word top-level paths per provider
  if (provider === "github" && RESERVED_OWNERS_GITHUB.has(owner.toLowerCase())) return null;
  if (provider === "gitlab" && RESERVED_OWNERS_GITLAB.has(owner.toLowerCase())) return null;
  if ((provider === "gitea" || provider === "codeberg") && RESERVED_OWNERS_GITEA.has(owner.toLowerCase())) {
    return null;
  }

  // Heuristic: github repos are 1+ chars; sanity-bound the segment lengths
  if (owner.length === 0 || owner.length > 64) return null;
  if (repo.length === 0 || repo.length > 100) return null;

  const repoUrl = `${parsed.protocol}//${parsed.host}/${owner}/${repo}`;

  return {
    provider,
    host,
    owner,
    repo,
    branches: ["main", "master"],
    repoUrl,
    rawUrl(path: string, branch: string): string {
      return rawUrlFor(provider, host, owner, repo, branch, path);
    },
  };
}

function classifyHost(host: string, extraWhitelist: string[]): Provider {
  if (host === "github.com") return "github";
  if (host === "codeberg.org") return "codeberg";
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) return "gitlab";
  if (host === "gitea.com" || host.endsWith(".gitea.com")) return "gitea";
  if (host.startsWith("gitea.")) return "gitea";
  for (const w of extraWhitelist) {
    if (host === w.toLowerCase()) return "gitea";
  }
  return "unknown";
}

function rawUrlFor(
  provider: Provider,
  host: string,
  owner: string,
  repo: string,
  branch: string,
  path: string,
): string {
  const cleanPath = path.replace(/^\/+/, "");
  switch (provider) {
    case "github":
      return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${cleanPath}`;
    case "gitlab":
      return `https://${host}/${owner}/${repo}/-/raw/${branch}/${cleanPath}`;
    case "codeberg":
      return `https://${host}/${owner}/${repo}/raw/branch/${branch}/${cleanPath}`;
    case "gitea":
      return `https://${host}/${owner}/${repo}/raw/branch/${branch}/${cleanPath}`;
    default:
      throw new Error(`rawUrlFor: unknown provider "${provider}"`);
  }
}

/**
 * Standard paths inside `.maintainers/` we need to fetch to compute the
 * overlay. The fetcher walks these and folds 404s into "not present".
 */
export interface MaintainersIndex {
  policy: string;
  trackPolicy(track: string): string;
  trackMandatesListing(track: string): string;
  keysListing: string;
}

export function maintainersPaths(): MaintainersIndex {
  return {
    policy: ".maintainers/policy.json",
    trackPolicy: (track) => `.maintainers/tracks/${track}/policy.json`,
    trackMandatesListing: (track) => `.maintainers/tracks/${track}/mandates/`,
    keysListing: ".maintainers/keys/",
  };
}
