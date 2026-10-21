// The describe form's name check and copy: a new build's name is its web
// address, and the box keeps it unique across installed services and open
// build sessions. The form asks as the owner types; start refuses a taken
// name with a 409 carrying the same body.
//
// MIRRORS: iOS VibeCodeDescribeScreen + VibeCodeNameCheck, Android
// VibeCodeDescribe.
import { tr } from "./i18n.js";

export const INVITE_ONLY = "just-me";
export const ANYONE_WITH_LINK = "link";

export const VISIBILITIES = [
  { value: INVITE_ONLY, label: tr("Invite only") },
  { value: ANYONE_WITH_LINK, label: tr("Anyone with the link") },
];

export function visibilityExplanation(value) {
  return value === ANYONE_WITH_LINK
    ? tr("Anyone with the address can open it. Where it needs to know who someone is, they sign in with Flagship.")
    : tr("Only you and the people you invite on Flagship can open it.");
}

export const EXAMPLES = [
  { label: tr("Habit tracker"), text: tr("A habit tracker: I tick off my daily habits and see my streaks for the last month.") },
  { label: tr("Family wishlist"), text: tr("A family wishlist: everyone keeps a list, and the others can quietly mark what they'll buy.") },
  { label: tr("Recipe jar"), text: tr("A recipe jar: save recipes with a photo, ingredients and steps, and search them by ingredient.") },
  { label: tr("Sleep journal"), text: tr("A sleep journal: log when I went to bed, when I woke up and how I slept, with a weekly chart.") },
];

export const CONFLICT_TITLE = tr("That name is taken");

/** The address label the box will serve at; the box is the authority. */
export function slugify(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "");
}

export function conflictMessage(check, name) {
  const n = check?.name ?? name;
  switch (check?.kind) {
    case "session":
      return tr("A build session already uses \"{0}\". To use the name for a new build, open Build sessions and discard that one first.", n);
    case "app":
      return tr("You already have a service called \"{0}\". Pick another name.", n);
    default:
      return check?.message ?? tr("Pick another name.");
  }
}

/** The red line under the name field, or null when there's nothing wrong. */
export function nameWarning(check, name) {
  if (!check || check.ok) return null;
  if (check.kind === "invalid") return check.message ?? tr("That can't be a web address.");
  return conflictMessage(check, name);
}

export function canBuild({ slug, prompt, check, starting }) {
  return Boolean(slug) && String(prompt ?? "").trim().length > 0 && check?.kind !== "invalid" && !starting;
}

/** A refused start, if `e` carries the box's 409 for a taken name. */
export function conflictFromError(e) {
  if (!e || e.status !== 409) return null;
  const body = e.body;
  if (!body || typeof body !== "object" || body.ok !== false) return null;
  return body;
}

/**
 * Ask the box whether `name` is free. A box too old to answer (404) or an
 * unreachable one reads as free: start and deploy still refuse a clash.
 */
export async function checkName({ baseUrl, token, name, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl || !token || !name) return { ok: true };
  try {
    const r = await fetchImpl(
      `${String(baseUrl).replace(/\/+$/, "")}/api/screens/vibe-code/name-check?name=${encodeURIComponent(name)}`,
      { headers: { "x-flagship-session": token } },
    );
    if (!r.ok) return { ok: true };
    const body = await r.json();
    return body && typeof body.ok === "boolean" ? body : { ok: true };
  } catch {
    return { ok: true };
  }
}
