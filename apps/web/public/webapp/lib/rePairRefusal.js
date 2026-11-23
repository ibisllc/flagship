// `.com`'s re-pair initiate refusals that carry a stable `code` (security report F3,
// packages/control-plane/src/rePair.ts `RePairRefusalCode`) as sentences. iOS
// `RePairRefusalText` and Android's `RePairRefusalText` word them the same.

import { tr } from "./i18n.js";

/** The sentence for a refusal body (`{ error, code }`), or null when it has no known code. */
export function rePairRefusalText(body) {
  switch (body?.code) {
    case "re-pair-vetoed-recently":
      return tr("An admin of this account rejected a recovery with this device less than a day ago. You can try again after a day, or ask the admin.");
    case "re-pair-replay":
    case "re-pair-cancelled-replay":
      return tr("This recovery request was already used. Start the recovery again.");
    case "re-pair-credential-used":
      return tr("That code was already used for a recovery. Wait for a new code, or repeat the recovery step, and try again.");
    case "re-pair-stale":
      return tr("This device's clock doesn't match Flagship's. Set the date and time to automatic, then try again.");
    default:
      return null;
  }
}

/** The same, from a body's text as `fetch` returned it. */
export function rePairRefusalTextOf(text) {
  try {
    return rePairRefusalText(JSON.parse(text));
  } catch {
    return null;
  }
}
