// The page's changes and its Public switch, shared by the Messages header (the quick control), the page editor and
// Home (docs/voici-and-messages.md §3.3, §5, §11). Every edit is a draft op; an admin device publishes them with the
// editor's Publish bar, or at once when the owner changes the name or photo on the header of a public page. Only an
// admin device signs the page; a sample account's device never holds the key that does (§3.3), so it can't publish.

import { canSignAdminOrders } from "./addServerGate.js";
import { getSession } from "./state.js";
import { getActiveProfile } from "./profiles.js";
import { isDemoProfile } from "./demoAccount.js";
import { inlineConfirm } from "./modal.js";
import { toast } from "./toast.js";
import { tr } from "./i18n.js";
import { mergeVoiciPage, sha256Hex } from "./voiciProtocol.js";
import { consumeDraftOps, defaultVoiciProfile, makeDraftOp, opImages, publishVoiciPage, removeVoiciPage, sendDraftOp } from "./voiciOwner.js";
import { reencodeAvatar } from "./voiciImage.js";
import { emitWorld, pendingOps, world } from "./voiciWorld.js";
import { clearRemovedSnapshot, hasSeenPublicWarning, markPublicWarningSeen, saveRemovedSnapshot } from "./voiciPagePublic.js";
import {
  VOICI_PUBLIC_WARNING,
  VOICI_PUBLIC_WARNING_TITLE,
  VOICI_REMOVE_TEXT,
  VOICI_REMOVE_TITLE,
  VOICI_RULES_TEXT,
  VOICI_RULES_TITLE,
  voiciErrorText,
} from "./voiciCopy.js";

const RULES_KEY = "flagship.voici.rulesAccepted.v1";

/** Photos picked on this device, sha256 → JPEG bytes (a draft carries them to the admin device). */
export const localImages = new Map();
let busy = false;

export const pageUsername = () => String(getSession()?.username ?? "").toLowerCase();
const deviceId = () => getActiveProfile()?.deviceId || "webapp";

/** This device signs the page: an admin device of a real account. */
export function canPublishPage(session = getSession(), profile = getActiveProfile()) {
  return canSignAdminOrders(session, profile) && !isDemoProfile(profile);
}

export const pageBusy = () => busy;

/** What the edits apply to: the published page, the removed page this device kept, or a new page. */
export function basePage() {
  return world.page ?? world.removed ?? { profile: defaultVoiciProfile(pageUsername()), acceptsMessages: 0, chunks: [], issuedAt: 0 };
}

/** The page with every pending change applied, plus which parts are still pending. */
export function editorModel() {
  const base = basePage();
  const ops = pendingOps();
  const merged = mergeVoiciPage(base, ops);
  const pendingPosts = new Set(ops.filter((o) => o.post).map((o) => o.post.id));
  const mergedIds = new Set(merged.chunks.flat().map((p) => p.id));
  const removing = base.chunks.flat().filter((p) => !mergedIds.has(p.id));
  return {
    merged,
    ops,
    pendingPosts,
    removing,
    profilePending: ops.some((o) => o.op === "profile" && o.at > base.issuedAt),
    acceptsPending: ops.some((o) => o.op === "accept-messages" && o.at > base.issuedAt),
  };
}

export function pageImageBytes(sha) {
  return localImages.get(sha) ?? world.page?.pieces?.get(sha) ?? world.removed?.pieces?.get(sha) ?? opImages(pendingOps()).get(sha) ?? null;
}

/**
 * Records one change. An admin device keeps it as a draft (published by the Publish bar), or publishes at once with
 * `publishNow` when the page is public; any other device hands it to the admin device. A new profile change from
 * this device replaces its earlier unsent one, so the bar counts one profile change.
 */
export async function addPageOp(op, { publishNow = false } = {}) {
  if (busy) return;
  if (op.op === "profile") world.localOps = world.localOps.filter((o) => o.op !== "profile");
  world.localOps.push(op);
  emitWorld();
  if (canPublishPage()) {
    if (publishNow && world.page) await publishPending();
    return;
  }
  busy = true;
  try {
    const { envelope } = await sendDraftOp(op);
    world.localOps = world.localOps.filter((o) => o.opId !== op.opId);
    world.drafts = [...world.drafts, { op, envelope }];
    toast(tr("Sent to your admin device to publish."));
  } catch (e) {
    world.localOps = world.localOps.filter((o) => o.opId !== op.opId);
    toast(voiciErrorText(e), "err");
  } finally {
    busy = false;
    emitWorld();
  }
}

/** A profile change: the merged profile with `patch` applied (name, photo). */
export function profileOp(patch, images = []) {
  const profile = { ...editorModel().merged.profile, ...patch };
  return makeDraftOp("profile", { profile }, { deviceId: deviceId(), images });
}

/** Re-encodes a picked photo (voiciImage.js, the editor's processing) and keeps its bytes for the next publish. */
export async function pickAvatar(file) {
  const bytes = await reencodeAvatar(file);
  const sha = sha256Hex(bytes);
  localImages.set(sha, bytes);
  return { sha, bytes };
}

export function avatarProblemText(e) {
  return e?.code === "too-large" ? tr("That photo is too detailed to fit. Try another one.") : tr("That file couldn't be read as a photo.");
}

function storageFlag(k) {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
}

/** Before a page goes public: the rules sheet once (§9.7), then the public warning once per account (§3.3). */
export async function confirmGoPublic(username = pageUsername()) {
  if (!storageFlag(RULES_KEY)) {
    const ok = await inlineConfirm({ title: VOICI_RULES_TITLE(), message: VOICI_RULES_TEXT(), okLabel: tr("I agree") });
    if (!ok) return false;
    try {
      localStorage.setItem(RULES_KEY, "1");
    } catch {
      /* asked again next time */
    }
  }
  if (hasSeenPublicWarning(username)) return true;
  const ok = await inlineConfirm({ title: VOICI_PUBLIC_WARNING_TITLE(), message: VOICI_PUBLIC_WARNING(), okLabel: tr("Make it public"), cancelLabel: tr("Cancel") });
  if (ok) markPublicWarningSeen(username);
  return ok;
}

/** Publishes every pending change and clears the drafts it included (admin devices). A page that isn't public goes
 *  public, after its warnings. */
export async function publishPending() {
  if (!canPublishPage() || busy) return false;
  const ops = pendingOps();
  if (!world.page && !(await confirmGoPublic())) return false;
  busy = true;
  emitWorld();
  try {
    const images = new Map([...opImages(ops), ...localImages]);
    const page = await publishVoiciPage({ ops, images }, { published: world.page ?? null, removed: world.removed ?? undefined });
    const laneIds = world.drafts.map((d) => d.op.opId).filter((id) => ops.some((o) => o.opId === id));
    const wasPublic = Boolean(world.page);
    world.page = page;
    world.removed = null;
    clearRemovedSnapshot(pageUsername());
    world.localOps = world.localOps.filter((o) => !ops.some((x) => x.opId === o.opId));
    world.drafts = world.drafts.filter((d) => !laneIds.includes(d.op.opId));
    try {
      if (laneIds.length) await consumeDraftOps(laneIds);
    } catch {
      /* the next publish clears them; merging a draft twice changes nothing */
    }
    toast(wasPublic ? tr("Published.") : tr("Your page is public."));
    return true;
  } catch (e) {
    toast(voiciErrorText(e), "err");
    return false;
  } finally {
    busy = false;
    emitWorld();
  }
}

/** Takes the page off voi.ci after the owner confirms; this device keeps what was public. */
export async function removePage() {
  if (!canPublishPage() || busy || !world.page) return false;
  const ok = await inlineConfirm({ title: VOICI_REMOVE_TITLE(), message: VOICI_REMOVE_TEXT(), okLabel: tr("Remove"), cancelLabel: tr("Cancel"), danger: true });
  if (!ok) return false;
  busy = true;
  emitWorld();
  try {
    const page = world.page;
    const r = await removeVoiciPage({ published: page });
    const seq = r.seq ?? page.index.seq + 1;
    saveRemovedSnapshot(pageUsername(), page, seq);
    world.removed = { ...page, index: { pageId: page.index.pageId, seq, inboxEpoch: page.index.inboxEpoch, pieces: [] } };
    world.page = null;
    toast(tr("Your page is off voi.ci."));
    return true;
  } catch (e) {
    toast(voiciErrorText(e), "err");
    return false;
  } finally {
    busy = false;
    emitWorld();
  }
}

/** The Public switch: on publishes (with its warnings), off removes (after its confirm). */
export async function setPagePublic(on) {
  if (on && !world.page) return publishPending();
  if (!on && world.page) return removePage();
  return false;
}
