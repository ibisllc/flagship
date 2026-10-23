import { verifyPutSealedLuksKey, type PutSealedLuksKey } from "@flagship/protocol";
import type { LuksKeyStorage, ServerStorage, UsernameStorage } from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import {
  ACCOUNT_KEY_HOLDERS_ONLY,
  ACCOUNT_READ_HEADERS,
  requireAccountRead,
  type AccountReadTokenDeps,
} from "./accountReadToken.js";
import { forbidden, malformed, notFound, type HandlerResponse, type HandlerResponseWithHeaders } from "./types.js";

/**
 * The disk key `.com` holds sealed for the account (never readable here).
 *
 * `POST   /api/server/:host/sealed-luks-key`   server identity-signed
 * `GET    /api/server/:host/sealed-luks-key`   the account's read token (devices / IRK only)
 *
 * The :host parameter must equal the `serverId` field inside the signed
 * request — defense in depth against a bug that mis-routes between hosts.
 *
 * A box unlocks from the box-sealed lease (secretMailbox.ts lease-v2, the
 * boot worker's /api/boot/lease) or the phone relay. The plaintext lease
 * (auto-unlock-lease/v1 and its /unlock-key/consume release) is gone: `.com`
 * never stores a key it can read.
 */
export interface LuksKeyDeps {
  servers: ServerStorage;
  usernames: UsernameStorage;
  luksKeys: LuksKeyStorage;
  maxAgeMs?: number;
  now?: () => number;
}

export interface LuksKeyReadDeps {
  servers: ServerStorage;
  luksKeys: LuksKeyStorage;
  readTokens: AccountReadTokenDeps;
}

const DEFAULT_MAX_AGE = 5 * 60_000;

export async function handlePutSealedLuksKey(
  deps: LuksKeyDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.sealedKey !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return malformed("malformed body");
  }
  if (r.serverId !== host) {
    return forbidden("serverId / host mismatch");
  }
  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return forbidden("stale request");
  }

  let sealedKey: Uint8Array;
  let sig: Uint8Array;
  try {
    sealedKey = hexToBytes(r.sealedKey);
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid hex");
  }
  const claim: PutSealedLuksKey = {
    serverId: host,
    sealedKey,
    issuedAt: r.issuedAt,
  };
  if (!verifyPutSealedLuksKey(claim, sig, hexToBytes(reg.identityPubKeyHex))) {
    return forbidden("invalid signature");
  }

  await deps.luksKeys.putSealed({
    serverDomain: host,
    sealedKeyHex: r.sealedKey,
    sealedAt: now(),
  });
  return { status: 200, body: { ok: true } };
}

/**
 * The deposit is sealed to the account IRK with classical X25519, so a copy
 * taken today opens once that falls: only the account's own devices (or its
 * IRK) may download it, with the account read token
 * (docs/account-read-token.md). Every legitimate reader is a device of the
 * owning account opening it with the UMK; no box reads it (boxes unlock from
 * their STK-sealed lease or the phone relay). Demo accounts read without a
 * token, as for `/pods`. An unknown server and a missing deposit both answer
 * 401 to a caller without a token, so names can't be probed for deposits.
 */
export async function handleGetSealedLuksKey(
  deps: LuksKeyReadDeps,
  host: string,
  authorization: string | null | undefined,
): Promise<HandlerResponseWithHeaders> {
  const reg = await deps.servers.get(host);
  const check = await requireAccountRead(
    deps.readTokens,
    reg?.username ?? "",
    authorization,
    ACCOUNT_KEY_HOLDERS_ONLY,
  );
  if (!check.ok) return check.response;
  const rec = reg ? await deps.luksKeys.getSealed(host) : undefined;
  if (!rec) return { ...notFound("no sealed key on file"), headers: { ...ACCOUNT_READ_HEADERS } };
  return {
    status: 200,
    headers: { ...ACCOUNT_READ_HEADERS },
    body: {
      serverDomain: rec.serverDomain,
      sealedKey: rec.sealedKeyHex,
      sealedAt: rec.sealedAt,
    },
  };
}
