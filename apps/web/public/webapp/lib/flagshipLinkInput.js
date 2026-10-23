// Settings → "Scan a code or enter a link": what a scanned or pasted text is.
//
// The text goes through the same parser a tapped link or a camera scan uses,
// and lands on the same screen, so typing it is no weaker than scanning it:
// a pairing join still needs the 6-digit match code on both screens, a share
// its code, a transfer offer its signature and the typed server name, a
// sign-in link the box's own check. MIRRORS iOS ScanOrLinkScreen and Android
// ScanOrLinkScreen.

import { parseJoinLink } from "./crossDevicePairing.js";
import { parseAccessDeepLink } from "./serviceInvite.js";
import { parseShareLink } from "./serverShare.js";
import { parseTransferLink } from "./serverTransfer.js";

/** `{ kind, value }` for a Flagship link or code, or null. `kind` is one of
 *  "join" (add this browser to an account), "access" (sign a browser in to a
 *  private app), "share" (a server shared with you) or "transfer" (take over a
 *  server). */
export function classifyFlagshipLink(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  if (parseJoinLink(raw)) return { kind: "join", value: raw };
  const access = safe(() => parseAccessDeepLink(raw));
  if (access) return { kind: "access", value: raw };
  const share = safe(() => parseShareLink(raw));
  if (share) return { kind: "share", value: share };
  const offer = safe(() => parseTransferLink(raw));
  if (offer) return { kind: "transfer", value: offer };
  return null;
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
