// Free AI credits — for a limited time, building your apps is free on
// Flagship (docs/build-modes.md). A weekly top-up is spent first, then a
// one-time starter reserve; only accounts with a running server get them.
//
// The account signs a `flagship/llm-promo-issue/v1` request (provider
// "flagship") and flagshipserver.com answers with a short-lived pass for
// Flagship's metered AI endpoint. The pass goes to the box like any other
// AI key, marked `source: "promo"`; prompts go box → relay → the endpoint,
// never through flagshipserver.com. A fresh pass is minted for each build
// and each reply (they last 12 hours), and nothing is counted until the
// model is actually used.
//
// MIRRORS: iOS FreeAiModels.swift + FreeAiCredits.swift, Android core/FreeAiCredits.kt.

import { bytesToHex, signWithIrk } from "../keystore.js";
import { controlApex } from "./apex.js";
import { ensureUsername, getSession } from "./state.js";

export const FREE_AI_TAG = "flagship/llm-promo-issue/v1";

export const USED_UP_MESSAGE =
  "Your free AI credits for this week are used up. More arrive on Monday, or add your own AI key to keep building.";
export const UNAVAILABLE_MESSAGE = "Free AI credits aren't available right now. You can add your own AI key.";
export const BUSY_TODAY_MESSAGE = "Free building is busy today. Try again tomorrow, or use your own AI key.";
export const NO_SERVER_MESSAGE = "Free AI credits start once one of your servers is running.";
export const ENDED_MESSAGE = "The free building period has ended — use your own AI key.";
export const CARD_NOTE = "Used automatically when you build with AI and haven't added your own key.";

const MESSAGE_BY_CODE = {
  "free-ai-used-up": USED_UP_MESSAGE,
  "free-ai-busy-today": BUSY_TODAY_MESSAGE,
  "free-ai-no-server": NO_SERVER_MESSAGE,
  "free-ai-ended": ENDED_MESSAGE,
  "free-ai-unavailable": UNAVAILABLE_MESSAGE,
};

/** 820000 → "820k", 1000000 → "1M", 1500000 → "1.5M". */
export function formatTokens(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "This week: 340k of 500k left · Starter reserve: 1.2M". */
export function creditsLine(credits) {
  if (!credits?.week || !credits?.starter) {
    return `${formatTokens(credits?.remainingTokens)} of ${formatTokens(credits?.allowanceTokens)} free AI tokens left`;
  }
  return `This week: ${formatTokens(credits.week.remaining)} of ${formatTokens(credits.week.allowance)} left · Starter reserve: ${formatTokens(credits.starter.remaining)}`;
}

/**
 * What to show for a status read: null when free AI is hidden (the status
 * couldn't be read, or the promotion has ended); else `{ usable, text,
 * offerOwnKey }`.
 */
export function freeAiView(status) {
  if (!status || status.ended) return null;
  if (!status.available) return { usable: false, text: UNAVAILABLE_MESSAGE, offerOwnKey: true };
  if (status.reason) {
    return { usable: false, text: MESSAGE_BY_CODE[`free-ai-${status.reason}`] ?? status.message ?? UNAVAILABLE_MESSAGE, offerOwnKey: status.reason !== "no-server" };
  }
  if ((status.credits?.remainingTokens ?? 0) <= 0) return { usable: false, text: USED_UP_MESSAGE, offerOwnKey: true };
  return { usable: true, text: creditsLine(status.credits), offerOwnKey: false };
}

/** The canonical bytes the account signs (vectors: packages/protocol/test-vectors/llm-promo-issue). */
export function canonicalFor(request) {
  return [
    FREE_AI_TAG,
    request.username,
    request.serverFqdn,
    request.provider,
    request.desiredDailyInputTokenCap,
    request.desiredDailyOutputTokenCap,
    request.issuedAt,
  ].join("|");
}

async function signedBody(serverFqdn) {
  const session = getSession();
  if (!session.umk) throw Object.assign(new Error("Unlock first"), { code: "locked" });
  const username = await ensureUsername();
  const request = {
    username,
    serverFqdn: serverFqdn || "",
    provider: "flagship",
    desiredDailyInputTokenCap: 0,
    desiredDailyOutputTokenCap: 0,
    issuedAt: Date.now(),
  };
  const sig = await signWithIrk(session.umk, new TextEncoder().encode(canonicalFor(request)));
  return { request, signature: bytesToHex(sig) };
}

async function post(path, body) {
  const r = await fetch(`${controlApex()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return { status: r.status, ok: r.ok, body: json };
}

/** `{ available, credits }`, or null when it can't be read. */
export async function fetchFreeAiStatus() {
  try {
    const r = await post("/api/free-ai/status", await signedBody(""));
    if (!r.ok || !r.body?.credits) return null;
    return {
      available: r.body.available === true,
      ended: r.body.ended === true,
      reason: r.body.reason ?? null,
      message: r.body.message ?? null,
      credits: r.body.credits,
    };
  } catch {
    return null;
  }
}

/**
 * Mint a pass for a build on `serverFqdn`. Resolves to the credential the
 * box takes (with `model` alongside, which the box ignores inside the
 * credential and the start request carries) and the account's credits.
 * Rejects with `.code` ("free-ai-used-up", "free-ai-busy-today",
 * "free-ai-no-server", "free-ai-ended" or "free-ai-unavailable") and the
 * message to show.
 */
export async function mintFreeAiCredential(serverFqdn) {
  const r = await post("/api/free-ai/token", await signedBody(serverFqdn));
  if (r.ok && r.body?.credential) {
    return { credential: { ...r.body.credential, model: r.body.model }, credits: r.body.credits };
  }
  const code = r.body?.code || (r.status === 429 ? "free-ai-used-up" : "free-ai-unavailable");
  const message = MESSAGE_BY_CODE[code] ?? UNAVAILABLE_MESSAGE;
  throw Object.assign(new Error(message), { code, status: r.status, credits: r.body?.credits ?? null });
}

/** Whether a credential is a free AI pass. */
export function isFreeAiCredential(c) {
  return !!c && c.source === "promo" && c.provider === "flagship";
}

/** A free AI pass is swapped for a fresh one; any other credential is returned as is. */
export async function freshCredential(c, serverFqdn) {
  if (!isFreeAiCredential(c)) return c;
  return (await mintFreeAiCredential(serverFqdn)).credential;
}
