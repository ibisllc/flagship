// The top of the Messages tab: the one place to manage the voi.ci page (docs/voici-and-messages.md §11.1). The
// photo, the display name (the account name until it's changed), voi.ci/<u> with a copy button, the Public switch
// and the way into the full editor. When the page is public, a name or photo changed here is published at once (the
// header is the quick control); everything else waits in the editor's drafts. Scrolled past, it folds into a slim
// sticky bar with the photo, the name and the switch.
//
// Every value reaches the page through properties (textContent, value, src), never markup.

import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { tr } from "../lib/i18n.js";
import { checkIcon, chevronRightIcon, copyIcon, userIcon } from "../lib/icons.js";
import { jpegUrl } from "../lib/voiciImage.js";
import { prepareVoiciText } from "../lib/voiciProtocol.js";
import { voiciPageUrl } from "../lib/voiciOwner.js";
import { onWorldChange, world } from "../lib/voiciWorld.js";
import { VOICI_PUBLISH_ADMIN_ONLY, voiciTextProblem } from "../lib/voiciCopy.js";
import { publicSwitchState } from "../lib/voiciPagePublic.js";
import {
  addPageOp,
  avatarProblemText,
  canPublishPage,
  editorModel,
  pageBusy,
  pageImageBytes,
  pageUsername,
  pickAvatar,
  profileOp,
  setPagePublic,
} from "../lib/voiciPageControl.js";

const urls = new Map();
/** One object URL per photo, so re-renders don't leak them. */
export function avatarUrl(sha) {
  if (!sha) return null;
  if (urls.has(sha)) return urls.get(sha);
  const bytes = pageImageBytes(sha);
  if (!bytes) return null;
  const u = jpegUrl(bytes);
  urls.set(sha, u);
  return u;
}

/** The Public switch (a button with role=switch), shared by the header, its folded bar and the editor. */
export function publicSwitchHtml(id, { labelledBy } = {}) {
  // Until `.com` has answered for the page, nobody knows which way the switch should go.
  const unknown = !world.pageLoaded || (Boolean(world.pageError) && !world.page);
  const s = publicSwitchState({ published: world.page, canPublish: canPublishPage(), busy: pageBusy() || unknown });
  return `<button type="button" role="switch" class="fs-switch" id="${id}" data-page-public aria-checked="${s.on}"${labelledBy ? ` aria-labelledby="${labelledBy}"` : ` aria-label="${escapeHtml(tr("Public"))}"`}${s.disabled ? " disabled" : ""}><span class="fs-switch-thumb" aria-hidden="true"></span></button>`;
}

/** Wires every Public switch under `root`. */
export function wirePublicSwitches(root) {
  root.querySelectorAll("[data-page-public]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (b.disabled) return;
      const want = b.getAttribute("aria-checked") !== "true";
      await setPagePublic(want);
    }),
  );
}

const displayUrl = () => voiciPageUrl(pageUsername()).replace(/^https:\/\//, "");

function avatarInner(sha, size) {
  const src = avatarUrl(sha);
  return src
    ? `<img class="ph-avatar-img" data-ph-avatar-img alt="" width="${size}" height="${size}" />`
    : `<span class="ph-avatar-empty icon" aria-hidden="true">${userIcon}</span>`;
}

function headerHtml() {
  const m = editorModel();
  const p = m.merged.profile;
  const admin = canPublishPage();
  const on = Boolean(world.page);
  return `
    <section class="ph${on ? " is-public" : ""}" id="messages-page-header" data-testid="messages-page-header" tabindex="-1" aria-label="${escapeHtml(tr("Your page"))}">
      <div class="ph-top">
        <button type="button" class="ph-avatar${on ? " is-public" : ""}" id="ph-avatar" aria-label="${escapeHtml(p.avatar ? tr("Change photo") : tr("Choose photo"))}">${avatarInner(p.avatar, 72)}</button>
        <input type="file" id="ph-photo" accept="image/*" hidden />
        <div class="ph-main">
          <label class="visually-hidden" for="ph-name">${escapeHtml(tr("Display name"))}</label>
          <input id="ph-name" class="ph-name" maxlength="64" autocomplete="off" spellcheck="false" />
          <p class="ph-error hidden" id="ph-name-error" role="alert"></p>
          <div class="ph-url">
            <span class="ph-url-text mono" data-testid="ph-url"></span>
            <button type="button" class="ph-copy" id="ph-copy" aria-label="${escapeHtml(tr("Copy link"))}"><span class="icon" data-ph-copy-icon>${copyIcon}</span></button>
            <span class="ph-copied" id="ph-copied" aria-live="polite"></span>
          </div>
        </div>
        <div class="ph-public">
          <span class="ph-public-label" id="ph-public-label">${escapeHtml(tr("Public"))}</span>
          ${publicSwitchHtml("ph-switch", { labelledBy: "ph-public-label" })}
        </div>
      </div>
      ${world.pageError && !world.page ? `<p class="note ph-note" data-testid="ph-page-error">${escapeHtml(tr("Couldn't check your page."))}</p>` : ""}
      ${admin ? "" : `<p class="note ph-note" data-testid="ph-admin-only">${escapeHtml(VOICI_PUBLISH_ADMIN_ONLY())}</p>`}
      <button type="button" class="ph-edit" id="ph-edit" data-testid="messages-edit-page">
        <span class="ph-edit-text">${escapeHtml(tr("Edit page"))}</span>
        <span class="ph-edit-hint">${escapeHtml(tr("Bio, links, posts, look, messages"))}</span>
        <span class="icon ph-edit-chevron" aria-hidden="true">${chevronRightIcon}</span>
      </button>
    </section>`;
}

/** The folded bar's inside; the bar itself (`#messages-page-bar`) is a direct child of the tab, so it can stick. */
function barHtml(p, on) {
  return `<div class="ph-bar-in">
      <span class="ph-avatar ph-avatar-sm${on ? " is-public" : ""}">${avatarInner(p.avatar, 28)}</span>
      <span class="ph-bar-name" data-ph-bar-name></span>
      <span class="ph-bar-status">${escapeHtml(on ? tr("Public") : tr("Not public"))}</span>
      ${publicSwitchHtml("ph-bar-switch").replace("<button ", '<button tabindex="-1" ')}
    </div>`;
}

let collapseObserver = null;

/** Draws the header into `root` (`#messages-page-row`) and its folded bar into `#messages-page-bar`. */
export function renderPageHeader(root) {
  if (!root) return;
  const m = editorModel();
  const p = m.merged.profile;
  root.innerHTML = headerHtml();
  root.querySelector("#ph-name").value = p.displayName;
  root.querySelector("[data-testid=ph-url]").textContent = displayUrl();
  const bar = document.getElementById("messages-page-bar");
  if (bar) {
    bar.innerHTML = barHtml(p, Boolean(world.page));
    bar.querySelector("[data-ph-bar-name]").textContent = p.displayName;
    wirePublicSwitches(bar);
  }
  for (const scope of [root, bar]) scope?.querySelectorAll("[data-ph-avatar-img]").forEach((img) => (img.src = avatarUrl(p.avatar)));
  wire(root);
  wireCollapse(root, bar);
}

function showNameError(root, text) {
  const el = root.querySelector("#ph-name-error");
  if (!el) return;
  el.textContent = text ?? "";
  el.classList.toggle("hidden", !text);
  root.querySelector("#ph-name")?.setAttribute("aria-invalid", String(Boolean(text)));
}

function wire(root) {
  const name = root.querySelector("#ph-name");
  const commitName = () => {
    const current = editorModel().merged.profile.displayName;
    const r = prepareVoiciText("displayName", name.value);
    if (!r.ok) return showNameError(root, voiciTextProblem(r.code, 64));
    showNameError(root, null);
    if (r.text === current) return;
    void addPageOp(profileOp({ displayName: r.text }), { publishNow: true });
  };
  name.addEventListener("change", commitName);
  name.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      name.blur();
    } else if (ev.key === "Escape") {
      name.value = editorModel().merged.profile.displayName;
      showNameError(root, null);
    }
  });
  const file = root.querySelector("#ph-photo");
  root.querySelector("#ph-avatar").addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const { sha, bytes } = await pickAvatar(f);
      const images = canPublishPage() ? [] : [bytes];
      await addPageOp(profileOp({ avatar: sha }, images), { publishNow: true });
    } catch (e) {
      toast(avatarProblemText(e), "err");
    }
  });
  root.querySelector("#ph-copy").addEventListener("click", () => void copyPageLink(root));
  root.querySelector("#ph-edit").addEventListener("click", () => void import("./page-editor.js").then((mod) => mod.enterPageEditor()));
  wirePublicSwitches(root);
}

let copiedTimer = null;
/** Writes the page address to the clipboard (never reads it) and says so next to the button for two seconds. */
export async function copyPageLink(root) {
  const url = voiciPageUrl(pageUsername());
  const said = root.querySelector("#ph-copied");
  const icon = root.querySelector("[data-ph-copy-icon]");
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    toast(url);
    return;
  }
  if (said) said.textContent = tr("Copied");
  if (icon) icon.innerHTML = checkIcon;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    if (said) said.textContent = "";
    if (icon) icon.innerHTML = copyIcon;
  }, 2000);
}

/** Folds the header into the slim bar while it is scrolled under the app header. */
function wireCollapse(root, bar) {
  const header = root.querySelector("#messages-page-header");
  if (!header || !bar || typeof IntersectionObserver === "undefined") return;
  collapseObserver?.disconnect();
  const sw = bar.querySelector("[data-page-public]");
  collapseObserver = new IntersectionObserver(
    (ents) => {
      for (const ent of ents) {
        const folded = !ent.isIntersecting && ent.boundingClientRect.top < 120;
        bar.classList.toggle("is-revealed", folded);
        bar.setAttribute("aria-hidden", String(!folded));
        if (sw) sw.tabIndex = folded ? 0 : -1;
      }
    },
    { rootMargin: "-120px 0px 0px 0px", threshold: 0 },
  );
  collapseObserver.observe(header.querySelector(".ph-top"));
}

let wiredWorld = false;
/** Re-draws on every change to the page, unless the owner is typing the name. */
export function keepPageHeaderFresh(getRoot) {
  if (wiredWorld) return;
  wiredWorld = true;
  // Next task: a change made while leaving the name is reported before the focus lands on the next control.
  onWorldChange(() =>
    setTimeout(() => {
      const root = getRoot();
      if (!root || !root.querySelector("#messages-page-header")) return;
      if (document.activeElement?.id === "ph-name") return;
      const focused = root.contains(document.activeElement) ? document.activeElement?.id : null;
      renderPageHeader(root);
      if (focused && root.querySelector(`#${focused}`)) root.querySelector(`#${focused}`).focus({ preventScroll: true });
    }, 0),
  );
}

