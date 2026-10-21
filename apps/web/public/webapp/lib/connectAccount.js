// "Connect to an existing account": one page, two ways in. The account-name
// field signs in (resolve → recovery / demo); the code field joins through the
// pairing relay. Same rules as iOS ConnectInput and Android ConnectInput.
// Pure: no DOM, no network.

import { parseJoinLink } from "./crossDevicePairing.js";

import { tr } from "./i18n.js";
export const CONNECT_TITLE = tr("Connect to an existing account");
export const CONNECT_NAME_HEADING = tr("Sign in with your account name");
export const CONNECT_NAME_HELPER = tr("The name you picked when you made the account.");
export const CONNECT_PAIR_HEADING = tr("Join with a pairing code");
export const CONNECT_PAIR_HELPER =
  tr("On a device of that account, open Settings → Trusted devices → Add device.");
export const CONNECT_ROUTED_TO_JOIN = tr("That's a pairing link, so we're joining with it.");
export const CONNECT_NOT_A_CODE =
  tr("That isn't a pairing code. Paste the whole link from the other device, or scan its code.");
export const CONNECT_NAME_IN_CODE =
  tr("That looks like an account name. Type it under Sign in with your account name.");
export const CONNECT_BAD_LINK =
  tr("That link isn't a pairing link. Ask the other device to show a new code.");

/** What a typed or pasted value is.
 *  @param {string} text
 *  @returns {{ kind: "empty" } | { kind: "pairing", link: string } | { kind: "name", name: string } | { kind: "bad-link" }}
 */
export function classifyConnectInput(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { kind: "empty" };
  if (parseJoinLink(raw)) return { kind: "pairing", link: raw };
  if (looksLikeLink(raw)) return { kind: "bad-link" };
  return { kind: "name", name: raw.replace(/^@/, "").toLowerCase() };
}

/** The account-name field: a pasted pairing link goes to join with a note. */
export function readNameField(text) {
  const c = classifyConnectInput(text);
  if (c.kind === "pairing") return { action: "join", link: c.link, note: CONNECT_ROUTED_TO_JOIN };
  if (c.kind === "bad-link") return { action: "error", error: CONNECT_BAD_LINK };
  if (c.kind === "empty") return { action: "none" };
  return { action: "sign-in", name: c.name };
}

/** The pairing field: only a pairing link or bare `sid=…&pk=…` code joins. */
export function readPairingField(text) {
  const c = classifyConnectInput(text);
  if (c.kind === "pairing") return { action: "join", link: c.link };
  if (c.kind === "empty") return { action: "none" };
  if (c.kind === "name" && /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(c.name)) {
    return { action: "error", error: CONNECT_NAME_IN_CODE };
  }
  if (c.kind === "bad-link") return { action: "error", error: CONNECT_BAD_LINK };
  return { action: "error", error: CONNECT_NOT_A_CODE };
}

function looksLikeLink(raw) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.includes("/join") || /(^|[?&])(sid|pk)=/.test(raw);
}
