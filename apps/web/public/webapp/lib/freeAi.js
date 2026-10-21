// Flagship Inference — for a limited time, building your apps is free on
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
import { rateLimitedError } from "./rateLimited.js";
import { ensureUsername, getSession } from "./state.js";

import { tr } from "./i18n.js";
export const FREE_AI_TAG = "flagship/llm-promo-issue/v1";

export const USED_UP_MESSAGE =
  tr("You've used this week's Flagship Inference credits. More arrive on Monday, or add your own AI key to keep building.");
export const UNAVAILABLE_MESSAGE = tr("Flagship Inference isn't available right now. You can add your own AI key.");
export const BUSY_TODAY_MESSAGE = tr("Flagship Inference is busy today. Try again tomorrow, or use your own AI key.");
export const NO_SERVER_MESSAGE = tr("Flagship Inference starts once one of your servers is running.");
export const ENDED_MESSAGE = tr("The free building period has ended — use your own AI key.");
export const CARD_NOTE = tr("Used automatically when you build with AI and haven't added your own key.");
export const TOO_LONG_MESSAGE =
  tr("This build is too big for Flagship Inference. Try a smaller change, or use your own AI key.");

// Free AI is listed as a built-in provider: always first, never removable.
export const PROVIDER_TITLE = tr("Flagship Inference");
export const PROVIDER_SUBTITLE = tr("We use third-party providers and anonymize your requests.");
export const BUILT_IN_LABEL = tr("Flagship Inference, built-in provider. It can't be removed.");

const MESSAGE_BY_CODE = {
  "free-ai-used-up": USED_UP_MESSAGE,
  "free-ai-busy-today": BUSY_TODAY_MESSAGE,
  "free-ai-no-server": NO_SERVER_MESSAGE,
  "free-ai-ended": ENDED_MESSAGE,
  "free-ai-unavailable": UNAVAILABLE_MESSAGE,
  "free-ai-too-long": TOO_LONG_MESSAGE,
};

// One credit is 1,000 weighted tokens (input × 1 + output × 4). `.com` sends
// the credit numbers; an older `.com` sends only tokens, converted here.
export const TOKENS_PER_CREDIT = 1000;

const whole = (n) => Math.max(0, Math.floor(Number(n) || 0));
const perCredit = (c) => (Number(c?.tokensPerCredit) > 0 ? Number(c.tokensPerCredit) : TOKENS_PER_CREDIT);

/** This week's and the starter reserve's credits left, together. */
export function creditsLeft(c) {
  if (Number.isFinite(c?.remainingCredits)) return whole(c.remainingCredits);
  return whole(whole(c?.remainingTokens) / perCredit(c));
}

/** The weekly top-up in credits, or null when `.com` doesn't say. */
export function weeklyCredits(c) {
  if (Number.isFinite(c?.weeklyCredits)) return whole(c.weeklyCredits);
  if (c?.week) return whole(whole(c.week.allowance) / perCredit(c));
  return null;
}

/** A whole number with the locale's thousands separators: 1840 → "1,840". */
export function formatCredits(n, locale) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(whole(n));
}

/**
 * "1,840 free credits left · 500 added each week". The only place that says
 * "free", so it can go when the promotion ends.
 */
export function creditsLine(credits, locale) {
  const left = tr("{0} free credits left", formatCredits(creditsLeft(credits), locale));
  const weekly = weeklyCredits(credits);
  return weekly === null ? left : tr("{0} · {1} added each week", left, formatCredits(weekly, locale));
}

/**
 * What to show for a status read: null when free AI is hidden (the status
 * couldn't be read, or the promotion has ended); else `{ usable, text,
 * offerOwnKey }`.
 */
export function freeAiView(status) {
  if (!status || status.ended) return null;
  if (status.rateLimited) return { usable: false, text: status.message, offerOwnKey: true };
  if (!status.available) return { usable: false, text: UNAVAILABLE_MESSAGE, offerOwnKey: true };
  if (status.reason) {
    return { usable: false, text: status.message || MESSAGE_BY_CODE[`free-ai-${status.reason}`] || UNAVAILABLE_MESSAGE, offerOwnKey: status.reason !== "no-server" };
  }
  if ((status.credits?.remainingTokens ?? 0) <= 0) return { usable: false, text: USED_UP_MESSAGE, offerOwnKey: true };
  return { usable: true, text: creditsLine(status.credits), offerOwnKey: false };
}

/**
 * The Flagship Inference entry for a status read. Never null: the entry is
 * always listed, disabled with the reason when it can't be used (unreadable
 * status, or the promotion has ended).
 */
export function freeAiEntryView(status) {
  if (!status) return { usable: false, text: UNAVAILABLE_MESSAGE, offerOwnKey: true };
  if (status.ended) return { usable: false, text: ENDED_MESSAGE, offerOwnKey: true };
  return freeAiView(status);
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

async function signedBody(serverFqdn, { askForUsername = true } = {}) {
  const session = getSession();
  if (!session.umk) throw Object.assign(new Error(tr("Unlock first")), { code: "locked" });
  const username = askForUsername ? await ensureUsername() : session.username;
  if (!username) throw Object.assign(new Error(tr("No username yet")), { code: "no-username" });
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
  return { status: r.status, ok: r.ok, body: json, retryAfter: r.headers?.get?.("retry-after") ?? null };
}

/**
 * `{ available, credits }`, or null when it can't be read. Settings and the
 * AI-key step read it on their own, so it never asks for a username: an
 * account without one yet sees the entry as unavailable. When
 * flagshipserver.com rate-limits the read, `{ rateLimited: true, message }`
 * says when to try again.
 */
export async function fetchFreeAiStatus() {
  try {
    const r = await post("/api/free-ai/status", await signedBody("", { askForUsername: false }));
    const limited = rateLimitedError(r.status, r.body, r.retryAfter);
    if (limited) return rateLimitedStatus(limited);
    if (!r.ok || !r.body?.credits) return null;
    return {
      available: r.body.available === true,
      ended: r.body.ended === true,
      reason: r.body.reason ?? null,
      message: r.body.message ?? null,
      credits: r.body.credits,
    };
  } catch (e) {
    return e?.rateLimited ? rateLimitedStatus(e) : null;
  }
}

function rateLimitedStatus(e) {
  return { available: false, ended: false, rateLimited: true, reason: null, message: e.message, credits: null };
}

/**
 * Mint a pass for a build on `serverFqdn`. Resolves to the credential the
 * box takes (with `model` alongside, which the box ignores inside the
 * credential and the start request carries) and the account's credits.
 * Rejects with `.code` ("free-ai-used-up", "free-ai-busy-today",
 * "free-ai-no-server", "free-ai-ended", "free-ai-unavailable" or
 * "rate-limited") and the message to show.
 */
export async function mintFreeAiCredential(serverFqdn) {
  const r = await post("/api/free-ai/token", await signedBody(serverFqdn));
  if (r.ok && r.body?.credential) {
    return { credential: { ...r.body.credential, model: r.body.model }, credits: r.body.credits };
  }
  const limited = rateLimitedError(r.status, r.body, r.retryAfter);
  if (limited) throw limited;
  const code = r.body?.code || (r.status === 429 ? "free-ai-used-up" : "free-ai-unavailable");
  const own = typeof r.body?.error === "string" && r.body.error.trim() ? r.body.error.trim() : null;
  const message = own ?? MESSAGE_BY_CODE[code] ?? UNAVAILABLE_MESSAGE;
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
