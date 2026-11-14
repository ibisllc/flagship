// The Social tab's Profile (docs/social-tab.md §1.2, §1.3; docs/voici-and-messages.md §2, §5): the page drawn the way
// voi.ci draws it, in its theme, and edited in place. Photo, name and bio each have a pencil; links have Edit links;
// posts have New post and their own menu; Page options (behind the title row's ⋯) holds the theme, the link, Accept
// messages, the visitor-side settings and Remove page. Every edit is a draft; one bar shows only while something is
// unpublished ("3 changes not published · Publish"). Any device of the account edits; only an admin device signs the
// page, so on any other device the bar says it is waiting for one and the changes go to it as sealed drafts.
//
// F: the webapp makes no link cards (its CSP reaches only Flagship's own hosts, and a site's page can't be read
// cross-origin), so its posts carry their links with `card: null`; a card made on a phone can still be removed here.
// Links are reordered with Up and Down buttons rather than dragged.
//
// Every value reaches the page through properties (textContent, value, src), never markup.

import { $ } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { formatWhen } from "../lib/dateFormat.js";
import { buildOverlay, ensureHost, inlineAlert, inlineChoice, inlineConfirm } from "../lib/modal.js";
import { getActiveProfile } from "../lib/profiles.js";
import { emitWorld, world } from "../lib/voiciWorld.js";
import {
  checkVoiciLinkUrl,
  findVoiciLinks,
  hex,
  parseVoiciProfile,
  prepareVoiciText,
  VOICI_THEMES,
  voiciLinkSite,
  voiciUrlHost,
  VOICI_PROFILE_MAX_LINKS,
  VOICI_POST_MAX_LINKS,
} from "../lib/voiciProtocol.js";
import { makeDraftOp, postsNewestFirst, publishVoiciPage, voiciPageUrl } from "../lib/voiciOwner.js";
import {
  addPageOp,
  avatarProblemText,
  basePage,
  canPublishPage,
  editorModel,
  pageBusy,
  pageUsername,
  pickAvatar,
  profileOp,
  publishPending,
  removePage,
} from "../lib/voiciPageControl.js";
import { avatarUrl, displayUrl } from "./page-header.js";
import { copyIcon, moreHorizontalIcon, pencilIcon, plusIcon, sendIcon, userIcon, xIcon } from "../lib/icons.js";
import { VOICI_ACCEPT_NOTE, VOICI_NOT_PUBLISHED, VOICI_RULES_TEXT, VOICI_RULES_TITLE, VOICI_WAITING_ADMIN, voiciErrorText, voiciTextProblem } from "../lib/voiciCopy.js";

import { tr, trn } from "../lib/i18n.js";

const isAdmin = () => canPublishPage();
const deviceId = () => getActiveProfile()?.deviceId || "webapp";

/** The field open for editing ("name" | "bio" | null), what is typed in it, and the sentence under it. */
const edit = { field: null, name: "", bio: "", note: "" };

export { editorModel };

function pendingLabel() {
  return isAdmin() ? VOICI_NOT_PUBLISHED() : VOICI_WAITING_ADMIN();
}

export function themeName(t) {
  return t === "ink" ? tr("Ink") : t === "sea" ? tr("Sea") : tr("Classic");
}

/** The open field applied to the page's profile. */
function editedProfile(m = editorModel()) {
  const p = m.merged.profile;
  if (edit.field === "name") return { ...p, displayName: edit.name.trim() };
  if (edit.field === "bio") return { ...p, bio: edit.bio.trim() };
  return p;
}

/** The open field differs from the page: it counts as one change until Done or Publish records it. */
export function fieldChanged(m = editorModel()) {
  return edit.field !== null && JSON.stringify(editedProfile(m)) !== JSON.stringify(m.merged.profile);
}

/** How many changes the bar counts: the drafts, plus the open field when it is changed and no profile draft waits. */
export function unpublishedCount(m = editorModel()) {
  return m.ops.length + (fieldChanged(m) && !m.profilePending ? 1 : 0);
}

/** The bar's line: how many changes wait (admin devices), or that they wait for an admin device. */
export function publishBarText(count, admin, publishing = false) {
  if (publishing) return tr("Publishing your page…");
  if (!count) return "";
  return admin ? trn(count, "{0} change not published", "{0} changes not published") : VOICI_WAITING_ADMIN();
}

/** The edited profile as a valid profile, or the sentence saying why it isn't one. */
export function profileFromForm(f) {
  const name = prepareVoiciText("displayName", f.displayName);
  if (!name.ok) return { error: f.displayName.trim() ? voiciTextProblem(name.code, 64) : tr("Add a display name.") };
  const bio = prepareVoiciText("bio", f.bio);
  if (!bio.ok) return { error: voiciTextProblem(bio.code, 280) };
  const links = [];
  for (const l of f.links) {
    if (!l.url && !l.label) continue;
    if (checkVoiciLinkUrl(l.url, true)) return { error: tr("{0} isn't a link that can go on your page. Use an https:// address.", l.url || "…") };
    const label = prepareVoiciText("linkLabel", l.label || voiciUrlHost(l.url) || "");
    if (!label.ok) return { error: voiciTextProblem(label.code, 40) };
    links.push({ url: l.url, label: label.text, site: l.url.startsWith("mailto:") ? null : voiciLinkSite(l.url) });
  }
  if (links.filter((l) => l.url.startsWith("mailto:")).length > 1) return { error: tr("A page can have one email link.") };
  const profile = parseVoiciProfile({ v: 1, displayName: name.text, bio: bio.text, avatar: f.avatar ?? null, theme: f.theme, links });
  return profile ? { profile } : { error: tr("That profile can't be published.") };
}

/**
 * Records the open field, with `patch` applied, as one profile draft. False when a field is refused: the field stays
 * open with the sentence under it.
 */
export async function commitProfile(patch = {}, images = []) {
  const m = editorModel();
  const r = profileFromForm({ ...editedProfile(m), ...patch });
  if (r.error) {
    edit.note = r.error;
    renderProfile();
    return false;
  }
  edit.note = "";
  edit.field = null;
  renderProfile();
  if (JSON.stringify(r.profile) !== JSON.stringify(m.merged.profile)) await addPageOp(profileOp(r.profile, images));
  else emitWorld();
  return true;
}

/** Publish from the bar: the open field first, then every draft (the make-public steps first on a new page). */
async function publishFromBar() {
  if (edit.field && !(await commitProfile())) return;
  await publishPending();
}

// ── render ────────────────────────────────────────────────────────────────

function pencilButton(id, label) {
  return `<button type="button" class="vp-pencil" id="${id}" aria-label="${escapeHtml(label)}"><span class="icon" aria-hidden="true">${pencilIcon}</span></button>`;
}

function nameHtml(m) {
  if (edit.field === "name") {
    return `<div class="vp-edit-row">
        <label class="visually-hidden" for="page-display-name">${escapeHtml(tr("Display name"))}</label>
        <input id="page-display-name" class="vp-input vp-input-name" maxlength="64" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(pageUsername())}" />
        <button type="button" class="vp-done" id="page-edit-done">${escapeHtml(tr("Done"))}</button>
      </div>`;
  }
  return `<div class="vp-line"><h3 class="vp-name" data-testid="page-name-text"></h3>${edit.field ? "" : pencilButton("page-edit-name", tr("Edit display name"))}</div>`;
}

function bioHtml(m) {
  if (edit.field === "bio") {
    return `<div class="vp-edit-col">
        <label class="visually-hidden" for="page-bio">${escapeHtml(tr("Bio"))}</label>
        <textarea id="page-bio" class="vp-input" rows="3"></textarea>
        <div class="vp-edit-foot"><span class="vp-muted" id="page-bio-count"></span><button type="button" class="vp-done" id="page-edit-done">${escapeHtml(tr("Done"))}</button></div>
      </div>`;
  }
  const empty = !m.merged.profile.bio;
  return `<div class="vp-line"><p class="vp-bio${empty ? " vp-muted" : ""}" data-testid="page-bio-text"></p>${edit.field ? "" : pencilButton("page-edit-bio", tr("Edit bio"))}</div>`;
}

function linksHtml(links) {
  return links
    .map(
      (l, i) => `<div class="vp-link" data-link="${i}">
        <span class="vp-link-icon" aria-hidden="true">${l.url.startsWith("mailto:") ? "@" : "↗"}</span>
        <span class="vp-link-body"><span class="vp-link-label" data-link-label></span><span class="vp-link-host mono" data-link-host></span></span>
      </div>`,
    )
    .join("");
}

function postHtml(p, { pending = false, removing = false } = {}) {
  const label = removing ? tr("Removal not published yet") : pending ? pendingLabel() : "";
  return `
    <article class="vp-post${pending || removing ? " is-pending" : ""}" data-post="${escapeHtml(p.id)}" data-testid="${pending || removing ? "page-post-pending" : "page-post"}">
      <div class="vp-post-head">
        <span class="vp-muted mono">${escapeHtml(formatWhen(p.createdAt))}</span>
        ${label ? `<span class="vp-muted" data-post-pending>${escapeHtml(label)}</span>` : ""}
        ${removing ? "" : `<button type="button" class="vp-icon-btn" data-post-menu="${escapeHtml(p.id)}" aria-label="${escapeHtml(tr("Post options"))}"><span class="icon" aria-hidden="true">${moreHorizontalIcon}</span></button>`}
      </div>
      <p class="vp-post-text" data-post-text></p>
      ${p.links
        .filter((l) => l.card)
        .map((l) => `<div class="vp-card"><span class="vp-card-title">${escapeHtml(l.card.title)}</span><span class="vp-muted mono">${escapeHtml(l.card.site || voiciUrlHost(l.url) || "")}</span></div>`)
        .join("")}
    </article>`;
}

/** Draws the Profile into `#social-profile` (and the bar), keeping the field being typed in. */
export function renderProfile() {
  const root = $("social-profile");
  if (!root) return;
  const typing = edit.field && document.activeElement && root.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (typing) {
    const n = root.querySelector("[data-profile-note]");
    if (n) {
      n.textContent = edit.note;
      n.classList.toggle("hidden", !edit.note);
    }
    renderBar();
    return;
  }
  const m = editorModel();
  const p = m.merged.profile;
  const posts = postsNewestFirst(m.merged.chunks);
  const photoLabel = p.avatar ? tr("Change photo") : tr("Add photo");
  root.innerHTML = `
    <div class="vp" data-page-theme="${escapeHtml(p.theme)}" data-testid="social-profile">
      <div class="vp-head${m.profilePending ? " is-pending" : ""}">
        <div class="vp-photo">
          ${avatarUrl(p.avatar) ? `<img class="vp-avatar" id="page-avatar-img" alt="" />` : `<span class="vp-avatar vp-avatar-empty icon" aria-hidden="true">${userIcon}</span>`}
          <button type="button" class="vp-pencil vp-photo-pencil" id="page-edit-photo" aria-label="${escapeHtml(photoLabel)}"><span class="icon" aria-hidden="true">${pencilIcon}</span></button>
          <input type="file" id="page-photo" accept="image/*" hidden />
        </div>
        ${nameHtml(m)}
        ${bioHtml(m)}
        <p class="vp-err${edit.note ? "" : " hidden"}" data-profile-note role="alert"></p>
        ${m.profilePending ? `<p class="vp-muted" data-testid="page-pending-note">${escapeHtml(pendingLabel())}</p>` : ""}
        <div class="vp-links">${linksHtml(p.links)}</div>
        <button type="button" class="vp-text-btn" id="page-edit-links"><span class="icon" aria-hidden="true">${pencilIcon}</span>${escapeHtml(p.links.length ? tr("Edit links") : tr("Add link"))}</button>
      </div>
      <div class="vp-posts-head">
        <h3 class="vp-label mono">${escapeHtml(tr("Posts"))}</h3>
        <button type="button" class="vp-fill-btn" id="page-new-post-open"><span class="icon" aria-hidden="true">${plusIcon}</span>${escapeHtml(tr("New post"))}</button>
      </div>
      ${!posts.length && !m.removing.length ? `<p class="vp-muted vp-empty">${escapeHtml(tr("No posts yet."))}</p>` : ""}
      ${m.removing.map((x) => postHtml(x, { removing: true })).join("")}
      ${posts.map((x) => postHtml(x, { pending: m.pendingPosts.has(x.id) })).join("")}
    </div>`;

  const nameText = root.querySelector("[data-testid=page-name-text]");
  if (nameText) nameText.textContent = p.displayName || pageUsername();
  const bioText = root.querySelector("[data-testid=page-bio-text]");
  if (bioText) bioText.textContent = p.bio || tr("Add a short bio");
  const note = root.querySelector("[data-profile-note]");
  note.textContent = edit.note;
  if (avatarUrl(p.avatar)) $("page-avatar-img").src = avatarUrl(p.avatar);
  p.links.forEach((l, i) => {
    const row = root.querySelector(`[data-link="${i}"]`);
    row.querySelector("[data-link-label]").textContent = l.label;
    row.querySelector("[data-link-host]").textContent = l.url.startsWith("mailto:") ? l.url.slice(7) : voiciUrlHost(l.url) ?? "";
  });
  root.querySelectorAll("[data-post-text]").forEach((el) => {
    const id = el.closest("[data-post]").getAttribute("data-post");
    const post = [...m.merged.chunks.flat(), ...basePage().chunks.flat()].find((x) => x.id === id);
    el.textContent = post?.text ?? "";
  });
  wireProfile(root);
  renderBar(m);
}

function wireProfile(root) {
  const name = $("page-display-name");
  if (name) {
    name.value = edit.name;
    name.addEventListener("input", () => {
      edit.name = name.value;
      renderBar();
    });
    name.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void commitProfile();
      } else if (ev.key === "Escape") {
        edit.field = null;
        edit.note = "";
        renderProfile();
      }
    });
    queueMicrotask(() => name.focus({ preventScroll: true }));
  }
  const bio = $("page-bio");
  if (bio) {
    bio.value = edit.bio;
    const count = () => ($("page-bio-count").textContent = `${[...bio.value.normalize("NFC")].length} / 280`);
    count();
    bio.addEventListener("input", () => {
      edit.bio = bio.value;
      count();
      renderBar();
    });
    queueMicrotask(() => bio.focus({ preventScroll: true }));
  }
  $("page-edit-done")?.addEventListener("click", () => void commitProfile());
  $("page-edit-name")?.addEventListener("click", () => beginEdit("name"));
  $("page-edit-bio")?.addEventListener("click", () => beginEdit("bio"));
  $("page-edit-photo").addEventListener("click", () => void photoMenu());
  $("page-photo").addEventListener("change", (ev) => void pickPhoto(ev.target.files?.[0]));
  $("page-edit-links").addEventListener("click", () => openLinksSheet());
  $("page-new-post-open").addEventListener("click", () => openPostSheet(null));
  root.querySelectorAll("[data-post-menu]").forEach((b) => b.addEventListener("click", () => void postMenu(b.getAttribute("data-post-menu"))));
}

function beginEdit(field) {
  const p = editorModel().merged.profile;
  edit.field = field;
  edit.name = p.displayName;
  edit.bio = p.bio;
  edit.note = "";
  renderProfile();
}

// ── the publish bar ───────────────────────────────────────────────────────

/** The bar above the tab bar, only while something is unpublished; it spins while the page is signed. */
export function renderBar(m = editorModel()) {
  const slot = $("pe-bar-slot");
  if (!slot) return;
  if ($("social-profile")?.classList.contains("hidden") && !pageBusy()) {
    slot.replaceChildren();
    return;
  }
  const admin = isAdmin();
  const publishing = pageBusy();
  const text = publishBarText(unpublishedCount(m), admin, publishing);
  if (!text) {
    slot.replaceChildren();
    return;
  }
  slot.innerHTML = `<div class="pe-bar" data-testid="pe-publish-bar" role="region" aria-label="${escapeHtml(tr("Changes"))}">
      <span class="pe-bar-text" data-testid="pe-bar-text" aria-live="polite"></span>
      ${admin ? `<button type="button" id="pe-publish"${publishing ? ` disabled aria-busy="true"` : ""}>${publishing ? `<span class="spinner" aria-hidden="true"></span>` : escapeHtml(tr("Publish"))}</button>` : ""}
    </div>`;
  slot.querySelector("[data-testid=pe-bar-text]").textContent = text;
  $("pe-publish")?.addEventListener("click", () => void publishFromBar());
}

// ── photo, links, posts ───────────────────────────────────────────────────

async function photoMenu() {
  const p = editorModel().merged.profile;
  if (!p.avatar) return void $("page-photo").click();
  const pick = await inlineChoice({
    title: tr("Change photo"),
    choices: [
      { id: "remove", label: tr("Remove photo"), secondary: true, danger: true },
      { id: "change", label: tr("Change photo") },
    ],
  });
  if (pick === "change") $("page-photo").click();
  else if (pick === "remove") await commitProfile({ avatar: null });
}

async function pickPhoto(file) {
  if (!file) return;
  try {
    const { sha, bytes } = await pickAvatar(file);
    // The photo rides in the draft, so it survives a reload and reaches the other devices.
    await commitProfile({ avatar: sha }, [bytes]);
  } catch (e) {
    toast(avatarProblemText(e), "err");
  }
}

/** A sheet over the tab: a title, Done, and the body `build` fills. Escape, a tap outside and Done close it. */
function openSheet({ title, testid, build, onClose }) {
  const host = ensureHost();
  const overlay = buildOverlay();
  overlay.innerHTML = `
    <div class="modal-card vp-sheet" role="document" data-testid="${testid}">
      <div class="vp-sheet-head">
        <h3 class="modal-title"></h3>
        <button type="button" class="secondary" data-sheet-done>${escapeHtml(tr("Done"))}</button>
      </div>
      <div data-sheet-body></div>
    </div>`;
  overlay.querySelector(".modal-title").textContent = title;
  host.appendChild(overlay);
  document.body.classList.add("modal-open");
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.body.classList.remove("modal-open");
    document.removeEventListener("keydown", onKey);
    onClose?.();
  }
  overlay.querySelector("[data-sheet-done]").addEventListener("click", close);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  build(overlay.querySelector("[data-sheet-body]"), close);
  queueMicrotask(() => overlay.querySelector("[data-sheet-done]")?.focus({ preventScroll: true }));
  return close;
}

/** Edit links: reorder, remove, add (at most VOICI_PROFILE_MAX_LINKS). Recorded as one draft when it closes. */
function openLinksSheet() {
  const links = structuredClone(editorModel().merged.profile.links);
  const start = JSON.stringify(links);
  openSheet({
    title: tr("Links"),
    testid: "page-links-sheet",
    onClose: () => {
      if (JSON.stringify(links) !== start) void commitProfile({ links });
    },
    build: (body) => {
      const draw = () => {
        body.innerHTML = `
          <div class="fs-group" data-links-list>
            ${links
              .map(
                (l, i) => `<div class="fs-row vp-link-edit" data-link-row="${i}">
                  <span class="fs-row-body"><span class="fs-row-title" data-l></span><span class="fs-row-subtitle mono" data-h></span></span>
                  <button type="button" class="ghost" data-up="${i}" aria-label="${escapeHtml(tr("Move up"))}"${i === 0 ? " disabled" : ""}>↑</button>
                  <button type="button" class="ghost" data-down="${i}" aria-label="${escapeHtml(tr("Move down"))}"${i === links.length - 1 ? " disabled" : ""}>↓</button>
                  <button type="button" class="ghost" data-remove="${i}" aria-label="${escapeHtml(tr("Remove"))}"><span class="icon" aria-hidden="true">${xIcon}</span></button>
                </div>`,
              )
              .join("")}
          </div>
          ${
            links.length < VOICI_PROFILE_MAX_LINKS
              ? `<div class="stack-sm mt-3" data-add-form>
              <h4>${escapeHtml(tr("Add link"))}</h4>
              <label for="link-label">${escapeHtml(tr("Label"))}</label>
              <input id="link-label" maxlength="40" />
              <label for="link-url">${escapeHtml(tr("Link address"))}</label>
              <input id="link-url" inputmode="url" placeholder="https://" />
              <p class="pe-error hidden" id="link-problem" role="alert"></p>
              <button type="button" class="secondary" id="link-add">${escapeHtml(tr("Add"))}</button>
            </div>`
              : ""
          }`;
        links.forEach((l, i) => {
          const row = body.querySelector(`[data-link-row="${i}"]`);
          row.querySelector("[data-l]").textContent = l.label;
          row.querySelector("[data-h]").textContent = l.url.startsWith("mailto:") ? l.url.slice(7) : voiciUrlHost(l.url) ?? "";
        });
        const move = (i, d) => {
          const [l] = links.splice(i, 1);
          links.splice(i + d, 0, l);
          draw();
        };
        body.querySelectorAll("[data-up]").forEach((b) => b.addEventListener("click", () => move(Number(b.getAttribute("data-up")), -1)));
        body.querySelectorAll("[data-down]").forEach((b) => b.addEventListener("click", () => move(Number(b.getAttribute("data-down")), 1)));
        body.querySelectorAll("[data-remove]").forEach((b) =>
          b.addEventListener("click", () => {
            links.splice(Number(b.getAttribute("data-remove")), 1);
            draw();
          }),
        );
        body.querySelector("#link-add")?.addEventListener("click", () => {
          const url = body.querySelector("#link-url").value.trim();
          const mailto = url.startsWith("mailto:");
          const label = prepareVoiciText("linkLabel", body.querySelector("#link-label").value.trim() || voiciUrlHost(url) || "");
          const problem = checkVoiciLinkUrl(url, true)
            ? tr("{0} isn't a link that can go on your page. Use an https:// address.", url || "…")
            : mailto && links.some((l) => l.url.startsWith("mailto:"))
              ? tr("A page can have one email link.")
              : !label.ok
                ? tr("Give the link a short label (40 characters at most).")
                : "";
          if (problem) {
            const el = body.querySelector("#link-problem");
            el.textContent = problem;
            el.classList.remove("hidden");
            return;
          }
          links.push({ url, label: label.text, site: mailto ? null : voiciLinkSite(url) });
          draw();
        });
      };
      draw();
    },
  });
}

function postFrom(text, prev) {
  const links = findVoiciLinks(text)
    .filter((l) => !checkVoiciLinkUrl(l.url))
    .slice(0, VOICI_POST_MAX_LINKS)
    .map((l) => ({ url: l.url, card: prev?.links.find((x) => x.url === l.url)?.card ?? null }));
  const now = Date.now();
  return { id: prev?.id ?? hex(crypto.getRandomValues(new Uint8Array(16))), createdAt: prev?.createdAt ?? now, editedAt: prev ? now : null, text, links };
}

function findPost(id) {
  return editorModel().merged.chunks.flat().find((p) => p.id === id) ?? null;
}

/** New post, or a post's Edit: the text (2,000 characters) and Add post / Save. */
function openPostSheet(prev) {
  openSheet({
    title: prev ? tr("Edit post") : tr("New post"),
    testid: "page-post-sheet",
    build: (body, close) => {
      body.innerHTML = `
        <label class="visually-hidden" for="post-text">${escapeHtml(tr("Write a post"))}</label>
        <textarea id="post-text" rows="6" placeholder="${escapeHtml(tr("Write a post"))}"></textarea>
        <p class="pe-error hidden" id="post-problem" role="alert"></p>
        <button type="button" class="mt-2 full-width" id="post-save">${escapeHtml(prev ? tr("Save") : tr("Add post"))}</button>`;
      const ta = body.querySelector("#post-text");
      ta.value = prev?.text ?? "";
      queueMicrotask(() => ta.focus({ preventScroll: true }));
      body.querySelector("#post-save").addEventListener("click", async () => {
        const p = prepareVoiciText("postText", ta.value);
        if (!p.ok) {
          const el = body.querySelector("#post-problem");
          el.textContent = voiciTextProblem(p.code, 2000);
          el.classList.remove("hidden");
          return;
        }
        close();
        await addPageOp(makeDraftOp(prev ? "post-edit" : "post-add", { post: postFrom(p.text, prev) }, { deviceId: deviceId() }));
      });
    },
  });
}

async function postMenu(id) {
  const post = findPost(id);
  if (!post) return;
  const choices = [{ id: "edit", label: tr("Edit"), secondary: true }];
  if (post.links.some((l) => l.card)) choices.push({ id: "cards", label: tr("Remove link cards"), secondary: true });
  choices.push({ id: "delete", label: tr("Delete"), danger: true });
  const pick = await inlineChoice({ title: tr("Post options"), choices });
  if (pick === "edit") openPostSheet(post);
  else if (pick === "cards") {
    const next = { ...post, editedAt: Date.now(), links: post.links.map((l) => ({ url: l.url, card: null })) };
    await addPageOp(makeDraftOp("post-edit", { post: next }, { deviceId: deviceId() }));
  } else if (pick === "delete") {
    const ok = await inlineConfirm({ title: tr("Delete this post?"), message: tr("It's removed from your page when the change is published."), okLabel: tr("Delete"), danger: true });
    if (ok) await addPageOp(makeDraftOp("post-delete", { postId: id }, { deviceId: deviceId() }));
  }
}

// ── Page options ──────────────────────────────────────────────────────────

async function copyLink() {
  try {
    await navigator.clipboard.writeText(voiciPageUrl(pageUsername()));
    toast(tr("Link copied."));
  } catch {
    toast(voiciPageUrl(pageUsername()));
  }
}

async function shareLink() {
  const url = voiciPageUrl(pageUsername());
  if (navigator.share) {
    try {
      await navigator.share({ url });
    } catch {
      /* cancelled: nothing to do */
    }
    return;
  }
  await copyLink();
}

/** Behind the title row's ⋯: the theme, the link, Accept messages, the visitor-side settings and Remove page. */
export function openPageOptions() {
  let redraw = () => {};
  openSheet({
    title: tr("Page options"),
    testid: "page-options-sheet",
    build: (body, close) => {
      redraw = () => {
        const m = editorModel();
        const admin = isAdmin();
        const on = Boolean(world.page);
        const canRotate = admin && on;
        body.innerHTML = `
          <h4>${escapeHtml(tr("Theme"))}</h4>
          <div class="vp-themes" role="radiogroup" aria-label="${escapeHtml(tr("Theme"))}">
            ${VOICI_THEMES.map((t) => `<button type="button" role="radio" class="vp vp-swatch" data-page-theme="${t}" data-theme-pick="${t}" aria-checked="${m.merged.profile.theme === t}">${escapeHtml(themeName(t))}</button>`).join("")}
          </div>
          ${
            on
              ? `<div class="fs-group mt-3">
              <button type="button" class="fs-row" id="page-copy-link"><span class="fs-row-icon icon" aria-hidden="true">${copyIcon}</span><span class="fs-row-body"><span class="fs-row-title">${escapeHtml(tr("Copy link"))}</span></span></button>
              <button type="button" class="fs-row" id="page-share"><span class="fs-row-icon icon" aria-hidden="true">${sendIcon}</span><span class="fs-row-body"><span class="fs-row-title">${escapeHtml(tr("Share"))}</span></span></button>
            </div>
            <p class="note mono" data-testid="page-options-url"></p>`
              : ""
          }
          <div class="fs-group mt-3${m.acceptsPending ? " is-pending" : ""}">
            <div class="fs-row">
              <span class="fs-row-body"><span class="fs-row-title" id="page-accepts-label">${escapeHtml(tr("Accept messages"))}</span>
              ${m.acceptsPending ? `<span class="fs-row-subtitle" data-testid="accepts-pending">${escapeHtml(pendingLabel())}</span>` : ""}</span>
              <button type="button" role="switch" class="fs-switch" id="page-accepts" aria-labelledby="page-accepts-label" aria-checked="${Boolean(m.merged.acceptsMessages)}"><span class="fs-switch-thumb" aria-hidden="true"></span></button>
            </div>
          </div>
          <p class="note">${escapeHtml(VOICI_ACCEPT_NOTE())}</p>
          <div class="fs-group mt-3">
            <button type="button" class="fs-row" id="page-signed-in-sites"><span class="fs-row-body"><span class="fs-row-title">${escapeHtml(tr("Websites you're signed in to"))}</span></span></button>
            ${canRotate ? `<button type="button" class="fs-row" id="page-rotate"><span class="fs-row-body"><span class="fs-row-title">${escapeHtml(tr("Rotate inbox key"))}</span></span></button>` : ""}
            <button type="button" class="fs-row" id="page-rules"><span class="fs-row-body"><span class="fs-row-title">${escapeHtml(VOICI_RULES_TITLE())}</span></span></button>
          </div>
          ${canRotate ? `<p class="note">${escapeHtml(tr("New messages are sealed to a new key. This device keeps reading the old ones."))}</p>` : ""}
          ${admin && on ? `<div class="fs-group mt-3"><button type="button" class="fs-row fs-row-danger" id="page-remove"><span class="fs-row-body"><span class="fs-row-title">${escapeHtml(tr("Remove page"))}</span></span></button></div>` : ""}`;
        const url = body.querySelector("[data-testid=page-options-url]");
        if (url) url.textContent = displayUrl();
        body.querySelectorAll("[data-theme-pick]").forEach((b) =>
          b.addEventListener("click", async () => {
            await commitProfile({ theme: b.getAttribute("data-theme-pick") });
            redraw();
          }),
        );
        body.querySelector("#page-copy-link")?.addEventListener("click", () => void copyLink());
        body.querySelector("#page-share")?.addEventListener("click", () => void shareLink());
        body.querySelector("#page-accepts").addEventListener("click", async (ev) => {
          const want = ev.currentTarget.getAttribute("aria-checked") !== "true";
          await addPageOp(makeDraftOp("accept-messages", { accepts: want ? 1 : 0 }, { deviceId: deviceId() }));
          redraw();
        });
        body.querySelector("#page-signed-in-sites").addEventListener("click", () => {
          close();
          void import("./messages.js").then((mod) => mod.enterSignedInSites());
        });
        body.querySelector("#page-rotate")?.addEventListener("click", () => void rotateInbox());
        body.querySelector("#page-rules").addEventListener("click", () => void inlineAlert({ title: VOICI_RULES_TITLE(), message: VOICI_RULES_TEXT() }));
        body.querySelector("#page-remove")?.addEventListener("click", () => {
          close();
          void removePage();
        });
      };
      redraw();
    },
  });
}

async function rotateInbox() {
  const ok = await inlineConfirm({ title: tr("Rotate your inbox key?"), message: tr("Your page is published again with the new key."), okLabel: tr("Rotate") });
  if (!ok || !world.page) return;
  try {
    world.page = await publishVoiciPage({ ops: [], rotate: true }, { published: world.page });
    emitWorld();
    toast(tr("Inbox key rotated."));
  } catch (e) {
    toast(voiciErrorText(e), "err");
  }
}

export const isEditingField = () => edit.field !== null;

export function resetProfileEdit() {
  edit.field = null;
  edit.note = "";
}
