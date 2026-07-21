/**
 * Discriminated union of every daemon→phone event the AlertInbox carries.
 *
 * The phone-paired-session HTTP poll drains AlertInbox; each module that
 * generates events declares its own alert variants (BrowserAlert here,
 * PhoneUpdateAlert in updateClient.ts, etc.) and they get unioned into
 * `PhoneAlert` so AlertInbox stays feature-agnostic.
 *
 * Every variant carries `kind: <discriminator>` and `serviceId` (so dedup
 * + filtering work uniformly across features).
 */

import type { PhoneUpdateAlert } from "./updateClient.js";

/**
 * Alerts emitted by the browser feature when the daemon needs the
 * phone to provide input (a password into a focused field, an OTP
 * into a 2FA prompt, etc.).
 *
 * `screenshotRef` is an opaque key the daemon hands the phone; the
 * phone fetches the screenshot bytes via a separate authenticated
 * endpoint. Keeping the bytes out of the alert payload itself bounds
 * the inbox memory footprint and lets us evict screenshots on a
 * different schedule from the alerts themselves.
 */
export type BrowserAlert = {
  kind: "browser-input-needed";
  serviceId: string;
  /** The CDP target id the input is destined for. Validated on response. */
  tabId: string;
  /** The host the user is signing into — surfaced to the phone for context ("Sign in to amazon.com"). */
  domain: string;
  /** What kind of input the page wants. Drives the phone-side UI. */
  inputKind: "password" | "otp" | "text";
  /** Opaque ref the phone uses to GET /api/browser/screenshot/<ref>. */
  screenshotRef: string;
};

/**
 * Per-app summary surfaced after a J.3 re-pair swap so the phone can
 * walk the user through "we re-anchored your membership in <app> from
 * the old IRK to the new one". One alert per installed app.
 *
 * The IRK hex prefixes (12 chars of SHA-256 over each pubkey) are
 * surfaced for UI display only — they never leak the full pubkey and
 * give the user enough to distinguish multiple in-flight swaps.
 */
export type ReissuanceAlert = {
  kind: "membership-reissued";
  /** App composite id (`<creator>-<slug>`). */
  serviceId: string;
  /** Display slug for the UI. */
  slug: string;
  /** Rows we rewrote from old → new IRK in this app. */
  rewrittenCount: number;
  /** SHA-256 prefix (first 12 hex chars) of the previous IRK pubkey. */
  oldIrkPrefix: string;
  /** SHA-256 prefix (first 12 hex chars) of the new IRK pubkey. */
  newIrkPrefix: string;
  /** Unix-ms when the per-app walk completed. */
  completedAt: number;
  /** Latest time the user can undo the rewrite (7-day default). */
  undoWindowExpiresAt: number;
};

/**
 * #91 — the AI build chat (vibe-code) paused and is waiting on the owner.
 * Emitted on the streaming → awaiting-tool-response transition (the same
 * point the W10 `notifyOwner` push-relay hook fires). The phone-paired
 * foreground poll drains this from the AlertInbox, raises an app-initiated
 * LOCAL notification, and surfaces the session in the global operations
 * sliver with a deep link into the chat.
 *
 * Value-free by construction — it carries ONLY the session id (here as the
 * uniform `serviceId` so dedup + filtering work like every other variant),
 * the pending tool kind, and the tool-use id. No model output, no env-var
 * value, no chat text. The phone fetches the human-readable pending request
 * (the question / the env-var name) over the paired-session BFF when the
 * owner opens the chat.
 */
export type AiChatAlert = {
  kind: "ai-chat-needs-you";
  /** The vibe-code session id, carried as `serviceId` for uniform dedup. */
  serviceId: string;
  /** What the AI is waiting on — drives the notification copy + chat UI. */
  request: "requestEnvVar" | "talkToUser";
  /** The pending tool-use id (matched when the owner replies). */
  toolUseId: string;
};

export type PhoneAlert =
  | PhoneUpdateAlert
  | BrowserAlert
  | ReissuanceAlert
  | AiChatAlert;
