// What the Messages tab, a thread and the page editor share while the account is unlocked: the published page, the
// pending changes (drafts in the `.com` lane and this device's own), the Messages state blob and the opened inbox.
// Held in memory only and dropped when the session locks (docs/voici-and-messages.md §10).

import {
  emptyMessagesState,
  forgetConversation,
  voiciPseudonymCode,
} from "./voiciProtocol.js";
import { forgetPlacedCalls } from "./voiciCallOut.js";
import {
  isRequest,
  isUnread,
  loadDraftOps,
  loadInbox,
  loadMessagesState,
  loadMissedCalls,
  loadPublishedPage,
  postConversationDelete,
  updateMessagesState,
} from "./voiciOwner.js";
import { getSession, onSessionLock } from "./state.js";
import { getActiveProfile } from "./profiles.js";
import { isDemoProfile } from "./demoAccount.js";
import { tr } from "./i18n.js";
import { clearRemovedSnapshot, loadRemovedSnapshot } from "./voiciPagePublic.js";

function fresh() {
  return {
    page: null,
    /** The page the owner removed, as this device kept it (voiciPagePublic.js), while it isn't public. */
    removed: null,
    pageLoaded: false,
    pageError: null,
    drafts: [],
    localOps: [],
    state: emptyMessagesState(),
    version: 0,
    stateLoaded: false,
    conversations: [],
    inboxError: null,
    /** Missed voi.ci calls (docs/voici-calls.md §6), opened and checked; the webapp never answers a call. */
    missedCalls: [],
    /** Blocked anonymous callers' conversations (the owner's anon-block orders). */
    anonBlocks: [],
    /** A sample account: its page is the operator's example, read and shown, never changed (no drafts, no inbox). */
    sample: false,
  };
}

export const world = fresh();
const listeners = new Set();

onSessionLock(() => Object.assign(world, fresh()));

/** Calls `fn` after every refresh or state change (the tab badge listens). */
export function onWorldChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitWorld() {
  for (const fn of listeners) {
    try {
      fn(world);
    } catch {
      /* a listener never breaks the others */
    }
  }
}

/**
 * Reads the page, the pending drafts, the state and (when the page exists) the inbox. Each part fails alone. A sample
 * account reads only its public page (the operator's example, docs/sample-users.md): this device holds none of its
 * keys, so nothing else is read and nothing is ever signed.
 */
export async function refreshWorld(deps = {}) {
  if (deps.sample ?? isDemoProfile(getActiveProfile())) return refreshSamplePage(deps);
  world.sample = false;
  if (!(getSession()?.umk instanceof Uint8Array)) return world;
  const [page, drafts, st] = await Promise.allSettled([
    (deps.loadPublishedPage ?? loadPublishedPage)(String(getSession().username ?? "").toLowerCase(), deps),
    (deps.loadDraftOps ?? loadDraftOps)(deps),
    (deps.loadMessagesState ?? loadMessagesState)(deps),
  ]);
  if (page.status === "fulfilled") {
    world.page = page.value;
    world.pageError = null;
    const u = String(getSession().username ?? "").toLowerCase();
    if (world.page) {
      clearRemovedSnapshot(u);
      world.removed = null;
    } else world.removed = loadRemovedSnapshot(u);
  } else world.pageError = page.reason;
  world.pageLoaded = true;
  if (drafts.status === "fulfilled") world.drafts = drafts.value;
  if (st.status === "fulfilled") {
    world.state = st.value.state;
    world.version = st.value.version;
    world.stateLoaded = true;
    applyForgotten(deps);
  }
  if (world.page) {
    try {
      const inbox = await (deps.loadInbox ?? loadInbox)(world.page, deps);
      world.conversations = inbox.conversations;
      world.anonBlocks = inbox.anonBlocks ?? [];
      world.inboxError = null;
    } catch (e) {
      world.inboxError = e;
    }
    try {
      world.missedCalls = (await (deps.loadMissedCalls ?? loadMissedCalls)(world.page, deps)).calls;
    } catch {
      /* calls off or unreachable: the conversations still show */
    }
  }
  emitWorld();
  return world;
}

/** A sample account's read: the public page, checked against the account's own key like any other page. */
async function refreshSamplePage(deps) {
  const u = String(getSession()?.username ?? "").toLowerCase();
  world.sample = true;
  if (!u) return world;
  try {
    world.page = await (deps.loadPublishedPage ?? loadPublishedPage)(u, deps);
    world.pageError = null;
  } catch (e) {
    world.pageError = e;
  }
  world.pageLoaded = true;
  emitWorld();
  return world;
}

/** Writes a change to the state blob (merging on conflict) and keeps the result. */
export async function changeState(fn, deps = {}) {
  const out = await (deps.updateMessagesState ?? updateMessagesState)(fn, { ...deps, current: world.stateLoaded ? { state: world.state, version: world.version } : undefined });
  world.state = out.state;
  world.version = out.version;
  world.stateLoaded = true;
  applyForgotten(deps);
  emitWorld();
  return out;
}

/** Another device's deletes reach what this browser keeps by itself: its placed calls (docs/voici-and-messages.md §10.1.1). */
function applyForgotten(deps) {
  try {
    (deps.forgetPlacedCalls ?? forgetPlacedCalls)(world.state.forgotten ?? {}, deps);
  } catch {
    /* the history is a courtesy */
  }
}

/**
 * Delete = forget (docs/voici-calls.md, docs/voici-and-messages.md §10.1.1), after `.com` dropped the conversation: the
 * synced state loses its accepted mark, archived flag, read mark, nickname and block and gains the marker that makes
 * the owner's other devices drop theirs; the conversation and its missed calls leave this browser's view at once.
 */
export async function forgetConversationEverywhere(cv, deps = {}) {
  await changeState((s) => forgetConversation(s, cv.conv, cv.pseudonymPub ?? null, (deps.now ?? Date.now)()), deps);
  world.conversations = world.conversations.filter((x) => x.conv !== cv.conv);
  world.missedCalls = world.missedCalls.filter((m) => m.conv !== cv.conv);
  emitWorld();
}

/**
 * The owner's delete, gated: the person confirms it's them (`confirm`, by default lib/freshUnlock.js
 * confirmUserForDelete: a passkey assertion, else this device's passphrase); only then is the signed delete sent and
 * the conversation forgotten. A cancelled or failed check deletes nothing and sends nothing. Resolves
 * `{ok: true}`, `{ok: false, cancelled: true}` or `{ok: false, error}`; a refused send throws.
 */
export async function deleteConversationGated(cv, deps = {}) {
  const confirm =
    deps.confirm ??
    (async () =>
      (await import("./freshUnlock.js")).confirmUserForDelete({
        title: tr("Delete this conversation?"),
        message: tr("It goes from all your devices and from Flagship."),
        okLabel: tr("Delete"),
      }));
  const gate = await confirm();
  if (!gate?.ok) return gate?.cancelled ? { ok: false, cancelled: true } : { ok: false, error: gate?.error ?? null };
  await (deps.post ?? postConversationDelete)(deps.page ?? world.page, cv.conv);
  await forgetConversationEverywhere(cv, deps);
  return { ok: true };
}

/** Every pending change: the drafts lane's, then this device's own not yet handed over or published. */
export function pendingOps() {
  const seen = new Set();
  const out = [];
  for (const op of [...world.drafts.map((d) => d.op), ...world.localOps]) {
    if (seen.has(op.opId)) continue;
    seen.add(op.opId);
    out.push(op);
  }
  return out;
}

/** The name the owner sees for a visitor: their nickname, else "Visitor 4F3A" (never text the visitor chose). */
export function visitorName(pseudonymPub) {
  const n = world.state.nicknames[pseudonymPub];
  return n?.name ?? tr("Visitor {0}", voiciPseudonymCode(pseudonymPub));
}

/** The conversations the list shows: not blocked, not deleted. */
export function visibleConversations() {
  return world.conversations.filter((cv) => !world.state.blocks.includes(cv.pseudonymPub) && !world.state.archived.includes(cv.conv));
}

export function conversationsIn(segment) {
  return visibleConversations().filter((cv) => (segment === "requests") === isRequest(cv, world.state));
}

export function unreadCount() {
  return visibleConversations().filter((cv) => isUnread(cv, world.state)).length;
}

export function findConversation(conv) {
  return world.conversations.find((cv) => cv.conv === conv) ?? null;
}
