/**
 * POST /api/accounts/<u>/messages-attestation (docs/voici-and-messages.md §6.3, §9.4, §9.5).
 *
 * A device of the account asks the CA to vouch for one per-page pseudonym key P. Body:
 *   {request: {username, pseudonymPub, renewOfHash, deviceCheckRef, issuedAt}, signature, integrity?, previous?}
 * with the device headers (as /profile) and `signature` = the same device key over the request's canonical bytes
 * (the headers don't cover the body). `integrity` is the platform evidence over those bytes (deviceIntegrity.ts),
 * required in shape when deviceCheckRef is ios or android; `previous` is the attestation a renewal names.
 *
 * `.com` seals the abuse tag itself (the account's name, sealed to the offline abuse key), so a sender cannot put
 * someone else's account in it.
 *
 * PRIVACY RULE (§6.3, §8.4, §13.2): nothing here may store or log anything that links a pseudonym, an abuse tag or
 * an attestation to the account that asked. The request is checked, counted and answered; the only lasting traces
 * are the per-account per-day count, the account's enrollment row (platform, no key) and the device-header nonce.
 * No console output names P, the tag or the attestation. `test/messagesAttestation.test.ts` reads every D1 table
 * after a run and fails if P, the tag hash or the attestation hash appear anywhere, or if anything was logged.
 */
import {
  authorizeActiveDevice,
  caKeypairFromEnv,
  evaluateCaGate,
  type CaGate,
  type DirectoryAuthorization,
} from "@flagship/control-plane";
import {
  canonicalMessagesKeyAttestationRequest,
  checkMessagesKeyAttestation,
  DEVICE_CHECK_REFS,
  messagesAttestationHash,
  MESSAGES_ATTESTATION_RENEW_GRACE_MS,
  MESSAGES_ATTESTATION_REQUEST_SKEW_MS,
  MESSAGES_ATTESTATION_TTL_MS,
  sealVoiciAbuseTag,
  signMessagesKeyAttestation,
  verifyCaSignedMessagesKeyAttestation,
  verifyMessagesKeyAttestationRequest,
  type AbuseKeyEntry,
  type DeviceCheckRef,
  type MessagesKeyAttestationRequest,
} from "@flagship/protocol";
import { D1NonceStore } from "@flagship/boot-core";
import { D1Storage, type D1Database } from "@flagship/storage";
import { currentAbuseKey } from "./abuseKeys.js";
import { parseIntegrityEvidence, type DeviceIntegrity, type DeviceIntegrityEnv, type IntegrityResult } from "./deviceIntegrity.js";
import { checkRateLimit, clientIp, type RateLimitEnv } from "./rateLimit.js";
import { isAccountBanned, json, type WaitUntil } from "./voiciAbuse.js";

export const MESSAGES_ATTESTATION_PATH = /^\/api\/accounts\/([^/]+)\/messages-attestation$/;

/** §9.4, D11: new recipients per account per UTC day by account age; the unattested tier (§9.5, D5). */
export const NEW_RECIPIENTS_PER_DAY = { under7Days: 3, under30Days: 10, older: 25, unattested: 1 } as const;
export const UNATTESTED_MIN_AGE_MS = 7 * 86_400_000;
const MAX_BODY_BYTES = 48 * 1024;

export interface MessagesAttestationEnv extends DeviceIntegrityEnv, RateLimitEnv {
  DB?: D1Database;
  FLAGSHIP_CA_PRIV_HEX?: string;
  FLAGSHIP_CA_ISSUER?: string;
}

export interface MessagesAttestationDeps {
  now: () => number;
  integrity: DeviceIntegrity;
  abuseKeys: readonly AbuseKeyEntry[];
  caGate?: CaGate;
  waitUntil?: WaitUntil;
}

const DAY_MS = 86_400_000;
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const untilNextDaySec = (now: number) => Math.max(1, Math.ceil((Math.floor(now / DAY_MS + 1) * DAY_MS - now) / 1000));

/** The account's daily allowance of new recipients, or the refusal for an unattested account that is too new. */
export function newRecipientLimit(accountAgeMs: number, attested: boolean, slowTier = false): number | "unattested-too-new" {
  if (attested && slowTier) return NEW_RECIPIENTS_PER_DAY.unattested;
  if (!attested) return accountAgeMs >= UNATTESTED_MIN_AGE_MS ? NEW_RECIPIENTS_PER_DAY.unattested : "unattested-too-new";
  if (accountAgeMs < 7 * DAY_MS) return NEW_RECIPIENTS_PER_DAY.under7Days;
  if (accountAgeMs < 30 * DAY_MS) return NEW_RECIPIENTS_PER_DAY.under30Days;
  return NEW_RECIPIENTS_PER_DAY.older;
}

function deviceAuth(request: Request, account: string, path: string): DirectoryAuthorization | undefined {
  const h = (n: string) => request.headers.get(n);
  const issuedAt = Number(h("x-flagship-issued-at"));
  const deviceId = h("x-flagship-device-id");
  const signerPubHex = h("x-flagship-device-pub");
  const requestId = h("x-flagship-request-id");
  const signature = h("x-flagship-signature");
  if (!deviceId || !signerPubHex || !requestId || !signature || !Number.isFinite(issuedAt)) return undefined;
  return {
    request: { accountId: account, deviceId: deviceId.toLowerCase(), signerPubHex: signerPubHex.toLowerCase(), method: "POST", path, requestId, issuedAt },
    signature,
  };
}

/** Count one new recipient if the day's count is under `limit`; false when it isn't. Prunes the account's old days. */
async function takeNewRecipient(db: D1Database, username: string, now: number, limit: number): Promise<boolean> {
  const day = dayOf(now);
  const [, inc] = await db.batch([
    db.prepare("DELETE FROM messages_attest_counters WHERE username = ?1 AND day < ?2").bind(username, dayOf(now - DAY_MS)),
    db
      .prepare(
        "INSERT INTO messages_attest_counters (username, day, count) VALUES (?1, ?2, 1) " +
          "ON CONFLICT(username, day) DO UPDATE SET count = count + 1 WHERE count < ?3",
      )
      .bind(username, day, limit),
  ]);
  return (inc?.meta?.changes ?? 0) > 0;
}

export async function handleMessagesAttestation(
  request: Request,
  env: MessagesAttestationEnv,
  accountInPath: string,
  deps: MessagesAttestationDeps,
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed", code: "malformed" }, 405);
  const db = env.DB;
  if (!db) return json({ error: "unavailable", code: "unavailable" }, 503);
  const now = deps.now();
  const account = accountInPath.toLowerCase();
  const path = `/api/accounts/${account}/messages-attestation`;

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "too large", code: "too-large" }, 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json({ error: "malformed", code: "malformed" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "malformed", code: "malformed" }, 400);
  const r = body.request as Partial<MessagesKeyAttestationRequest> | undefined;
  if (!r || typeof r !== "object" || typeof body.signature !== "string" || !/^[0-9a-f]{128}$/.test(body.signature)) {
    return json({ error: "malformed", code: "malformed" }, 400);
  }
  const req: MessagesKeyAttestationRequest = {
    username: r.username as string,
    pseudonymPub: r.pseudonymPub as string,
    renewOfHash: r.renewOfHash as string,
    deviceCheckRef: r.deviceCheckRef as DeviceCheckRef,
    issuedAt: r.issuedAt as number,
  };
  let requestBytes: Uint8Array;
  try {
    requestBytes = canonicalMessagesKeyAttestationRequest(req);
  } catch {
    return json({ error: "malformed", code: "malformed" }, 400);
  }
  if (req.username !== account) return json({ error: "request names another account", code: "malformed" }, 400);
  if (!DEVICE_CHECK_REFS.includes(req.deviceCheckRef)) return json({ error: "malformed", code: "malformed" }, 400);
  const evidence = req.deviceCheckRef === "none" ? null : parseIntegrityEvidence(body.integrity, req.deviceCheckRef);
  if (req.deviceCheckRef !== "none" && !evidence) return json({ error: "integrity evidence malformed", code: "malformed" }, 400);
  if (req.deviceCheckRef === "none" && body.integrity !== undefined) return json({ error: "malformed", code: "malformed" }, 400);
  if (Math.abs(now - req.issuedAt) > MESSAGES_ATTESTATION_REQUEST_SKEW_MS) return json({ error: "stale request", code: "stale" }, 403);

  const storage = new D1Storage(db);
  const user = await storage.usernames.get(account);
  if (!user) return json({ error: "not found", code: "not-found" }, 404);
  const caller = await authorizeActiveDevice(
    { identities: storage.deviceIdentities, nonces: new D1NonceStore(db), now: deps.now },
    deviceAuth(request, account, path),
    { accountId: account, method: "POST", path },
  );
  if (!caller || !verifyMessagesKeyAttestationRequest(req, body.signature, caller.signerPubHex)) {
    return json({ error: "not authorized", code: "not-authorized" }, 403);
  }

  const ca = caKeypairFromEnv({ FLAGSHIP_CA_PRIV_HEX: env.FLAGSHIP_CA_PRIV_HEX, FLAGSHIP_CA_ISSUER: env.FLAGSHIP_CA_ISSUER });
  const renewal = req.renewOfHash !== "";
  if (renewal) {
    const caKeys = [Array.from(ca.keypair.publicKey, (b) => b.toString(16).padStart(2, "0")).join(""), ...(deps.caGate?.caTrustChain?.authorizedCaKeys(now) ?? [])];
    const prev = body.previous;
    const parsed = prev && typeof prev === "object" ? checkMessagesKeyAttestation(prev, { caKeys, now: (prev as { issuedAt?: number }).issuedAt ?? 0, pseudonymPub: req.pseudonymPub }) : null;
    if (!parsed?.ok || messagesAttestationHash(parsed.attestation) !== req.renewOfHash || now > parsed.attestation.expiresAt + MESSAGES_ATTESTATION_RENEW_GRACE_MS) {
      return json({ error: "the attestation this renews doesn't check out", code: "bad-renewal" }, 403);
    }
  } else if (body.previous !== undefined) {
    return json({ error: "malformed", code: "malformed" }, 400);
  }

  const verdict: IntegrityResult = evidence ? await deps.integrity.check(evidence, requestBytes, now) : { attested: false, reason: "none" };
  const later = (p: Promise<unknown>) => (deps.waitUntil ? deps.waitUntil(p) : void p.catch(() => undefined));

  if (await isAccountBanned(db, account)) {
    if (verdict.attested && !verdict.banned) later(deps.integrity.setBits(verdict.platform, verdict.deviceToken, { banned: true }, now));
    return json({ error: "banned", code: "banned" }, 403);
  }
  if (verdict.attested && verdict.banned) return json({ error: "banned", code: "banned" }, 403);

  const key = currentAbuseKey(deps.abuseKeys, now);
  if (!key) return json({ error: "Messages is not available right now.", code: "no-abuse-key" }, 503);

  const enrolled = await db
    .prepare("SELECT platform, slow_tier FROM messages_enrollments WHERE username = ?1")
    .bind(account)
    .first<{ platform: string; slow_tier: number }>();
  // A device that already started Messages for another account this month: not refused (shared review phones, a
  // family's phone), but slow, and charged per address like the unattested tier. The checked device waives the age.
  const deviceOver = !enrolled && verdict.attested && verdict.enrolledThisMonth;
  const slowTier = deviceOver || enrolled?.slow_tier === 1;

  if (!renewal) {
    const limit = newRecipientLimit(now - user.claimedAt, verdict.attested, slowTier);
    if (limit === "unattested-too-new") return json({ error: "too new for the web tier", code: "unattested-too-new" }, 403);
    if (!enrolled && (!verdict.attested || deviceOver)) {
      const endpoint = deviceOver ? "messages-enroll-device-over" : "messages-enroll-unattested";
      const rl = await checkRateLimit(env, { endpoint, ip: clientIp(request) }, deps.waitUntil ? { waitUntil: deps.waitUntil } : undefined);
      if (rl.limited) return json({ error: "rate limited", code: "rate-limited", retryAfterSec: rl.retryAfterSec }, 429, { "retry-after": String(rl.retryAfterSec) });
    }
    if (!(await takeNewRecipient(db, account, now, limit))) {
      const retryAfterSec = untilNextDaySec(now);
      return json({ error: "new conversation limit", code: "first-contact-limit", limit, retryAfterSec }, 429, { "retry-after": String(retryAfterSec) });
    }
  }

  const tag = sealVoiciAbuseTag(key.publicKey, req.pseudonymPub, { v: 1, username: account, accountCreatedAt: user.claimedAt, issuedAt: now });
  const attestation = signMessagesKeyAttestation(
    { pseudonymPub: req.pseudonymPub, abuseEpoch: key.epoch, issuedAt: now, expiresAt: now + MESSAGES_ATTESTATION_TTL_MS },
    tag,
    ca.keypair.privateKey,
  );
  const gate = evaluateCaGate(deps.caGate, "MessagesKeyAttestation", "-", now, () =>
    verifyCaSignedMessagesKeyAttestation(attestation, deps.caGate!.caTrustChain, now),
  );
  if (gate) return json(gate.body, gate.status);

  const platform = verdict.attested ? verdict.platform : "none";
  const token = verdict.attested ? verdict.deviceToken : null;
  if (!enrolled) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO messages_enrollments (username, platform, enrolled_at, attest_key_hmac, device_token, device_token_at, slow_tier) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      )
      .bind(account, platform, now, verdict.attested ? verdict.attestKeyHmac : null, token, token ? now : null, deviceOver ? 1 : 0)
      .run();
    if (verdict.attested) later(deps.integrity.setBits(verdict.platform, verdict.deviceToken, { enrolled: true }, now));
  } else if (token) {
    await db.prepare("UPDATE messages_enrollments SET device_token = ?2, device_token_at = ?3 WHERE username = ?1").bind(account, token, now).run();
  }
  return json({ attestation }, 200);
}
