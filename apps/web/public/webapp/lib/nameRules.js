// The voi.ci namespace format (docs/voici-namespace-spec.md D12), for usernames and custom link names alike:
// 3 to 63 characters, a-z 0-9 and -, no leading, trailing or double hyphen; a name may start with a digit. It mirrors
// packages/protocol/src/voiciName.ts byte for byte (pinned by packages/protocol/test-vectors/voici-name/vectors.json);
// `.com`'s names registry stays the authority on what is taken. No imports but i18n, so state.js can use it too.

import { tr } from "./i18n.js";

export const VOICI_NAME_MIN = 3;
export const VOICI_NAME_MAX = 63;

/** What a client can check alone: "characters" | "hyphens" | "too-short" | "too-long" | null (on the lower-cased input). */
export function voiciNameProblem(typed) {
  const name = String(typed).toLowerCase();
  if (!/^[a-z0-9-]*$/.test(name)) return "characters";
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) return "hyphens";
  if (name.length < VOICI_NAME_MIN) return "too-short";
  if (name.length > VOICI_NAME_MAX) return "too-long";
  return null;
}

/** The safety key: lower case, hyphens removed, 0 read as o and 1 as l (D9). */
export function voiciNameKey(typed) {
  return String(typed).toLowerCase().replace(/-/g, "").replace(/0/g, "o").replace(/1/g, "l");
}

/** True when `name` is already lower case and meets the format. */
export function isValidName(name) {
  return typeof name === "string" && name === name.toLowerCase() && voiciNameProblem(name) === null;
}

/** The sentence for a format problem (the same words on every platform). */
export function nameProblemText(problem) {
  switch (problem) {
    case "too-short":
      return tr("At least 3 characters");
    case "too-long":
      return tr("At most 63 characters");
    case "hyphens":
      return tr("No hyphen at the start or end, or two in a row");
    default:
      return tr("Letters, numbers and hyphens only");
  }
}

/** The one refusal for a name that is taken, reserved, held, or a look-alike of one (D9). */
export function nameTakenText() {
  return tr("Taken or too similar to an existing name");
}

/** The sentence for a `.com` refusal of a name claim (`{code, problem}`), or null when it is not one. */
export function nameRefusalText(body) {
  if (!body || typeof body !== "object") return null;
  if (body.code === "taken" || body.code === "reserved") return nameTakenText();
  if (body.code === "invalid") return nameProblemText(body.problem);
  return null;
}
