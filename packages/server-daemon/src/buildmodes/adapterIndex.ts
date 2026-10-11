/**
 * The public store of repo adapters. When this box adapts a public
 * open-source repo with AI and the result deploys, it sends the adapter to
 * flagshipserver.com, which checks it and publishes it in a public git repo
 * (ibisllc/flagship-adapters); on import, the box reads that repo directly.
 * Reading the public repo rather than asking our API means every box gets
 * the same bytes anyone can audit: nobody, us included, can quietly serve
 * one person a different adapter. docs/repo-adapters.md.
 *
 * Both calls are anonymous by construction: no session, no account, no box
 * or server name, no header beyond the content type. Only repos on the big
 * public hosts are ever sent, and only after a clone that needed no
 * credentials, so a private repo's address never leaves the box.
 */

import { createHash } from "node:crypto";
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

export const DEFAULT_ADAPTER_STORE = "https://raw.githubusercontent.com/ibisllc/flagship-adapters/main";
const CANDIDATES = 3;

type FetchLike = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ ok: boolean; text(): Promise<string> }>;

interface StoreIndex {
  adapters?: Array<{ base?: unknown; file?: unknown; added?: unknown; confirmations?: unknown }>;
}

/**
 * `store`: the public repo's raw base URL (read). `submitTo`:
 * flagshipserver.com (write).
 */
export function httpAdapterIndex(
  opts: { store?: string; submitTo: string },
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): AdapterIndex {
  const store = (opts.store ?? DEFAULT_ADAPTER_STORE).replace(/\/+$/, "");
  const submitTo = opts.submitTo.replace(/\/+$/, "");
  const get = async (url: string): Promise<string | null> => {
    const res = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    return res.ok ? res.text() : null;
  };
  return {
    async lookup(repo, commit) {
      try {
        const dir = `${store}/adapters/${repo.slice("https://".length)}`;
        const [indexText, blocked] = await Promise.all([get(`${dir}/index.json`), get(`${store}/do-not-adapt.txt`)]);
        if (!indexText) return [];
        if (blocked?.split("\n").some((l) => l.trim() === repo)) return [];
        const entries = ((JSON.parse(indexText) as StoreIndex).adapters ?? []).filter(
          (a): a is { base: string; file: string } =>
            typeof a.base === "string" && typeof a.file === "string" && /^[0-9a-f]{64}\.json$/.test(a.file),
        );
        const ordered = [...entries.filter((a) => a.base === commit), ...entries.filter((a) => a.base !== commit)];
        const out: Array<{ base: string; file: string }> = [];
        for (const a of ordered.slice(0, CANDIDATES)) {
          const file = await get(`${dir}/${a.file}`);
          // The name is the hash of the content: a file that doesn't match it isn't the one published.
          if (file && createHash("sha256").update(file).digest("hex") === a.file.slice(0, 64)) {
            out.push({ base: a.base, file });
          }
        }
        return out;
      } catch {
        return [];
      }
    },
    async submit(s) {
      try {
        await fetchImpl(`${submitTo}/api/adapters/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(s),
          signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
        });
      } catch {
        // Sharing is a courtesy to the next importer; a failure costs nothing here.
      }
    },
  };
}
