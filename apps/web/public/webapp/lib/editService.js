// "Edit this service": change an installed service's code, by describing the
// change to the AI chat or from the owner's own IDE. Either way the new
// version replaces the running one in place (same address, same data). The
// copy and the reading of the box's refusals live here so the views stay thin.
//
// MIRRORS: iOS EditServiceScreens.swift (EditStartRefusal), Android
// EditServiceScreens.kt.

import { humanError } from "./humanError.js";

import { tr } from "./i18n.js";
/** The slug half of a `<creator>--<slug>` service id. */
export function serviceSlug(serviceId) {
  const s = String(serviceId ?? "");
  const i = s.indexOf("--");
  return i >= 0 ? s.slice(i + 2) : s;
}

export const EDIT_ROW_TITLE = tr("Edit this service");
export const EDIT_ROW_CAPTION = tr("Change it with AI, or in your own editor");

export function editTitle(name) {
  return tr("Edit {0}", name);
}

export const AI_OPTION = {
  title: tr("Describe the change"),
  subtitle: tr("Tell the AI what to change. It starts from the current code."),
};

export const IDE_OPTION = {
  title: tr("Use your IDE"),
  subtitle: tr("Connect Cursor, Cline or another editor and change it with your own AI."),
};

export const REPLACE_NOTE =
  tr("The new version replaces the one running now. Its address, data and the people who can open it stay the same.");

export const PROMPT_LABEL = tr("What should change?");
export const PROMPT_HINT = tr("For example: \"Add a due date to each item and sort by it.\"");

export function canStart(prompt, starting) {
  return !starting && String(prompt ?? "").trim().length > 0;
}

/** The "Connect your IDE" intro when the IDE changes an installed service. */
export function ideEditIntro(name) {
  return tr("Your editor's agent changes {0} on your server, starting from its current code, using your own AI subscription. Deploying from the IDE replaces the running version; its address and data stay the same.", name);
}

const TOO_BIG_FALLBACK = tr("This service is too big to change in the AI chat. Use your IDE instead.");

/**
 * Why the box wouldn't start an edit session, from the error `screensFetch`
 * threw: another session is already changing it (409 kind "session"), too
 * much code for the chat (413, the IDE route can take it), or anything else.
 */
export function editRefusal(e) {
  const body = e && typeof e.body === "object" && e.body !== null ? e.body : null;
  if (e?.status === 409 && body?.ok === false && body.kind === "session") return { kind: "session" };
  const msg = typeof body?.error === "string" && body.error ? body.error : null;
  if (e?.status === 413) return { kind: "tooBig", message: msg ?? TOO_BIG_FALLBACK };
  if (msg) return { kind: "other", message: msg };
  return { kind: "other", message: humanError(e) };
}

export function refusalTitle(r) {
  switch (r?.kind) {
    case "session": return tr("Already being changed");
    case "tooBig": return tr("Too big for the AI chat");
    default: return tr("Couldn't start");
  }
}

export function refusalMessage(r, name) {
  if (r?.kind === "session") {
    return tr("A build session is already changing {0}. Open it from Build sessions, or discard it there to start over.", name);
  }
  return r?.message ?? "";
}
