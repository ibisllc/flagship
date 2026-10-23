/**
 * The community adapter vetting pipeline and its signed index (SECURITY-HARDENING-PLAN.md 10.3,
 * SEC-ADAPTER-002).
 *
 *   1. Deterministic checks (adapterIndex.ts: shape, source, rules, license, public-code fit, added
 *      secrets and server addresses). A failing check ends it: the model never sees that file.
 *   2. The model review (adapterReview.ts), which reads only the adapter file itself.
 *   3. On a pass, the pipeline (not the model) signs `flagship/adapter-attestation/v1` for that exact
 *      digest with ADAPTER_ATTESTATION_SIGNING_KEY, whose public half boxes pin in their release.
 *   4. A signed, append-only index (`flagship/adapter-index/v1`) lists every current attestation and
 *      every revocation. Boxes read it at GET /api/adapters/index and fetch only attested digests at
 *      GET /api/adapters/file/<sha256>.
 *
 * Revocation is a signed `revoked` attestation that beats every attestation of the digest; complaints
 * from enough distinct networks, a later failed review, or the repo owner's opt-out produce one. A
 * complaint's source is kept only as a keyed hash of its network, per adapter, so two adapters'
 * complainers cannot be linked and the network cannot be read back.
 */
import {
  adapterFileCapabilityDigest,
  adapterIndexDigest,
  attestationDigest,
  ed,
  repoAdapterProblems,
  signAdapterAttestation,
  signAdapterIndex,
  splitAdapterFile,
  type AdapterAttestation,
  type AdapterIndexBody,
  type AdapterIndexDocument,
  type Keypair,
  type SignedAdapterAttestation,
} from "@flagship/protocol";
import type { D1Database } from "@flagship/storage";
import type { AdapterBucketLike } from "./adapterIndex.js";
import { REVIEW_MODEL, REVIEW_POLICY_VERSION, reviewAdapterFile, reviewPolicyDigest, type ReviewResult } from "./adapterReview.js";

export const ADAPTER_INDEX_PATH = "/api/adapters/index";
export const ADAPTER_FILE_PATH = "/api/adapters/file/";
/** Bump with any change to the deterministic checks an attestation vouches for. */
export const VALIDATOR_VERSION = "adapter-rules/1";
const DAY_MS = 86_400_000;
export const ATTESTATION_TTL_MS = 90 * DAY_MS;
/** A box treats a lapsed index as absent; a daily refresh keeps a missed day harmless. */
export const INDEX_TTL_MS = 3 * DAY_MS;
const INDEX_REFRESH_MS = DAY_MS;
/** Distinct networks whose complaints withdraw an attested adapter. */
export const RETIRE_AT_SOURCES = 3;
const COMPLAINT_WINDOW_DAYS = 90;
/** Model reviews per cron run (catch-up and renewals), within the publish slot's subrequest budget. */
export const MAX_VETS_PER_RUN = 4;
const RENEW_BEFORE_MS = 14 * DAY_MS;
const INDEX_VERSIONS_KEPT = 30;

export interface AdapterVettingEnv {
  DB?: D1Database;
  ADAPTERS_BUCKET?: AdapterBucketLike;
  ADAPTER_REVIEW_ANTHROPIC_KEY?: string;
  /** 64 hex: the Ed25519 seed of the online attestation key. Unset: nothing is attested. */
  ADAPTER_ATTESTATION_SIGNING_KEY?: string;
  /** HMAC key for complaint sources. Unset: complaints are kept but count toward no withdrawal. */
  ADAPTER_COMPLAINT_SALT?: string;
}

export type RevokeReason = "reports" | "review" | "do-not-adapt" | "admin";

export function attestationKey(env: AdapterVettingEnv): Keypair | null {
  const seed = env.ADAPTER_ATTESTATION_SIGNING_KEY?.trim().toLowerCase();
  if (!seed || !/^[0-9a-f]{64}$/.test(seed)) return null;
  const privateKey = Uint8Array.from(seed.match(/../g)!.map((x) => parseInt(x, 16)));
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PassEvidence {
  fileText: string;
  fileSha: string;
  repo: string;
  base: string;
  license: string;
  review: ReviewResult;
}

/**
 * Sign a pass for one exact file and keep the bytes where boxes fetch them. Null when the key is
 * missing, the review was not a whole-file pass, or the file's manifest does not parse.
 */
export async function attestPass(env: AdapterVettingEnv, e: PassEvidence, now: number): Promise<SignedAdapterAttestation | null> {
  const key = attestationKey(env);
  const db = env.DB;
  const bucket = env.ADAPTERS_BUCKET;
  if (!key || !db || !bucket || e.review.kind !== "pass" || e.review.truncated) return null;
  const capabilityDigestHex = adapterFileCapabilityDigest(e.fileText);
  if (!capabilityDigestHex) return null;
  if (await revokedAlready(db, e.fileSha)) return null;
  const evidence = JSON.stringify({
    validatorVersion: VALIDATOR_VERSION,
    checks: ["shape", "source", "rules", "license", "no-own-manifest", "public-base-fit", "no-added-secrets", "no-server-address"],
    license: e.license,
    policyVersion: REVIEW_POLICY_VERSION,
    policyDigestHex: await reviewPolicyDigest(),
    reviewerModel: REVIEW_MODEL,
    modelVersion: e.review.modelVersion,
    verdict: { ok: true, category: "none" },
    reviewedChars: e.fileText.length,
  });
  const attestation: AdapterAttestation = {
    adapterDigestHex: e.fileSha,
    repo: e.repo,
    baseRevision: e.base,
    capabilityDigestHex,
    validatorVersion: VALIDATOR_VERSION,
    policyVersion: REVIEW_POLICY_VERSION,
    reviewerModel: REVIEW_MODEL,
    modelVersion: e.review.modelVersion,
    evidenceSha256Hex: await sha256Hex(evidence),
    outcome: "pass",
    issuedAt: now,
    expiresAt: now + ATTESTATION_TTL_MS,
  };
  const signed = signAdapterAttestation(attestation, key);
  await bucket.put(`attested/${e.fileSha}.json`, e.fileText, { httpMetadata: { contentType: "application/json" } });
  await insertAttestation(db, signed, evidence, null);
  return signed;
}

async function revokedAlready(db: D1Database, fileSha: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM adapter_attestations WHERE adapter_sha256 = ? AND outcome = 'revoked' LIMIT 1").bind(fileSha).first()) != null;
}

async function insertAttestation(db: D1Database, signed: SignedAdapterAttestation, evidence: string, reason: RevokeReason | null): Promise<void> {
  const a = signed.attestation;
  await db
    .prepare(
      `INSERT OR IGNORE INTO adapter_attestations
         (digest, adapter_sha256, repo, outcome, reason, issued_at, expires_at, signed_json, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(attestationDigest(a), a.adapterDigestHex, a.repo, a.outcome, reason, a.issuedAt, a.expiresAt, JSON.stringify(signed), evidence)
    .run();
}

/**
 * Withdraw one digest for good with a signed revocation. Its expiry outlasts every pass of the
 * digest, so a box holding any index that listed a pass also sees the revocation while it matters.
 * False when there is nothing to revoke or no key to sign with.
 */
export async function revokeAdapter(env: AdapterVettingEnv, fileSha: string, reason: RevokeReason, now: number): Promise<boolean> {
  const key = attestationKey(env);
  const db = env.DB;
  if (!key || !db || (await revokedAlready(db, fileSha))) return false;
  const last = await db
    .prepare("SELECT signed_json, expires_at FROM adapter_attestations WHERE adapter_sha256 = ? AND outcome = 'pass' ORDER BY issued_at DESC LIMIT 1")
    .bind(fileSha)
    .first<{ signed_json: string; expires_at: number }>();
  if (!last) return false;
  const pass = (JSON.parse(last.signed_json) as SignedAdapterAttestation).attestation;
  const evidence = JSON.stringify({ validatorVersion: VALIDATOR_VERSION, revoked: reason });
  const attestation: AdapterAttestation = {
    ...pass,
    validatorVersion: VALIDATOR_VERSION,
    policyVersion: REVIEW_POLICY_VERSION,
    evidenceSha256Hex: await sha256Hex(evidence),
    outcome: "revoked",
    issuedAt: Math.max(now, pass.issuedAt + 1),
    expiresAt: Math.max(last.expires_at, now) + INDEX_TTL_MS,
  };
  await insertAttestation(db, signAdapterAttestation(attestation, key), evidence, reason);
  return true;
}

interface IndexRow {
  sequence: number;
  digest: string;
  issued_at: number;
  expires_at: number;
  r2_key: string;
  listed: string;
}

/**
 * Sign the next index when what it lists changed or the current one is a day old. The sequence is
 * the table's primary key, so of two publishes racing for one number only one lands; the other
 * leaves things as they are.
 */
export async function publishAdapterIndex(env: AdapterVettingEnv, now: number): Promise<{ published: boolean; sequence?: number }> {
  const key = attestationKey(env);
  const db = env.DB;
  const bucket = env.ADAPTERS_BUCKET;
  if (!key || !db || !bucket) return { published: false };
  const rows = (
    await db
      .prepare(
        `SELECT digest, adapter_sha256, outcome, issued_at, expires_at, signed_json FROM adapter_attestations
         WHERE expires_at > ? ORDER BY adapter_sha256, issued_at DESC`,
      )
      .bind(now)
      .all<{ digest: string; adapter_sha256: string; outcome: string; issued_at: number; expires_at: number; signed_json: string }>()
  ).results;
  const byAdapter = new Map<string, typeof rows>();
  for (const r of rows) byAdapter.set(r.adapter_sha256, [...(byAdapter.get(r.adapter_sha256) ?? []), r]);
  const listed: typeof rows = [];
  const withdrawn: string[] = [];
  for (const [sha, list] of byAdapter) {
    const revoked = list.find((r) => r.outcome === "revoked");
    if (revoked) {
      listed.push(revoked);
      withdrawn.push(sha);
      continue;
    }
    const pass = list.find((r) => r.outcome === "pass");
    if (pass) listed.push(pass);
  }
  const signature = JSON.stringify({ a: listed.map((r) => r.digest).sort(), w: [...withdrawn].sort() });
  const last = await db
    .prepare("SELECT sequence, digest, issued_at, expires_at, r2_key, listed FROM adapter_index_versions ORDER BY sequence DESC LIMIT 1")
    .bind()
    .first<IndexRow>();
  if (last && last.listed === signature && now - last.issued_at < INDEX_REFRESH_MS && now < last.expires_at) return { published: false, sequence: last.sequence };
  const body: AdapterIndexBody = {
    sequence: (last?.sequence ?? 0) + 1,
    prevDigestHex: last?.digest ?? "genesis",
    issuedAt: Math.max(now, (last?.issued_at ?? 0) + 1),
    expiresAt: Math.max(now, (last?.issued_at ?? 0) + 1) + INDEX_TTL_MS,
    attestationDigests: listed.map((r) => r.digest),
    withdrawn,
  };
  const doc: AdapterIndexDocument = {
    schema: 1,
    index: signAdapterIndex(body, key),
    attestations: listed.map((r) => JSON.parse(r.signed_json) as SignedAdapterAttestation),
  };
  const digest = adapterIndexDigest(body);
  const r2Key = `index/${body.sequence}.json`;
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO adapter_index_versions (sequence, digest, issued_at, expires_at, r2_key, listed)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(body.sequence, digest, body.issuedAt, body.expiresAt, r2Key, signature)
    .run();
  if (!inserted.meta.changes) return { published: false };
  await bucket.put(r2Key, JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  const stale = (
    await db
      .prepare("SELECT sequence, r2_key FROM adapter_index_versions WHERE sequence <= ?")
      .bind(body.sequence - INDEX_VERSIONS_KEPT)
      .all<{ sequence: number; r2_key: string }>()
  ).results;
  if (stale.length) {
    await bucket.delete(stale.map((s) => s.r2_key));
    await db.prepare("DELETE FROM adapter_index_versions WHERE sequence <= ?").bind(body.sequence - INDEX_VERSIONS_KEPT).run();
  }
  return { published: true, sequence: body.sequence };
}

/** The current signed index, as published. 404 until the first one. */
export async function serveAdapterIndex(env: AdapterVettingEnv): Promise<Response> {
  if (!env.DB || !env.ADAPTERS_BUCKET) return json({ error: "adapter index unavailable" }, 503);
  const last = await env.DB.prepare("SELECT r2_key FROM adapter_index_versions ORDER BY sequence DESC LIMIT 1").bind().first<{ r2_key: string }>();
  const obj = last ? await env.ADAPTERS_BUCKET.get(last.r2_key) : null;
  if (!obj) return json({ error: "no adapter index yet" }, 404);
  return new Response(await obj.text(), { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } });
}

/** An attested file, only while a pass covers it and nothing revoked it. */
export async function serveAttestedFile(env: AdapterVettingEnv, fileSha: string, now: number): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(fileSha)) return json({ error: "not found" }, 404);
  if (!env.DB || !env.ADAPTERS_BUCKET) return json({ error: "adapter index unavailable" }, 503);
  const live = await env.DB
    .prepare(
      `SELECT 1 AS x FROM adapter_attestations
       WHERE adapter_sha256 = ? AND outcome = 'pass' AND expires_at > ?
         AND NOT EXISTS (SELECT 1 FROM adapter_attestations WHERE adapter_sha256 = ? AND outcome = 'revoked')`,
    )
    .bind(fileSha, now, fileSha)
    .first();
  const obj = live ? await env.ADAPTERS_BUCKET.get(`attested/${fileSha}.json`) : null;
  if (!obj) return json({ error: "not found" }, 404);
  return new Response(await obj.text(), { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });
}

// ---- complaint sources -----------------------------------------------------

/**
 * The network a request came from: an IPv4 /24 or an IPv6 /48, so one home or one cloud
 * allocation counts once however many addresses it rotates through. Null when unknown.
 */
export function sourceNetwork(ip: string | null): string | null {
  if (!ip) return null;
  const v = ip.trim().toLowerCase();
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (v4) {
    const parts = v4.slice(1, 5).map(Number);
    if (parts.some((n) => n > 255)) return null;
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (!/^[0-9a-f:]+$/.test(v) || !v.includes(":")) return null;
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => g.length === 0 || g.length > 4)) return null;
  return `${groups.slice(0, 3).map((g) => parseInt(g, 16).toString(16)).join(":")}::/48`;
}

/** A per-adapter keyed hash of the complaint's network. Null without the salt or a network. */
export async function complaintSource(env: AdapterVettingEnv, fileSha: string, network: string | null): Promise<string | null> {
  const salt = env.ADAPTER_COMPLAINT_SALT;
  if (!salt || !network) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`flagship/adapter-complaint-source/v1|${fileSha}|${network}`));
  return [...new Uint8Array(mac)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function distinctComplaintSources(db: D1Database, fileSha: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - COMPLAINT_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const row = await db
    .prepare("SELECT count(*) AS n FROM adapter_complaint_sources WHERE file_sha256 = ? AND day >= ?")
    .bind(fileSha, cutoff)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Withdraw an attested adapter once enough distinct networks reported it. */
export async function retireIfDisputed(env: AdapterVettingEnv, fileSha: string, now: Date): Promise<boolean> {
  const db = env.DB;
  if (!db) return false;
  if ((await distinctComplaintSources(db, fileSha, now)) < RETIRE_AT_SOURCES) return false;
  const revoked = await revokeAdapter(env, fileSha, "reports", now.getTime());
  if (revoked) {
    await db.prepare("UPDATE repo_adapters SET retired_day = ?, retired_reason = 'reports', pending_confirmations = 0 WHERE file_sha256 = ? AND retired_day IS NULL")
      .bind(now.toISOString().slice(0, 10), fileSha)
      .run();
    await publishAdapterIndex(env, now.getTime());
  }
  return revoked;
}

// ---- the cron --------------------------------------------------------------

export interface VettingRunResult {
  vetted: number;
  failed: number;
  revoked: number;
  index: { published: boolean; sequence?: number };
}

interface QueueRow {
  file_sha256: string;
  repo: string;
  base: string;
  license: string;
  r2_key: string | null;
}

/**
 * Daily, in the publish slot: review what was kept before there was a key and renew passes close
 * to expiry (a few a run), withdraw what is disputed or opted out, then refresh the index.
 */
export async function runAdapterVetting(env: AdapterVettingEnv, now: Date): Promise<VettingRunResult | null> {
  const db = env.DB;
  const bucket = env.ADAPTERS_BUCKET;
  if (!db || !bucket || !attestationKey(env)) return null;
  const t = now.getTime();
  const result: VettingRunResult = { vetted: 0, failed: 0, revoked: 0, index: { published: false } };

  const optedOut = (
    await db
      .prepare(
        `SELECT DISTINCT a.adapter_sha256 AS sha FROM adapter_attestations a
         JOIN adapter_blocklist b ON lower(b.repo) = lower(a.repo) AND b.state != 'unlisting'
         WHERE a.outcome = 'pass'`,
      )
      .bind()
      .all<{ sha: string }>()
  ).results;
  for (const r of optedOut) if (await revokeAdapter(env, r.sha, "do-not-adapt", t)) result.revoked++;

  const disputed = (
    await db
      .prepare(
        `SELECT DISTINCT s.file_sha256 AS sha FROM adapter_complaint_sources s
         JOIN adapter_attestations a ON a.adapter_sha256 = s.file_sha256 AND a.outcome = 'pass'`,
      )
      .bind()
      .all<{ sha: string }>()
  ).results;
  for (const r of disputed) {
    if ((await distinctComplaintSources(db, r.sha, now)) >= RETIRE_AT_SOURCES && (await revokeAdapter(env, r.sha, "reports", t))) result.revoked++;
  }

  const reviewKey = env.ADAPTER_REVIEW_ANTHROPIC_KEY;
  if (reviewKey) {
    const due = (
      await db
        .prepare(
          `SELECT r.file_sha256, r.repo, r.base, r.license, r.r2_key FROM repo_adapters r
           WHERE r.retired_day IS NULL
             AND NOT EXISTS (SELECT 1 FROM adapter_attestations x WHERE x.adapter_sha256 = r.file_sha256 AND x.outcome = 'revoked')
             AND NOT EXISTS (SELECT 1 FROM adapter_attestations p WHERE p.adapter_sha256 = r.file_sha256 AND p.outcome = 'pass' AND p.expires_at > ?)
             AND NOT EXISTS (SELECT 1 FROM adapter_blocklist b WHERE lower(b.repo) = lower(r.repo) AND b.state != 'unlisting')
           ORDER BY r.created_day, r.file_sha256 LIMIT ?`,
        )
        .bind(t + RENEW_BEFORE_MS, MAX_VETS_PER_RUN)
        .all<QueueRow>()
    ).results;
    for (const row of due) {
      const text = await adapterText(bucket, row);
      if (text == null || (await sha256Hex(text)) !== row.file_sha256) continue;
      // The same deterministic checks first; a file that fails one never reaches the model.
      const split = splitAdapterFile(text);
      if (
        !split.ok ||
        !split.adapter ||
        split.adapter.source.repo !== row.repo ||
        split.adapter.source.base !== row.base ||
        repoAdapterProblems(split.adapter, split.manifestJson, { skipSecrets: true }).length > 0
      ) {
        result.failed++;
        continue;
      }
      const review = await reviewAdapterFile(reviewKey, text);
      if (review.kind === "fail") {
        result.failed++;
        if (await revokeAdapter(env, row.file_sha256, "review", t)) result.revoked++;
        continue;
      }
      if (review.kind !== "pass") continue;
      const signed = await attestPass(env, { fileText: text, fileSha: row.file_sha256, repo: row.repo, base: row.base, license: row.license, review }, t);
      if (signed) {
        result.vetted++;
        await db.prepare("UPDATE repo_adapters SET review = 'rules+ai' WHERE file_sha256 = ?").bind(row.file_sha256).run();
      }
    }
  }
  result.index = await publishAdapterIndex(env, t);
  return result;
}

async function adapterText(bucket: AdapterBucketLike, row: QueueRow): Promise<string | null> {
  for (const key of [`attested/${row.file_sha256}.json`, row.r2_key, `retired/${row.file_sha256}.json`]) {
    if (!key) continue;
    const obj = await bucket.get(key);
    if (obj) return obj.text();
  }
  return null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
