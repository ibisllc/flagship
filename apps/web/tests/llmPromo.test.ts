import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import {
  deriveIRK,
  signLlmPromoIssueComplete,
  signLlmPromoIssueStart,
  type LlmPromoIssueComplete,
  type LlmPromoIssueStart,
} from "@flagship/protocol";
import { buildServer } from "../src/server.js";
import {
  ConsoleSmsSender,
  InMemoryPromoLedger,
  type PromoIssuer,
  type PromoIssuedKey,
} from "../src/routes/llmPromo.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);
const sarahUmk = { seed: new Uint8Array(32).fill(22) };
const sarahIrk = deriveIRK(sarahUmk);

const PEPPER = new Uint8Array(32).fill(0xab);

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

class FakeIssuer implements PromoIssuer {
  minted: { keyId: string; userId: string }[] = [];
  async mintKey(args: { irkPub: Uint8Array; userId: string }): Promise<PromoIssuedKey> {
    const keyId = `gpu-${this.minted.length + 1}`;
    this.minted.push({ keyId, userId: args.userId });
    return {
      keyId,
      apiKey: `fp-${keyId}`,
      baseUrl: "https://promo.flagshipserver.com/v1",
      model: "flagship-coder-v1",
      lifetimeTokens: 500_000,
      dailyTokens: 100_000,
    };
  }
}

function makeApp(extra: { issuer?: FakeIssuer; sms?: ConsoleSmsSender; ledger?: InMemoryPromoLedger; otp?: string; ticket?: string } = {}) {
  const issuer = extra.issuer ?? new FakeIssuer();
  const sms = extra.sms ?? new ConsoleSmsSender();
  const ledger = extra.ledger ?? new InMemoryPromoLedger();
  const app = buildServer({
    promoIssuer: issuer,
    promoLedger: ledger,
    promoSms: sms,
    promoIdentityPepper: PEPPER,
    resolveUserIrk: (uid) => {
      if (uid === "harry") return harryIrk.publicKey;
      if (uid === "sarah") return sarahIrk.publicKey;
      return null;
    },
  });
  // Inject deterministic test seams via the underlying app re-registration.
  // For these tests we override the OTP/ticket via spies on the SMS sender:
  // the OTP is captured from sms.delivered[].
  return { app, issuer, sms, ledger };
}

function buildSignedStart(
  identity: string,
  over: Partial<LlmPromoIssueStart> = {},
  signer = harryIrk,
) {
  const identityHash = sha256(new TextEncoder().encode(identity));
  const claim: LlmPromoIssueStart = {
    userId: over.userId ?? "harry",
    method: over.method ?? "phone-otp",
    identityHash,
    issuedAt: over.issuedAt ?? Date.now(),
  };
  return {
    request: {
      userId: claim.userId,
      method: claim.method,
      identityHash: bytesToHex(identityHash),
      issuedAt: claim.issuedAt,
    },
    signature: bytesToHex(signLlmPromoIssueStart(claim, signer)),
    identity,
  };
}

function buildSignedComplete(
  ticket: string,
  otp: string,
  over: Partial<LlmPromoIssueComplete> = {},
  signer = harryIrk,
) {
  const otpHash = sha256(new TextEncoder().encode(otp));
  const claim: LlmPromoIssueComplete = {
    userId: over.userId ?? "harry",
    ticket,
    otpHash,
    issuedAt: over.issuedAt ?? Date.now(),
  };
  return {
    request: {
      userId: claim.userId,
      ticket: claim.ticket,
      otpHash: bytesToHex(otpHash),
      issuedAt: claim.issuedAt,
    },
    signature: bytesToHex(signLlmPromoIssueComplete(claim, signer)),
    otp,
  };
}

async function startAndGetOtp(
  app: ReturnType<typeof buildServer>,
  sms: ConsoleSmsSender,
  identity: string,
) {
  const start = await app.inject({
    method: "POST",
    url: "/api/llm-promo/issue/start",
    payload: buildSignedStart(identity),
  });
  expect(start.statusCode).toBe(200);
  const { ticket } = JSON.parse(start.body);
  const last = sms.delivered.at(-1)!;
  return { ticket, otp: last.otp };
}

describe("/api/llm-promo/issue/start", () => {
  it("requires the identity input to match identityHash (no swapping numbers between sign and post)", async () => {
    const { app, sms } = makeApp();
    const payload = buildSignedStart("+15555550100");
    payload.identity = "+15555550999"; // tamper after signing → mismatch
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/issue/start",
      payload,
    });
    expect(r.statusCode).toBe(400);
    expect(sms.delivered).toHaveLength(0);
  });

  it("rejects forged signatures (cross-user)", async () => {
    const { app, sms } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/issue/start",
      payload: buildSignedStart("+15555550100", { userId: "harry" }, sarahIrk),
    });
    expect(r.statusCode).toBe(403);
    expect(sms.delivered).toHaveLength(0);
  });

  it("returns 409 when this account already received a promo key", async () => {
    const ledger = new InMemoryPromoLedger();
    ledger.recordIssuance({
      irkPubHex: bytesToHex(harryIrk.publicKey),
      saltedIdentityHash: new Uint8Array(32).fill(0xee),
      issuedKeyId: "old-key",
      issuedAt: Date.now(),
    });
    const { app, sms } = makeApp({ ledger });
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/issue/start",
      payload: buildSignedStart("+15555550100"),
    });
    expect(r.statusCode).toBe(409);
    expect(sms.delivered).toHaveLength(0);
  });

  it("sends an OTP via the SmsSender on success", async () => {
    const { app, sms } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/issue/start",
      payload: buildSignedStart("+15555550100"),
    });
    expect(r.statusCode).toBe(200);
    expect(sms.delivered).toHaveLength(1);
    expect(sms.delivered[0]!.otp).toMatch(/^[0-9]{6}$/);
    expect(sms.delivered[0]!.phoneNumber).toBe("+15555550100");
  });

  it("rejects 501 for stripe-zero-auth (not yet implemented)", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/issue/start",
      payload: buildSignedStart("+1", { method: "stripe-zero-auth" }),
    });
    expect(r.statusCode).toBe(501);
  });
});

describe("/api/llm-promo/issue/complete", () => {
  it("mints a key on the right OTP and records the issuance", async () => {
    const { app, issuer, sms, ledger } = makeApp();
    const { ticket, otp } = await startAndGetOtp(app, sms, "+15555550100");
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/issue/complete",
      payload: buildSignedComplete(ticket, otp),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.key.keyId).toBe("gpu-1");
    expect(body.key.apiKey).toMatch(/^fp-/);
    expect(body.key.baseUrl).toMatch(/promo\.flagshipserver\.com/);
    expect(body.note).toMatch(/never see your prompts/i);
    expect(issuer.minted).toHaveLength(1);
    expect(ledger.alreadyIssuedTo(bytesToHex(harryIrk.publicKey))).toBe(true);
  });

  it("rejects the wrong OTP — and counts attempts toward the per-ticket cap", async () => {
    const { app, issuer, sms } = makeApp();
    const { ticket } = await startAndGetOtp(app, sms, "+15555550100");
    const wrong = await app.inject({
      method: "POST",
      url: "/api/llm-promo/issue/complete",
      payload: buildSignedComplete(ticket, "000000"),
    });
    expect(wrong.statusCode).toBe(403);
    expect(issuer.minted).toHaveLength(0);
  });

  it("rejects when the OTP plaintext doesn't match the signed otpHash (no swap-after-sign)", async () => {
    const { app, sms } = makeApp();
    const { ticket, otp } = await startAndGetOtp(app, sms, "+15555550100");
    const payload = buildSignedComplete(ticket, otp);
    payload.otp = "999999"; // different OTP than what we signed
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/issue/complete",
      payload,
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects a complete signed by a different IRK than the ticket owner", async () => {
    const { app, sms } = makeApp();
    const { ticket, otp } = await startAndGetOtp(app, sms, "+15555550100");
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/issue/complete",
      payload: buildSignedComplete(ticket, otp, { userId: "sarah" }, sarahIrk),
    });
    // Sarah's signature is valid for Sarah's userId, but the ticket was harry's.
    expect(r.statusCode).toBe(403);
  });

  it("locks out after MAX_OTP_ATTEMPTS bad attempts", async () => {
    const { app, sms } = makeApp();
    const { ticket } = await startAndGetOtp(app, sms, "+15555550100");
    let last;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({
        method: "POST",
        url: "/api/llm-promo/issue/complete",
        payload: buildSignedComplete(ticket, "000000"),
      });
    }
    expect(last!.statusCode).toBe(429);
  });
});

describe("InMemoryPromoLedger — identity dedup", () => {
  it("the same hashed identity (salted) cannot mint a second key under a different IRK", async () => {
    const ledger = new InMemoryPromoLedger();
    const { app, sms, issuer } = makeApp({ ledger });
    const phone = "+15555550100";

    // Harry issues first.
    const { ticket: t1, otp: o1 } = await startAndGetOtp(app, sms, phone);
    const c1 = await app.inject({
      method: "POST",
      url: "/api/llm-promo/issue/complete",
      payload: buildSignedComplete(t1, o1),
    });
    expect(c1.statusCode).toBe(200);
    expect(issuer.minted).toHaveLength(1);

    // Sarah tries with the same phone.
    const r = await app.inject({
      method: "POST",
      url: "/api/llm-promo/issue/start",
      payload: buildSignedStart(phone, { userId: "sarah" }, sarahIrk),
    });
    expect(r.statusCode).toBe(409);
    expect(issuer.minted).toHaveLength(1);
  });
});

describe("the proxy is gone", () => {
  it("/api/llm-promo/chat does not exist (404)", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "POST", url: "/api/llm-promo/chat", payload: {} });
    expect(r.statusCode).toBe(404);
  });

  it("/api/llm-promo/quota does not exist (404)", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "POST", url: "/api/llm-promo/quota", payload: {} });
    expect(r.statusCode).toBe(404);
  });
});
