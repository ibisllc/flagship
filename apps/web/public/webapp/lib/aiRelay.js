// The per-key Flagship relay: AI calls leave the box through the Flagship hub
// so the provider sees Flagship's address, not the owner's. On by default.
// docs/ai-privacy-and-staging.md §4.
import { tr } from "./i18n.js";

export const RELAY_LABEL = tr("Send through the Flagship relay");
export const RELAY_NOTE = tr("Better for your anonymity: the AI provider sees Flagship's address, not yours.");
export const RELAY_ON_CAPTION = tr("Through the Flagship relay");
export const RELAY_OFF_CAPTION = tr("Direct");
export const TURN_RELAY_OFF = tr("Turn the relay off for this key");
export const RELAY_TURNED_OFF = tr("The relay is off for this key.");

/** The key list's row caption. */
export function relayCaption(relay) {
  return relay === false ? RELAY_OFF_CAPTION : RELAY_ON_CAPTION;
}

/**
 * Whether a failure is the box refusing to call the provider because the
 * relay couldn't carry it ("the Flagship relay isn't reachable, so the AI
 * call wasn't sent", "the Flagship relay didn't connect to <host> because …",
 * or the streaming outcome reason `relay-unavailable`). The message is shown
 * as it is; this only decides whether to offer turning the relay off.
 */
export function isRelayFailure(reason) {
  const r = String(reason ?? "");
  return (
    r === "relay-unavailable" ||
    r.includes("the Flagship relay isn't reachable") ||
    r.includes("the Flagship relay didn't connect to")
  );
}
