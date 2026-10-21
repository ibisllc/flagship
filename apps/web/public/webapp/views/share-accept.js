// Opening a share link (docs/share-a-server.md §5.1, §9 "B accepts"): show
// what is being shared, accept with this account's per-share key, read the
// six digits to the owner, then wait until the box lets this account in.

import { $, registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { inlinePrompt } from "../lib/modal.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { serverIcon } from "../lib/icons.js";
import { parseShareLink } from "../lib/serverShare.js";
import { canAddServers, refuseAddServer } from "../lib/addServerGate.js";
import {
  DATA_TITLE,
  LEVEL_LINE,
  LEVEL_TEXT,
  SHARE_ACCEPT_ADMIN_ONLY,
  acceptShare,
  openShareLink,
  shareErrorText,
  signInToShare,
} from "../lib/serverShares.js";

import { tr } from "../lib/i18n.js";
registerView("view-share-accept", { tab: "home" });

export const SHARE_POLL_MS = 4000;

let seq = 0;
let pollTimer = null;

function stopPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

const root = () => $("share-accept-content");
const visible = () => !$("view-share-accept")?.classList.contains("hidden");

function errorCard(message) {
  return `
      <div class="card">
        <p class="err-text">${escapeHtml(message)}</p>
        <button class="secondary full-width mt-2" data-share-home>${tr("Back to servers")}</button>
      </div>`;
}

/** The offer as B sees it before accepting. */
export function offerCardHtml(offer) {
  const extras = [];
  if (offer.unlockAtBoot) extras.push("You can approve its start-up. Your phone gets a copy of its disk key.");
  if (offer.seeAppData) extras.push(`${DATA_TITLE}: you can open each app's Database section.`);
  return `
      <div class="card share-offer">
        <span class="fs-listrow-icon fs-listrow-icon--teal icon share-offer-icon" aria-hidden="true">${serverIcon}</span>
        <h3 class="share-offer-name">${tr("{0} is shared with you", escapeHtml(offer.serverName || offer.serverDomain))}</h3>
        <p class="mono faint-sm">${escapeHtml(offer.serverDomain)}</p>
        <p class="mt-2"><span class="pill ok">${escapeHtml(LEVEL_TEXT[offer.level])}</span></p>
        <p class="note mt-2">${escapeHtml(LEVEL_LINE[offer.level])}</p>
        ${extras.map((x) => `<p class="note">${escapeHtml(x)}</p>`).join("")}
        <p class="faint-sm mt-2">${tr("You use your own account. The owner sees only the name they gave you.")}</p>
        <div class="row-2 mt-3">
          <button class="secondary" data-share-decline>${tr("Not now")}</button>
          <button data-share-accept>${tr("Accept")}</button>
        </div>
      </div>`;
}

/** The code B reads to the owner while the owner confirms. */
export function codeCardHtml(sas, serverName) {
  return `
      <div class="card share-code">
        <p class="note">${tr("Read this code to the owner:")}</p>
        <p class="share-sas mono" data-share-sas>${escapeHtml(sas)}</p>
        <p class="note">${tr("They check it matches on their side before you can use {0}.", escapeHtml(serverName))}</p>
        <div class="update-pending mt-2" data-share-waiting>
          <span class="update-pending-spinner" aria-hidden="true"></span>
          <p class="text-sm">${tr("Waiting for the owner to confirm…")}</p>
        </div>
      </div>`;
}

function wireHome() {
  root()?.querySelectorAll("[data-share-home]").forEach((b) =>
    b.addEventListener("click", async () => {
      const { enterHome } = await import("./home.js");
      await enterHome();
    }),
  );
}

export async function enterShareAccept(link) {
  stopPoll();
  const my = ++seq;
  show("view-share-accept");
  const el = root();
  if (!el) return;
  const title = $("share-accept-title");
  if (title) title.textContent = tr("Shared server");
  if (!getSession()?.umk) {
    el.innerHTML = errorCard(tr("Unlock Flagship first, then open the link again."));
    wireHome();
    return;
  }
  // Co-managing a server adds it to the account: admin devices only, and the
  // shared server checks the admin key's signature (docs/share-a-server.md §5.1).
  if (!canAddServers()) {
    el.innerHTML = errorCard(SHARE_ACCEPT_ADMIN_ONLY);
    wireHome();
    return;
  }
  el.innerHTML = skeletonCards(1);
  let opened;
  try {
    opened = await openShareLink(link);
  } catch (e) {
    if (my !== seq) return;
    el.innerHTML = errorCard(shareErrorText(e));
    wireHome();
    return;
  }
  if (my !== seq) return;
  if (opened.acceptedByMe) return accept(opened, my);
  el.innerHTML = offerCardHtml(opened.offer);
  el.querySelector("[data-share-decline]")?.addEventListener("click", async () => {
    const { enterHome } = await import("./home.js");
    await enterHome();
  });
  const btn = el.querySelector("[data-share-accept]");
  btn?.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = tr("Accepting…");
    void accept(opened, my).catch(() => {
      btn.disabled = false;
      btn.textContent = tr("Accept");
    });
  });
}

async function accept(opened, my) {
  const el = root();
  let r;
  try {
    r = await acceptShare(opened);
  } catch (e) {
    if (my !== seq) return;
    if (e?.code === "taken" || e?.code === "expired" || e?.code === "not-admin") {
      el.innerHTML = errorCard(shareErrorText(e));
      wireHome();
      return;
    }
    if (e?.code !== "cancelled") toast(shareErrorText(e), "err");
    throw e;
  }
  if (my !== seq) return;
  const name = opened.offer.serverName || opened.offer.serverDomain;
  el.innerHTML = codeCardHtml(r.sas, name);
  if (!r.savedToInbox) toast(tr("Accepted, but it isn't saved to your list yet. Keep this page open until the owner confirms."), "err");
  waitForOwner(r.entry, name, my);
}

function waitForOwner(entry, name, my) {
  const tick = async () => {
    pollTimer = null;
    if (my !== seq || !visible()) return;
    try {
      await signInToShare(entry, {}, { force: true });
    } catch (e) {
      if (my !== seq) return;
      if (e?.code === "share-ended") {
        root().innerHTML = errorCard(tr("The owner cancelled this share."));
        wireHome();
        return;
      }
      pollTimer = setTimeout(tick, SHARE_POLL_MS);
      return;
    }
    if (my !== seq) return;
    root().innerHTML = `
      <div class="card share-code">
        <p class="share-offer-name">${tr("You can now use {0}", escapeHtml(name))}</p>
        <p class="note">${tr("It's under <strong>Shared with me</strong> on your servers list.")}</p>
        <button class="full-width mt-2" data-share-open>${tr("Open {0}", escapeHtml(name))}</button>
      </div>`;
    root().querySelector("[data-share-open]")?.addEventListener("click", async () => {
      const { enterSharedServer } = await import("./shared-server.js");
      await enterSharedServer(entry);
    });
  };
  pollTimer = setTimeout(tick, SHARE_POLL_MS);
}

/** "Paste a share link": a browser can't take flagship:// links, so the
 *  person pastes what they were sent. */
export async function promptShareLink() {
  if (!canAddServers()) return refuseAddServer();
  const text = await inlinePrompt({
    title: tr("Open a share link"),
    message: tr("Paste the link the owner sent you."),
    placeholder: "https://flagshipserver.com/share#s=…",
    okLabel: tr("Open"),
    validate: (v) => (parseShareLink(v) ? null : tr("That isn't a share link.")),
  });
  if (!text) return;
  const link = parseShareLink(text);
  if (link) await enterShareAccept(link);
}

export function initShareAcceptView() {
  $("share-accept-back")?.addEventListener("click", async () => {
    stopPoll();
    const { enterHome } = await import("./home.js");
    await enterHome();
  });
}
