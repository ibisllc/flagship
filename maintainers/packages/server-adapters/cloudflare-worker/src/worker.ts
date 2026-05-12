/**
 * Cloudflare Worker — maintainers protocol Model A adapter.
 *
 * Holds a GitHub fine-grained PAT (contents:write, single repo) and
 * accepts signed-envelope commits on POST /commit. Reads the repo's
 * current `.maintainers/` state on every request, runs the policy
 * checks in `policy.ts`, and on success commits the file via the
 * GitHub Contents API.
 *
 * Threat-model reminder: this Worker is a high-value target because it
 * holds a token capable of pushing to `main`. Every line here is
 * written assuming the policy verifier is the gate, the path-prefix
 * fence is the fallback, and the PAT must never appear in any
 * response, log, or error message.
 */

import {
  decide,
  summarizeState,
  type PolicyDecision,
  type RepoState,
} from "./policy.js";
import type {
  Envelope,
  KeyFile,
  KeyRedirect,
  Mandate,
  RootPolicy,
  TrackPolicy,
} from "@maintainers/protocol";

export interface Env {
  GITHUB_MAINTAINERS_PAT: string;
  RATE_LIMIT_PER_IP_PER_HOUR: string;
  RATE_LIMIT_PER_REPO_PER_HOUR: string;
  ALLOWED_REPOS: string;
  DEFAULT_BRANCH: string;
  MAINTAINERS_PATH_PREFIX: string;
  RATE_LIMITER?: { limit: (key: { key: string }) => Promise<{ success: boolean }> };
}

interface CommitRequest {
  repoUrl: string;
  targetBranch?: string;
  path: string;
  envelope: unknown;
  envelopeBytes: string;
}

interface RepoIdent {
  host: string;
  owner: string;
  repo: string;
  canonical: string;
}

const PATH_PREFIX_HARD = ".maintainers/";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/commit") {
        return await handleCommit(request, env, ctx);
      }
      if (request.method === "GET" && url.pathname === "/verify") {
        return await handleVerify(url, env);
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true });
      }
      return json({ ok: false, reason: "not-found" }, 404);
    } catch (err) {
      // Defensive: never let an unhandled error leak the token.
      return json({ ok: false, reason: "internal-error" }, 500);
    }
  },
};

async function handleCommit(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

  let body: CommitRequest;
  try {
    body = (await request.json()) as CommitRequest;
  } catch {
    return json({ ok: false, reason: "invalid-json" }, 400);
  }
  if (typeof body !== "object" || body === null) {
    return json({ ok: false, reason: "body-not-object" }, 400);
  }
  if (typeof body.repoUrl !== "string" || typeof body.path !== "string" || typeof body.envelopeBytes !== "string") {
    return json({ ok: false, reason: "missing-fields" }, 400);
  }

  // Path-prefix fence ahead of any I/O. This is defense-in-depth: the
  // policy.decide() call will re-check it, but a request that fails
  // here never even causes a GitHub read.
  if (!body.path.startsWith(env.MAINTAINERS_PATH_PREFIX || PATH_PREFIX_HARD)) {
    return json({ ok: false, reason: "path-outside-maintainers" }, 403);
  }

  const repo = parseRepoUrl(body.repoUrl);
  if (!repo) return json({ ok: false, reason: "repo-url-invalid" }, 400);

  // Repo-allowlist fence. Empty ALLOWED_REPOS means deny-all.
  if (!isRepoAllowed(repo.canonical, env.ALLOWED_REPOS)) {
    return json({ ok: false, reason: "repo-not-allowed" }, 403);
  }

  // Rate-limiting. Bail before doing any GitHub I/O so an attacker
  // can't drive cost.
  const rlIp = await checkRateLimit(env, `ip:${ip}`, parseIntSafe(env.RATE_LIMIT_PER_IP_PER_HOUR, 60));
  if (!rlIp.ok) return json({ ok: false, reason: "rate-limited-ip" }, 429);
  const rlRepo = await checkRateLimit(env, `repo:${repo.canonical}`, parseIntSafe(env.RATE_LIMIT_PER_REPO_PER_HOUR, 100));
  if (!rlRepo.ok) return json({ ok: false, reason: "rate-limited-repo" }, 429);

  const branch = body.targetBranch ?? env.DEFAULT_BRANCH ?? "main";

  // Fetch current `.maintainers/` state from the repo.
  let state: RepoState;
  try {
    state = await fetchMaintainersState(repo, branch, env.GITHUB_MAINTAINERS_PAT);
  } catch (err) {
    return json({ ok: false, reason: "github-read-failed" }, 502);
  }

  const decision: PolicyDecision = decide({
    path: body.path,
    envelope: body.envelope,
    envelopeBytesHex: body.envelopeBytes,
    state,
    now: new Date(),
  });

  if (!decision.ok) {
    return json({ ok: false, reason: decision.reason, detail: decision.detail }, decision.status);
  }

  // Commit. The envelope is the body of the file at body.path.
  const fileContent = new TextEncoder().encode(JSON.stringify(body.envelope, null, 2) + "\n");
  const existingSha = await fetchFileSha(repo, body.path, branch, env.GITHUB_MAINTAINERS_PAT);
  let commitResult;
  try {
    commitResult = await putFile({
      repo,
      path: body.path,
      branch,
      content: fileContent,
      message: decision.commitMessage,
      sha: existingSha,
      pat: env.GITHUB_MAINTAINERS_PAT,
    });
  } catch (err) {
    return json({ ok: false, reason: "github-write-failed" }, 502);
  }

  return json({
    ok: true,
    commit: commitResult.commitSha,
    path: body.path,
    branch,
  });
}

async function handleVerify(url: URL, env: Env): Promise<Response> {
  const repoUrl = url.searchParams.get("repoUrl");
  if (!repoUrl) return json({ ok: false, reason: "missing-repoUrl" }, 400);
  const repo = parseRepoUrl(repoUrl);
  if (!repo) return json({ ok: false, reason: "repo-url-invalid" }, 400);
  if (!isRepoAllowed(repo.canonical, env.ALLOWED_REPOS)) {
    return json({ ok: false, reason: "repo-not-allowed" }, 403);
  }
  const branch = env.DEFAULT_BRANCH ?? "main";
  let state: RepoState;
  try {
    state = await fetchMaintainersState(repo, branch, env.GITHUB_MAINTAINERS_PAT);
  } catch {
    return json({ ok: false, reason: "github-read-failed" }, 502);
  }
  const summary = summarizeState(state, new Date());
  return json({ ok: true, repo: repo.canonical, branch, summary });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseIntSafe(s: string | undefined, dflt: number): number {
  if (!s) return dflt;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function parseRepoUrl(raw: string): RepoIdent | null {
  // Accepts: "github.com/owner/repo", "https://github.com/owner/repo",
  // "github.com/owner/repo.git". Owner/repo segments restricted to a
  // conservative charset.
  let s = raw.trim();
  if (s.startsWith("https://")) s = s.slice("https://".length);
  if (s.startsWith("http://")) s = s.slice("http://".length);
  if (s.endsWith(".git")) s = s.slice(0, -4);
  const parts = s.split("/");
  if (parts.length !== 3) return null;
  const [host, owner, repo] = parts as [string, string, string];
  if (host !== "github.com") return null;
  const segRe = /^[A-Za-z0-9._-]+$/;
  if (!segRe.test(owner) || !segRe.test(repo)) return null;
  return { host, owner, repo, canonical: `${host}/${owner}/${repo}` };
}

function isRepoAllowed(canonical: string, allowedCsv: string | undefined): boolean {
  if (!allowedCsv) return false;
  const allowed = allowedCsv.split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(canonical);
}

// ---------- Rate limiting ----------

const RL_MEMORY = new Map<string, { count: number; resetAt: number }>();

async function checkRateLimit(env: Env, key: string, perHourLimit: number): Promise<{ ok: boolean }> {
  if (env.RATE_LIMITER) {
    const r = await env.RATE_LIMITER.limit({ key });
    return { ok: r.success };
  }
  // Fallback: in-memory window. Note that the Workers runtime tears
  // down isolates frequently; this is approximate and good enough as a
  // last-resort throttle. Use the CF rate-limit binding in production.
  const now = Date.now();
  const slot = RL_MEMORY.get(key);
  if (!slot || slot.resetAt <= now) {
    RL_MEMORY.set(key, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return { ok: true };
  }
  if (slot.count >= perHourLimit) return { ok: false };
  slot.count++;
  return { ok: true };
}

// ---------- GitHub Contents API ----------

const UA = "maintainers-cloudflare-worker/0.1";

async function ghHeaders(pat: string): Promise<Record<string, string>> {
  return {
    "authorization": `Bearer ${pat}`,
    "accept": "application/vnd.github+json",
    "user-agent": UA,
    "x-github-api-version": "2022-11-28",
  };
}

async function fetchFileSha(
  repo: RepoIdent,
  path: string,
  branch: string,
  pat: string,
): Promise<string | undefined> {
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(url, { headers: await ghHeaders(pat) });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`github status ${r.status}`);
  const j = (await r.json()) as { sha?: string };
  return j.sha;
}

interface PutFileResult {
  commitSha: string;
}

async function putFile(opts: {
  repo: RepoIdent;
  path: string;
  branch: string;
  content: Uint8Array;
  message: string;
  sha: string | undefined;
  pat: string;
}): Promise<PutFileResult> {
  if (!opts.path.startsWith(PATH_PREFIX_HARD)) {
    // Last-line-of-defense fence.
    throw new Error("path-outside-maintainers");
  }
  const url = `https://api.github.com/repos/${opts.repo.owner}/${opts.repo.repo}/contents/${encodePath(opts.path)}`;
  const body: Record<string, unknown> = {
    message: opts.message,
    content: base64Encode(opts.content),
    branch: opts.branch,
  };
  if (opts.sha) body["sha"] = opts.sha;
  const r = await fetch(url, {
    method: "PUT",
    headers: { ...(await ghHeaders(opts.pat)), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    // Never include the body of the response in case it echoes any
    // header / token fragment.
    throw new Error(`github status ${r.status}`);
  }
  const j = (await r.json()) as { commit?: { sha?: string } };
  return { commitSha: j.commit?.sha ?? "" };
}

function encodePath(p: string): string {
  return p.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

function base64Encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  // Workers runtime has btoa.
  // @ts-ignore
  return btoa(bin);
}

function base64Decode(s: string): Uint8Array {
  // @ts-ignore
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- Repo-state reader ----------

interface GhDirEntry {
  type: string;
  name: string;
  path: string;
}

async function ghListDir(
  repo: RepoIdent,
  path: string,
  branch: string,
  pat: string,
): Promise<GhDirEntry[]> {
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(url, { headers: await ghHeaders(pat) });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`github status ${r.status}`);
  const j = await r.json();
  if (Array.isArray(j)) return j as GhDirEntry[];
  return [];
}

async function ghReadFile(
  repo: RepoIdent,
  path: string,
  branch: string,
  pat: string,
): Promise<Uint8Array | null> {
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(url, { headers: await ghHeaders(pat) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`github status ${r.status}`);
  const j = (await r.json()) as { content?: string; encoding?: string };
  if (!j.content) return null;
  if (j.encoding !== "base64") return null;
  // Strip newlines GitHub interleaves.
  return base64Decode(j.content.replace(/\n/g, ""));
}

async function ghListCommitsForPath(
  repo: RepoIdent,
  path: string,
  branch: string,
  pat: string,
): Promise<{ sha: string; date: string }[]> {
  // Canonical log ordering for mandates: we use the commit date that
  // touched each mandate file. GitHub returns newest-first; we reverse.
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits?path=${encodePath(path)}&sha=${encodeURIComponent(branch)}&per_page=100`;
  const r = await fetch(url, { headers: await ghHeaders(pat) });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`github status ${r.status}`);
  const j = (await r.json()) as { sha: string; commit: { committer?: { date?: string } } }[];
  const out: { sha: string; date: string }[] = [];
  for (const c of j) {
    const d = c.commit?.committer?.date ?? "";
    out.push({ sha: c.sha, date: d });
  }
  return out.reverse();
}

async function fetchMaintainersState(
  repo: RepoIdent,
  branch: string,
  pat: string,
): Promise<RepoState> {
  // Read .maintainers/policy.json if present.
  const rootBytes = await ghReadFile(repo, ".maintainers/policy.json", branch, pat);
  const rootPolicy = rootBytes ? (parseJsonOrNull(rootBytes) as RootPolicy | null) : null;

  const tracks = new Map<string, { policy: TrackPolicy; mandates: Mandate[] }>();
  const keyFiles = new Map<string, KeyFile>();

  // Discover tracks.
  const trackDirs = await ghListDir(repo, ".maintainers/tracks", branch, pat);
  for (const dir of trackDirs) {
    if (dir.type !== "dir") continue;
    const trackName = dir.name;
    const policyBytes = await ghReadFile(repo, `.maintainers/tracks/${trackName}/policy.json`, branch, pat);
    if (!policyBytes) continue;
    const policy = parseJsonOrNull(policyBytes) as TrackPolicy | null;
    if (!policy) continue;
    // Walk mandates/ and reconstruct canonical-log order using commit history.
    const mandateEntries = await ghListDir(repo, `.maintainers/tracks/${trackName}/mandates`, branch, pat);
    const fileBytes = new Map<string, Mandate>();
    for (const f of mandateEntries) {
      if (f.type !== "file" || !f.name.endsWith(".json")) continue;
      const b = await ghReadFile(repo, f.path, branch, pat);
      if (!b) continue;
      const parsed = parseJsonOrNull(b) as Mandate | null;
      if (parsed && parsed.kind === "Mandate") fileBytes.set(f.path, parsed);
    }
    // Canonical log order: by issuedAt timestamp ascending. Git history
    // would be ideal, but issuedAt is in canonical bytes and signed —
    // an attacker can't backdate without breaking signatures or the
    // verifier's `issued-before-predecessor` check.
    const mandates = Array.from(fileBytes.values()).sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));
    tracks.set(trackName, { policy, mandates });
  }

  // Discover keys.
  const keyEntries = await ghListDir(repo, ".maintainers/keys", branch, pat);
  for (const f of keyEntries) {
    if (f.type !== "file" || !f.name.endsWith(".json")) continue;
    const b = await ghReadFile(repo, f.path, branch, pat);
    if (!b) continue;
    const parsed = parseJsonOrNull(b) as KeyFile | KeyRedirect | null;
    if (parsed && parsed.kind === "KeyFile") {
      keyFiles.set(parsed.pubkey, parsed);
    }
  }

  return { rootPolicy, tracks, keyFiles };
}

function parseJsonOrNull(bytes: Uint8Array): unknown | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// Test surface — kept under an explicit export so the production
// entrypoint stays minimal.
export const __test = {
  parseRepoUrl,
  isRepoAllowed,
  checkRateLimit,
  base64Encode,
  base64Decode,
};
