// The voi.ci page editor (docs/voici-and-messages.md §2, §5, §11.2): bio, links, posts, the look and Accept
// messages, with the same Public switch as the Messages header at the top. Every edit is a draft; one bar at the
// bottom counts them and publishes ("3 changes not published · Publish"). Any device of the account edits; only an
// admin device signs the page, so on any other device the bar says it is waiting for one and the changes go to it as
// sealed drafts. A change that isn't in a published index yet is shown grayed.
//
// F: the webapp makes no link cards (its CSP reaches only Flagship's own hosts, and a site's page can't be read
// cross-origin), so its posts carry their links with `card: null`; a card made on a phone can still be removed here.
// Links are reordered with Up and Down buttons rather than dragged.

import { $, registerView, show } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { formatWhen } from "../lib/dateFormat.js";
import { inlineConfirm, inlinePrompt } from "../lib/modal.js";
import { getActiveProfile } from "../lib/profiles.js";
import {
  checkVoiciLinkUrl,
  findVoiciLinks,
  hex,
  parseVoiciProfile,
  prepareVoiciText,
  VOICI_LINK_SITES,
  voiciLinkSite,
  VOICI_THEMES,
  voiciUrlHost,
  VOICI_PROFILE_MAX_LINKS,
  VOICI_POST_MAX_LINKS,
} from "../lib/voiciProtocol.js";
import { makeDraftOp, postsNewestFirst, voiciPageUrl } from "../lib/voiciOwner.js";
import { onWorldChange, refreshWorld, world } from "../lib/voiciWorld.js";
import {
  addPageOp,
  avatarProblemText,
  basePage,
  canPublishPage,
  editorModel,
  pageBusy,
  pageImageBytes,
  pageUsername,
  pickAvatar,
  publishPending,
} from "../lib/voiciPageControl.js";
import { avatarUrl, publicSwitchHtml, wirePublicSwitches } from "./page-header.js";
import {
  VOICI_ACCEPT_NOTE,
  VOICI_NOT_PUBLISHED,
  VOICI_PAGE_WARNING,
  VOICI_PUBLISH_ADMIN_ONLY,
  VOICI_WAITING_ADMIN,
  voiciTextProblem,
} from "../lib/voiciCopy.js";

import { tr, trn } from "../lib/i18n.js";

registerView("view-page-editor", { tab: "messages" });

/** The profile form as edited, until it is a valid profile (then it becomes a draft and this resets). */
let form = null;

const username = pageUsername;
const isAdmin = () => canPublishPage();
const deviceId = () => getActiveProfile()?.deviceId || "webapp";
const imageBytes = pageImageBytes;

export { editorModel };

function siteLabel(id) {
  if (id === "email") return tr("Email");
  return VOICI_LINK_SITES.find((s) => s.id === id)?.label ?? "";
}

function pendingLabel() {
  return isAdmin() ? VOICI_NOT_PUBLISHED() : VOICI_WAITING_ADMIN();
}

/** The bar at the bottom: how many changes wait, and Publish (admin devices). */
export function publishBarText(count, admin) {
  if (!count) return "";
  return admin ? trn(count, "{0} change not published", "{0} changes not published") : VOICI_WAITING_ADMIN();
}

// ── render ────────────────────────────────────────────────────────────────

function barHtml(barText, admin) {
  if (!barText) return "";
  return `<div class="pe-bar" data-testid="pe-publish-bar" role="region" aria-label="${escapeHtml(tr("Changes"))}">
      <span class="pe-bar-text" data-testid="pe-bar-text">${escapeHtml(barText)}</span>
      ${admin ? `<button type="button" id="pe-publish"${pageBusy() ? " disabled" : ""}>${escapeHtml(tr("Publish"))}</button>` : ""}
    </div>`;
}

function profilePillHtml(m) {
  return m.profilePending ? ` <span class="pill" data-testid="profile-pending">${escapeHtml(pendingLabel())}</span>` : "";
}

/** After a profile field became a draft: the pill, the card's shade, the preview and the bar, leaving the fields
 *  (and the one being typed in) alone. */
function renderChrome() {
  const root = $("page-editor-content");
  if (!root || !$("pe-bar-slot")) return render();
  const m = editorModel();
  $("pe-profile-pill").innerHTML = profilePillHtml(m);
  $("pe-profile-card").classList.toggle("is-pending", m.profilePending);
  $("pe-bar-slot").innerHTML = barHtml(publishBarText(m.ops.length, isAdmin()), isAdmin());
  $("pe-publish")?.addEventListener("click", () => void publishPending());
  renderPreview(m);
}

const FOCUS_ATTRS = ["data-link-url", "data-link-label", "data-link-up", "data-link-down", "data-link-remove", "data-theme", "data-post-edit", "data-post-delete"];

/** A selector for the focused control, so a redraw (a field turned into a draft on leaving it) keeps the focus. */
function activeKey(root) {
  const a = document.activeElement;
  if (!a || !root.contains(a)) return null;
  if (a.id) return `#${a.id}`;
  for (const attr of FOCUS_ATTRS) if (a.hasAttribute(attr)) return `[${attr}="${a.getAttribute(attr)}"]`;
  return null;
}

function restoreFocus(root, key) {
  if (!key) return;
  const el = root.querySelector(key);
  if (!el || el.disabled) return;
  el.focus({ preventScroll: true });
  if (typeof el.value === "string" && typeof el.setSelectionRange === "function" && el.type !== "file" && el.type !== "checkbox") {
    try {
      el.setSelectionRange(el.value.length, el.value.length);
    } catch {
      /* not a text field */
    }
  }
}

function render() {
  const root = $("page-editor-content");
  if (!root) return;
  const focusKey = activeKey(root);
  const m = editorModel();
  if (!form) form = structuredClone(m.merged.profile);
  const avatar = form.avatar ? imageBytes(form.avatar) : null;
  const posts = postsNewestFirst(m.merged.chunks);
  const admin = isAdmin();
  const barText = publishBarText(m.ops.length, admin);
  const on = Boolean(world.page);
  root.innerHTML = `
    <div class="pe-public card">
      <div class="pe-public-row">
        <span class="pe-public-text">
          <span class="weight-600" id="pe-public-label">${escapeHtml(tr("Public"))}</span>
          <span class="muted-sm mono" data-testid="pe-url"></span>
        </span>
        ${publicSwitchHtml("pe-switch", { labelledBy: "pe-public-label" })}
      </div>
      <p class="note" data-testid="page-status">${escapeHtml(on ? tr("Anyone with the link can see your page.") : tr("Your page is not on voi.ci. Turn on Public to publish it."))}</p>
      ${admin ? "" : `<p class="note" data-testid="page-admin-only">${escapeHtml(VOICI_PUBLISH_ADMIN_ONLY())}</p>`}
    </div>
    <div class="card warn-card mt-3" data-testid="voici-warning">${escapeHtml(VOICI_PAGE_WARNING())}</div>

    <h3 class="mt-3">${escapeHtml(tr("Profile"))}<span id="pe-profile-pill">${profilePillHtml(m)}</span></h3>
    <div class="card stack-sm${m.profilePending ? " is-pending" : ""}" id="pe-profile-card">
      <div class="pe-photo-row">
        ${avatar ? `<img id="pe-avatar-img" class="pe-avatar" alt="${escapeHtml(tr("Your photo"))}" />` : `<div class="pe-avatar pe-avatar-empty" aria-hidden="true"></div>`}
        <div class="stack-sm">
          <button type="button" class="secondary" id="pe-photo-pick">${escapeHtml(tr("Choose photo"))}</button>
          <input type="file" id="pe-photo" accept="image/*" hidden />
          ${form.avatar ? `<button type="button" class="ghost" id="pe-photo-remove">${escapeHtml(tr("Remove photo"))}</button>` : ""}
        </div>
      </div>
      <label for="pe-name">${escapeHtml(tr("Display name"))}</label>
      <input id="pe-name" maxlength="64" />
      <label for="pe-bio">${escapeHtml(tr("Bio"))} <span class="muted-sm" id="pe-bio-count"></span></label>
      <textarea id="pe-bio" rows="3"></textarea>
      <label>${escapeHtml(tr("Links"))}</label>
      <div id="pe-links" class="stack-sm">
        ${form.links
          .map(
            (l, i) => `
          <div class="pe-link" data-link-row="${i}">
            <input data-link-url="${i}" placeholder="https://" aria-label="${escapeHtml(tr("Link address"))}" />
            <input data-link-label="${i}" maxlength="40" placeholder="${escapeHtml(tr("Label"))}" aria-label="${escapeHtml(tr("Link label"))}" />
            <span class="muted-sm" data-link-site="${i}">${escapeHtml(siteLabel(l.site))}</span>
            <span class="pe-link-buttons">
              <button type="button" class="ghost" data-link-up="${i}" aria-label="${escapeHtml(tr("Move up"))}"${i === 0 ? " disabled" : ""}>↑</button>
              <button type="button" class="ghost" data-link-down="${i}" aria-label="${escapeHtml(tr("Move down"))}"${i === form.links.length - 1 ? " disabled" : ""}>↓</button>
              <button type="button" class="ghost" data-link-remove="${i}">${escapeHtml(tr("Remove"))}</button>
            </span>
          </div>`,
          )
          .join("")}
      </div>
      ${form.links.length < VOICI_PROFILE_MAX_LINKS ? `<button type="button" class="secondary" id="pe-link-add">${escapeHtml(tr("Add link"))}</button>` : ""}
      <label>${escapeHtml(tr("Look"))}</label>
      <div class="fs-segmented" role="radiogroup" aria-label="${escapeHtml(tr("Look"))}">
        ${VOICI_THEMES.map((t) => `<button type="button" role="radio" data-theme="${t}" aria-checked="${form.theme === t}">${escapeHtml(themeName(t))}</button>`).join("")}
      </div>
      <p class="pe-error hidden" id="pe-profile-error" role="alert"></p>
    </div>

    <div class="card stack-sm mt-3${m.acceptsPending ? " is-pending" : ""}">
      <label class="inline-check"><input type="checkbox" id="pe-accepts" role="switch"${m.merged.acceptsMessages ? " checked" : ""} /> <span class="weight-600">${escapeHtml(tr("Accept messages"))}</span></label>
      <p class="note">${escapeHtml(VOICI_ACCEPT_NOTE())}</p>
      ${m.acceptsPending ? `<span class="pill" data-testid="accepts-pending">${escapeHtml(pendingLabel())}</span>` : ""}
    </div>

    <h3 class="mt-3">${escapeHtml(tr("Posts"))}</h3>
    <div class="card stack-sm">
      <textarea id="pe-post-text" rows="3" placeholder="${escapeHtml(tr("Write a post"))}" aria-label="${escapeHtml(tr("Write a post"))}"></textarea>
      <button type="button" id="pe-post-add">${escapeHtml(tr("Post"))}</button>
    </div>
    <div id="pe-posts" class="stack-sm mt-2">
      ${m.removing.map((p) => postHtml(p, { removing: true })).join("")}
      ${posts.map((p) => postHtml(p, { pending: m.pendingPosts.has(p.id) })).join("")}
    </div>

    <h3 class="mt-3">${escapeHtml(tr("Preview"))}</h3>
    <div id="pe-preview" class="card voici-preview" data-theme="${escapeHtml(m.merged.profile.theme)}"></div>

    <div class="row-2 mt-3">
      <button type="button" class="secondary" id="pe-copy"${on ? "" : " disabled"}>${escapeHtml(tr("Copy link"))}</button>
      <button type="button" class="secondary" id="pe-share"${on ? "" : " disabled"}>${escapeHtml(tr("Share"))}</button>
    </div>
    <div id="pe-bar-slot" class="pe-bar-slot">${barHtml(barText, admin)}</div>`;

  // Values go in through properties, never markup.
  root.querySelector("[data-testid=pe-url]").textContent = voiciPageUrl(username()).replace(/^https:\/\//, "");
  $("pe-name").value = form.displayName;
  $("pe-bio").value = form.bio;
  updateBioCount();
  form.links.forEach((l, i) => {
    root.querySelector(`[data-link-url="${i}"]`).value = l.url;
    root.querySelector(`[data-link-label="${i}"]`).value = l.label;
  });
  if (avatar) $("pe-avatar-img").src = avatarUrl(form.avatar);
  renderPreview(m);
  wire(root);
  restoreFocus(root, focusKey);
}

function themeName(t) {
  return t === "ink" ? tr("Ink") : t === "sea" ? tr("Sea") : tr("Classic");
}

function postHtml(p, { pending = false, removing = false } = {}) {
  const label = removing ? tr("Removal not published yet") : pending ? pendingLabel() : "";
  return `
    <div class="card post-card${pending || removing ? " is-pending" : ""}" data-post="${escapeHtml(p.id)}">
      <div class="muted-sm">${escapeHtml(formatWhen(p.createdAt))}${label ? ` · <span data-post-pending>${escapeHtml(label)}</span>` : ""}</div>
      <p class="post-text" data-post-text></p>
      ${p.links
        .map(
          (l, i) => `<div class="post-link muted-sm"><span class="mono">${escapeHtml(voiciUrlHost(l.url) ?? "")}</span>${
            l.card ? ` · ${escapeHtml(l.card.title)} <button type="button" class="ghost" data-card-remove="${escapeHtml(p.id)}:${i}">${escapeHtml(tr("Remove card"))}</button>` : ""
          }</div>`,
        )
        .join("")}
      ${removing ? "" : `<div class="row-2">
        <button type="button" class="ghost" data-post-edit="${escapeHtml(p.id)}">${escapeHtml(tr("Edit"))}</button>
        <button type="button" class="ghost" data-post-delete="${escapeHtml(p.id)}">${escapeHtml(tr("Delete"))}</button>
      </div>`}
    </div>`;
}

/** The page as a visitor sees it (§2.1), with the same text-only rules. */
function renderPreview(m) {
  const root = $("pe-preview");
  if (!root) return;
  root.replaceChildren();
  const p = m.merged.profile;
  const head = document.createElement("div");
  head.className = "voici-preview-head";
  const bytes = p.avatar ? imageBytes(p.avatar) : null;
  if (bytes) {
    const img = document.createElement("img");
    img.className = "pe-avatar";
    img.alt = "";
    img.src = avatarUrl(p.avatar);
    head.appendChild(img);
  }
  const name = document.createElement("div");
  name.className = "voici-preview-name";
  name.setAttribute("data-testid", "preview-name");
  name.textContent = p.displayName;
  const bio = document.createElement("p");
  bio.className = "voici-preview-bio";
  bio.textContent = p.bio;
  head.append(name, bio);
  root.appendChild(head);
  for (const l of p.links) {
    const row = document.createElement("div");
    row.className = "voici-preview-link";
    const label = document.createElement("span");
    label.textContent = l.label;
    const host = document.createElement("span");
    host.className = "muted-sm mono";
    host.textContent = l.url.startsWith("mailto:") ? l.url.slice(7) : voiciUrlHost(l.url) ?? "";
    row.append(label, host);
    root.appendChild(row);
  }
  if (m.merged.acceptsMessages) {
    const b = document.createElement("div");
    b.className = "voici-preview-send";
    b.setAttribute("data-testid", "preview-send");
    b.textContent = tr("Send me a message");
    root.appendChild(b);
  }
  for (const post of postsNewestFirst(m.merged.chunks)) {
    const card = document.createElement("div");
    card.className = "voici-preview-post";
    const when = document.createElement("div");
    when.className = "muted-sm";
    when.textContent = formatWhen(post.createdAt);
    const text = document.createElement("p");
    text.textContent = post.text;
    card.append(when, text);
    root.appendChild(card);
  }
}

function updateBioCount() {
  const n = [...($("pe-bio")?.value ?? "").normalize("NFC")].length;
  const c = $("pe-bio-count");
  if (c) c.textContent = `${n} / 280`;
}

/** Copies the form's inputs into `form` (before any re-render). */
function readForm(root) {
  form.displayName = $("pe-name").value;
  form.bio = $("pe-bio").value;
  form.links = form.links.map((l, i) => {
    const u = root.querySelector(`[data-link-url="${i}"]`);
    const lb = root.querySelector(`[data-link-label="${i}"]`);
    if (!u || !lb) return l;
    const url = u.value.trim();
    return { url, label: lb.value, site: checkVoiciLinkUrl(url, true) ? null : voiciLinkSite(url) };
  });
}


function showProfileError(text) {
  const el = $("pe-profile-error");
  if (!el) return;
  el.textContent = text ?? "";
  el.classList.toggle("hidden", !text);
}

/** The edited profile as a valid profile, or the sentence saying why it isn't one. */
export function profileFromForm(f) {
  const name = prepareVoiciText("displayName", f.displayName);
  if (!name.ok) return { error: voiciTextProblem(name.code, 64) };
  const bio = prepareVoiciText("bio", f.bio);
  if (!bio.ok) return { error: voiciTextProblem(bio.code, 280) };
  const links = [];
  for (const l of f.links) {
    if (!l.url && !l.label) continue;
    if (checkVoiciLinkUrl(l.url, true)) return { error: tr("{0} isn't a link that can go on your page. Use an https:// address.", l.url || "…") };
    const label = prepareVoiciText("linkLabel", l.label || voiciUrlHost(l.url) || "");
    if (!label.ok) return { error: voiciTextProblem(label.code, 40) };
    links.push({ url: l.url, label: label.text, site: voiciLinkSite(l.url) });
  }
  if (links.filter((l) => l.url.startsWith("mailto:")).length > 1) return { error: tr("A page can have one email link.") };
  const profile = parseVoiciProfile({ v: 1, displayName: name.text, bio: bio.text, avatar: f.avatar ?? null, theme: f.theme, links });
  return profile ? { profile } : { error: tr("That profile can't be published.") };
}

/** Turns the form into a draft when it is a valid profile that differs from the page with its drafts. */
async function commitProfile() {
  const r = profileFromForm(form);
  if (r.error) return showProfileError(r.error);
  showProfileError(null);
  if (JSON.stringify(r.profile) === JSON.stringify(editorModel().merged.profile)) return;
  const images = r.profile.avatar && !isAdmin() && imageBytes(r.profile.avatar) && !world.page?.pieces?.has(r.profile.avatar) ? [imageBytes(r.profile.avatar)] : [];
  await addPageOp(makeDraftOp("profile", { profile: r.profile }, { deviceId: deviceId(), images }));
  renderChrome();
}

function wire(root) {
  root.querySelectorAll("[data-post-text]").forEach((el) => {
    const id = el.closest("[data-post]").getAttribute("data-post");
    const post = [...editorModel().merged.chunks.flat(), ...basePage().chunks.flat()].find((p) => p.id === id);
    el.textContent = post?.text ?? "";
  });
  $("pe-bio").addEventListener("input", updateBioCount);
  root.querySelectorAll("[data-link-url]").forEach((input) =>
    input.addEventListener("input", () => {
      const i = Number(input.getAttribute("data-link-url"));
      const url = input.value.trim();
      root.querySelector(`[data-link-site="${i}"]`).textContent = checkVoiciLinkUrl(url, true) ? "" : siteLabel(voiciLinkSite(url));
    }),
  );
  // A field becomes a draft when it's left (change), not on every key; every key goes into the working copy
  // (`form`), so a redraw meanwhile (another field turned into a draft) keeps what is being typed.
  for (const el of root.querySelectorAll("#pe-name, #pe-bio, [data-link-url], [data-link-label]")) {
    el.addEventListener("input", () => readForm(root));
    el.addEventListener("change", () => {
      readForm(root);
      void commitProfile();
    });
  }
  $("pe-photo-pick").addEventListener("click", () => $("pe-photo").click());
  $("pe-photo").addEventListener("change", (ev) => void pickPhoto(ev.target.files?.[0]));
  $("pe-photo-remove")?.addEventListener("click", () => {
    readForm(root);
    form.avatar = null;
    void commitProfile().then(render);
  });
  $("pe-link-add")?.addEventListener("click", () => {
    readForm(root);
    form.links.push({ url: "", label: "", site: null });
    render();
    root.querySelector(`[data-link-url="${form.links.length - 1}"]`)?.focus();
  });
  const move = (i, d) => {
    readForm(root);
    const [l] = form.links.splice(i, 1);
    form.links.splice(i + d, 0, l);
    void commitProfile().then(render);
  };
  root.querySelectorAll("[data-link-up]").forEach((b) => b.addEventListener("click", () => move(Number(b.getAttribute("data-link-up")), -1)));
  root.querySelectorAll("[data-link-down]").forEach((b) => b.addEventListener("click", () => move(Number(b.getAttribute("data-link-down")), 1)));
  root.querySelectorAll("[data-link-remove]").forEach((b) =>
    b.addEventListener("click", () => {
      readForm(root);
      form.links.splice(Number(b.getAttribute("data-link-remove")), 1);
      void commitProfile().then(render);
    }),
  );
  root.querySelectorAll("[data-theme]").forEach((b) =>
    b.addEventListener("click", () => {
      readForm(root);
      form.theme = b.getAttribute("data-theme");
      void commitProfile().then(render);
    }),
  );
  $("pe-accepts").addEventListener("change", (ev) => void addOp(makeDraftOp("accept-messages", { accepts: ev.target.checked ? 1 : 0 }, { deviceId: deviceId() })));
  $("pe-post-add").addEventListener("click", () => void addPost());
  root.querySelectorAll("[data-post-edit]").forEach((b) => b.addEventListener("click", () => void editPost(b.getAttribute("data-post-edit"))));
  root.querySelectorAll("[data-post-delete]").forEach((b) => b.addEventListener("click", () => void deletePost(b.getAttribute("data-post-delete"))));
  root.querySelectorAll("[data-card-remove]").forEach((b) => {
    const [id, i] = b.getAttribute("data-card-remove").split(":");
    b.addEventListener("click", () => void removeCard(id, Number(i)));
  });
  $("pe-publish")?.addEventListener("click", () => void publishPending());
  $("pe-copy")?.addEventListener("click", () => void copyLink());
  $("pe-share")?.addEventListener("click", () => void shareLink());
  wirePublicSwitches(root);
}

// ── changes ───────────────────────────────────────────────────────────────

async function pickPhoto(file) {
  if (!file) return;
  readForm($("page-editor-content"));
  try {
    const { sha } = await pickAvatar(file);
    form.avatar = sha;
    await commitProfile();
    render();
  } catch (e) {
    toast(avatarProblemText(e), "err");
  }
}

/** A change from the editor: always a draft, published with the bar. */
async function addOp(op) {
  await addPageOp(op);
  render();
}

function postFrom(text, prev) {
  const links = findVoiciLinks(text)
    .filter((l) => !checkVoiciLinkUrl(l.url))
    .slice(0, VOICI_POST_MAX_LINKS)
    .map((l) => ({ url: l.url, card: prev?.links.find((x) => x.url === l.url)?.card ?? null }));
  const now = Date.now();
  return { id: prev?.id ?? hex(crypto.getRandomValues(new Uint8Array(16))), createdAt: prev?.createdAt ?? now, editedAt: prev ? now : null, text, links };
}

async function addPost() {
  const ta = $("pe-post-text");
  const p = prepareVoiciText("postText", ta.value);
  if (!p.ok) return void toast(voiciTextProblem(p.code, 2000), "err");
  await addOp(makeDraftOp("post-add", { post: postFrom(p.text, null) }, { deviceId: deviceId() }));
}

function findPost(id) {
  return editorModel().merged.chunks.flat().find((p) => p.id === id) ?? null;
}

async function editPost(id) {
  const prev = findPost(id);
  if (!prev) return;
  const text = await inlinePrompt({
    title: tr("Edit post"),
    initial: prev.text,
    okLabel: tr("Save"),
    validate: (v) => {
      const p = prepareVoiciText("postText", v);
      return p.ok ? "" : voiciTextProblem(p.code, 2000);
    },
  });
  if (text === null || text === undefined) return;
  const p = prepareVoiciText("postText", text);
  if (!p.ok) return;
  await addOp(makeDraftOp("post-edit", { post: postFrom(p.text, prev) }, { deviceId: deviceId() }));
}

async function deletePost(id) {
  const ok = await inlineConfirm({ title: tr("Delete this post?"), message: tr("It's removed from your page when the change is published."), okLabel: tr("Delete"), danger: true });
  if (!ok) return;
  await addOp(makeDraftOp("post-delete", { postId: id }, { deviceId: deviceId() }));
}

async function removeCard(id, i) {
  const prev = findPost(id);
  if (!prev?.links[i]) return;
  const post = { ...prev, editedAt: Date.now(), links: prev.links.map((l, k) => (k === i ? { url: l.url, card: null } : l)) };
  await addOp(makeDraftOp("post-edit", { post }, { deviceId: deviceId() }));
}

/** Records one change: an admin device publishes it (once the page exists); any other device hands it over. */
async function copyLink() {
  try {
    await navigator.clipboard.writeText(voiciPageUrl(username()));
    toast(tr("Link copied."));
  } catch {
    toast(voiciPageUrl(username()));
  }
}

async function shareLink() {
  const url = voiciPageUrl(username());
  if (navigator.share) {
    try {
      await navigator.share({ url });
      return;
    } catch {
      /* cancelled: nothing to do */
      return;
    }
  }
  await copyLink();
}


export async function enterPageEditor() {
  show("view-page-editor");
  form = null;
  if (!world.pageLoaded) {
    $("page-editor-content").innerHTML = skeletonCards(3);
    await refreshWorld();
  }
  render();
}

const editing = () => {
  const a = document.activeElement;
  return !!a && !!$("page-editor-content")?.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== "checkbox";
};

export function initPageEditorView() {
  $("page-editor-back")?.addEventListener("click", () => void import("./messages.js").then((m) => m.enterMessages()));
  // The switch, a publish or a refresh elsewhere: draw again, unless the owner is typing here.
  // Next task: a change made while leaving a field is reported before the focus lands on the next one.
  onWorldChange(() => {
    setTimeout(() => {
      if ($("view-page-editor")?.classList.contains("hidden") || editing()) return;
      render();
    }, 0);
  });
}
