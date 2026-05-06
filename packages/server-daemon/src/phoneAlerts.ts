/**
 * Discriminated union of every daemon→phone event the AlertInbox carries.
 *
 * The phone-paired-session HTTP poll drains AlertInbox; each module that
 * generates events declares its own alert variants (BrowserAlert here,
 * PhoneUpdateAlert in updateClient.ts, etc.) and they get unioned into
 * `PhoneAlert` so AlertInbox stays feature-agnostic.
 *
 * Every variant carries `kind: <discriminator>` and `appId` (so dedup
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
  appId: string;
  /** The CDP target id the input is destined for. Validated on response. */
  tabId: string;
  /** The host the user is signing into — surfaced to the phone for context ("Sign in to amazon.com"). */
  domain: string;
  /** What kind of input the page wants. Drives the phone-side UI. */
  inputKind: "password" | "otp" | "text";
  /** Opaque ref the phone uses to GET /api/browser/screenshot/<ref>. */
  screenshotRef: string;
};

export type PhoneAlert = PhoneUpdateAlert | BrowserAlert;
