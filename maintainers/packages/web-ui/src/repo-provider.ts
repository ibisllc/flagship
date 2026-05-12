/**
 * Repo-URL parsing and raw-content URL construction for the providers
 * the maintainers protocol supports out of the box.
 *
 * Static deployments (Model B) read `.maintainers/` over plain HTTPS
 * from a raw-content endpoint; this module's job is to map a
 * human-typable repo URL ("github.com/foo/bar", "codeberg.org/foo/bar",
 * "gitlab.com/foo/bar/-/tree/main") to the corresponding raw URL.
 *
 * If you operate a provider that isn't covered here, register a custom
 * `RepoProvider` and pass it to `loadProject` via the adapter.
 */

export interface RepoRef {
  provider: string;
  owner: string;
  repo: string;
  ref: string;
  /** Full canonical form, e.g. "github.com/foo/bar". */
  canonical: string;
}

export interface RepoProvider {
  name: string;
  matches(host: string): boolean;
  rawContentUrl(ref: RepoRef, path: string): string;
  /**
   * Construct a "list a directory" URL. Some providers expose a tree
   * API; for those that don't, fall back to known file paths.
   */
  treeApiUrl?(ref: RepoRef, path: string): string;
  /**
   * Construct a URL where the user can manually drop a new envelope
   * if neither an API write nor a ZIP download are usable. Used in the
   * "fallback to manual" branch of the static adapter.
   */
  manualCommitUrl(ref: RepoRef, path: string): string;
}

const GITHUB: RepoProvider = {
  name: "github",
  matches: (h) => h === "github.com" || h === "www.github.com",
  rawContentUrl: (r, p) => `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.ref}/${p}`,
  treeApiUrl: (r, p) =>
    `https://api.github.com/repos/${r.owner}/${r.repo}/contents/${p}?ref=${encodeURIComponent(r.ref)}`,
  manualCommitUrl: (r, p) =>
    `https://github.com/${r.owner}/${r.repo}/new/${encodeURIComponent(r.ref)}/${p.split("/").slice(0, -1).join("/")}`,
};

const CODEBERG: RepoProvider = {
  name: "codeberg",
  matches: (h) => h === "codeberg.org",
  rawContentUrl: (r, p) => `https://codeberg.org/${r.owner}/${r.repo}/raw/branch/${r.ref}/${p}`,
  treeApiUrl: (r, p) =>
    `https://codeberg.org/api/v1/repos/${r.owner}/${r.repo}/contents/${p}?ref=${encodeURIComponent(r.ref)}`,
  manualCommitUrl: (r, p) =>
    `https://codeberg.org/${r.owner}/${r.repo}/_new/${encodeURIComponent(r.ref)}/${p.split("/").slice(0, -1).join("/")}`,
};

const GITLAB: RepoProvider = {
  name: "gitlab",
  matches: (h) => h === "gitlab.com",
  rawContentUrl: (r, p) =>
    `https://gitlab.com/${r.owner}/${r.repo}/-/raw/${r.ref}/${p}`,
  treeApiUrl: (r, p) =>
    `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${r.owner}/${r.repo}`)}/repository/tree?path=${encodeURIComponent(p)}&ref=${encodeURIComponent(r.ref)}`,
  manualCommitUrl: (r, p) =>
    `https://gitlab.com/${r.owner}/${r.repo}/-/new/${encodeURIComponent(r.ref)}?file_name=${encodeURIComponent(p)}`,
};

const FORGEJO: RepoProvider = {
  name: "forgejo",
  matches: (h) => h.endsWith(".forgejo.org") || h === "forgejo.org",
  rawContentUrl: (r, p) => `https://${r.provider}/${r.owner}/${r.repo}/raw/branch/${r.ref}/${p}`,
  treeApiUrl: (r, p) =>
    `https://${r.provider}/api/v1/repos/${r.owner}/${r.repo}/contents/${p}?ref=${encodeURIComponent(r.ref)}`,
  manualCommitUrl: (r, p) =>
    `https://${r.provider}/${r.owner}/${r.repo}/_new/${encodeURIComponent(r.ref)}/${p.split("/").slice(0, -1).join("/")}`,
};

export const BUILTIN_PROVIDERS: RepoProvider[] = [GITHUB, CODEBERG, GITLAB, FORGEJO];

/**
 * Parse a typed-in repo URL.
 *
 * Accepted shapes:
 *   github.com/foo/bar
 *   github.com/foo/bar@v1.2.0
 *   github.com/foo/bar/tree/main
 *   https://github.com/foo/bar
 *   https://github.com/foo/bar.git
 *   git@github.com:foo/bar.git
 */
export function parseRepoUrl(input: string): RepoRef {
  let s = input.trim();
  if (!s) throw new Error("empty repo URL");
  // git@host:owner/repo style
  const sshMatch = /^git@([^:]+):([^/]+)\/(.+?)(\.git)?$/.exec(s);
  if (sshMatch) {
    const host = sshMatch[1]!;
    const owner = sshMatch[2]!;
    const repo = sshMatch[3]!;
    return finalizeRef(host, owner, repo, "main");
  }
  // strip scheme
  s = s.replace(/^https?:\/\//, "");
  // strip .git
  s = s.replace(/\.git$/, "");
  // split off @ref
  let ref = "main";
  const atIdx = s.indexOf("@");
  if (atIdx > 0 && !s.includes("@", atIdx + 1)) {
    ref = s.slice(atIdx + 1);
    s = s.slice(0, atIdx);
  }
  // strip /tree/<branch> and use it as ref
  const treeMatch = /\/tree\/([^/]+)\/?$/.exec(s);
  if (treeMatch) {
    ref = treeMatch[1]!;
    s = s.slice(0, treeMatch.index);
  }
  // strip /-/tree/<branch>
  const dashTreeMatch = /\/-\/tree\/([^/]+)\/?$/.exec(s);
  if (dashTreeMatch) {
    ref = dashTreeMatch[1]!;
    s = s.slice(0, dashTreeMatch.index);
  }
  // strip trailing slash
  s = s.replace(/\/$/, "");
  const parts = s.split("/");
  if (parts.length < 3) {
    throw new Error(`repo URL is missing owner/repo: ${input}`);
  }
  const host = parts[0]!;
  const owner = parts[1]!;
  const repo = parts.slice(2).join("/");
  return finalizeRef(host, owner, repo, ref);
}

function finalizeRef(host: string, owner: string, repo: string, ref: string): RepoRef {
  return {
    provider: host,
    owner,
    repo,
    ref,
    canonical: `${host}/${owner}/${repo}`,
  };
}

export function pickProvider(
  ref: RepoRef,
  registry: RepoProvider[] = BUILTIN_PROVIDERS,
): RepoProvider {
  for (const p of registry) {
    if (p.matches(ref.provider)) return p;
  }
  throw new Error(
    `no provider registered for host ${ref.provider}; pass a custom RepoProvider via the adapter`,
  );
}
