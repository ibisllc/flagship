import type { FastifyInstance } from "fastify";
import {
  verifyInstallBlob,
  type InstallBlob,
} from "@flagship/protocol";
import { hexToBytes, bytesToHex } from "../lib/hex.js";
import type { UsernameRegistry } from "./usernameRegistry.js";

/**
 * Build-ticket layer: turns a phone-signed InstallBlob into a short,
 * human-typeable code that the user enters on flagshipserver.com/build.
 *
 * The blob itself is too long to type. The phone signs it with the user's
 * IRK; .com mints a code, stores the blob behind it, and returns the code
 * to the phone. The user types the code on a PC; /build/ redeems it and
 * uses the blob to personalize the ISO.
 *
 * Codes are 12 chars over a 28-char alphabet (no 0/O/1/I/L), grouped
 * `XXXX-XXXX-XXXX`. Brute force on a 12-char code with TTL ≤ 1h is
 * infeasible; rate-limit `/redeem` per IP for defense in depth.
 */

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_GROUP_LEN = 4;
const CODE_GROUPS = 3;
const CODE_LEN = CODE_GROUP_LEN * CODE_GROUPS;
const CODE_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}-?[A-Z0-9]{4}$/;

export type BuildTicketStatus = "active" | "redeemed" | "revoked";

export interface BuildTicket {
  code: string;
  blob: InstallBlob;
  blobSignature: Uint8Array;
  createdAt: number;
  expiresAt: number;
  status: BuildTicketStatus;
  redeemedAt?: number;
  /** How many times the code has been read. */
  redemptions: number;
}

export interface BuildTicketStore {
  put(t: BuildTicket): { ok: true } | { ok: false; reason: string };
  get(code: string): BuildTicket | undefined;
  refresh(code: string, expiresAt: number): { ok: true } | { ok: false; reason: string };
  markRedeemed(code: string, at: number): void;
  list(): BuildTicket[];
}

export class InMemoryBuildTicketStore implements BuildTicketStore {
  private byCode = new Map<string, BuildTicket>();
  put(t: BuildTicket): { ok: true } | { ok: false; reason: string } {
    if (this.byCode.has(t.code)) return { ok: false, reason: "code collision" };
    this.byCode.set(t.code, t);
    return { ok: true };
  }
  get(code: string): BuildTicket | undefined {
    return this.byCode.get(code);
  }
  refresh(code: string, expiresAt: number): { ok: true } | { ok: false; reason: string } {
    const t = this.byCode.get(code);
    if (!t) return { ok: false, reason: "unknown code" };
    if (t.status === "revoked") return { ok: false, reason: "revoked" };
    t.expiresAt = expiresAt;
    return { ok: true };
  }
  markRedeemed(code: string, at: number): void {
    const t = this.byCode.get(code);
    if (!t) return;
    t.status = "redeemed";
    t.redeemedAt = at;
    t.redemptions += 1;
  }
  list(): BuildTicket[] {
    return [...this.byCode.values()];
  }
}

export interface BuildTicketOptions {
  store: BuildTicketStore;
  usernameRegistry: UsernameRegistry;
  /** Default lifetime of a fresh ticket, before refresh. Default 1 h. */
  defaultTtlMs?: number;
  /** Hard cap on a single refresh extension. Default 1 h. */
  maxRefreshMs?: number;
  /** Hard ceiling: a ticket can never live past this from creation. Default 24 h. */
  maxLifetimeMs?: number;
  /** Random source — overridable in tests. */
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
}

interface IssueBody {
  blob?: InstallBlobJson;
  signature?: string;
}

interface RedeemBody {
  code?: string;
}

interface RefreshBody {
  ttlMs?: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const SERIAL_RE = /^[A-Za-z0-9_-]{8,64}$/;

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

function parseInstallBlob(j: InstallBlobJson, body: IssueBody): InstallBlob | null {
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
    typeof j.expiresAt !== "number"
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
  };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function registerBuildTicket(
  app: FastifyInstance,
  opts: BuildTicketOptions,
): void {
  const now = opts.now ?? (() => Date.now());
  const rand = opts.randomBytes ?? defaultRandom;
  const defaultTtlMs = opts.defaultTtlMs ?? 60 * 60_000;
  const maxRefreshMs = opts.maxRefreshMs ?? 60 * 60_000;
  const maxLifetimeMs = opts.maxLifetimeMs ?? 24 * 60 * 60_000;

  app.post<{ Body: IssueBody }>("/api/build-tickets/issue", async (req, reply) => {
    const body = req.body ?? {};
    if (typeof body.signature !== "string" || !HEX128.test(body.signature)) {
      return reply.status(400).send({ error: "malformed body" });
    }
    const blob = parseInstallBlob(body.blob ?? {}, body);
    if (!blob) return reply.status(400).send({ error: "malformed install blob" });

    const userRec = opts.usernameRegistry.lookup(blob.username);
    if (!userRec) return reply.status(404).send({ error: "username not registered" });
    if (!equalBytes(userRec.irkPub, blob.authCode.userPubKey)) {
      return reply.status(403).send({ error: "userPubKey does not match registered IRK" });
    }

    const sig = hexToBytes(body.signature);
    if (!verifyInstallBlob(blob, sig, blob.authCode.userPubKey)) {
      return reply.status(403).send({ error: "invalid blob signature" });
    }

    const expectedDomain = `${blob.serverName}.${blob.username}.flagship.services`;
    if (blob.serverDomain !== expectedDomain) {
      return reply.status(400).send({ error: `serverDomain must equal ${expectedDomain}` });
    }
    if (blob.expiresAt <= now()) {
      return reply.status(400).send({ error: "blob already expired" });
    }

    let code = "";
    let collisions = 0;
    while (collisions < 8) {
      code = generateTicketCode(rand);
      const out = opts.store.put({
        code,
        blob,
        blobSignature: sig,
        createdAt: now(),
        expiresAt: now() + defaultTtlMs,
        status: "active",
        redemptions: 0,
      });
      if (out.ok) break;
      collisions += 1;
      code = "";
    }
    if (!code) return reply.status(500).send({ error: "could not allocate code" });

    return {
      ok: true,
      code,
      expiresAt: now() + defaultTtlMs,
      ttlMs: defaultTtlMs,
    };
  });

  app.post<{ Body: RedeemBody }>("/api/build-tickets/redeem", async (req, reply) => {
    const raw = (req.body ?? {}).code;
    if (typeof raw !== "string" || !CODE_RE.test(raw)) {
      return reply.status(400).send({ error: "malformed code" });
    }
    const code = normalizeCode(raw);
    if (!code) return reply.status(400).send({ error: "malformed code" });

    const t = opts.store.get(code);
    if (!t) return reply.status(404).send({ error: "unknown code" });
    if (t.status === "revoked") return reply.status(410).send({ error: "revoked" });
    if (now() > t.expiresAt) return reply.status(410).send({ error: "expired" });

    opts.store.markRedeemed(code, now());

    return {
      ok: true,
      code: t.code,
      blob: blobToJson(t.blob),
      blobSignature: bytesToHex(t.blobSignature),
      expiresAt: t.expiresAt,
      redemptions: t.redemptions,
    };
  });

  app.post<{ Params: { code: string }; Body: RefreshBody }>(
    "/api/build-tickets/:code/refresh",
    async (req, reply) => {
      const code = normalizeCode(req.params.code);
      if (!code) return reply.status(400).send({ error: "malformed code" });
      const t = opts.store.get(code);
      if (!t) return reply.status(404).send({ error: "unknown code" });
      if (t.status === "revoked") return reply.status(410).send({ error: "revoked" });
      if (now() > t.createdAt + maxLifetimeMs) {
        return reply.status(410).send({ error: "max lifetime exceeded" });
      }
      const ttlMs = Math.min(req.body?.ttlMs ?? defaultTtlMs, maxRefreshMs);
      const candidate = Math.max(t.expiresAt, now() + ttlMs);
      const newExpiry = Math.min(candidate, t.createdAt + maxLifetimeMs);
      opts.store.refresh(code, newExpiry);
      return { ok: true, code: t.code, expiresAt: newExpiry };
    },
  );

  app.get<{ Params: { code: string } }>(
    "/api/build-tickets/:code",
    async (req, reply) => {
      const code = normalizeCode(req.params.code);
      if (!code) return reply.status(400).send({ error: "malformed code" });
      const t = opts.store.get(code);
      if (!t) return reply.status(404).send({ error: "unknown code" });
      const expired = now() > t.expiresAt;
      return {
        code: t.code,
        status: t.status === "active" && expired ? "expired" : t.status,
        username: t.blob.username,
        serverName: t.blob.serverName,
        serverDomain: t.blob.serverDomain,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        redemptions: t.redemptions,
      };
    },
  );
}

export const _internal = { ALPHABET, CODE_LEN, CODE_RE };
