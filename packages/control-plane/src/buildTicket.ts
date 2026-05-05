import {
  verifyInstallBlob,
  type InstallBlob,
} from "@flagship/protocol";
import type { BuildTicketStorage, UsernameStorage } from "@flagship/storage";
import { HEX128, HEX64, equalHex, hexToBytes, bytesToHex } from "./hex.js";
import { SERIAL_RE } from "./authCode.js";
import {
  forbidden, gone, malformed, notFound, ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_GROUP_LEN = 4;
const CODE_GROUPS = 3;
const CODE_LEN = CODE_GROUP_LEN * CODE_GROUPS;
const CODE_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}-?[A-Z0-9]{4}$/;

export interface BuildTicketDeps {
  storage: BuildTicketStorage;
  usernames: UsernameStorage;
  defaultTtlMs?: number;
  maxRefreshMs?: number;
  maxLifetimeMs?: number;
  randomBytes?: (n: number) => Uint8Array;
  now?: () => number;
}

interface InstallBlobJson {
  version?: number;
  serverDomain?: string;
  username?: string;
  serverName?: string;
  phoneDelegatedPubKey?: string;
  registrationUrl?: string;
  authCode?: {
    version?: number;
    serial?: string;
    username?: string;
    serverName?: string;
    serverDomain?: string;
    delegatedPubKey?: string;
    userPubKey?: string;
    issuedAt?: number;
    expiresAt?: number;
  };
  authCodeUserSignature?: string;
  issuedAt?: number;
  expiresAt?: number;
  installerGitRef?: string;
  rckPubKey?: string;
}

interface IssueBody {
  blob?: InstallBlobJson;
  signature?: string;
  ttlMs?: number;
}

interface RedeemBody {
  code?: string;
}

interface RefreshBody {
  ttlMs?: number;
}

export function generateTicketCode(rand: (n: number) => Uint8Array): string {
  const bytes = rand(CODE_LEN);
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) {
    if (i > 0 && i % CODE_GROUP_LEN === 0) s += "-";
    s += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return s;
}

export function normalizeCode(input: string): string | null {
  const stripped = input.toUpperCase().replace(/-/g, "");
  if (stripped.length !== CODE_LEN) return null;
  for (const c of stripped) if (!ALPHABET.includes(c)) return null;
  return (
    stripped.slice(0, 4) + "-" + stripped.slice(4, 8) + "-" + stripped.slice(8, 12)
  );
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function parseInstallBlob(j: InstallBlobJson | undefined): InstallBlob | null {
  if (
    !j ||
    j.version !== 1 ||
    typeof j.serverDomain !== "string" ||
    typeof j.username !== "string" ||
    typeof j.serverName !== "string" ||
    typeof j.phoneDelegatedPubKey !== "string" ||
    !HEX64.test(j.phoneDelegatedPubKey) ||
    typeof j.registrationUrl !== "string" ||
    !j.authCode ||
    typeof j.authCodeUserSignature !== "string" ||
    !HEX128.test(j.authCodeUserSignature) ||
    typeof j.issuedAt !== "number" ||
    typeof j.expiresAt !== "number" ||
    typeof j.installerGitRef !== "string" ||
    typeof j.rckPubKey !== "string" ||
    !HEX64.test(j.rckPubKey)
  ) {
    return null;
  }
  const ac = j.authCode;
  if (
    ac.version !== 1 ||
    typeof ac.serial !== "string" ||
    !SERIAL_RE.test(ac.serial) ||
    typeof ac.username !== "string" ||
    typeof ac.serverName !== "string" ||
    typeof ac.serverDomain !== "string" ||
    typeof ac.delegatedPubKey !== "string" ||
    !HEX64.test(ac.delegatedPubKey) ||
    typeof ac.userPubKey !== "string" ||
    !HEX64.test(ac.userPubKey) ||
    typeof ac.issuedAt !== "number" ||
    typeof ac.expiresAt !== "number"
  ) {
    return null;
  }
  return {
    version: 1,
    serverDomain: j.serverDomain,
    username: j.username,
    serverName: j.serverName,
    phoneDelegatedPubKey: hexToBytes(j.phoneDelegatedPubKey),
    registrationUrl: j.registrationUrl,
    authCode: {
      version: 1,
      serial: ac.serial,
      username: ac.username,
      serverName: ac.serverName,
      serverDomain: ac.serverDomain,
      delegatedPubKey: hexToBytes(ac.delegatedPubKey),
      userPubKey: hexToBytes(ac.userPubKey),
      issuedAt: ac.issuedAt,
      expiresAt: ac.expiresAt,
    },
    authCodeUserSignature: hexToBytes(j.authCodeUserSignature),
    issuedAt: j.issuedAt,
    expiresAt: j.expiresAt,
    installerGitRef: j.installerGitRef,
    rckPubKey: hexToBytes(j.rckPubKey),
  };
}

function blobToJson(b: InstallBlob): InstallBlobJson {
  return {
    version: 1,
    serverDomain: b.serverDomain,
    username: b.username,
    serverName: b.serverName,
    phoneDelegatedPubKey: bytesToHex(b.phoneDelegatedPubKey),
    registrationUrl: b.registrationUrl,
    authCode: {
      version: 1,
      serial: b.authCode.serial,
      username: b.authCode.username,
      serverName: b.authCode.serverName,
      serverDomain: b.authCode.serverDomain,
      delegatedPubKey: bytesToHex(b.authCode.delegatedPubKey),
      userPubKey: bytesToHex(b.authCode.userPubKey),
      issuedAt: b.authCode.issuedAt,
      expiresAt: b.authCode.expiresAt,
    },
    authCodeUserSignature: bytesToHex(b.authCodeUserSignature),
    issuedAt: b.issuedAt,
    expiresAt: b.expiresAt,
    installerGitRef: b.installerGitRef,
    rckPubKey: bytesToHex(b.rckPubKey),
  };
}

export async function handleBuildTicketIssue(
  deps: BuildTicketDeps,
  body: IssueBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const rand = deps.randomBytes ?? defaultRandom;
  const defaultTtlMs = deps.defaultTtlMs ?? 60 * 60_000;

  if (typeof body?.signature !== "string" || !HEX128.test(body.signature)) {
    return malformed("malformed body");
  }
  const blob = parseInstallBlob(body.blob);
  if (!blob) return malformed("malformed install blob");

  const userRec = await deps.usernames.get(blob.username);
  if (!userRec) return notFound("username not registered");
  if (!equalHex(userRec.irkPubHex, bytesToHex(blob.authCode.userPubKey))) {
    return forbidden("userPubKey does not match registered IRK");
  }

  const sig = hexToBytes(body.signature);
  if (!verifyInstallBlob(blob, sig, blob.authCode.userPubKey)) {
    return forbidden("invalid blob signature");
  }

  const expectedDomain = `${blob.serverName}.${blob.username}.flagship.services`;
  if (blob.serverDomain !== expectedDomain) {
    return malformed(`serverDomain must equal ${expectedDomain}`);
  }
  if (blob.expiresAt <= now) return malformed("blob already expired");

  const ttlMs = Math.min(body.ttlMs ?? defaultTtlMs, defaultTtlMs);
  const blobJson = JSON.stringify(blobToJson(blob));

  let code = "";
  for (let attempts = 0; attempts < 8 && !code; attempts++) {
    const candidate = generateTicketCode(rand);
    const out = await deps.storage.put({
      code: candidate,
      blobJson,
      blobSignatureHex: bytesToHex(sig),
      username: blob.username,
      serverDomain: blob.serverDomain,
      createdAt: now,
      expiresAt: now + ttlMs,
      status: "active",
      redemptions: 0,
    });
    if (out.ok) code = candidate;
  }
  if (!code) return { status: 500, body: { error: "could not allocate code" } };

  return ok({ ok: true, code, expiresAt: now + ttlMs, ttlMs });
}

export async function handleBuildTicketRedeem(
  deps: BuildTicketDeps,
  body: RedeemBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const raw = body?.code;
  if (typeof raw !== "string" || !CODE_RE.test(raw)) return malformed("malformed code");
  const code = normalizeCode(raw);
  if (!code) return malformed("malformed code");

  const t = await deps.storage.get(code);
  if (!t) return notFound("unknown code");
  if (t.status === "revoked") return gone("revoked");
  if (now > t.expiresAt) return gone("expired");

  await deps.storage.markRedeemed(code, now);
  let blob: InstallBlobJson;
  try {
    blob = JSON.parse(t.blobJson);
  } catch {
    return { status: 500, body: { error: "stored blob is malformed" } };
  }
  return ok({
    ok: true,
    code: t.code,
    blob,
    blobSignature: t.blobSignatureHex,
    expiresAt: t.expiresAt,
    redemptions: t.redemptions + 1,
  });
}

export async function handleBuildTicketRefresh(
  deps: BuildTicketDeps,
  code: string,
  body: RefreshBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const defaultTtlMs = deps.defaultTtlMs ?? 60 * 60_000;
  const maxRefreshMs = deps.maxRefreshMs ?? 60 * 60_000;
  const maxLifetimeMs = deps.maxLifetimeMs ?? 24 * 60 * 60_000;

  const norm = normalizeCode(code);
  if (!norm) return malformed("malformed code");
  const t = await deps.storage.get(norm);
  if (!t) return notFound("unknown code");
  if (t.status === "revoked") return gone("revoked");
  if (now > t.createdAt + maxLifetimeMs) return gone("max lifetime exceeded");

  const ttlMs = Math.min(body?.ttlMs ?? defaultTtlMs, maxRefreshMs);
  const candidate = Math.max(t.expiresAt, now + ttlMs);
  const newExpiry = Math.min(candidate, t.createdAt + maxLifetimeMs);
  await deps.storage.refresh(norm, newExpiry);
  return ok({ ok: true, code: t.code, expiresAt: newExpiry });
}

export async function handleBuildTicketLookup(
  deps: BuildTicketDeps,
  code: string,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const norm = normalizeCode(code);
  if (!norm) return malformed("malformed code");
  const t = await deps.storage.get(norm);
  if (!t) return notFound("unknown code");
  const expired = now > t.expiresAt;
  const serverName = t.serverDomain.split(".")[0] ?? "";
  return ok({
    code: t.code,
    status: t.status === "active" && expired ? "expired" : t.status,
    username: t.username,
    serverName,
    serverDomain: t.serverDomain,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    redemptions: t.redemptions,
  });
}

export const _ticketInternal = { ALPHABET, CODE_LEN, CODE_RE };
