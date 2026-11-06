// What the Messages tab, a thread and the page editor share while the account is unlocked: the published page, the
// pending changes (drafts in the `.com` lane and this device's own), the Messages state blob and the opened inbox.
// Held in memory only and dropped when the session locks (docs/voici-and-messages.md §10).

import {
  emptyMessagesState,
  voiciPseudonymCode,
} from "./voiciProtocol.js";
import {
  isRequest,
  isUnread,
  loadDraftOps,
  loadInbox,
  loadMessagesState,
  loadPublishedPage,
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
  }
  if (world.page) {
    try {
      world.conversations = (await (deps.loadInbox ?? loadInbox)(world.page, deps)).conversations;
      world.inboxError = null;
    } catch (e) {
      world.inboxError = e;
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
  emitWorld();
  return out;
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
