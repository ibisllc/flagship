// The voi.ci page editor (docs/voici-and-messages.md §2, §5, §11.2). Any device of the account edits; only an admin
// device signs the page. A change that isn't in a published index yet is shown grayed ("Not published yet"); on a
// device without the admin root it goes to the admin device as a sealed draft ("Waiting for an admin device to
// publish"). An admin device publishes at once once the page exists; the first publish waits for Publish and the
// warning that the page can be linked to the owner's apps and servers (O1).
//
// F: the webapp makes no link cards (its CSP reaches only Flagship's own hosts, and a site's page can't be read
// cross-origin), so its posts carry their links with `card: null`; a card made on a phone can still be removed here.
// Links are reordered with Up and Down buttons rather than dragged.

import { $, registerView, show } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { formatWhen } from "../lib/dateFormat.js";
import { inlineConfirm, inlinePrompt } from "../lib/modal.js";
import { canSignAdminOrders } from "../lib/addServerGate.js";
import { getSession } from "../lib/state.js";
import { getActiveProfile } from "../lib/profiles.js";
import {
  checkVoiciLinkUrl,
  findVoiciLinks,
  hex,
  parseVoiciProfile,
  prepareVoiciText,
  sha256Hex,
  VOICI_LINK_SITES,
  voiciLinkSite,
  VOICI_THEMES,
  voiciUrlHost,
  VOICI_PROFILE_MAX_LINKS,
  VOICI_POST_MAX_LINKS,
} from "../lib/voiciProtocol.js";
import { mergeVoiciPage } from "../lib/voiciProtocol.js";
import { consumeDraftOps, defaultVoiciProfile, makeDraftOp, opImages, postsNewestFirst, publishVoiciPage, sendDraftOp, voiciPageUrl } from "../lib/voiciOwner.js";
import { jpegUrl, reencodeAvatar } from "../lib/voiciImage.js";
import { emitWorld, pendingOps, refreshWorld, world } from "../lib/voiciWorld.js";
import {
  VOICI_ACCEPT_NOTE,
  VOICI_NOT_PUBLISHED,
  VOICI_PAGE_WARNING,
  VOICI_RULES_TEXT,
  VOICI_RULES_TITLE,
  VOICI_WAITING_ADMIN,
  voiciErrorText,
  voiciTextProblem,
} from "../lib/voiciCopy.js";

import { tr, trn } from "../lib/i18n.js";

registerView("view-page-editor", { tab: "messages" });

const RULES_KEY = "flagship.voici.rulesAccepted.v1";
/** Photos picked on this device, sha256 → JPEG bytes (a draft carries them to the admin device). */
const localImages = new Map();
/** The profile form as edited, until Save. */
let form = null;
let busy = false;

const username = () => String(getSession()?.username ?? "").toLowerCase();
const isAdmin = () => canSignAdminOrders();
const deviceId = () => getActiveProfile()?.deviceId || "webapp";

function basePage() {
  return world.page ?? { profile: defaultVoiciProfile(username()), acceptsMessages: 0, chunks: [], issuedAt: 0 };
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

function imageBytes(sha) {
  return localImages.get(sha) ?? world.page?.pieces?.get(sha) ?? opImages(pendingOps()).get(sha) ?? null;
}

function siteLabel(id) {
  return VOICI_LINK_SITES.find((s) => s.id === id)?.label ?? "";
}

function statusText(m) {
  if (!world.page && !m.ops.length) return tr("Not published");
  if (m.ops.length) return isAdmin() ? trn(m.ops.length, "{0} change not published", "{0} changes not published") : VOICI_WAITING_ADMIN();
  return tr("Published at {0}", voiciPageUrl(username()).replace(/^https:\/\//, ""));
}

function pendingLabel() {
  return isAdmin() ? VOICI_NOT_PUBLISHED() : VOICI_WAITING_ADMIN();
}

// ── render ────────────────────────────────────────────────────────────────

function render() {
  const root = $("page-editor-content");
  if (!root) return;
  const m = editorModel();
  if (!form) form = structuredClone(m.merged.profile);
  const avatar = form.avatar ? imageBytes(form.avatar) : null;
  const posts = postsNewestFirst(m.merged.chunks);
  const showPublish = isAdmin() && (m.ops.length > 0 || !world.page);
  root.innerHTML = `
    <p class="note" data-testid="page-status">${escapeHtml(statusText(m))}</p>
    <div class="card warn-card" data-testid="voici-warning">${escapeHtml(VOICI_PAGE_WARNING())}</div>

    <h3 class="mt-3">${escapeHtml(tr("Profile"))}${m.profilePending ? ` <span class="pill" data-testid="profile-pending">${escapeHtml(pendingLabel())}</span>` : ""}</h3>
    <div class="card stack-sm${m.profilePending ? " is-pending" : ""}">
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
      <button type="button" id="pe-save-profile" class="mt-2">${escapeHtml(tr("Save profile"))}</button>
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

    <div class="stack-sm mt-3">
      ${showPublish ? `<button type="button" id="pe-publish">${escapeHtml(tr("Publish"))}</button>` : ""}
      ${!isAdmin() ? `<p class="note" data-testid="page-admin-only">${escapeHtml(tr("Only an admin device can publish your page. Changes you make here wait for it."))}</p>` : ""}
      <div class="row-2">
        <button type="button" class="secondary" id="pe-copy"${world.page ? "" : " disabled"}>${escapeHtml(tr("Copy link"))}</button>
        <button type="button" class="secondary" id="pe-share"${world.page ? "" : " disabled"}>${escapeHtml(tr("Share"))}</button>
      </div>
    </div>`;

  // Values go in through properties, never markup.
  $("pe-name").value = form.displayName;
  $("pe-bio").value = form.bio;
  updateBioCount();
  form.links.forEach((l, i) => {
    root.querySelector(`[data-link-url="${i}"]`).value = l.url;
    root.querySelector(`[data-link-label="${i}"]`).value = l.label;
  });
  if (avatar) $("pe-avatar-img").src = jpegUrl(avatar);
  renderPreview(m);
  wire(root);
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
    img.src = jpegUrl(bytes);
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
    const url = root.querySelector(`[data-link-url="${i}"]`).value.trim();
    return { url, label: root.querySelector(`[data-link-label="${i}"]`).value, site: checkVoiciLinkUrl(url, true) ? null : voiciLinkSite(url) };
  });
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
  $("pe-photo-pick").addEventListener("click", () => $("pe-photo").click());
  $("pe-photo").addEventListener("change", (ev) => void pickPhoto(ev.target.files?.[0]));
  $("pe-photo-remove")?.addEventListener("click", () => {
    readForm(root);
    form.avatar = null;
    render();
  });
  $("pe-link-add")?.addEventListener("click", () => {
    readForm(root);
    form.links.push({ url: "", label: "", site: null });
    render();
  });
  const move = (i, d) => {
    readForm(root);
    const [l] = form.links.splice(i, 1);
    form.links.splice(i + d, 0, l);
    render();
  };
  root.querySelectorAll("[data-link-up]").forEach((b) => b.addEventListener("click", () => move(Number(b.getAttribute("data-link-up")), -1)));
  root.querySelectorAll("[data-link-down]").forEach((b) => b.addEventListener("click", () => move(Number(b.getAttribute("data-link-down")), 1)));
  root.querySelectorAll("[data-link-remove]").forEach((b) =>
    b.addEventListener("click", () => {
      readForm(root);
      form.links.splice(Number(b.getAttribute("data-link-remove")), 1);
      render();
    }),
  );
  root.querySelectorAll("[data-theme]").forEach((b) =>
    b.addEventListener("click", () => {
      readForm(root);
      form.theme = b.getAttribute("data-theme");
      render();
    }),
  );
  $("pe-save-profile").addEventListener("click", () => {
    readForm(root);
    void saveProfile();
  });
  $("pe-accepts").addEventListener("change", (ev) => void addOp(makeDraftOp("accept-messages", { accepts: ev.target.checked ? 1 : 0 }, { deviceId: deviceId() })));
  $("pe-post-add").addEventListener("click", () => void addPost());
  root.querySelectorAll("[data-post-edit]").forEach((b) => b.addEventListener("click", () => void editPost(b.getAttribute("data-post-edit"))));
  root.querySelectorAll("[data-post-delete]").forEach((b) => b.addEventListener("click", () => void deletePost(b.getAttribute("data-post-delete"))));
  root.querySelectorAll("[data-card-remove]").forEach((b) => {
    const [id, i] = b.getAttribute("data-card-remove").split(":");
    b.addEventListener("click", () => void removeCard(id, Number(i)));
  });
  $("pe-publish")?.addEventListener("click", () => void publishAndConsume({ ask: true }));
  $("pe-copy")?.addEventListener("click", () => void copyLink());
  $("pe-share")?.addEventListener("click", () => void shareLink());
}

// ── changes ───────────────────────────────────────────────────────────────

async function pickPhoto(file) {
  if (!file) return;
  readForm($("page-editor-content"));
  try {
    const bytes = await reencodeAvatar(file);
    const sha = sha256Hex(bytes);
    localImages.set(sha, bytes);
    form.avatar = sha;
    render();
  } catch (e) {
    toast(e?.code === "too-large" ? tr("That photo is too detailed to fit. Try another one.") : tr("That file couldn't be read as a photo."), "err");
  }
}

async function saveProfile() {
  const name = prepareVoiciText("displayName", form.displayName);
  if (!name.ok) return void toast(voiciTextProblem(name.code, 64), "err");
  const bio = prepareVoiciText("bio", form.bio);
  if (!bio.ok) return void toast(voiciTextProblem(bio.code, 280), "err");
  const links = [];
  for (const l of form.links) {
    if (!l.url && !l.label) continue;
    if (checkVoiciLinkUrl(l.url, true)) return void toast(tr("{0} isn't a link that can go on your page. Use an https:// address.", l.url || "…"), "err");
    const label = prepareVoiciText("linkLabel", l.label || voiciUrlHost(l.url) || "");
    if (!label.ok) return void toast(voiciTextProblem(label.code, 40), "err");
    links.push({ url: l.url, label: label.text, site: voiciLinkSite(l.url) });
  }
  if (links.filter((l) => l.url.startsWith("mailto:")).length > 1) return void toast(tr("A page can have one email link."), "err");
  const profile = parseVoiciProfile({ v: 1, displayName: name.text, bio: bio.text, avatar: form.avatar ?? null, theme: form.theme, links });
  if (!profile) return void toast(tr("That profile can't be published."), "err");
  const images = profile.avatar && localImages.has(profile.avatar) && !world.page?.pieces?.has(profile.avatar) ? [localImages.get(profile.avatar)] : [];
  form = null;
  await addOp(makeDraftOp("profile", { profile }, { deviceId: deviceId(), images }));
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
async function addOp(op) {
  if (busy) return;
  world.localOps.push(op);
  emitWorld();
  render();
  if (isAdmin()) {
    if (world.page) await publishAndConsume();
    return;
  }
  busy = true;
  try {
    const { envelope } = await sendDraftOp(op);
    // It is in the lane now: shown from there until the admin device publishes and consumes it.
    world.localOps = world.localOps.filter((o) => o.opId !== op.opId);
    world.drafts = [...world.drafts, { op, envelope }];
    toast(tr("Sent to your admin device to publish."));
  } catch (e) {
    world.localOps = world.localOps.filter((o) => o.opId !== op.opId);
    toast(voiciErrorText(e), "err");
  } finally {
    busy = false;
    emitWorld();
    render();
  }
}

/** The one-time rules sheet (§9.7), then, before the very first publish, the warning (O1). */
async function confirmFirstPublish() {
  let accepted = false;
  try {
    accepted = localStorage.getItem(RULES_KEY) === "1";
  } catch {
    accepted = false;
  }
  if (!accepted) {
    const ok = await inlineConfirm({ title: VOICI_RULES_TITLE(), message: VOICI_RULES_TEXT(), okLabel: tr("I agree") });
    if (!ok) return false;
    try {
      localStorage.setItem(RULES_KEY, "1");
    } catch {
      /* asked again next time */
    }
  }
  return inlineConfirm({ title: tr("Publish your page?"), message: VOICI_PAGE_WARNING(), okLabel: tr("Publish"), cancelLabel: tr("Cancel") });
}

/** Publishes every pending change and clears the drafts it included (admin devices only). */
export async function publishAndConsume({ ask = false } = {}) {
  if (!isAdmin() || busy) return;
  const ops = pendingOps();
  if (!world.page && !(await confirmFirstPublish())) return;
  if (world.page && !ops.length && !ask) return;
  busy = true;
  const btn = $("pe-publish");
  if (btn) btn.disabled = true;
  try {
    const images = new Map([...opImages(ops), ...localImages]);
    const page = await publishVoiciPage({ ops, images }, { published: world.page ?? null });
    const laneIds = world.drafts.map((d) => d.op.opId).filter((id) => ops.some((o) => o.opId === id));
    world.page = page;
    world.localOps = world.localOps.filter((o) => !ops.some((x) => x.opId === o.opId));
    world.drafts = world.drafts.filter((d) => !laneIds.includes(d.op.opId));
    try {
      await consumeDraftOps(laneIds);
    } catch {
      /* the next publish clears them; merging a draft twice changes nothing */
    }
    form = null;
    toast(tr("Published."));
  } catch (e) {
    toast(voiciErrorText(e), "err");
  } finally {
    busy = false;
    emitWorld();
    render();
  }
}

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
  if (isAdmin() && world.page && world.drafts.length) await publishAndConsume();
}

export function initPageEditorView() {
  $("page-editor-back")?.addEventListener("click", () => void import("./messages.js").then((m) => m.enterMessages()));
}
