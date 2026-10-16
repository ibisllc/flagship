// Access control (docs/service-access-gating.md, "Open mode + members" and
// "Account members, ranks and who may change them").
//
// A two-way toggle (Open to all | Members only); Account members (this
// account's devices, names decrypted from the account directory on this
// device, and the co-managing accounts, under the owner's label), each with
// its rank; and the invited people and groups with theirs (member < manager <
// master, set by signed orders the box verifies; apps enforce them). The toggle
// never changes the list. Add a person (or one you approve first: the friend
// replies an acceptance the author finalizes here) or a group link (maxN,
// optional expiry), each with its rank; names and photos are sealed under the
// household key (.com stores ciphertext). Remove = revoke on .com AND withdraw
// on the box (it prunes who joined through it).
//
// Who may do what (the box enforces it): an admin device (it holds the admin
// root) signs everything with the admin root: invites at any rank, rank
// orders (flagship/app-rank/v1, also Refuse for a device or co-manager), the
// mode (flagship/service-access-mode/v2) and removals
// (flagship/service-allow-remove/v2). Any other device, while its own rank in
// the app is manager or master, invites at Member and withdraws its own
// invites, signed with its account device key; below that it sees why it
// can't. See lib/serviceInvite.js for the wire + canonical bytes.
//
// The consumer's USERNAME is never disclosed to the author in ANY tier — the
// author sees only the private label they themselves assigned (personal) or the
// group label (group).

import { $, registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { getPodBaseUrl, screensFetch } from "../lib/api.js";
import { controlApex } from "../lib/apex.js";
import { getActiveProfile } from "../lib/profiles.js";
import { fetchDecryptedDirectory } from "../lib/accountDirectory.js";
import {
  bytesToHex,
  deriveAccountDeviceKeyFromSeed,
  deriveAccountIdFromSeed,
  deriveHouseholdKeyFromSeed,
  signWithAccountDeviceKey,
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
  withdrawInviteOnBox,
} from "../lib/serviceInvite.js";
import { crownIcon, monitorIcon, usersIcon } from "../lib/icons.js";
import {
  ADMIN_ONLY_MODE_NOTE,
  ADMIN_ONLY_RANK_NOTE,
  CROWNED_ROLE,
  MEMBER_ROLES,
  RANK_REFUSED,
  accountMemberLine,
  accountMemberName,
  accountMemberTarget,
  aidsToPrune,
  alsoInText,
  canRevokeInvite,
  deviceNameResolver,
  fetchMembers,
  inviteAbility,
  inviteTarget,
  invitedByText,
  isAdminDevice,
  isManagerClass,
  myAccountMember,
  otherGrants,
  roleDescription,
  roleLabel,
  roleTargetFor,
  rowRole,
  setAppRank,
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

const screensJson = (path, init) => screensFetch(path, init);

/** This device's account device id, or "" when the profile has none. */
function thisDeviceId() {
  const id = getActiveProfile()?.deviceId;
  return typeof id === "string" && /^[0-9a-f]{32}$/.test(id) ? id : "";
}

/** This device's account device key (public, hex), or "" when the profile has no device id. */
async function thisDevicePub() {
  const accountId = getActiveProfile()?.accountId;
  const deviceId = thisDeviceId();
  const umk = getSession()?.umk;
  if (!accountId || !deviceId || !(umk instanceof Uint8Array)) return "";
  return bytesToHex((await deriveAccountDeviceKeyFromSeed(umk, accountId, deviceId)).publicKey);
}

/** Signs with this device's account device key (what a non-admin device signs invites with). */
async function signWithThisDevice(umk, bytes) {
  const accountId = getActiveProfile()?.accountId;
  const deviceId = thisDeviceId();
  if (!accountId || !deviceId) throw new Error("This device isn't set up on your account yet. Sign in to your account on it again.");
  return signWithAccountDeviceKey(umk, accountId, deviceId, bytes);
}

let deviceNamesKey = null;
let deviceNames = null;

/** Device names from the account directory, read once per account and device. */
function loadDeviceNames() {
  const profile = getActiveProfile();
  const key = `${profile?.accountId ?? ""}:${profile?.deviceId ?? ""}`;
  if (!deviceNames || deviceNamesKey !== key) {
    deviceNamesKey = key;
    deviceNames = deviceNameResolver(() => fetchDecryptedDirectory());
  }
  return deviceNames();
}

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
  const admin = isAdminDevice(session);

  root.innerHTML = `
    <div class="card">
      <div class="card-title">${escapeHtml(service.slug ?? serviceRef)}</div>
      <div class="muted-sm text-xs mt-1">id: ${escapeHtml(serviceRef)}</div>
    </div>

    <div class="card mt-3">
      <div class="fs-segmented" id="sa-mode" role="radiogroup" aria-label="Who can open it"${admin ? "" : ' aria-disabled="true"'}>
        <button type="button" role="radio" data-mode="open" aria-checked="${mode === "open"}"${admin ? "" : " disabled"}>${MODE_LABEL.open}</button>
        <button type="button" role="radio" data-mode="restricted" aria-checked="${mode === "restricted"}"${admin ? "" : " disabled"}>${MODE_LABEL.restricted}</button>
      </div>
      <div id="sa-mode-status" class="mt-2 text-xs muted-sm">${escapeHtml(modeNote(mode))}</div>
      ${admin ? "" : `<p id="sa-mode-locked" class="note mt-1">${escapeHtml(ADMIN_ONLY_MODE_NOTE)}</p>`}
    </div>

    <h2 class="mt-4" id="sa-account-title">Account members</h2>
    <div id="sa-account-people"><div class="card placeholder">loading…</div></div>

    <h2 class="mt-4" id="sa-members-title">Members</h2>
    <div class="row-2" id="sa-add-row">
      <button id="sa-add-person" class="secondary" type="button">+ Add person</button>
      <button id="sa-add-group" class="secondary" type="button">+ Add group</button>
    </div>
    <p id="sa-add-why" class="note hidden"></p>
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
      <p id="sa-rank-locked" class="note mt-1 hidden">${escapeHtml(ADMIN_ONLY_RANK_NOTE)}</p>
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
  if (!admin) $("sa-add-row")?.classList.add("hidden");
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
function roleOptionsHtml(selected, withDescriptions = false, roles = MEMBER_ROLES) {
  return roles.map((r) => {
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
  if (!card || !addAbility().canInvite) return;
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
  const admin = isAdminDevice(getSession());
  const roleSel = $("sa-new-role");
  if (roleSel) {
    roleSel.innerHTML = roleOptionsHtml("member", true, addAbility().roles);
    roleSel.value = admin ? (lastMembers?.defaultRole ?? "member") : "member";
    roleSel.disabled = !admin;
  }
  $("sa-rank-locked")?.classList.toggle("hidden", admin);
  $("sa-name")?.focus();
}

function setModeUi(mode) {
  for (const b of document.querySelectorAll("#sa-mode [data-mode]")) {
    b.setAttribute("aria-checked", String(b.getAttribute("data-mode") === mode));
  }
}

/**
 * The toggle (admin devices only): sign flagship/service-access-mode/v2 with
 * the admin root + POST it to the box. The members list is never touched.
 * Going members-only asks once how many people that leaves.
 */
async function onPickMode(serviceRef, mode) {
  const group = $("sa-mode");
  if (!group || group.getAttribute("aria-disabled") === "true") return;
  if (!isAdminDevice(getSession())) return;
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
  group.dataset.saving = "1";
  if (status) {
    status.className = "mt-2 text-xs muted-sm";
    status.textContent = "Saving…";
  }
  try {
    await setServiceAccessMode({ baseUrl: podBaseUrl(), serviceRef, mode, umk: session.umk, signWithIrk: sensitiveSigner() });
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
    delete group.dataset.saving;
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
 * its rank, and surface the share-link + QR. On an admin device the rank rides
 * a signed order to the box right after the create (the app's default rank
 * needs none); a manager-class device invites at Member and sends no order.
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
  const admin = isAdminDevice(session);
  if (!addAbility().canInvite) return;
  const role = admin ? ($("sa-new-role")?.value || "member") : "member";
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
      deviceId: thisDeviceId(),
      umk: session.umk,
      signWithAccountId: inviteSigner(),
    });
    let roleNote = "";
    if (admin && role !== (lastMembers?.defaultRole ?? null)) {
      try {
        await setAppRank({
          serviceId: serviceRef,
          target: inviteTarget(r.inviteId),
          rank: role,
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
/** This device's account device key (hex), last derived. */
let lastDevicePub = "";

/** What this device may add right now (from the box's list and its own rank there). */
function addAbility() {
  return inviteAbility({
    isAdmin: isAdminDevice(getSession()),
    members: lastMembers,
    me: myAccountMember(lastMembers, { devicePub: lastDevicePub, deviceId: thisDeviceId() }),
  });
}

/**
 * The create/revoke signer: the admin root on an admin device (unlocked with
 * the session, no extra prompt), else this device's account device key, which
 * .com and the box take as a member-tier invite from this device.
 */
function inviteSigner() {
  return sensitiveSigner(signWithThisDevice);
}

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

/**
 * Render Account members (the box's list; device names decrypted here) and
 * the invited people (.com's invites, bundles decrypted locally, with the
 * box's ranks), and what this device may do with them.
 */
async function renderPeople(serviceRef) {
  const root = $("sa-people");
  if (!root) return;
  const [invites, members, names, pub] = await Promise.allSettled([
    loadInvites(serviceRef),
    fetchMembers(serviceRef, { fetchJson: screensJson }),
    loadDeviceNames(),
    thisDevicePub(),
  ]);
  lastDevicePub = pub.status === "fulfilled" ? pub.value : "";
  if (members.status === "fulfilled") {
    lastMembers = members.value;
    if (lastMembers.mode === "open" || lastMembers.mode === "restricted") {
      rememberMode(serviceRef, lastMembers.mode);
      if (!$("sa-mode")?.dataset.saving) {
        setModeUi(lastMembers.mode);
        const status = $("sa-mode-status");
        if (status && status.className.indexOf("err-text") === -1) status.textContent = modeNote(lastMembers.mode);
      }
    }
  } else {
    lastMembers = null;
  }
  const deviceNamesMap = names.status === "fulfilled" ? names.value : null;
  const isAdmin = isAdminDevice(getSession());
  renderAccountMembers(serviceRef, { isAdmin, deviceNames: deviceNamesMap });
  const ability = addAbility();
  $("sa-add-row")?.classList.toggle("hidden", !ability.canInvite);
  const why = $("sa-add-why");
  if (why) {
    why.textContent = ability.why;
    why.classList.toggle("hidden", ability.canInvite || !ability.why);
  }
  if (!ability.canInvite) $("sa-add-card")?.classList.add("hidden");
  if (invites.status === "rejected") {
    root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(humanError(invites.reason))}</p></div>`;
    return;
  }
  lastInvites = invites.value;
  const title = $("sa-members-title");
  if (title) title.textContent = `Members (${lastInvites.length})`;
  if (lastInvites.length === 0) {
    root.innerHTML = `<div class="card placeholder">${ability.canInvite ? "No members yet. Add a person or a group." : "No members yet."}</div>`;
    return;
  }
  const labelOf = (id) => {
    const row = lastInvites.find((i) => i.inviteId === id);
    return row ? (row.bundle?.name ?? "") : "";
  };
  const me = myAccountMember(lastMembers, { devicePub: lastDevicePub, deviceId: thisDeviceId() });
  const ctx = {
    isAdmin,
    deviceId: thisDeviceId(),
    devicePub: lastDevicePub,
    managerClass: !!me && !me.refused && isManagerClass(me.rank),
    members: lastMembers,
    deviceNames: deviceNamesMap,
  };
  root.innerHTML =
    (lastMembers ? "" : '<div class="card"><p class="err-text">Couldn\'t load roles from your server.</p></div>') +
    lastInvites.map((i) => peopleRowHtml(i, lastMembers, labelOf, ctx)).join("");
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

/** Admin devices: sign one flagship/app-rank/v1 with the admin root and send it. */
async function sendRank(serviceRef, target, rank) {
  const session = getSession();
  if (!isAdminDevice(session)) throw new Error("Only an admin device can change a rank.");
  await setAppRank({
    serviceId: serviceRef,
    target,
    rank,
    umk: session.umk,
    signWithIrk: sensitiveSigner(),
    fetchJson: screensJson,
  });
}

/** Sign + send one row's rank change; roll the picker back on failure. */
async function onPickRole(serviceRef, sel) {
  const before = sel.getAttribute("data-current");
  const role = sel.value;
  if (role === before) return;
  if (!isAdminDevice(getSession())) {
    sel.value = before;
    return;
  }
  sel.disabled = true;
  try {
    await sendRank(serviceRef, sel.getAttribute("data-target"), role);
    toast(`Now ${roleLabel(role)}.`);
    await renderPeople(serviceRef);
  } catch (e) {
    sel.value = before;
    throw e;
  } finally {
    sel.disabled = false;
  }
}

/** Refuse a device or co-manager in this app (admin devices); picking a rank again lets them back in. */
async function onRefuse(serviceRef, btn) {
  const name = btn.getAttribute("data-name") || "them";
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: `Refuse ${name}?`,
    message: "They can't open this app until an admin gives them a rank again.",
    okLabel: "Refuse",
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    await sendRank(serviceRef, btn.getAttribute("data-target"), RANK_REFUSED);
    toast(`${name} is refused in this app.`);
    await renderPeople(serviceRef);
  } finally {
    btn.disabled = false;
  }
}

/** The Account members list (this account's devices and the co-managers). */
function renderAccountMembers(serviceRef, { isAdmin, deviceNames }) {
  const root = $("sa-account-people");
  if (!root) return;
  if (!lastMembers) {
    root.innerHTML = '<div class="card"><p class="err-text">Couldn\'t load ranks from your server.</p></div>';
    return;
  }
  const rows = lastMembers.accountMembers ?? [];
  if (rows.length === 0) {
    root.innerHTML = '<div class="card placeholder">Your server doesn\'t list this account\'s devices yet.</div>';
    return;
  }
  const ctx = { isAdmin, devicePub: lastDevicePub, deviceNames };
  root.innerHTML = rows.map((r) => accountMemberRowHtml(r, ctx)).join("");
  root.querySelectorAll('select[data-action="sa-acct-rank"]').forEach((sel) => {
    sel.addEventListener("change", () => {
      onPickRole(serviceRef, sel).catch((e) => {
        console.error(e);
        toast(humanError(e), "err");
      });
    });
  });
  root.querySelectorAll('[data-action="sa-acct-refuse"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      onRefuse(serviceRef, btn).catch((e) => {
        console.error(e);
        toast(humanError(e), "err");
      });
    });
  });
}

/**
 * One Account members row: a device (its name from the decrypted directory)
 * or a co-managing account (the owner's label), its rank (Master crowned,
 * "Refused" when refused), and on an admin device a rank menu and Refuse.
 */
export function accountMemberRowHtml(row, ctx = { isAdmin: false, devicePub: "", deviceNames: null }) {
  const name = accountMemberName(row, ctx);
  const line = accountMemberLine(row, ctx);
  const target = accountMemberTarget(row);
  const current = row.refused ? RANK_REFUSED : (row.rank ?? RANK_REFUSED);
  const icon = row.kind === "co-manager" ? usersIcon : monitorIcon;
  let actions;
  if (ctx.isAdmin) {
    const refusedOption = row.refused ? `<option value="${RANK_REFUSED}" selected disabled>${escapeHtml(roleLabel(RANK_REFUSED))}</option>` : "";
    actions = `${row.refused ? "" : crownHtml(current)}<select data-action="sa-acct-rank" data-target="${escapeHtml(target)}" data-current="${escapeHtml(current)}" aria-label="Rank for ${escapeHtml(name)}">${refusedOption}${roleOptionsHtml(row.refused ? "" : current)}</select>${
      row.refused
        ? ""
        : `<button class="sa-remove" type="button" data-action="sa-acct-refuse" data-target="${escapeHtml(target)}" data-name="${escapeHtml(name)}">Refuse</button>`
    }`;
  } else {
    actions = `${row.refused ? "" : crownHtml(current)}<span class="sa-rank" data-rank="${escapeHtml(current)}">${escapeHtml(roleLabel(current))}</span>`;
  }
  return `
    <div class="card" data-account-member="${escapeHtml(target)}">
      <div class="sa-member">
        <div class="sa-avatar" aria-hidden="true">${icon}</div>
        <div class="sa-member-body">
          <div class="weight-600">${escapeHtml(name)}</div>
          <div class="muted-sm text-xs sa-account-line">${escapeHtml(line)}</div>
        </div>
        <div class="sa-member-actions">
          ${actions}
        </div>
      </div>
    </div>`;
}

/**
 * One member row — a person (single bind) OR a group ("k of N joined"), with
 * its rank (a picker on an admin device, read-only elsewhere), who invited it,
 * and Remove/Revoke where this device may withdraw it.
 */
export function peopleRowHtml(i, members, labelOf, ctx = { isAdmin: false, deviceId: "", devicePub: "", managerClass: false, members: null, deviceNames: null }) {
  // A co-manager's invitee is named under their key, which this account can't open.
  const name = i.bundle?.name ?? (i.creatorTier === "co-manager" ? "Someone they invited" : "unknown");
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
  const picker = !role
    ? ""
    : ctx.isAdmin
      ? `${crownHtml(role)}<select data-action="sa-role" data-target="${escapeHtml(target)}" data-current="${escapeHtml(role)}" aria-label="Rank for ${escapeHtml(name)}">${roleOptionsHtml(role)}</select>`
      : `${crownHtml(role)}<span class="sa-rank" data-rank="${escapeHtml(role)}">${escapeHtml(roleLabel(role))}</span>`;
  const removeLabel = isGroup ? "Revoke" : "Remove";
  const invitedBy = invitedByText(i, ctx);
  const remove = canRevokeInvite(i, { ...ctx, members })
    ? `<button class="sa-remove" type="button" data-action="sa-remove" data-id="${escapeHtml(i.inviteId)}" data-aid="${escapeHtml(i.boundAID ?? "")}" data-name="${escapeHtml(name)}" data-group="${isGroup ? "1" : "0"}">${removeLabel}</button>`
    : "";
  return `
    <div class="card">
      <div class="sa-member">
        ${avatar}
        <div class="sa-member-body">
          <div class="weight-600">${escapeHtml(name)}</div>
          <div class="muted-sm text-xs">${escapeHtml(statusText)}</div>
          ${also ? `<div class="muted-sm text-xs">${escapeHtml(also)}</div>` : ""}
          ${invitedBy ? `<div class="muted-sm text-xs sa-invited-by">${escapeHtml(invitedBy)}</div>` : ""}
        </div>
        <div class="sa-member-actions">
          ${picker}
          ${remove}
        </div>
      </div>
    </div>`;
}

/**
 * The remove CORE — DOM-free + dependency-injected, so it's testable under
 * Node (mirrors webappCompanionRequestsView's `runApprove`). Leg 1 records the
 * revocation on `.com` (signed by `revokeSigner`: the admin root, or this
 * device's key for its own invite); leg 2 hands the same signed revoke to the
 * BOX, which drops the invite's grants and whoever is left with none. On an
 * admin device leg 3 also prunes the bound AID(s) (v2, admin-signed): for a
 * GROUP every bound AID, but only those for whom it was their last grant.
 * Returns `{ ok, prunedBox }`. A box failure throws a `box-prune-failed`-tagged
 * error (the `.com` revoke already ran, so the device must know access may
 * persist until the box next checks).
 */
export async function runRemovePerson(
  { serviceRef, inviteId, boundAID, boundAIDs, isGroup, members, isAdmin = true },
  { getSession, controlApex, podBaseUrl, signWithIrk, revokeSigner, humanError, revokeInvite, removeServiceAllow, withdrawInviteOnBox },
) {
  const session = getSession();
  const signed = await revokeInvite({
    comBase: controlApex(),
    username: session.username,
    inviteId,
    umk: session.umk,
    signWithAccountId: revokeSigner,
  });
  let withdrew = false;
  if (typeof withdrawInviteOnBox === "function" && signed?.revoke && typeof signed.signature === "string") {
    try {
      const w = await withdrawInviteOnBox({ baseUrl: podBaseUrl(), revoke: signed.revoke, signature: signed.signature });
      withdrew = (w?.pruned ?? 0) > 0;
    } catch (e) {
      if (!isAdmin) {
        throw err(
          `Withdrawn on flagshipserver.com, but your server didn't take it yet (${humanError(e)}). Anyone who joined keeps access until it next checks.`,
          "box-prune-failed",
        );
      }
    }
  }
  if (!isAdmin) return { ok: true, prunedBox: withdrew };
  // The AIDs to prune on the box: the whole group set, else the single bound
  // AID — but only those for whom this was their last grant. Someone who also
  // holds another invite keeps it: the withdraw (or the box's revocation
  // poller) drops just this grant.
  const bound = isGroup && Array.isArray(boundAIDs) ? boundAIDs : boundAID ? [boundAID] : [];
  const aids = members === undefined ? bound : aidsToPrune(inviteId, bound, members);
  if (aids.length === 0) return { ok: true, prunedBox: withdrew };
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
  const isAdmin = isAdminDevice(getSession());
  const me = myAccountMember(lastMembers, { devicePub: lastDevicePub, deviceId: thisDeviceId() });
  const managerClass = !!me && !me.refused && isManagerClass(me.rank);
  if (!canRevokeInvite(row, { isAdmin, deviceId: thisDeviceId(), devicePub: lastDevicePub, managerClass, members: lastMembers })) return;
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
      { serviceRef, inviteId, boundAID, boundAIDs, isGroup, members: lastMembers ?? undefined, isAdmin },
      {
        getSession,
        controlApex,
        podBaseUrl,
        signWithIrk: sensitiveSigner(),
        revokeSigner: inviteSigner(),
        humanError,
        revokeInvite,
        removeServiceAllow,
        withdrawInviteOnBox,
      },
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
    deviceNames = null;
    if (currentService) renderServiceAccess(currentService).catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
}
