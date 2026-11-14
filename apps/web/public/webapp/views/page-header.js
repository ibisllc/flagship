// The page's Public switch, its photo URLs and a sample account's read-only page (docs/voici-and-messages.md §3.3,
// docs/social-tab.md §1.1, §1.4). The switch sits in the Social tab's title row; the sample page replaces the Profile
// for a sample account.
//
// Every value reaches the page through properties (textContent, value, src), never markup.

import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { tr } from "../lib/i18n.js";
import { checkIcon, chevronRightIcon, copyIcon, userIcon } from "../lib/icons.js";
import { jpegUrl } from "../lib/voiciImage.js";
import { voiciPageUrl } from "../lib/voiciOwner.js";
import { world } from "../lib/voiciWorld.js";
import { publicSwitchState } from "../lib/voiciPagePublic.js";
import { canPublishPage, pageBusy, pageImageBytes, pageUsername, setPagePublic } from "../lib/voiciPageControl.js";

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

/** The Public switch (a button with role=switch). */
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

export const displayUrl = () => voiciPageUrl(pageUsername()).replace(/^https:\/\//, "");

function avatarInner(sha, size) {
  const src = avatarUrl(sha);
  return src
    ? `<img class="ph-avatar-img" data-ph-avatar-img alt="" width="${size}" height="${size}" />`
    : `<span class="ph-avatar-empty icon" aria-hidden="true">${userIcon}</span>`;
}

/** The sample account's version: the operator's example page, shown read-only (docs/sample-users.md). */
export const SAMPLE_PAGE_NOTE = () => tr("This is a sample account. Its page is an example, so you can't change it.");

function sampleHeaderHtml() {
  const p = world.page?.profile;
  const on = Boolean(world.page);
  return `
    <section class="ph${on ? " is-public" : ""}" id="messages-page-header" data-testid="messages-demo-page" tabindex="-1" aria-label="${escapeHtml(tr("Your page"))}">
      <div class="ph-top">
        <span class="ph-avatar${on ? " is-public" : ""}">${avatarInner(p?.avatar ?? null, 72)}</span>
        <div class="ph-main">
          <p class="ph-name ph-name-static" data-ph-name></p>
          <div class="ph-url">
            <span class="ph-url-text mono" data-testid="ph-url"></span>
            <button type="button" class="ph-copy" id="ph-copy" aria-label="${escapeHtml(tr("Copy link"))}"><span class="icon" data-ph-copy-icon>${copyIcon}</span></button>
            <span class="ph-copied" id="ph-copied" aria-live="polite"></span>
          </div>
        </div>
        <div class="ph-public">
          <span class="ph-public-label" id="ph-public-label" data-testid="demo-page-status">${escapeHtml(on ? tr("Public") : tr("Not public"))}</span>
          <button type="button" role="switch" class="fs-switch" id="ph-switch" data-testid="demo-page-public-switch" aria-checked="${on}" aria-labelledby="ph-public-label" disabled><span class="fs-switch-thumb" aria-hidden="true"></span></button>
        </div>
      </div>
      <p class="note ph-note" data-testid="demo-page-note">${escapeHtml(SAMPLE_PAGE_NOTE())}</p>
      <button type="button" class="ph-edit" id="ph-view" data-testid="demo-page-view">
        <span class="ph-edit-text">${escapeHtml(tr("View page"))}</span>
        <span class="icon ph-edit-chevron" aria-hidden="true">${chevronRightIcon}</span>
      </button>
    </section>`;
}

/** Draws the sample account's read-only page into `root`. */
export function renderSamplePage(root) {
  if (!root) return;
  const p = world.page?.profile;
  root.innerHTML = sampleHeaderHtml();
  root.querySelector("[data-ph-name]").textContent = p?.displayName || pageUsername();
  root.querySelector("[data-testid=ph-url]").textContent = displayUrl();
  root.querySelectorAll("[data-ph-avatar-img]").forEach((img) => (img.src = avatarUrl(p?.avatar)));
  root.querySelector("#ph-copy").addEventListener("click", () => void copyPageLink(root));
  root.querySelector("#ph-view").addEventListener("click", () => window.open(voiciPageUrl(pageUsername()), "_blank", "noopener,noreferrer"));
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
