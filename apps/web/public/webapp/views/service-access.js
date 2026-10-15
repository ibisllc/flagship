// Access control — admin UI (docs/service-access-gating.md, "Open mode +
// members").
//
// A two-way toggle (Open to all | Members only) and, in both modes, the
// members list with each person's and group's rank (member < manager <
// master, set by signed orders the box verifies; apps enforce them). The toggle
// never changes the list. Add a person (or one you approve first: the friend
// replies an acceptance the author finalizes here) or a group link (maxN,
// optional expiry), each with its role; names and photos are sealed under the
// household key (.com stores ciphertext). Remove = revoke on .com AND prune on
// the box the AIDs for whom it was their last grant.
//
// Identity model (v2 box-as-authority): create/revoke/list are now AID-signed —
// the box verifies them against the owner's STABLE AID (the IRK rotates). The
// access-mode change + the per-AID prune stay OWNER-IRK-signed to the box's
// pinned pipe. The bound principal is the friend's per-author CONTACT AID. See
// lib/serviceInvite.js for the wire + canonical bytes.
//
// The consumer's USERNAME is never disclosed to the author in ANY tier — the
// author sees only the private label they themselves assigned (personal) or the
// group label (group).

import { $, registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { getPodBaseUrl, screensFetch } from "../lib/api.js";
import { controlApex } from "../lib/apex.js";
import {
  deriveAccountIdFromSeed,
  deriveHouseholdKeyFromSeed,
  signWithIrk,
  signWithAccountId,
} from "../keystore.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import {
  createInvite,
  listInvites,
  removeServiceAllow,
  revokeInvite,
  setServiceAccessMode,
  submitAccept,
  parseAcceptReply,
} from "../lib/serviceInvite.js";
import { crownIcon, usersIcon } from "../lib/icons.js";
import {
  CROWNED_ROLE,
  MEMBER_ROLES,
  aidsToPrune,
  alsoInText,
  fetchMembers,
  inviteTarget,
  otherGrants,
  roleDescription,
  roleLabel,
  roleTargetFor,
  rowRole,
  setMemberRole,
} from "../lib/memberRoles.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { formatWhen } from "../lib/dateFormat.js";

registerView("view-service-access");

let currentService = null;

// localStorage key for the last-known access mode (shown until the box answers).
const MODE_KEY_PREFIX = "flagship.serviceAccessMode.";

function modeKey(serviceRef) {
  return `${MODE_KEY_PREFIX}${serviceRef}`;
}
function lastKnownMode(serviceRef) {
  try {
    const v = localStorage.getItem(modeKey(serviceRef));
    return v === "restricted" || v === "open" ? v : null;
  } catch {
    return null;
  }
}
function rememberMode(serviceRef, mode) {
  try {
    localStorage.setItem(modeKey(serviceRef), mode);
  } catch {
    /* private mode — the box POST response remains the source of truth */
  }
}

/** Box base URL of the currently-paired pod (canonical-bytes input). */
function podBaseUrl() {
  return getPodBaseUrl() ?? "";
}

/** The paired box's FQDN — the server a signed role order names. */
function podServerDomain() {
  try {
    return new URL(podBaseUrl()).host;
  } catch {
    return "";
  }
}

const screensJson = (path, init) => screensFetch(path, init);

export async function enterServiceAccess(service) {
  currentService = service;
  show("view-service-access");
  await renderServiceAccess(service);
}

export async function renderServiceAccess(service) {
  currentService = service;
  const root = $("service-access-content");
  root.innerHTML = skeletonCards(2);
  const serviceRef = service.serviceId;
  const session = getSession();
  if (!session.username || !session.umk) {
    root.innerHTML = `<div class="card"><p class="err-text">Unlock the webapp first.</p></div>`;
    return;
  }

  const mode = lastKnownMode(serviceRef) ?? "open";

  root.innerHTML = `
    <div class="card">
      <div class="card-title">${escapeHtml(service.slug ?? serviceRef)}</div>
      <div class="muted-sm text-xs mt-1">id: ${escapeHtml(serviceRef)}</div>
    </div>

    <div class="card mt-3">
      <div class="fs-segmented" id="sa-mode" role="radiogroup" aria-label="Who can open it">
        <button type="button" role="radio" data-mode="open" aria-checked="${mode === "open"}">${MODE_LABEL.open}</button>
        <button type="button" role="radio" data-mode="restricted" aria-checked="${mode === "restricted"}">${MODE_LABEL.restricted}</button>
      </div>
      <div id="sa-mode-status" class="mt-2 text-xs muted-sm">${escapeHtml(modeNote(mode))}</div>
    </div>

    <h2 class="mt-4" id="sa-members-title">Members</h2>
    <div class="row-2">
      <button id="sa-add-person" class="secondary" type="button">+ Add person</button>
      <button id="sa-add-group" class="secondary" type="button">+ Add group</button>
    </div>
    <div id="sa-add-card" class="card mt-2 hidden">
      <div class="card-title" id="sa-add-title">Add a person</div>
      <p class="note mt-1">
        Names &amp; photos stay encrypted to your account — flagshipserver.com
        stores only ciphertext and never sees them. Send the link over a private channel.
      </p>
      <label class="mt-2" id="sa-name-label">Name <span class="faint-sm">(only you and your servers see it)</span></label>
      <input id="sa-name" type="text" placeholder="Alex" autocomplete="off" maxlength="120" />
      <label class="mt-2" for="sa-new-role">Rank</label>
      <select id="sa-new-role">${roleOptionsHtml("member", true)}</select>
      <div id="sa-person-opts">
        <label class="mt-2">Photo <span class="faint-sm">(optional)</span></label>
        <input id="sa-photo" type="file" accept="image/*" />
        <div id="sa-photo-preview" class="mt-2"></div>
        <label class="inline-check mt-2"><input type="checkbox" id="sa-approve" /> I approve them before they get in (most secure)</label>
      </div>
      <div id="sa-group-opts" class="hidden mt-2">
        <p class="note">Anyone the link reaches (up to the limit) joins with this rank. Set a limit and an expiry.</p>
        <label>Max uses <span class="faint-sm">(0 = unlimited)</span></label>
        <input id="sa-maxn" type="number" min="0" step="1" value="10" />
        <label class="mt-2">Expires in days <span class="faint-sm">(optional — a forever link is a liability)</span></label>
        <input id="sa-expiry-days" type="number" min="0" step="1" placeholder="30" />
      </div>
      <button id="sa-add-go" class="full-width mt-3">Create invite link</button>
      <div id="sa-add-status" class="mt-2 text-sm"></div>
      <div id="sa-add-result" class="mt-2 hidden">
        <label>Shareable link</label>
        <input id="sa-link" type="text" readonly class="mt-1" />
        <div id="sa-qr" class="mt-2" style="text-align:center;"></div>
        <div class="row-2 mt-2">
          <button id="sa-share" class="secondary">Share…</button>
          <button id="sa-copy" class="secondary">Copy link</button>
        </div>
        <p id="sa-manual-hint" class="note mt-2 hidden">
          You approve this one. After they open the link, they'll send you back
          an acceptance code — paste it under &ldquo;Finalize an acceptance&rdquo;
          below to let them in.
        </p>
      </div>
    </div>
    <div id="sa-people" class="mt-2"><div class="card placeholder">loading…</div></div>

    <h2 class="mt-4">Finalize an acceptance</h2>
    <div class="card">
      <p class="note">
        For an invite you approve: paste the acceptance code (or link) your
        friend sent back. It never reveals who they are — you're just
        confirming it really came from them.
      </p>
      <textarea id="sa-accept-input" rows="2" placeholder="https://flagshipserver.com/invite-accept?…" class="mt-1"></textarea>
      <button id="sa-accept-go" class="full-width mt-2">Finalize &amp; grant access</button>
      <div id="sa-accept-status" class="mt-2 text-sm"></div>
    </div>
  `;

  for (const b of root.querySelectorAll("#sa-mode [data-mode]")) {
    b.addEventListener("click", () => {
      onPickMode(serviceRef, b.getAttribute("data-mode")).catch((e) => {
        console.error(e);
        toast(humanError(e), "err");
      });
    });
  }
  $("sa-add-person")?.addEventListener("click", () => openAddCard("person"));
  $("sa-add-group")?.addEventListener("click", () => openAddCard("group"));
  $("sa-photo")?.addEventListener("change", onPhotoPicked);
  $("sa-add-go")?.addEventListener("click", () => {
    onAdd(serviceRef).catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
  $("sa-accept-go")?.addEventListener("click", () => {
    onFinalizeAccept(serviceRef).catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });

  await renderPeople(serviceRef);
}

const MODE_LABEL = { open: "Open to all", restricted: "Members only" };

/** The line under the toggle. */
function modeNote(mode) {
  return mode === "restricted"
    ? "Only members and you can open it. Anyone else is asked to sign in."
    : "Anyone can open it. Members who sign in get their rank.";
}

/** Rank options; `withDescriptions` adds the app's one line per rank (the add card has room). */
function roleOptionsHtml(selected, withDescriptions = false) {
  return MEMBER_ROLES.map((r) => {
    const desc = roleDescription(r, lastMembers);
    const text = withDescriptions && desc ? `${roleLabel(r)} — ${desc}` : roleLabel(r);
    return `<option value="${r}"${r === selected ? " selected" : ""}${desc ? ` title="${escapeHtml(desc)}"` : ""}>${escapeHtml(text)}</option>`;
  }).join("");
}

/** The crown Master carries, wherever a rank is shown. */
function crownHtml(role) {
  return role === CROWNED_ROLE ? `<span class="sa-crown" title="${escapeHtml(roleLabel(role))}" aria-hidden="true">${crownIcon}</span>` : "";
}

/** Which form the add card shows: "person" | "group". */
let addKind = "person";

function openAddCard(kind) {
  addKind = kind;
  const card = $("sa-add-card");
  if (!card) return;
  card.classList.remove("hidden");
  $("sa-add-result")?.classList.add("hidden");
  const status = $("sa-add-status");
  if (status) status.textContent = "";
  const group = kind === "group";
  $("sa-add-title").textContent = group ? "Add a group" : "Add a person";
  $("sa-name-label").innerHTML = group
    ? 'Group name <span class="faint-sm">(only you and your servers see it)</span>'
    : 'Name <span class="faint-sm">(only you and your servers see it)</span>';
  $("sa-name").placeholder = group ? "Chess club" : "Alex";
  $("sa-person-opts")?.classList.toggle("hidden", group);
  $("sa-group-opts")?.classList.toggle("hidden", !group);
  const roleSel = $("sa-new-role");
  if (roleSel) {
    roleSel.innerHTML = roleOptionsHtml("member", true);
    roleSel.value = lastMembers?.defaultRole ?? "member";
  }
  $("sa-name")?.focus();
}

function setModeUi(mode) {
  for (const b of document.querySelectorAll("#sa-mode [data-mode]")) {
    b.setAttribute("aria-checked", String(b.getAttribute("data-mode") === mode));
  }
}

/**
 * The toggle: OWNER-IRK-sign + POST the mode to the box. The members list is
 * never touched. Going members-only asks once how many people that leaves.
 */
async function onPickMode(serviceRef, mode) {
  const group = $("sa-mode");
  if (!group || group.getAttribute("aria-disabled") === "true") return;
  const current = group.querySelector('[aria-checked="true"]')?.getAttribute("data-mode") ?? "open";
  if (mode === current) return;
  if (mode === "restricted") {
    const n = lastMembers?.members?.length ?? 0;
    const { inlineConfirm } = await import("../lib/modal.js");
    const ok = await inlineConfirm({
      title: "Members only?",
      message: n === 1
        ? "Only this 1 person will be able to open it."
        : `Only these ${n} people will be able to open it.`,
      okLabel: "Members only",
    });
    if (!ok) return;
  }
  const status = $("sa-mode-status");
  const session = getSession();
  setModeUi(mode);
  group.setAttribute("aria-disabled", "true");
  if (status) {
    status.className = "mt-2 text-xs muted-sm";
    status.textContent = "Saving…";
  }
  try {
    await setServiceAccessMode({ baseUrl: podBaseUrl(), serviceRef, mode, umk: session.umk, signWithIrk });
    rememberMode(serviceRef, mode);
    if (status) status.textContent = modeNote(mode);
    toast(mode === "restricted" ? "Now members only." : "Now open to all.");
  } catch (e) {
    setModeUi(current);
    if (status) {
      status.className = "mt-2 text-xs err-text";
      status.textContent = "Couldn't change access. Try again in a moment.";
    }
    throw e;
  } finally {
    group.removeAttribute("aria-disabled");
  }
}

let pickedPhotoDataUri = null;

/** Read the chosen image as a data: URI (capped) for the encrypted bundle. */
function onPhotoPicked(ev) {
  const file = ev.currentTarget.files?.[0];
  const preview = $("sa-photo-preview");
  pickedPhotoDataUri = null;
  if (preview) preview.innerHTML = "";
  if (!file) return;
  // Cap at ~256 KB encoded so the sealed bundle stays small (.com stores it).
  if (file.size > 256 * 1024) {
    toast("Photo is too large (max 256 KB). Pick a smaller image.", "err");
    if (ev.currentTarget) ev.currentTarget.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pickedPhotoDataUri = String(reader.result || "");
    if (preview && pickedPhotoDataUri) {
      preview.innerHTML = `<img src="${escapeHtml(pickedPhotoDataUri)}" alt="" style="max-height:64px;border-radius:8px;" />`;
    }
  };
  reader.onerror = () => toast("Couldn't read that image.", "err");
  reader.readAsDataURL(file);
}

/** Render an inline QR of a link into `box` (in ADDITION to the link text). */
async function renderQrInto(box, link) {
  if (!box) return;
  try {
    const m = await import("/qrEncoder.js");
    box.innerHTML = m.renderQrSvg(link, { size: 200, foreground: "#0f172a", background: "#ffffff" });
  } catch {
    box.innerHTML = ""; // the link text is the reliable fallback
  }
}

/**
 * Mint a capability invite (a person, approve-each person, or a group) with
 * its role, and surface the share-link + QR. The role rides a signed order to
 * the box right after the create; the app's default role needs none.
 */
async function onAdd(serviceRef) {
  const session = getSession();
  const status = $("sa-add-status");
  const goBtn = $("sa-add-go");
  if (goBtn?.disabled) return;
  const isGroup = addKind === "group";
  const name = ($("sa-name")?.value || "").trim();
  if (!name) {
    if (status) {
      status.className = "mt-2 text-sm err-text";
      status.textContent = "Name is required (kept private to your account).";
    }
    return;
  }
  const role = $("sa-new-role")?.value || "viewer";
  let maxRedemptions;
  let expiresAt;
  if (isGroup) {
    const maxN = Number($("sa-maxn")?.value);
    maxRedemptions = Number.isInteger(maxN) && maxN >= 0 ? maxN : 0;
    const days = Number($("sa-expiry-days")?.value);
    if (Number.isFinite(days) && days > 0) {
      expiresAt = Date.now() + Math.round(days) * 86_400_000;
    }
  }
  const manual = !isGroup && !!$("sa-approve")?.checked;

  if (status) {
    status.className = "mt-2 text-sm";
    status.textContent = "creating…";
  }
  if (goBtn) {
    goBtn.disabled = true;
    goBtn.textContent = "Creating…";
  }
  try {
    const [aid, householdKey] = await Promise.all([
      deriveAccountIdFromSeed(session.umk),
      deriveHouseholdKeyFromSeed(session.umk),
    ]);
    const bundle = !isGroup && pickedPhotoDataUri ? { name, photo: pickedPhotoDataUri } : { name };
    const r = await createInvite({
      comBase: controlApex(),
      username: session.username,
      podBaseUrl: podBaseUrl(),
      authorAID: aid.publicKey,
      serviceRef,
      bundle,
      householdKey,
      approvalMode: manual ? "manual" : "auto",
      ...(maxRedemptions !== undefined ? { maxRedemptions } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      umk: session.umk,
      // Slice D (D-2): creating a service-collaborator invite is a SENSITIVE
      // (admin-only) op. Sign with the admin master root when present; else the
      // account AID (legacy — `.com` dual-accepts AID-or-IRK on the closed gate).
      signWithAccountId: sensitiveSigner(signWithAccountId),
    });
    let roleNote = "";
    if (role !== (lastMembers?.defaultRole ?? null)) {
      try {
        await setMemberRole({
          serverDomain: podServerDomain(),
          serviceId: serviceRef,
          target: inviteTarget(r.inviteId),
          role,
          umk: session.umk,
          signWithIrk: sensitiveSigner(),
          fetchJson: screensJson,
        });
      } catch (e) {
        roleNote = ` Couldn't set the rank (${humanError(e)}): change it in the list.`;
      }
    }
    if (status) {
      status.className = roleNote ? "mt-2 text-sm err-text" : "mt-2 text-sm ok-text";
      status.textContent = `${isGroup ? "Group" : "Invite for"} ${name} created.${roleNote}`;
    }
    const result = $("sa-add-result");
    const linkEl = $("sa-link");
    if (result) result.classList.remove("hidden");
    if (linkEl) linkEl.value = r.link;
    $("sa-manual-hint")?.classList.toggle("hidden", !manual);
    await renderQrInto($("sa-qr"), r.link);
    $("sa-share")?.addEventListener("click", () => shareIt(r.link));
    $("sa-copy")?.addEventListener("click", () => copyIt(r.link));
    if ($("sa-name")) $("sa-name").value = "";
    if ($("sa-photo")) $("sa-photo").value = "";
    if ($("sa-approve")) $("sa-approve").checked = false;
    pickedPhotoDataUri = null;
    if ($("sa-photo-preview")) $("sa-photo-preview").innerHTML = "";
    await renderPeople(serviceRef);
  } catch (e) {
    if (status) {
      status.className = "mt-2 text-sm err-text";
      status.textContent = humanError(e);
    }
    throw e;
  } finally {
    if (goBtn) {
      goBtn.disabled = false;
      goBtn.textContent = "Create invite link";
    }
  }
}

/**
 * MANUAL-approve finalize CORE — DOM-free + dependency-injected (mirrors
 * runRemovePerson). Parses the friend's acceptance reply and submits ONLY
 * `{accept, acceptSig}` to the AUTHOR's box; the box fetches the owner's signed
 * create from `.com` by inviteId (so finalize works from ANY device — no local
 * create cache). Throws a tagged error when the reply is junk (`bad-accept`).
 */
export async function runFinalizeAccept(
  { raw },
  { podBaseUrl, parseAcceptReply, submitAccept },
) {
  const parsed = parseAcceptReply(raw);
  if (!parsed) throw err("That doesn't look like an acceptance code. Paste the whole thing.", "bad-accept");
  const r = await submitAccept({
    baseUrl: podBaseUrl(),
    accept: parsed.accept,
    acceptSig: parsed.acceptSig,
  });
  return { ok: true, serviceRef: r.serviceRef, boundAID: r.boundAID };
}

async function onFinalizeAccept(serviceRef) {
  const status = $("sa-accept-status");
  const btn = $("sa-accept-go");
  if (btn?.disabled) return;
  const raw = ($("sa-accept-input")?.value || "").trim();
  if (!raw) {
    if (status) { status.className = "mt-2 text-sm err-text"; status.textContent = "Paste the acceptance code first."; }
    return;
  }
  if (status) { status.className = "mt-2 text-sm"; status.textContent = "finalizing…"; }
  if (btn) { btn.disabled = true; btn.textContent = "Finalizing…"; }
  try {
    await runFinalizeAccept({ raw }, { podBaseUrl, parseAcceptReply, submitAccept });
    if (status) { status.className = "mt-2 text-sm ok-text"; status.textContent = "Granted — they can open it now."; }
    if ($("sa-accept-input")) $("sa-accept-input").value = "";
    await renderPeople(serviceRef);
  } catch (e) {
    if (status) { status.className = "mt-2 text-sm err-text"; status.textContent = humanError(e); }
    throw e;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Finalize & grant access"; }
  }
}

/** The box's members + roles, last loaded (null when it couldn't be read). */
let lastMembers = null;
/** The live .com rows, last loaded. */
let lastInvites = [];

async function loadInvites(serviceRef) {
  const session = getSession();
  const [aid, householdKey] = await Promise.all([
    deriveAccountIdFromSeed(session.umk),
    deriveHouseholdKeyFromSeed(session.umk),
  ]);
  const invites = await listInvites({
    comBase: controlApex(),
    username: session.username,
    authorAID: aid.publicKey,
    householdKey,
    serviceRef,
    umk: session.umk,
    signWithAccountId,
  });
  return invites.filter((i) => !i.revokedAt);
}

/** Render the members list: .com's invites (bundles decrypted locally) + the box's roles. */
async function renderPeople(serviceRef) {
  const root = $("sa-people");
  if (!root) return;
  const [invites, members] = await Promise.allSettled([
    loadInvites(serviceRef),
    fetchMembers(serviceRef, { fetchJson: screensJson }),
  ]);
  if (members.status === "fulfilled") {
    lastMembers = members.value;
    if (lastMembers.mode === "open" || lastMembers.mode === "restricted") {
      rememberMode(serviceRef, lastMembers.mode);
      if (!$("sa-mode")?.getAttribute("aria-disabled")) {
        setModeUi(lastMembers.mode);
        const status = $("sa-mode-status");
        if (status && status.className.indexOf("err-text") === -1) status.textContent = modeNote(lastMembers.mode);
      }
    }
  } else {
    lastMembers = null;
  }
  if (invites.status === "rejected") {
    root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(humanError(invites.reason))}</p></div>`;
    return;
  }
  lastInvites = invites.value;
  const title = $("sa-members-title");
  if (title) title.textContent = `Members (${lastInvites.length})`;
  if (lastInvites.length === 0) {
    root.innerHTML = '<div class="card placeholder">No members yet. Add a person or a group.</div>';
    return;
  }
  const labelOf = (id) => {
    const row = lastInvites.find((i) => i.inviteId === id);
    return row ? (row.bundle?.name ?? "") : "";
  };
  root.innerHTML =
    (lastMembers ? "" : '<div class="card"><p class="err-text">Couldn\'t load roles from your server.</p></div>') +
    lastInvites.map((i) => peopleRowHtml(i, lastMembers, labelOf)).join("");
  root.querySelectorAll('[data-action="sa-remove"]').forEach((b) => {
    b.addEventListener("click", () =>
      onRemovePerson(
        serviceRef,
        b.getAttribute("data-id"),
        b.getAttribute("data-name"),
        b.getAttribute("data-aid") || null,
        b.getAttribute("data-group") === "1",
      ).catch((e) => {
        console.error(e);
        toast(humanError(e), "err");
      }),
    );
  });
  root.querySelectorAll('select[data-action="sa-role"]').forEach((sel) => {
    sel.addEventListener("change", () => {
      onPickRole(serviceRef, sel).catch((e) => {
        console.error(e);
        toast(humanError(e), "err");
      });
    });
  });
}

/** Sign + send one row's role change; roll the picker back on failure. */
async function onPickRole(serviceRef, sel) {
  const before = sel.getAttribute("data-current");
  const role = sel.value;
  if (role === before) return;
  const session = getSession();
  sel.disabled = true;
  try {
    await setMemberRole({
      serverDomain: podServerDomain(),
      serviceId: serviceRef,
      target: sel.getAttribute("data-target"),
      role,
      umk: session.umk,
      signWithIrk: sensitiveSigner(),
      fetchJson: screensJson,
    });
    toast(`Now ${roleLabel(role)}.`);
    await renderPeople(serviceRef);
  } catch (e) {
    sel.value = before;
    throw e;
  } finally {
    sel.disabled = false;
  }
}

/** One member row — a person (single bind) OR a group ("k of N joined"), each with a role picker. */
function peopleRowHtml(i, members, labelOf) {
  const name = i.bundle?.name ?? "unknown";
  const photo = i.bundle?.photo;
  const isGroup = i.maxRedemptions !== null && i.maxRedemptions !== undefined;
  let statusText;
  if (isGroup) {
    const used = typeof i.redemptions === "number" ? i.redemptions : (Array.isArray(i.boundAIDs) ? i.boundAIDs.length : 0);
    const cap = i.maxRedemptions === 0 ? "∞" : i.maxRedemptions;
    statusText = `${used} of ${cap} joined`;
    if (i.expiresAt) {
      statusText += i.expiresAt <= Date.now() ? " · expired" : ` · expires ${formatWhen(i.expiresAt)}`;
    }
  } else if (i.approvalMode === "manual" && !i.boundAID) {
    statusText = "you approve — waiting for their acceptance";
  } else {
    statusText = i.boundAID ? "active" : "invite sent — not opened yet";
  }
  const also = isGroup ? "" : alsoInText(otherGrants(i, members, labelOf));
  const avatar = isGroup
    ? `<div class="sa-avatar" aria-hidden="true">${usersIcon}</div>`
    : photo
      ? `<img class="sa-avatar" src="${escapeHtml(photo)}" alt="" />`
      : `<div class="sa-avatar" aria-hidden="true">${escapeHtml((name[0] || "?").toUpperCase())}</div>`;
  const role = members ? rowRole(i, members) : null;
  const target = roleTargetFor(i, members);
  const picker = role
    ? `${crownHtml(role)}<select data-action="sa-role" data-target="${escapeHtml(target)}" data-current="${escapeHtml(role)}" aria-label="Rank for ${escapeHtml(name)}">${roleOptionsHtml(role)}</select>`
    : "";
  const removeLabel = isGroup ? "Revoke" : "Remove";
  return `
    <div class="card">
      <div class="sa-member">
        ${avatar}
        <div class="sa-member-body">
          <div class="weight-600">${escapeHtml(name)}</div>
          <div class="muted-sm text-xs">${escapeHtml(statusText)}</div>
          ${also ? `<div class="muted-sm text-xs">${escapeHtml(also)}</div>` : ""}
        </div>
        <div class="sa-member-actions">
          ${picker}
          <button class="sa-remove" type="button" data-action="sa-remove" data-id="${escapeHtml(i.inviteId)}" data-aid="${escapeHtml(i.boundAID ?? "")}" data-name="${escapeHtml(name)}" data-group="${isGroup ? "1" : "0"}">${removeLabel}</button>
        </div>
      </div>
    </div>`;
}

/**
 * The two-leg remove CORE — DOM-free + dependency-injected, so it's testable
 * under Node (mirrors webappCompanionRequestsView's `runApprove`). Leg 1 records
 * the revocation on `.com` (AID-signed); leg 2 prunes the bound AID(s) on the BOX
 * (the leg that actually enforces). For a GROUP invite, leg 2 prunes EVERY bound
 * AID (the group is a labeled set). Returns `{ ok, prunedBox }`; an unredeemed
 * invite (no boundAID/boundAIDs) skips the box prune. A box-prune failure throws
 * a `box-prune-failed`-tagged error (the `.com` revoke already ran, so the admin
 * must know access may persist).
 */
export async function runRemovePerson(
  { serviceRef, inviteId, boundAID, boundAIDs, isGroup, members },
  { getSession, controlApex, podBaseUrl, signWithIrk, signWithAccountId, humanError, revokeInvite, removeServiceAllow },
) {
  const session = getSession();
  await revokeInvite({
    comBase: controlApex(),
    username: session.username,
    inviteId,
    umk: session.umk,
    // Slice D (D-2): revoking a service-collaborator invite is a SENSITIVE
    // (admin-only) op — admin master root when present, else the account AID.
    signWithAccountId: sensitiveSigner(signWithAccountId),
  });
  // The AIDs to prune on the box: the whole group set, else the single bound
  // AID — but only those for whom this was their last grant. Someone who also
  // holds another invite keeps it: the box drops just this grant when its
  // revocation poller sees the .com revoke.
  const bound = isGroup && Array.isArray(boundAIDs) ? boundAIDs : boundAID ? [boundAID] : [];
  const aids = members === undefined ? bound : aidsToPrune(inviteId, bound, members);
  if (aids.length === 0) return { ok: true, prunedBox: false };
  for (const aid of aids) {
    try {
      await removeServiceAllow({
        baseUrl: podBaseUrl(),
        serviceRef,
        aid,
        umk: session.umk,
        signWithIrk,
      });
    } catch (e) {
      throw err(
        `Revoked on flagshipserver.com, but couldn't remove their access on your server (${humanError(e)}). They may still have access — try again.`,
        "box-prune-failed",
      );
    }
  }
  return { ok: true, prunedBox: true };
}

async function onRemovePerson(serviceRef, inviteId, name, boundAID, isGroup) {
  const row = lastInvites.find((i) => i.inviteId === inviteId);
  const boundAIDs = isGroup ? (row && Array.isArray(row.boundAIDs) ? row.boundAIDs : []) : null;
  const restricted = (lastMembers?.mode ?? lastKnownMode(serviceRef)) === "restricted";
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: isGroup ? `Revoke the "${name}" group?` : `Remove ${name || "this person"}?`,
    message: isGroup
      ? (restricted
          ? "Everyone who joined through this link loses access, unless they were also invited another way."
          : "Everyone who joined through this link loses their rank and can still visit as anyone can.")
      : (restricted
          ? "They're signed out and kept out. You can invite them again later."
          : "They lose their rank and can still visit as anyone can. You can invite them again later."),
    okLabel: isGroup ? "Revoke" : "Remove",
    danger: true,
  });
  if (!ok) return;
  try {
    await runRemovePerson(
      { serviceRef, inviteId, boundAID, boundAIDs, isGroup, members: lastMembers ?? undefined },
      { getSession, controlApex, podBaseUrl, signWithIrk, signWithAccountId, humanError, revokeInvite, removeServiceAllow },
    );
  } catch (e) {
    await renderPeople(serviceRef);
    throw e;
  }
  toast(isGroup ? "Group revoked." : "Removed.");
  await renderPeople(serviceRef);
}

/** Tag an Error with a code (mirrors lib/serviceInvite.js's `err`). */
function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function shareIt(link) {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "Flagship invite", url: link });
    } catch {
      /* user cancelled */
    }
  } else {
    await copyIt(link);
  }
}

async function copyIt(link) {
  try {
    await navigator.clipboard.writeText(link);
    toast("Link copied.");
  } catch {
    toast("Couldn't copy — long-press the field to copy.", "err");
  }
}

export function initServiceAccessView() {
  $("service-access-back")?.addEventListener("click", async () => {
    if (currentService) {
      const { enterServiceDetail } = await import("./service-detail.js");
      await enterServiceDetail(currentService.serviceId);
    } else {
      show("view-home");
    }
  });
  $("service-access-refresh")?.addEventListener("click", () => {
    if (currentService) renderServiceAccess(currentService).catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
}
