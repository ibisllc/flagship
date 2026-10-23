/**
 * The public store of repo adapters. When this box adapts a public
 * open-source repo with AI and the result deploys, it sends the adapter to
 * flagshipserver.com, which checks it, has it vetted and signs an
 * attestation for that exact digest into an append-only index. On import the
 * box reads the signed index, verifies it and every attestation against the
 * keys its release pins, and fetches only attested digests, checking each
 * file's hash: a mirror or `.com` itself cannot hand one box a different
 * adapter without a signature that names it. docs/repo-adapters.md.
 *
 * Every call is anonymous by construction: no session, no account, no box
 * or server name, no header beyond the content type. Only repos on the big
 * public hosts are ever sent, and only after a clone that needed no
 * credentials, so a private repo's address never leaves the box.
 */

import { join } from "node:path";
import {
  adapterFileCapabilityDigest,
  normalizeRepoUrl,
  splitAdapterFile,
  type AdapterIndexDocument,
  type IndexHighWater,
  type PinnedVettingKey,
} from "@flagship/protocol";
import { keepCorruptAside, readStateFile, writeFileDurable } from "../durableFile.js";
import { AdapterTrust, type ServicePolicy } from "./adapterTrust.js";
import { hasCurrentVettingKey, loadAdapterVettingKeys } from "./adapterVettingKeys.js";

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
 * SEC-ADAPTER-002: an adapter someone else made is anonymous code that would
 * change this owner's build, and a content hash proves only that the bytes
 * match their name. A box offers one only when Flagship's signed index lists
 * a current, unrevoked attestation for that exact digest, signed by a key
 * this release pins (release/adapter-vetting-keys.json). With no pinned key,
 * lookup stays off. Sharing and complaints work either way. Tests flip it.
 */
const PINNED = loadAdapterVettingKeys();
export const communityAdapters = { lookupEnabled: PINNED.length > 0 };

export const ADAPTER_INDEX_API_PATH = "/api/adapters/index";
export const ADAPTER_FILE_API_PATH = "/api/adapters/file/";
const CANDIDATES = 3;

/**
 * The owner importing a repo into a new service is the choice to use an
 * adapter Flagship vetted for it; nothing else is accepted, and no per-service
 * manual choice is stored yet (SECURITY-HARDENING-PLAN.md 16.3).
 */
const IMPORT_POLICY: ServicePolicy = { manual: [], standingVetted: true, approvedCapabilityDigestHex: null };

type FetchLike = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status?: number; text(): Promise<string> }>;

export interface HttpAdapterIndexOptions {
  /** The public mirror's raw base URL. Lookups no longer read it: the bytes come from `.com` by digest. */
  store?: string;
  /** flagshipserver.com: the signed index, attested files, submissions and complaints. */
  submitTo: string;
  /** Defaults to the keys this release pins. */
  pinned?: () => readonly PinnedVettingKey[];
  /** Where the highest index seen is kept across restarts; null keeps it in memory only. */
  highWaterPath?: string | null;
  now?: () => number;
}

const DEFAULT_HIGH_WATER = join(process.env.FLAGSHIP_DATA_DIR ?? "/var/flagship", "data", "adapter-index-highwater.json");

async function loadHighWater(path: string | null): Promise<IndexHighWater | null> {
  if (!path) return null;
  const r = await readStateFile(path);
  if (r.kind !== "ok") {
    // A lost high-water mark lets an older, still unexpired index back in until the next one; the
    // index's short expiry bounds that, so lookup is not shut off for good.
    if (r.kind === "unreadable") await keepCorruptAside(path, r.error, "The adapter index is checked from scratch.");
    return null;
  }
  try {
    const v = JSON.parse(r.text) as Partial<IndexHighWater>;
    if (Number.isSafeInteger(v.sequence) && (v.sequence as number) >= 1 && typeof v.digestHex === "string" && /^[0-9a-f]{64}$/.test(v.digestHex)) {
      return { sequence: v.sequence as number, digestHex: v.digestHex };
    }
    throw new Error("bad high-water mark");
  } catch (e) {
    await keepCorruptAside(path, e, "The adapter index is checked from scratch.");
    return null;
  }
}

function asDocument(text: string): AdapterIndexDocument | null {
  const v = JSON.parse(text) as Partial<AdapterIndexDocument>;
  if (v?.schema !== 1 || !v.index || typeof v.index !== "object" || !Array.isArray(v.attestations)) return null;
  return v as AdapterIndexDocument;
}

/**
 * `submitTo`: flagshipserver.com, which serves the signed index and the
 * attested files, and takes submissions and complaints.
 */
export function httpAdapterIndex(
  opts: HttpAdapterIndexOptions,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): AdapterIndex {
  const submitTo = opts.submitTo.replace(/\/+$/, "");
  const now = opts.now ?? (() => Date.now());
  const pinned = opts.pinned ?? (() => PINNED);
  const highWaterPath = opts.highWaterPath === undefined ? DEFAULT_HIGH_WATER : opts.highWaterPath;
  let trust: Promise<AdapterTrust> | null = null;
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
  const refreshed = async (): Promise<AdapterTrust> => {
    trust ??= loadHighWater(highWaterPath).then((hw) => new AdapterTrust(pinned, now, hw));
    const t = await trust;
    const text = await get(`${submitTo}${ADAPTER_INDEX_API_PATH}`);
    const doc = text ? asDocument(text) : null;
    // A refused index (rolled back, forked, expired, unsigned) changes nothing: the last good one
    // stays in force until its own expiry.
    if (doc && t.accept(doc.index, doc.attestations).ok && highWaterPath && t.highWater) {
      await writeFileDurable(highWaterPath, JSON.stringify(t.highWater)).catch(() => {});
    }
    return t;
  };
  return {
    async lookup(repo, commit) {
      if (!communityAdapters.lookupEnabled || !hasCurrentVettingKey(pinned(), now())) return [];
      try {
        const t = await refreshed();
        const vetted = t.vettedFor(repo).sort(
          (a, b) => Number(b.baseRevision === commit) - Number(a.baseRevision === commit) || b.issuedAt - a.issuedAt,
        );
        const out: Array<{ base: string; file: string; sha: string }> = [];
        for (const a of vetted.slice(0, CANDIDATES)) {
          const file = await get(`${submitTo}${ADAPTER_FILE_API_PATH}${a.adapterDigestHex}`);
          if (file == null) continue;
          const split = splitAdapterFile(file);
          if (!split.ok || !split.adapter || split.adapter.source.repo !== repo || split.adapter.source.base !== a.baseRevision) continue;
          const capabilityDigestHex = adapterFileCapabilityDigest(file);
          if (!capabilityDigestHex) continue;
          const decision = t.decide(
            {
              digestHex: a.adapterDigestHex,
              bytes: new TextEncoder().encode(file),
              repo,
              baseRevision: split.adapter.source.base,
              capabilityDigestHex,
              provenance: "ai-vetted",
            },
            IMPORT_POLICY,
          );
          if (decision.use) out.push({ base: a.baseRevision, file, sha: a.adapterDigestHex });
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
