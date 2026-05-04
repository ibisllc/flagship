import type { FetchLike } from "@flagship/llm-providers";

/**
 * Per-app Forgejo admin — wraps a small slice of the Gitea/Forgejo REST API
 * scoped to `<user>-flagship/<app>`. The Flagship server-daemon exposes
 * this through HTTP routes the phone calls so the user can review LLM
 * commits, approve PRs, and revert from inside the Flagship app without
 * needing a Forgejo login.
 *
 * Each app has its own *push* token (so an app cannot push to a sibling's
 * repo even if its container is compromised). The admin operations below
 * use the LLM-harness service token, which has org-wide access; the daemon
 * is the single integration point that fans out to the right repo for the
 * caller's `appId`.
 */

export interface ForgejoAppAdminOptions {
  baseUrl: string;
  /** `<user>-flagship` — see forgejoProvisioning.ts. */
  orgName: string;
  /** Service token minted at first-boot provisioning. */
  serviceToken: string;
  fetchImpl?: FetchLike;
}

export interface ForgejoCommit {
  sha: string;
  message: string;
  author: { name: string; email: string };
  committedAt: string;
}

export interface ForgejoPullRequest {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  user: string;
  branch: string;
  createdAt: string;
}

export class ForgejoAppAdmin {
  private readonly opts: ForgejoAppAdminOptions;

  constructor(opts: ForgejoAppAdminOptions) {
    this.opts = opts;
  }

  /** List commits on the default branch of an app's repo. */
  async listCommits(appName: string, max = 50): Promise<ForgejoCommit[]> {
    const data = await this.api<unknown>(
      "GET",
      `/api/v1/repos/${this.path(appName)}/commits?limit=${clampMax(max)}`,
    );
    if (!Array.isArray(data)) return [];
    return data.map(parseCommit).filter((c): c is ForgejoCommit => c !== null);
  }

  /** List open + closed pull requests on the app repo. */
  async listPullRequests(appName: string, state: "open" | "closed" | "all" = "open"): Promise<ForgejoPullRequest[]> {
    const data = await this.api<unknown>(
      "GET",
      `/api/v1/repos/${this.path(appName)}/pulls?state=${encodeURIComponent(state)}`,
    );
    if (!Array.isArray(data)) return [];
    return data.map(parsePR).filter((p): p is ForgejoPullRequest => p !== null);
  }

  /** Merge (approve) a PR. */
  async mergePr(appName: string, number: number, message?: string): Promise<{ merged: boolean }> {
    const data = await this.api<unknown>(
      "POST",
      `/api/v1/repos/${this.path(appName)}/pulls/${number}/merge`,
      {
        Do: "squash",
        merge_message: message ?? `flagship: merge PR #${number}`,
      },
    );
    if (typeof data === "object" && data !== null && "merged" in data) {
      return { merged: !!(data as { merged: unknown }).merged };
    }
    // Forgejo returns 200 with empty body on success — treat that as merged.
    return { merged: true };
  }

  /** Close a PR without merging (the "retract" path). */
  async closePr(appName: string, number: number): Promise<void> {
    await this.api(
      "PATCH",
      `/api/v1/repos/${this.path(appName)}/issues/${number}`,
      { state: "closed" },
    );
  }

  /**
   * Create a revert commit (as a PR) for the given SHA. Forgejo doesn't have
   * a single endpoint for this; we open a PR with the ref name `revert-<sha>`
   * which the user reviews. The daemon API exposes this as
   * POST /apps/:appId/git/commits/:sha/revert.
   */
  async createRevertPr(appName: string, sha: string): Promise<ForgejoPullRequest> {
    const branch = `revert-${sha.slice(0, 12)}-${Date.now()}`;
    // Forgejo: cherry-pick ref creation. We post a "branches" creation from
    // the parent commit, then open a PR.
    await this.api(
      "POST",
      `/api/v1/repos/${this.path(appName)}/branches`,
      { new_branch_name: branch, old_ref_name: `${sha}^` },
    );
    const data = await this.api<unknown>(
      "POST",
      `/api/v1/repos/${this.path(appName)}/pulls`,
      {
        title: `Revert ${sha.slice(0, 8)}`,
        body: `Automated revert request from the Flagship app.`,
        head: branch,
        base: "main",
      },
    );
    const parsed = parsePR(data);
    if (!parsed) throw new Error("forgejo did not return a PR object");
    return parsed;
  }

  private path(appName: string): string {
    return `${encodeURIComponent(this.opts.orgName)}/${encodeURIComponent(appName)}`;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const f = this.opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const res = await f(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `token ${this.opts.serviceToken}`,
        "content-type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`forgejo ${method} ${path} failed: ${res.status} ${await res.text()}`);
    }
    const text = await res.text();
    if (text.length === 0) return {} as T;
    return JSON.parse(text) as T;
  }
}

function clampMax(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(Math.floor(n), 200);
}

function parseCommit(raw: unknown): ForgejoCommit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const sha = typeof r.sha === "string" ? r.sha : null;
  if (!sha) return null;
  const commit = (r.commit ?? {}) as Record<string, unknown>;
  const author = (commit.author ?? {}) as Record<string, unknown>;
  return {
    sha,
    message: typeof commit.message === "string" ? commit.message : "",
    author: {
      name: typeof author.name === "string" ? author.name : "",
      email: typeof author.email === "string" ? author.email : "",
    },
    committedAt: typeof author.date === "string" ? author.date : "",
  };
}

function parsePR(raw: unknown): ForgejoPullRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.number !== "number") return null;
  const head = (r.head ?? {}) as Record<string, unknown>;
  const user = (r.user ?? {}) as Record<string, unknown>;
  return {
    number: r.number,
    title: typeof r.title === "string" ? r.title : "",
    state: r.state === "closed" ? "closed" : "open",
    merged: !!r.merged,
    user: typeof user.login === "string" ? user.login : "",
    branch: typeof head.ref === "string" ? head.ref : "",
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
  };
}
