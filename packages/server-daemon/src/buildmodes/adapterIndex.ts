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

export interface StoreReason {
  code: string;
  message: string;
  /** Whether changing the adaptation could get it kept. */
  fixable: boolean;
}

/** flagshipserver.com's answer to a submission. */
export interface SubmitVerdict {
  status: "kept" | "known" | "refused";
  /** The sha256 of the file, which names it in the store. */
  file?: string;
  reasons?: StoreReason[];
}

export interface AdapterIndex {
  /** Adapters for this repo, best first. Empty on any failure. */
  lookup(repo: string, base: string): Promise<Array<{ base: string; file: string; sha: string }>>;
  /** Submit and wait for the checks. Null when there was no answer. */
  submit(s: { repo: string; base: string; licensePath: string; file: string }): Promise<SubmitVerdict | null>;
  /**
   * Say a published adapter didn't work: it failed to build or start while
   * installing, or the owner reports a problem in their own words. Nothing
   * else is sent. Fire and forget.
   */
  complain(c: { repo: string; file: string; stage: "build" | "start" | "report"; detail?: string }): Promise<void>;
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

/**
 * SEC-ADAPTER-001: an adapter from the public store is anonymous code that
 * would change this owner's build, and a content hash proves only that the
 * bytes match their name. Boxes do not offer or apply one until the signed,
 * reviewed index (SEC-ADAPTER-002) exists. Sharing and complaints still work.
 * Tests flip it.
 */
export const communityAdapters = { lookupEnabled: false };

export const DEFAULT_ADAPTER_STORE = "https://raw.githubusercontent.com/ibisllc/flagship-adapters/main";
const CANDIDATES = 3;

type FetchLike = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status?: number; text(): Promise<string> }>;

interface StoreIndex {
  adapters?: Array<{ base?: unknown; file?: unknown; added?: unknown; confirmations?: unknown; complaints?: unknown }>;
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
  const post = (path: string, body: unknown, ms: number) =>
    fetchImpl(`${submitTo}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
  const get = async (url: string): Promise<string | null> => {
    const res = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    return res.ok ? res.text() : null;
  };
  return {
    async lookup(repo, commit) {
      if (!communityAdapters.lookupEnabled) return [];
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
        const out: Array<{ base: string; file: string; sha: string }> = [];
        for (const a of ordered.slice(0, CANDIDATES)) {
          const file = await get(`${dir}/${a.file}`);
          const sha = a.file.slice(0, 64);
          // The name is the hash of the content: a file that doesn't match it isn't the one published.
          if (file && createHash("sha256").update(file).digest("hex") === sha) out.push({ base: a.base, file, sha });
        }
        return out;
      } catch {
        return [];
      }
    },
    async submit(s) {
      try {
        const res = await post("/api/adapters/submit", { ...s, wait: true }, SUBMIT_TIMEOUT_MS);
        if (!res.ok) return null;
        const v = JSON.parse(await res.text()) as Partial<SubmitVerdict>;
        if (v.status !== "kept" && v.status !== "known" && v.status !== "refused") return null;
        const reasons = Array.isArray(v.reasons)
          ? v.reasons.filter(
              (r): r is StoreReason =>
                !!r && typeof r.code === "string" && typeof r.message === "string" && typeof r.fixable === "boolean",
            )
          : [];
        return {
          status: v.status,
          ...(typeof v.file === "string" && /^[0-9a-f]{64}$/.test(v.file) ? { file: v.file } : {}),
          ...(reasons.length ? { reasons } : {}),
        };
      } catch {
        // Sharing is a courtesy to the next importer; a failure costs nothing here.
        return null;
      }
    },
    async complain(c) {
      try {
        await post("/api/adapters/complain", c, LOOKUP_TIMEOUT_MS);
      } catch {
        // Best effort, like sharing.
      }
    },
  };
}
