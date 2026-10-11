/**
 * flagshipserver.com's index of repo adapters. When this box adapts a public
 * open-source repo with AI and the result deploys, it shares the adapter so
 * the next person importing that repo installs it without AI; on import, it
 * asks whether anyone has. docs/repo-adapters.md.
 *
 * Both calls are anonymous by construction: no session, no account, no box
 * or server name, no header beyond the content type. Only repos on the big
 * public hosts are ever sent, and only after a clone that needed no
 * credentials, so a private repo's address never leaves the box.
 */

import { normalizeRepoUrl } from "@flagship/protocol";

export interface AdapterIndex {
  /** Adapters for this repo, best first. Empty on any failure. */
  lookup(repo: string, base: string): Promise<Array<{ base: string; file: string }>>;
  /** Fire and forget: the index answers the same whether it kept it or not. */
  submit(s: { repo: string; base: string; licensePath: string; file: string }): Promise<void>;
}

const INDEX_HOSTS = new Set(["github.com", "gitlab.com", "codeberg.org"]);
const LOOKUP_TIMEOUT_MS = 10_000;
const SUBMIT_TIMEOUT_MS = 120_000;

/** The repo's normalized address, if it is one the index takes. */
export function indexableRepo(gitUrl: string): string | null {
  const repo = normalizeRepoUrl(gitUrl);
  if (!repo) return null;
  return INDEX_HOSTS.has(new URL(repo).hostname) ? repo : null;
}

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|rst))?$/i;

/** The top-level license file, which the index reads to check the license. */
export function licensePathOf(files: Record<string, string>): string | null {
  return Object.keys(files).filter((p) => !p.includes("/") && LICENSE_FILE.test(p)).sort()[0] ?? null;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function httpAdapterIndex(baseUrl: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): AdapterIndex {
  const base = baseUrl.replace(/\/+$/, "");
  const post = (path: string, body: unknown, ms: number) =>
    fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
  return {
    async lookup(repo, commit) {
      try {
        const res = await post("/api/adapters/lookup", { repo, base: commit }, LOOKUP_TIMEOUT_MS);
        if (!res.ok) return [];
        const j = (await res.json()) as { adapters?: unknown };
        if (!Array.isArray(j.adapters)) return [];
        return j.adapters.filter(
          (a): a is { base: string; file: string } =>
            !!a && typeof (a as { base?: unknown }).base === "string" && typeof (a as { file?: unknown }).file === "string",
        );
      } catch {
        return [];
      }
    },
    async submit(s) {
      try {
        await post("/api/adapters/submit", s, SUBMIT_TIMEOUT_MS);
      } catch {
        // Sharing is a courtesy to the next importer; a failure costs nothing here.
      }
    },
  };
}
