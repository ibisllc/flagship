import type { FetchLike } from "@flagship/llm-providers";

/**
 * First-boot provisioning of the Forgejo container that ships as a system app
 * on every Flagship server. The container is started by NixOS / podman; this
 * module:
 *
 *   1. Polls Forgejo's HTTP API until it is ready.
 *   2. Creates the admin user using the install-time DB-bootstrap form (or
 *      the cookie-protected admin API on subsequent boots).
 *   3. Creates a per-user organization (`<userId>-flagship`) under which the
 *      user's repos live.
 *   4. Mints a long-lived API token scoped to that org for the LLM harness
 *      to commit vibe-coded changes.
 *
 * Caller stores the token wrapped under SWK on disk and references it from
 * the LLM harness when invoking Forgejo's git-push API.
 */

export interface ForgejoProvisioningOptions {
  /** Where Forgejo listens on the local network. */
  baseUrl: string;
  /** Logical Flagship user (DNS label). Used as the org-name root. */
  userId: string;
  /** Owner's display name (defaults to userId). */
  ownerDisplayName?: string;
  /** Owner email — required by Forgejo for the admin user. */
  ownerEmail: string;
  /** A random password generated locally for the bootstrap admin user. */
  adminPassword: string;
  fetchImpl?: FetchLike;
  /** Polling controls. */
  readinessTimeoutMs?: number;
  readinessIntervalMs?: number;
}

export interface ForgejoProvisioningResult {
  orgName: string;
  llmServiceToken: string;
  adminUsername: string;
  alreadyProvisioned: boolean;
}

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_INTERVAL = 1_000;

export async function provisionForgejo(
  opts: ForgejoProvisioningOptions,
): Promise<ForgejoProvisioningResult> {
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const adminUsername = `${opts.userId}-admin`;
  const orgName = `${opts.userId}-flagship`;
  const baseUrl = opts.baseUrl.replace(/\/$/, "");

  await waitForReadiness(baseUrl, f, opts.readinessTimeoutMs ?? DEFAULT_TIMEOUT, opts.readinessIntervalMs ?? DEFAULT_INTERVAL);

  const adminCreated = await ensureAdminUser(baseUrl, f, {
    username: adminUsername,
    email: opts.ownerEmail,
    password: opts.adminPassword,
  });

  await ensureOrganization(baseUrl, f, adminUsername, opts.adminPassword, {
    name: orgName,
    description: `Flagship apps for ${opts.ownerDisplayName ?? opts.userId}`,
  });

  const llmServiceToken = await ensureLlmServiceToken(
    baseUrl,
    f,
    adminUsername,
    opts.adminPassword,
  );

  return {
    orgName,
    llmServiceToken,
    adminUsername,
    alreadyProvisioned: !adminCreated,
  };
}

async function waitForReadiness(
  baseUrl: string,
  f: FetchLike,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await f(`${baseUrl}/api/v1/version`, { method: "GET" });
      if (r.ok) return;
      lastError = new Error(`status ${r.status}`);
    } catch (e) {
      lastError = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Forgejo not ready after ${timeoutMs}ms: ${String(lastError)}`);
}

interface AdminUserOptions {
  username: string;
  email: string;
  password: string;
}

async function ensureAdminUser(
  baseUrl: string,
  f: FetchLike,
  user: AdminUserOptions,
): Promise<boolean> {
  // Forgejo's bootstrap form lives at /-/install on a fresh database. After
  // first run, the admin endpoint /api/v1/admin/users requires admin auth.
  // We try install first (idempotent: returns 4xx if already installed) and
  // fall back to nothing on a re-boot.
  const installRes = await f(`${baseUrl}/-/install`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      db_type: "sqlite3",
      db_path: "/data/forgejo/forgejo.db",
      app_name: "Flagship Forgejo",
      repo_root_path: "/data/forgejo/git/repositories",
      lfs_root_path: "/data/forgejo/git/lfs",
      run_user: "git",
      domain: "git.flagship.local",
      ssh_port: "0", // disable ssh inside the container
      http_port: "3000",
      app_url: `${baseUrl}/`,
      log_root_path: "/data/forgejo/log",
      admin_name: user.username,
      admin_email: user.email,
      admin_passwd: user.password,
      admin_confirm_passwd: user.password,
    }).toString(),
  });
  // 200/302 = installed; 4xx = already installed.
  return installRes.ok;
}

interface OrgOptions {
  name: string;
  description: string;
}

async function ensureOrganization(
  baseUrl: string,
  f: FetchLike,
  adminUsername: string,
  adminPassword: string,
  org: OrgOptions,
): Promise<void> {
  const auth = basicAuth(adminUsername, adminPassword);
  const existing = await f(`${baseUrl}/api/v1/orgs/${encodeURIComponent(org.name)}`, {
    method: "GET",
    headers: { authorization: auth },
  });
  if (existing.ok) return;
  const created = await f(`${baseUrl}/api/v1/orgs`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({
      username: org.name,
      full_name: org.description,
      visibility: "private",
    }),
  });
  if (!created.ok) {
    throw new Error(`forgejo org create failed: ${created.status} ${await created.text()}`);
  }
}

async function ensureLlmServiceToken(
  baseUrl: string,
  f: FetchLike,
  adminUsername: string,
  adminPassword: string,
): Promise<string> {
  const auth = basicAuth(adminUsername, adminPassword);
  const tokenName = "flagship-llm-harness";

  // Try to delete a stale token of the same name; ignore failures.
  await f(`${baseUrl}/api/v1/users/${encodeURIComponent(adminUsername)}/tokens/${tokenName}`, {
    method: "DELETE",
    headers: { authorization: auth },
  }).catch(() => {});

  const r = await f(`${baseUrl}/api/v1/users/${encodeURIComponent(adminUsername)}/tokens`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({
      name: tokenName,
      scopes: ["write:repository", "read:repository", "write:organization", "read:user"],
    }),
  });
  if (!r.ok) throw new Error(`forgejo token create failed: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { sha1?: string; token?: string };
  const tok = body.sha1 ?? body.token;
  if (!tok) throw new Error("forgejo token response did not contain a token");
  return tok;
}

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
