/**
 * Retail box claims at `.com` (docs/retail-box-setup.md §4 step 8, §7.7, §15.1).
 *
 * The claim itself never goes through `.com`. Two small things do:
 *
 *   POST /api/box-claim/key   the admin device registers the box key it saw in the claim receipt
 *                             under the recipe's AuthCode, before it sends the Wi-Fi password.
 *                             `/api/server/register` then admits that AuthCode's server only under
 *                             this key, so a relay's real box (another key) never comes online.
 *   /api/box-claim/mailbox/<id>/<dir>   the remote claim (sharing method): opaque messages under a
 *                             name that is a hash of the setup code. `.com` learns nothing else.
 */
import { BOX_CLAIM_MAILBOX_ID, BOX_CLAIM_MAX_MESSAGE, verifyBoxClaimKey, type BoxClaimKey } from "@flagship/protocol";
import type { AuthCodeStorage, BoxClaimMailboxDir, BoxClaimStorage, DeviceCapabilityGrantStorage, UsernameStorage } from "@flagship/storage";
import { addServerRefused, authorizeAddServer } from "./adminAuthorityGate.js";
import { HEX64, HEX128, equalHex, hexToBytes } from "./hex.js";
import { SERIAL_RE } from "./authCode.js";
import { conflict, forbidden, malformed, ok, type HandlerResponseWithHeaders } from "./types.js";

export const BOX_KEY_MISMATCH_CODE = "box-key-mismatch";
export const BOX_KEY_TAKEN_CODE = "box-key-already-registered";
export const BOX_CLAIM_MAILBOX_TTL_MS = 3_600_000;
export const BOX_CLAIM_MAILBOX_MAX_PER_DIR = 32;
/** Base64 of the largest claim message, with room for padding. */
const MAX_BODY_CHARS = Math.ceil(BOX_CLAIM_MAX_MESSAGE / 3) * 4 + 4;

export interface BoxClaimDeps {
  boxClaims: BoxClaimStorage;
  authCodes: AuthCodeStorage;
  usernames: UsernameStorage;
  grants?: DeviceCapabilityGrantStorage;
  freshnessMs?: number;
  now?: () => number;
}

interface KeyBody {
  key?: { username?: unknown; serial?: unknown; serverDomain?: unknown; stkPubHex?: unknown; issuedAt?: unknown };
  signature?: unknown;
}

const unusable = () => forbidden("auth-code not usable");

export async function handleBoxClaimKey(deps: BoxClaimDeps, body: KeyBody | undefined): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const k = body?.key;
  if (
    !k ||
    typeof k.username !== "string" ||
    typeof k.serial !== "string" ||
    !SERIAL_RE.test(k.serial) ||
    typeof k.serverDomain !== "string" ||
    typeof k.stkPubHex !== "string" ||
    !HEX64.test(k.stkPubHex) ||
    typeof k.issuedAt !== "number" ||
    !Number.isSafeInteger(k.issuedAt) ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }
  if (Math.abs(now - k.issuedAt) > (deps.freshnessMs ?? 5 * 60_000)) return malformed("stale request");
  const key: BoxClaimKey = { username: k.username, serial: k.serial, serverDomain: k.serverDomain, stkPubHex: k.stkPubHex.toLowerCase(), issuedAt: k.issuedAt };

  const [code, userRec] = await Promise.all([deps.authCodes.get(key.serial), deps.usernames.get(key.username)]);
  if (!code || !userRec) return unusable();
  if (code.username !== key.username || code.serverDomain !== key.serverDomain) return unusable();
  if (code.status !== "active" || now > code.expiresAt) return unusable();

  const sig = hexToBytes(body.signature);
  let signerPubHex: string;
  if (userRec.isDemo) {
    if (!equalHex(userRec.irkPubHex, code.userPubKeyHex) || !verifyBoxClaimKey(key, sig, hexToBytes(userRec.irkPubHex))) return unusable();
    signerPubHex = userRec.irkPubHex.toLowerCase();
  } else {
    const authz = await authorizeAddServer(
      { grants: deps.grants, now: deps.now },
      { username: key.username, userRec, verifyWith: (pub) => verifyBoxClaimKey(key, sig, hexToBytes(pub)), now },
    );
    if (!authz.ok) return addServerRefused();
    signerPubHex = authz.signerPubHex.toLowerCase();
  }

  const stored = await deps.boxClaims.putKeyOnce({
    serial: key.serial,
    username: key.username,
    serverDomain: key.serverDomain,
    stkPubHex: key.stkPubHex,
    signerPubHex,
    issuedAt: key.issuedAt,
    recordedAt: now,
  });
  if (stored.stkPubHex !== key.stkPubHex) {
    return { status: 409, body: { error: "another box key is already registered for this server", code: BOX_KEY_TAKEN_CODE } };
  }
  return ok({ ok: true, serial: key.serial, stkPubHex: stored.stkPubHex });
}

/** The register gate: null when the box may register, else the refusal. Runs before the AuthCode is used. */
export async function boxClaimRegisterGate(boxClaims: BoxClaimStorage | undefined, serial: string, stkPubHex: string): Promise<HandlerResponseWithHeaders | null> {
  if (!boxClaims) return null;
  const pre = await boxClaims.getKey(serial);
  if (!pre || pre.stkPubHex === stkPubHex.toLowerCase()) return null;
  return { status: 403, body: { error: "this server's key does not match the box its owner set up", code: BOX_KEY_MISMATCH_CODE } };
}

const isDir = (d: string): d is BoxClaimMailboxDir => d === "to-box" || d === "to-phone";

export async function handleBoxClaimMailboxPost(
  deps: Pick<BoxClaimDeps, "boxClaims" | "now">,
  mailboxId: string,
  dir: string,
  body: { body?: unknown } | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (!BOX_CLAIM_MAILBOX_ID.test(mailboxId) || !isDir(dir)) return malformed("bad mailbox");
  const b = body?.body;
  if (typeof b !== "string" || b.length === 0 || b.length > MAX_BODY_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(b)) return malformed("malformed body");
  const r = await deps.boxClaims.postMessage(mailboxId, dir, b, (deps.now ?? Date.now)(), { ttlMs: BOX_CLAIM_MAILBOX_TTL_MS, maxPerDir: BOX_CLAIM_MAILBOX_MAX_PER_DIR });
  if (!r.ok) return conflict("mailbox full");
  return ok({ ok: true, seq: r.seq });
}

export async function handleBoxClaimMailboxRead(
  deps: Pick<BoxClaimDeps, "boxClaims" | "now">,
  mailboxId: string,
  dir: string,
  after: string | null,
): Promise<HandlerResponseWithHeaders> {
  if (!BOX_CLAIM_MAILBOX_ID.test(mailboxId) || !isDir(dir)) return malformed("bad mailbox");
  const a = after === null ? 0 : Number(after);
  if (!Number.isSafeInteger(a) || a < 0) return malformed("bad cursor");
  const messages = await deps.boxClaims.readMessages(mailboxId, dir, a, (deps.now ?? Date.now)());
  return ok({ messages }, { "cache-control": "no-store" });
}
