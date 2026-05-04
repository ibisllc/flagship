import type { FastifyInstance } from "fastify";
import { sha256 } from "@noble/hashes/sha256";
import {
  verifyLlmPromoIssueComplete,
  verifyLlmPromoIssueStart,
  type LlmPromoIssueComplete,
  type LlmPromoIssueStart,
} from "@flagship/protocol";
import { hexToBytes } from "../lib/hex.js";

/**
 * Flagship-promo issuance — one-shot. flagshipserver.com mints a per-user
 * API key after ID verification; the key is then used like any other BYOK
 * provider entry. flagshipserver.com NEVER sees vibe-coding prompts.
 *
 * Throttling, quota tracking, key revocation: all live on the GPU server,
 * not here.
 */

const TICKET_TTL_MS = 10 * 60_000;
const MAX_OTP_ATTEMPTS = 5;
const MAX_AGE_MS = 5 * 60_000;

export type VerificationMethod = "phone-otp" | "stripe-zero-auth";

export interface PromoIssuedKey {
  /** Internal id used to revoke the key on the GPU server later. */
  keyId: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Quota the GPU server has been told to enforce on this key. */
  lifetimeTokens: number;
  dailyTokens: number;
}

/**
 * Pluggable issuer — the real implementation calls our GPU server's admin
 * API; tests use an in-memory fake. The mintKey contract is "tell the GPU
 * server about this user; return the key shape the user will use."
 */
export interface PromoIssuer {
  mintKey(args: { irkPub: Uint8Array; userId: string }): Promise<PromoIssuedKey>;
}

/** Pluggable SMS sender for phone-otp verification. */
export interface SmsSender {
  send(args: { phoneNumber: string; otp: string }): Promise<void>;
}

export class ConsoleSmsSender implements SmsSender {
  /** Dev / test only — captures the OTP for inspection. */
  delivered: { phoneNumber: string; otp: string }[] = [];
  async send(args: { phoneNumber: string; otp: string }): Promise<void> {
    this.delivered.push({ ...args });
  }
}

export interface PromoLedgerEntry {
  irkPubHex: string;
  /** sha256(identity || serverPepper) — a brute-force recovery of the
   * original identity needs to know the server pepper. */
  saltedIdentityHash: Uint8Array;
  issuedKeyId: string;
  issuedAt: number;
}

export interface PromoLedger {
  alreadyIssuedTo(irkPubHex: string): boolean;
  identityAlreadyUsed(saltedIdentityHash: Uint8Array): boolean;
  recordIssuance(entry: PromoLedgerEntry): void;
}

export class InMemoryPromoLedger implements PromoLedger {
  private byIrk = new Map<string, PromoLedgerEntry>();
  private identityKeys = new Set<string>();

  alreadyIssuedTo(irkPubHex: string): boolean {
    return this.byIrk.has(irkPubHex);
  }

  identityAlreadyUsed(saltedIdentityHash: Uint8Array): boolean {
    return this.identityKeys.has(bytesToHex(saltedIdentityHash));
  }

  recordIssuance(entry: PromoLedgerEntry): void {
    this.byIrk.set(entry.irkPubHex, {
      ...entry,
      saltedIdentityHash: entry.saltedIdentityHash.slice(),
    });
    this.identityKeys.add(bytesToHex(entry.saltedIdentityHash));
  }
}

interface VerificationTicket {
  ticket: string;
  irkPubHex: string;
  irkPub: Uint8Array;
  userId: string;
  identityHash: Uint8Array;
  saltedIdentityHash: Uint8Array;
  /** sha256(otp). The plaintext OTP only ever lives in the SmsSender's hands. */
  otpHash: Uint8Array;
  attempts: number;
  expiresAt: number;
}

class TicketStore {
  private byTicket = new Map<string, VerificationTicket>();

  put(t: VerificationTicket): void {
    this.byTicket.set(t.ticket, t);
  }
  get(ticket: string, now: number): VerificationTicket | undefined {
    const t = this.byTicket.get(ticket);
    if (!t) return undefined;
    if (t.expiresAt < now) {
      this.byTicket.delete(ticket);
      return undefined;
    }
    return t;
  }
  delete(ticket: string): void {
    this.byTicket.delete(ticket);
  }
}

export interface LlmPromoOptions {
  resolveUserIrk: (userId: string) => Uint8Array | null | Promise<Uint8Array | null>;
  ledger: PromoLedger;
  issuer: PromoIssuer;
  sms: SmsSender;
  /** Server-side pepper that gets mixed into identity hashes before storage. */
  identityPepper: Uint8Array;
  now?: () => number;
  /** Test seam — override OTP generation. */
  generateOtp?: () => string;
  /** Test seam — override ticket id. */
  generateTicket?: () => string;
}

interface StartBody {
  request?: {
    userId?: string;
    method?: VerificationMethod;
    identityHash?: string;
    issuedAt?: number;
  };
  signature?: string;
  /** Plaintext input that hashes to identityHash. */
  identity?: string;
}

interface CompleteBody {
  request?: {
    userId?: string;
    ticket?: string;
    otpHash?: string;
    issuedAt?: number;
  };
  signature?: string;
  /** Plaintext OTP that hashes to otpHash. */
  otp?: string;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function saltIdentity(identityHash: Uint8Array, pepper: Uint8Array): Uint8Array {
  const buf = new Uint8Array(identityHash.length + pepper.length);
  buf.set(identityHash, 0);
  buf.set(pepper, identityHash.length);
  return sha256(buf);
}

function defaultGenerateOtp(): string {
  // 6-digit zero-padded numeric.
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const n = ((buf[0]! << 24) | (buf[1]! << 16) | (buf[2]! << 8) | buf[3]!) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}

function defaultGenerateTicket(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return "tk-" + bytesToHex(buf);
}

export function registerLlmPromo(app: FastifyInstance, opts: LlmPromoOptions): void {
  const tickets = new TicketStore();
  const now = opts.now ?? (() => Date.now());
  const generateOtp = opts.generateOtp ?? defaultGenerateOtp;
  const generateTicket = opts.generateTicket ?? defaultGenerateTicket;

  app.post<{ Body: StartBody }>("/api/llm-promo/issue/start", async (req, reply) => {
    const body = req.body ?? {};
    const r = body.request;
    if (
      !r ||
      typeof r.userId !== "string" ||
      (r.method !== "phone-otp" && r.method !== "stripe-zero-auth") ||
      typeof r.identityHash !== "string" ||
      typeof r.issuedAt !== "number" ||
      typeof body.signature !== "string" ||
      typeof body.identity !== "string"
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }
    if (r.method !== "phone-otp") {
      return reply.status(501).send({ error: "stripe-zero-auth not yet implemented" });
    }
    const irkPub = await opts.resolveUserIrk(r.userId);
    if (!irkPub) return reply.status(404).send({ error: "unknown user" });

    let identityHash: Uint8Array;
    let sig: Uint8Array;
    try {
      identityHash = hexToBytes(r.identityHash);
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "invalid hex" });
    }
    const expected = sha256(new TextEncoder().encode(body.identity));
    if (!equalBytes(expected, identityHash)) {
      return reply.status(400).send({ error: "identityHash does not match identity input" });
    }

    const claim: LlmPromoIssueStart = {
      userId: r.userId,
      method: r.method,
      identityHash,
      issuedAt: r.issuedAt,
    };
    if (!verifyLlmPromoIssueStart(claim, sig, irkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }
    const t = now();
    if (Math.abs(t - r.issuedAt) > MAX_AGE_MS) {
      return reply.status(403).send({ error: "stale request" });
    }

    const irkHex = bytesToHex(irkPub);
    if (opts.ledger.alreadyIssuedTo(irkHex)) {
      return reply.status(409).send({ error: "this account has already received a promo key" });
    }
    const salted = saltIdentity(identityHash, opts.identityPepper);
    if (opts.ledger.identityAlreadyUsed(salted)) {
      return reply
        .status(409)
        .send({ error: "this identity is already associated with another account" });
    }

    const otp = generateOtp();
    const otpHash = sha256(new TextEncoder().encode(otp));
    const ticket = generateTicket();
    tickets.put({
      ticket,
      irkPubHex: irkHex,
      irkPub,
      userId: r.userId,
      identityHash,
      saltedIdentityHash: salted,
      otpHash,
      attempts: 0,
      expiresAt: t + TICKET_TTL_MS,
    });

    try {
      await opts.sms.send({ phoneNumber: body.identity, otp });
    } catch (e) {
      tickets.delete(ticket);
      return reply.status(502).send({ error: "sms send failed", message: errMsg(e) });
    }
    return { ticket, expiresAt: t + TICKET_TTL_MS };
  });

  app.post<{ Body: CompleteBody }>("/api/llm-promo/issue/complete", async (req, reply) => {
    const body = req.body ?? {};
    const r = body.request;
    if (
      !r ||
      typeof r.userId !== "string" ||
      typeof r.ticket !== "string" ||
      typeof r.otpHash !== "string" ||
      typeof r.issuedAt !== "number" ||
      typeof body.signature !== "string" ||
      typeof body.otp !== "string"
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }
    const irkPub = await opts.resolveUserIrk(r.userId);
    if (!irkPub) return reply.status(404).send({ error: "unknown user" });

    let otpHash: Uint8Array;
    let sig: Uint8Array;
    try {
      otpHash = hexToBytes(r.otpHash);
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "invalid hex" });
    }
    const expectedOtpHash = sha256(new TextEncoder().encode(body.otp));
    if (!equalBytes(expectedOtpHash, otpHash)) {
      return reply.status(400).send({ error: "otpHash does not match otp input" });
    }

    const claim: LlmPromoIssueComplete = {
      userId: r.userId,
      ticket: r.ticket,
      otpHash,
      issuedAt: r.issuedAt,
    };
    if (!verifyLlmPromoIssueComplete(claim, sig, irkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }
    const t = now();
    if (Math.abs(t - r.issuedAt) > MAX_AGE_MS) {
      return reply.status(403).send({ error: "stale request" });
    }

    const tk = tickets.get(r.ticket, t);
    if (!tk) return reply.status(404).send({ error: "ticket not found or expired" });
    if (tk.irkPubHex !== bytesToHex(irkPub)) {
      return reply.status(403).send({ error: "ticket does not belong to this user" });
    }
    tk.attempts += 1;
    if (tk.attempts > MAX_OTP_ATTEMPTS) {
      tickets.delete(r.ticket);
      return reply.status(429).send({ error: "too many attempts" });
    }
    if (!equalBytes(tk.otpHash, otpHash)) {
      return reply.status(403).send({ error: "wrong otp" });
    }

    // Defense in depth: re-check the per-account constraint at completion.
    if (opts.ledger.alreadyIssuedTo(tk.irkPubHex)) {
      tickets.delete(r.ticket);
      return reply.status(409).send({ error: "this account already has a promo key" });
    }
    if (opts.ledger.identityAlreadyUsed(tk.saltedIdentityHash)) {
      tickets.delete(r.ticket);
      return reply.status(409).send({ error: "this identity is already associated with another account" });
    }

    const minted = await opts.issuer.mintKey({ irkPub: tk.irkPub, userId: tk.userId });
    opts.ledger.recordIssuance({
      irkPubHex: tk.irkPubHex,
      saltedIdentityHash: tk.saltedIdentityHash,
      issuedKeyId: minted.keyId,
      issuedAt: t,
    });
    tickets.delete(r.ticket);

    return {
      key: minted,
      note:
        "This key is delivered once. Save it — flagshipserver.com cannot recover it. " +
        "All vibe-coding traffic that uses this key goes phone → your server → our GPU directly; " +
        "we never see your prompts.",
    };
  });

  // No /chat, no /quota — by design. Throttling lives on the GPU server.
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const _internal = { TICKET_TTL_MS, MAX_OTP_ATTEMPTS, saltIdentity };
