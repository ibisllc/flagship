// The build sessions this device runs on Flagship Inference, and which AI key
// a reply in a build chat carries.
//
// A pass lasts 12 hours, so every reply in a free-AI build mints a fresh one.
// A chat reopened later (the build list, a notification) holds no key in
// memory: this list says the session runs on free AI, else the box says
// whether it still has a key (`needsCredential`), and only then does the
// reply carry the owner's saved key (or a pass when nothing is saved).
//
// MIRRORS: iOS FreeAiSessions + VibeCodeReplyCredential.

const KEY = "flagship.freeAi.sessions.v1";
const LIMIT = 50;

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(storage) {
  try {
    const ids = JSON.parse(storage?.getItem(KEY) ?? "[]");
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Remember that `sessionId` runs on Flagship Inference (the newest 50 are kept). */
export function markFreeAiSession(sessionId, storage) {
  const s = storageOf(storage);
  if (!s || !sessionId) return;
  const ids = read(s).filter((id) => id !== sessionId);
  ids.push(sessionId);
  try {
    s.setItem(KEY, JSON.stringify(ids.slice(-LIMIT)));
  } catch {
    // Storage full or blocked: the next reopen falls back to what the box says.
  }
}

export function isFreeAiSession(sessionId, storage) {
  return !!sessionId && read(storageOf(storage)).includes(sessionId);
}

/** What the model menu reads for a Flagship Inference session whose pass isn't in memory. */
export const FLAGSHIP_MENU_CREDENTIAL = Object.freeze({ provider: "flagship" });

/**
 * The credential the model menu is built for, matching what a reply will
 * carry: the one this chat holds, else Flagship Inference for a free-AI
 * session, else the owner's saved key, else (the box needing a key and none
 * saved) Flagship Inference.
 */
export async function menuCredential({ known = null, sessionId = null, boxNeedsKey = false, saved, isFree = isFreeAiSession }) {
  if (known) return known;
  if (isFree(sessionId)) return FLAGSHIP_MENU_CREDENTIAL;
  const key = (await saved?.()) ?? null;
  if (key) return key;
  return boxNeedsKey ? FLAGSHIP_MENU_CREDENTIAL : null;
}

/**
 * The key a reply carries, or null to let the box keep the one it holds.
 *   known      — the credential this chat started or was opened with
 *   boxNeedsKey — the box holds none for the session (or the relay setting changed)
 *   saved      — () => the owner's saved key, or null
 *   mintFree   — () => a fresh Flagship Inference pass
 * A free-AI refusal (used up, busy today, no server, ended) throws so the
 * owner sees it; "unavailable for now" sends nothing and the box keeps its pass.
 */
export async function replyCredential({
  known = null,
  sessionId = null,
  boxNeedsKey = false,
  saved,
  mintFree,
  isFree = isFreeAiSession,
  markFree = markFreeAiSession,
}) {
  const free = known ? known.source === "promo" && known.provider === "flagship" : isFree(sessionId);
  if (free) {
    try {
      return await mintFree();
    } catch (e) {
      if (e?.code === "free-ai-unavailable") return null;
      throw e;
    }
  }
  if (known) return known;
  if (!boxNeedsKey) return null;
  const key = (await saved?.()) ?? null;
  if (key) return key;
  const pass = await mintFree();
  markFree(sessionId);
  return pass;
}
