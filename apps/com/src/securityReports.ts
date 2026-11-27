/**
 * Vulnerability reports from the website's form (security.html#report).
 *
 *   POST /api/security/report           anyone: {email?, severity, component?, summary, details, turnstileToken?, website?}
 *   GET  /api/security/report-config    anyone: the Turnstile site key the form renders, or null
 *   GET  /api/admin/security-reports    x-admin-secret: every stored report, ciphertext included
 *
 * What the reporter typed becomes one OpenPGP message encrypted to the security key
 * (securityReportKey.ts) before anything is stored, so `.com`, D1 and its backups hold it only as ciphertext;
 * `npm run security-reports` decrypts with the YubiKey. In clear: the id, the time, the severity, the size and the
 * notification status (D1 `security_reports`, migration 0162). No address is stored: the rate limiter counts
 * sources in Durable Objects only (rateLimit.ts "security-report"). The owner is emailed only the id, severity and
 * time, after the report is stored; an email failure never fails the submission. Report content is never logged.
 *
 * Spam: Cloudflare Turnstile, checked with Siteverify before anything is stored, while both TURNSTILE_SITE_KEY and
 * the TURNSTILE_SECRET_KEY secret are set (rate limits apply either way); and a honeypot field (`website`) that a
 * person never sees: filled in, the answer looks like success and nothing is stored.
 *
 * AI triage: with SECURITY_REPORT_TRIAGE_KEY and its pinned SECURITY_REPORT_TRIAGE_FINGERPRINT set, each report is one
 * message to two recipients, the YubiKey key and the triage key (`triage` = 1 on its row). A triage key that does not
 * match its pin, or cannot encrypt, is left out (the report still goes to the YubiKey key alone), never trusted.
 */
import { authorizeAdmin } from "@flagship/control-plane";
import type { D1Database } from "@flagship/storage";
import { createMessage, encrypt, enums, readKey, type PublicKey } from "openpgp";
import {
  SECURITY_KEY_ARMORED,
  SECURITY_KEY_ENCRYPTION_SUBKEY_FINGERPRINT,
  SECURITY_KEY_FINGERPRINT,
} from "./securityReportKey.js";

export const SECURITY_REPORT_PATH = "/api/security/report";
export const SECURITY_REPORTS_ADMIN_PATH = "/api/admin/security-reports";
export const SECURITY_REPORT_CONFIG_PATH = "/api/security/report-config";
export const TURNSTILE_ACTION = "security-report";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TOKEN_MAX = 2048;
const HONEYPOT_MAX = 2048;
export const SECURITY_REPORT_FORMAT = "flagship/security-report/v1";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SUMMARY_MAX = 200;
export const DETAILS_MAX = 20_000;
export const COMPONENT_MAX = 100;
export const EMAIL_MAX = 254;
/** Characters × up to 4 bytes each, plus the JSON around them. */
export const BODY_MAX_BYTES = 4 * (SUMMARY_MAX + DETAILS_MAX + COMPONENT_MAX + EMAIL_MAX + HONEYPOT_MAX) + TURNSTILE_TOKEN_MAX + 2048;
const ADMIN_LIST_MAX = 500;
const EMAIL = /^[^\s@<>"',;]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/i;
const RESEND_URL = "https://api.resend.com/emails";
const NOTIFY_TIMEOUT_MS = 10_000;

export type NotifyStatus = "pending" | "sent" | "failed" | "skipped";

export interface SecurityReportEnv {
  DB?: D1Database;
  FLAGSHIP_ADMIN_SECRET?: string;
  RESEND_API_KEY?: string;
  SECURITY_REPORT_NOTIFY_TO?: string;
  SECURITY_REPORT_NOTIFY_FROM?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  SECURITY_REPORT_TRIAGE_KEY?: string;
  SECURITY_REPORT_TRIAGE_FINGERPRINT?: string;
}

export interface SecurityReportKeyPin {
  armored: string;
  fingerprint: string;
  encryptionSubkeyFingerprint: string;
}

export interface SecurityReportDeps {
  now?: () => number;
  fetchFn?: typeof fetch;
  waitUntil?: (p: Promise<unknown>) => void;
  /** Tests encrypt to a throwaway key; production always uses the bundled one. */
  key?: SecurityReportKeyPin;
}

export interface TriageKeyPin {
  armored: string;
  fingerprint: string;
}

export const BUNDLED_KEY: SecurityReportKeyPin = {
  armored: SECURITY_KEY_ARMORED,
  fingerprint: SECURITY_KEY_FINGERPRINT,
  encryptionSubkeyFingerprint: SECURITY_KEY_ENCRYPTION_SUBKEY_FINGERPRINT,
};

/** What is encrypted: everything the reporter typed, bound to the id and severity stored beside it. */
export interface SecurityReportPlaintext {
  format: typeof SECURITY_REPORT_FORMAT;
  id: string;
  receivedAt: string;
  severity: Severity;
  component: string;
  email: string | null;
  summary: string;
  details: string;
}

export function isSecurityReportPath(pathname: string): boolean {
  return pathname === SECURITY_REPORT_PATH || pathname === SECURITY_REPORT_CONFIG_PATH;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function newReportId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return "FLG-" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}

const keyCache = new Map<string, Promise<PublicKey>>();

function parsedKey(armored: string): Promise<PublicKey> {
  let p = keyCache.get(armored);
  if (!p) {
    p = readKey({ armoredKey: armored }) as Promise<PublicKey>;
    p.catch(() => keyCache.delete(armored));
    keyCache.set(armored, p);
  }
  return p;
}

/**
 * Parse the key once per isolate and check it is the pinned one, with the pinned subkey as the one openpgp picks
 * for encryption. Anything else (an edited key, a lapsed one) refuses: a report is never encrypted to another key.
 */
export async function pinnedEncryptionKey(pin: SecurityReportKeyPin, date: Date): Promise<PublicKey> {
  const key = await parsedKey(pin.armored);
  if (key.isPrivate()) throw new Error("security key: a private key was bundled");
  if (key.getFingerprint().toLowerCase() !== pin.fingerprint.toLowerCase()) throw new Error("security key: fingerprint does not match the pin");
  const enc = await key.getEncryptionKey(undefined, date);
  if (enc.getFingerprint().toLowerCase() !== pin.encryptionSubkeyFingerprint.toLowerCase()) {
    throw new Error("security key: encryption subkey does not match the pin");
  }
  return key;
}

export function triageKeyFromEnv(env: SecurityReportEnv): TriageKeyPin | null {
  const armored = env.SECURITY_REPORT_TRIAGE_KEY?.trim();
  const fingerprint = env.SECURITY_REPORT_TRIAGE_FINGERPRINT?.replace(/\s+/g, "").toLowerCase();
  return armored && fingerprint ? { armored, fingerprint } : null;
}

/** The triage key when it is the pinned one and can encrypt today; else null (the report goes to the YubiKey only). */
export async function pinnedTriageKey(pin: TriageKeyPin, date: Date): Promise<PublicKey | null> {
  try {
    const key = await parsedKey(pin.armored);
    if (key.isPrivate()) throw new Error("a private key was configured");
    if (key.getFingerprint().toLowerCase() !== pin.fingerprint) throw new Error("fingerprint does not match the pin");
    await key.getEncryptionKey(undefined, date);
    return key;
  } catch (e) {
    console.error(`security-report: triage key refused (${(e as Error)?.message?.slice(0, 120) ?? "error"})`);
    return null;
  }
}

export async function encryptReport(
  plaintext: SecurityReportPlaintext,
  pin: SecurityReportKeyPin,
  date: Date,
  triage?: TriageKeyPin | null,
): Promise<{ armored: string; triage: boolean }> {
  const key = await pinnedEncryptionKey(pin, date);
  const triageKey = triage ? await pinnedTriageKey(triage, date) : null;
  const message = await createMessage({ text: JSON.stringify(plaintext), format: "utf8" });
  // SEIPD v1 with AES-256, uncompressed: what GnuPG on the YubiKey host decrypts.
  const armored = await encrypt({
    message,
    encryptionKeys: triageKey ? [key, triageKey] : key,
    format: "armored",
    date,
    config: {
      aeadProtect: false,
      preferredSymmetricAlgorithm: enums.symmetric.aes256,
      preferredCompressionAlgorithm: enums.compression.uncompressed,
    },
  });
  return { armored, triage: !!triageKey };
}

type Parsed =
  | { ok: true; honeypot: boolean; turnstileToken: string; value: Omit<SecurityReportPlaintext, "format" | "id" | "receivedAt"> }
  | { ok: false; status: number; code: string; error: string };

export function parseReport(text: string): Parsed {
  const bad = (code: string, error: string, status = 400): Parsed => ({ ok: false, status, code, error });
  if (new TextEncoder().encode(text).length > BODY_MAX_BYTES) return bad("too-large", "The report is too long.", 413);
  let b: unknown;
  try {
    b = JSON.parse(text);
  } catch {
    return bad("malformed", "The report could not be read.");
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) return bad("malformed", "The report could not be read.");
  const r = b as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!["email", "severity", "component", "summary", "details", "turnstileToken", "website"].includes(k)) return bad("malformed", "The report could not be read.");
  }
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : null);
  const summary = str(r.summary);
  const details = str(r.details);
  const component = str(r.component);
  const email = str(r.email);
  const website = str(r.website);
  const turnstileToken = str(r.turnstileToken);
  if (summary === null || details === null || component === null || email === null || website === null || turnstileToken === null) {
    return bad("malformed", "The report could not be read.");
  }
  if (website.length > HONEYPOT_MAX || turnstileToken.length > TURNSTILE_TOKEN_MAX) return bad("malformed", "The report could not be read.");
  if (!(SEVERITIES as readonly unknown[]).includes(r.severity)) return bad("bad-severity", "Pick a severity.");
  if (summary.length === 0 || summary.length > SUMMARY_MAX) return bad("summary-length", `The summary must be 1 to ${SUMMARY_MAX} characters.`);
  if (details.length === 0 || details.length > DETAILS_MAX) return bad("details-length", `The details must be 1 to ${DETAILS_MAX} characters.`);
  if (component.length > COMPONENT_MAX) return bad("component-length", `The component must be at most ${COMPONENT_MAX} characters.`);
  if (email.length > 0 && (email.length > EMAIL_MAX || !EMAIL.test(email))) return bad("bad-email", "Check the email address, or leave it empty.");
  return {
    ok: true,
    honeypot: website.length > 0,
    turnstileToken,
    value: { severity: r.severity as Severity, component: component || "Other", email: email || null, summary, details },
  };
}

export function turnstileConfigured(env: SecurityReportEnv): boolean {
  return !!(env.TURNSTILE_SITE_KEY?.trim() && env.TURNSTILE_SECRET_KEY);
}

/** Siteverify (one use per token): "ok", "failed" (a bad, used or missing token) or "unavailable" (no answer). */
export async function verifyTurnstile(secret: string, token: string, fetchFn: typeof fetch): Promise<"ok" | "failed" | "unavailable"> {
  if (!token) return "failed";
  try {
    const res = await fetchFn(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }).toString(),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) return "unavailable";
    const out = (await res.json()) as { success?: unknown; action?: unknown };
    if (out.success !== true) return "failed";
    if (out.action !== undefined && out.action !== TURNSTILE_ACTION) return "failed";
    return "ok";
  } catch {
    return "unavailable";
  }
}

export function notifyConfigured(env: SecurityReportEnv): boolean {
  return !!(env.RESEND_API_KEY && env.SECURITY_REPORT_NOTIFY_TO?.trim() && env.SECURITY_REPORT_NOTIFY_FROM?.trim());
}

/** The owner's email: the id, the severity and the time, nothing the reporter wrote. */
export function notifyEmail(env: SecurityReportEnv, id: string, severity: Severity, receivedAt: number) {
  const at = new Date(receivedAt).toISOString();
  return {
    from: env.SECURITY_REPORT_NOTIFY_FROM!.trim(),
    to: env.SECURITY_REPORT_NOTIFY_TO!.split(",").map((s) => s.trim()).filter(Boolean),
    subject: `Security report ${id} (${severity})`,
    text: `A security report came in through the website form.\n\nId: ${id}\nSeverity (the reporter's guess): ${severity}\nReceived: ${at}\n\nRead it with: npm run security-reports\n`,
  };
}

async function notify(env: SecurityReportEnv, db: D1Database, fetchFn: typeof fetch, id: string, severity: Severity, receivedAt: number, now: () => number): Promise<void> {
  let status: NotifyStatus = "failed";
  try {
    const res = await fetchFn(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(notifyEmail(env, id, severity, receivedAt)),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    status = res.ok ? "sent" : "failed";
    if (!res.ok) console.error(`security-report notify: ${id} HTTP ${res.status}`);
  } catch (e) {
    console.error(`security-report notify: ${id} ${(e as Error)?.name ?? "error"}`);
  }
  try {
    await db.prepare("UPDATE security_reports SET notify_status = ?1, notify_at = ?2 WHERE id = ?3").bind(status, now(), id).run();
  } catch {
    console.error(`security-report notify: ${id} status not recorded`);
  }
}

async function handleIntake(request: Request, env: SecurityReportEnv, db: D1Database, deps: SecurityReportDeps): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed", code: "malformed" }, 405);
  const parsed = parseReport(await request.text());
  if (!parsed.ok) return json({ error: parsed.error, code: parsed.code }, parsed.status);
  if (parsed.honeypot) return json({ reportId: newReportId(), status: "received" }, 200);
  if (turnstileConfigured(env)) {
    const verdict = await verifyTurnstile(env.TURNSTILE_SECRET_KEY!, parsed.turnstileToken, deps.fetchFn ?? fetch);
    if (verdict === "failed") return json({ error: "The spam check did not pass.", code: "challenge-failed" }, 403);
    if (verdict === "unavailable") return json({ error: "The spam check is unavailable.", code: "challenge-unavailable" }, 503);
  }
  const now = deps.now ?? Date.now;
  const receivedAt = now();
  const id = newReportId();
  const plaintext: SecurityReportPlaintext = {
    format: SECURITY_REPORT_FORMAT,
    id,
    receivedAt: new Date(receivedAt).toISOString(),
    ...parsed.value,
  };
  let sealed: { armored: string; triage: boolean };
  try {
    sealed = await encryptReport(plaintext, deps.key ?? BUNDLED_KEY, new Date(receivedAt), triageKeyFromEnv(env));
  } catch (e) {
    console.error(`security-report: encryption refused (${(e as Error)?.message?.slice(0, 120) ?? "error"})`);
    return json({ error: "The report form is unavailable. Please email the security address.", code: "unavailable" }, 503);
  }
  const size = new TextEncoder().encode(JSON.stringify(plaintext)).length;
  const configured = notifyConfigured(env);
  await db
    .prepare("INSERT INTO security_reports (id, received_at, severity, size_bytes, ciphertext, triage, notify_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(id, receivedAt, parsed.value.severity, size, sealed.armored, sealed.triage ? 1 : 0, configured ? "pending" : "skipped")
    .run();
  if (configured) {
    const sent = notify(env, db, deps.fetchFn ?? fetch, id, parsed.value.severity, receivedAt, now);
    if (deps.waitUntil) deps.waitUntil(sent);
    else await sent;
  }
  return json({ reportId: id, status: "received" }, 200);
}

interface Row {
  id: string;
  received_at: number;
  severity: string;
  size_bytes: number;
  ciphertext: string;
  triage: number;
  notify_status: string;
  notify_at: number | null;
}

async function handleAdmin(request: Request, env: SecurityReportEnv, db: D1Database): Promise<Response> {
  const auth = authorizeAdmin({ expected: env.FLAGSHIP_ADMIN_SECRET, provided: request.headers.get("x-admin-secret") });
  if (auth) return json(auth.body, auth.status);
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const url = new URL(request.url);
  const since = Number(url.searchParams.get("since") ?? 0);
  if (!Number.isSafeInteger(since) || since < 0) return json({ error: "since takes a time in milliseconds" }, 400);
  const rows = await db
    .prepare(`SELECT * FROM security_reports WHERE received_at >= ?1 ORDER BY received_at DESC LIMIT ${ADMIN_LIST_MAX}`)
    .bind(since)
    .all<Row>();
  return json(
    {
      reports: (rows.results ?? []).map((r) => ({
        id: r.id,
        receivedAt: r.received_at,
        severity: r.severity,
        sizeBytes: r.size_bytes,
        notifyStatus: r.notify_status,
        notifyAt: r.notify_at,
        triage: r.triage === 1,
        ciphertext: r.ciphertext,
      })),
    },
    200,
  );
}

export async function handleSecurityReportRoute(request: Request, env: SecurityReportEnv, deps: SecurityReportDeps = {}): Promise<Response> {
  if (!env.DB) return json({ error: "The report form is unavailable. Please email the security address.", code: "unavailable" }, 503);
  const { pathname } = new URL(request.url);
  if (pathname === SECURITY_REPORTS_ADMIN_PATH) return handleAdmin(request, env, env.DB);
  if (pathname === SECURITY_REPORT_CONFIG_PATH) {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    return new Response(JSON.stringify({ turnstileSiteKey: turnstileConfigured(env) ? env.TURNSTILE_SITE_KEY!.trim() : null }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    });
  }
  return handleIntake(request, env, env.DB, deps);
}
