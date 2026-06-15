import { bytesToHex, signWithIrk } from "../keystore.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import { decorateHomeGrid, serverIcon, alertCircleIcon, keyIcon } from "../lib/icons.js";
import {
  chipRow,
  searchField,
  announcementCard,
  listRow,
} from "../lib/uikit.js";
import { tickRenewals } from "../lib/leases.js";
import { activeOperations } from "../lib/activeOperations.js";
import { $, registerView, show, setSubtitle, currentViewId } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { escapeHtml } from "../lib/util.js";
import { formatDuration as formatAge, formatDays } from "../lib/dateFormat.js";
import { toast } from "../lib/toast.js";
import { releaseServerName } from "../lib/releaseServer.js";
import { renderProBanner } from "../lib/proBanner.js";
import { getActiveProfile } from "../lib/profiles.js";
import {
  deviceCapabilityChipText,
  applyScopeGateToButton,
} from "../lib/usersCheck.js";
import { loadProviders } from "../providers.js";
import { renderListProgressBar } from "../lib/provisionProgress.js";
import {
  get as recoveryStoreGet,
  set as recoveryStoreSet,
  remove as profileRemove,
} from "../lib/profilesStore.js";
import { controlApex } from "../lib/apex.js";
import { isServerDecommissioned } from "../lib/serverReplacement.js";
import { depositSwkIfNeeded } from "../lib/swkDeposit.js";
import { depositCgkIfNeeded } from "../lib/cgkDeposit.js";
import { depositPairingIfNeeded } from "../lib/pairingDeposit.js";
import { liveSync } from "../lib/liveSync.js";
import { fetchLeads, invertLeadsMap } from "../lib/directLeads.js";

registerView("view-home", { tab: "home" });

// #36 — empty-state brand mark. The flag-on-mast pennant is RETIRED;
// the empty state now shows the current brand mark (a rounded square
// containing a circle) in teal so it reads as "a moment", not a missing
// asset. Inline SVG to avoid a network round-trip for one decorative glyph.
const EMPTY_MARK_SVG = `
<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" class="empty-mark">
  <rect x="8" y="8" width="80" height="80" rx="22" fill="var(--accent-soft)"
        stroke="var(--accent)" stroke-width="2" />
  <circle cx="48" cy="48" r="20" fill="none" stroke="var(--accent)" stroke-width="4" />
</svg>
`;

/**
 * #31 / #56 — fetch the consolidated pod inventory from .com's public,
 * UNAUTHENTICATED endpoint. ONE fetch returns BOTH the registered pods
 * (liveness + cert state, `state:"online"`) AND the active in-flight
 * install orders (`pending[]`, `state:"pending"`). Mirrors the iOS
 * consolidation (commit bae3537): no second signed/biometric fetch — a
 * just-created, not-yet-registered server surfaces from this same call.
 *
 * Returns `{ statusByDomain, pending }`:
 *   - `statusByDomain`: Map keyed by lower-cased serverDomain, used to
 *     enrich the registered server cards from /api/me/servers.
 *   - `pending`: the raw pending-order array (each `{ orderRef, serverName,
 *     fqdn, phase, createdAt, state }`). `orderRef` is the opaque
 *     sha256("flagship/order-ref/v1|" + serial) — the raw auth-code serial
 *     never rides this unauthenticated response (it's a provision-status
 *     write capability); deep-progress polling uses the serial saved
 *     locally at order creation (views/pending-server.js). Empty when the
 *     field is absent (backward-compatible with a pre-#56 Worker).
 *
 * Best-effort: any error resolves to empty so the home view still renders
 * the base cards.
 */
export async function fetchPodInventory(username) {
  const out = { statusByDomain: new Map(), pending: [] };
  if (!username) return out;
  // Prefer the LiveSync canal: while it's running it holds a fresh `{ pods,
  // pending }` snapshot fed by the /stream long-poll, so we read THAT instead
  // of a second /pods fetch. A cold start (LiveSync not yet started, or no
  // snapshot) falls through to a one-shot /pods read (today's behavior — the
  // safety net).
  const snap = liveSync.get?.();
  if (snap && (snap.pods?.length || snap.pending?.length)) {
    for (const p of snap.pods ?? []) {
      out.statusByDomain.set(String(p.serverDomain ?? "").toLowerCase(), p);
    }
    out.pending = (snap.pending ?? []).filter(
      (p) => p && typeof p.fqdn === "string" && p.fqdn.length > 0,
    );
    return out;
  }
  try {
    const r = await fetch(
      `${controlApex()}/api/users/${encodeURIComponent(username)}/pods`,
    );
    if (!r.ok) return out;
    const body = await r.json();
    for (const p of body.pods ?? []) {
      out.statusByDomain.set(String(p.serverDomain ?? "").toLowerCase(), p);
    }
    // The `pending` array is new + backward-compatible: a pre-#56 Worker
    // omits it, so a missing/non-array value degrades to no pending cards.
    if (Array.isArray(body.pending)) {
      out.pending = body.pending.filter(
        (p) => p && typeof p.fqdn === "string" && p.fqdn.length > 0,
      );
    }
  } catch {
    /* offline / cors — fall back to bare cards, no pending */
  }
  return out;
}

/**
 * #56 — merge the registered servers (authoritative, from the paired
 * session's /api/me/servers) with the in-flight pending orders (from the
 * unauthenticated /pods `pending[]`). Identity is unified on the
 * normalized fqdn (a registered server's `serverId` === a pod's
 * `serverDomain` === a pending order's `fqdn`); a REGISTERED server always
 * SUPERSEDES a pending order with the same fqdn, so a box that finished
 * registering between the two reads never shows as both online and
 * pending. Returns the pending orders that have no registered twin, newest
 * first (the array already arrives newest-first from the server, but we
 * don't depend on that here).
 *
 * @param {Array<{serverId:string}>} servers  registered servers
 * @param {Array<{fqdn:string,createdAt?:number}>} pending  pending orders
 */
export function pendingWithoutRegisteredTwin(servers, pending) {
  const registeredFqdns = new Set(
    (servers ?? []).map((s) => String(s.serverId ?? "").toLowerCase()),
  );
  return (pending ?? [])
    .filter((p) => !registeredFqdns.has(String(p.fqdn ?? "").toLowerCase()))
    .slice()
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Render one pending-order card body: the reserved FQDN, a "pending"
 *  pill, and (when a provisioning phase is known) the thin determinate
 *  progress bar shared with the create-server flow. Pure string builder
 *  so it's unit-testable alongside the registered-card renderer.
 *  @param {{fqdn:string,serverName?:string,phase?:string|null}} order */
export function renderPendingCard(order) {
  const label = order.serverName || order.fqdn;
  const bar = renderListProgressBar({ phase: order.phase ?? null, status: "provisioning" });
  // Clean list row: a warning-tinted server glyph, the reserved name, the
  // fqdn subtitle + "installing" detail, and a "pending" pill trailing.
  const row = listRow({
    leading: { kind: "icon", svg: serverIcon, tone: "warning" },
    title: String(label),
    subtitle: "Installing",
    detail: String(order.fqdn),
    trailing: `<span class="pill warn">Pending</span>`,
  });
  return `
    ${row}
    ${bar}
    <div class="row mt-2"><button class="secondary danger full-width js-delete-dead-server" data-fqdn="${escapeHtml(String(order.fqdn))}">Delete server (free name)</button></div>
  `;
}

/** Grace window (ms) after registration during which a not-yet-online box
 *  reads "coming online" rather than "never came online". 20 minutes —
 *  shared across iOS/Android (PodInfo.comingOnlineGraceMs /
 *  COMING_ONLINE_GRACE_MS). */
export const COMING_ONLINE_GRACE_MS = 20 * 60 * 1000;

/**
 * Classify the server's live status. A registered box that hasn't checked in
 * is NOT automatically dead: distinguish
 *   - waiting-for-approval: a LIVE pending unlock request exists for it (the
 *     box is actively trying to boot and waiting for the owner) → no delete;
 *   - coming-online: registered recently, no live request, inside the grace
 *     window → provisioning, no delete;
 *   - never-seen: registered, no live request, no check-in, past the grace
 *     window → genuinely dead, offer the free-the-name delete.
 *
 * @param {object} server  registered server (may carry `revoked`)
 * @param {object} pod      directory pod entry (lastReported / registeredAt / currentCert / pendingRequests)
 * @param {{ hasLiveUnlockRequest?: boolean, now?: number }} [opts]
 */
export function classifyServer(server, pod, opts = {}) {
  if (server.revoked) return { kind: "revoked", label: `Revoked: ${server.revoked.reason}` };
  const now = opts.now ?? Date.now();

  // Fix A — honor the new /pods `liveness` field when present.
  //
  // The .com control plane now emits `liveness: "live"|"unreachable"|"never"`
  // on each pod entry (alongside the existing `lastReported`). When present,
  // trust it as the authoritative signal — it folds in the latest HELLO
  // timestamps and avoids the client computing stale ages off a cached
  // `lastReported`. When absent (pre-update Worker / test fixture), the
  // existing `lastReported`-age logic acts as the faithful fallback.
  //
  // Mapping:
  //   "live"        → online (cert-expiry sub-checks still apply)
  //   "unreachable" → offline, using `lastSeenMsAgo` for the human age
  //   "never"       → "still coming up" / awaiting first heartbeat
  //
  // Approval / grace-window states take precedence over `liveness === "never"`
  // so a box stuck on serve-authorization still reads "waiting for approval".
  const liveness = pod?.liveness;

  if (liveness === "unreachable") {
    // The box has checked in before but is not reachable right now.
    const msAgo = typeof pod.lastSeenMsAgo === "number" ? pod.lastSeenMsAgo : null;
    const ageLabel = msAgo != null ? formatAge(msAgo) : "unknown";
    return { kind: "offline", label: `Offline (last seen ${ageLabel} ago)` };
  }

  if (liveness === "never") {
    // Box registered but never sent a heartbeat. Check approval / grace states
    // first — they override "never" (same logic as the no-lastReported path).
    if (opts.hasLiveUnlockRequest || (pod?.pendingRequests?.length ?? 0) > 0) {
      return { kind: "waiting-for-approval", label: "Waiting for approval" };
    }
    return { kind: "never-seen", label: "Still coming up" };
  }

  if (!pod || pod.lastReported == null) {
    // No liveness field AND no lastReported — fall back to the existing logic.
    // Registered but never checked in. ANY live request (unlock OR entitlement
    // OR a future type) means it's actively waiting for the owner — not dead.
    // `pendingRequests` is the cheap, unauthenticated Box Request Inbox digest
    // off /pods (the typed list of parked requests); the explicit opt is the
    // biometric-read fallback. A non-empty digest ⇒ waiting (folding every type
    // in is what stops a box stuck on serve-authorization from reading "never
    // came online").
    if (opts.hasLiveUnlockRequest || (pod?.pendingRequests?.length ?? 0) > 0) {
      return { kind: "waiting-for-approval", label: "Waiting for approval" };
    }
    // Within the grace window after registration ⇒ still coming online.
    const registeredAt = pod?.registeredAt;
    if (registeredAt != null && now - registeredAt <= COMING_ONLINE_GRACE_MS) {
      return { kind: "coming-online", label: "Coming online…" };
    }
    return { kind: "never-seen", label: "Never seen" };
  }
  const ageMs = now - pod.lastReported;
  // Daemons HELLO at least every 5 minutes; tolerate a 15-minute
  // staleness before flipping the dot off — handles a transient
  // tunnel hiccup without lighting up the home screen.
  if (ageMs > 15 * 60 * 1000) return { kind: "offline", label: `Offline (${formatAge(ageMs)} ago)` };
  // Cert expiry within 30d — surface as warning even when daemon is online.
  if (pod.currentCert?.validUntil) {
    const msToExpiry = pod.currentCert.validUntil - Date.now();
    if (msToExpiry < 0) return { kind: "cert-expired", label: "Cert expired" };
    if (msToExpiry < 30 * 86400_000) {
      return { kind: "cert-expiring-soon", label: `Cert renews in ${formatDays(msToExpiry)}` };
    }
  }
  return { kind: "online", label: "Online" };
}

/** The short server label for the operations-sliver "preparing <name>"
 *  line — the first DNS segment of `<server>.<user>.flagship.services` (the
 *  home cards still show the full fqdn). Falls back to the raw value. */
function serverShortName(serverIdOrFqdn) {
  const s = String(serverIdOrFqdn ?? "");
  const first = s.split(".")[0];
  return first || s;
}

/**
 * Home filter chips — mirror the iOS `HomeStatusFilter` bucket set + labels
 * (HomeScreen.swift): All / Online / Pending / Offline. Pure presentation —
 * the underlying servers + every action on them are untouched; this only
 * narrows which cards render.
 */
export const HOME_FILTERS = [
  { value: "all", label: "All" },
  { value: "online", label: "Online" },
  { value: "pending", label: "Pending" },
  { value: "offline", label: "Offline" },
];

/**
 * Map a `classifyServer` kind onto one of the three iOS status buckets
 * (online / pending / offline), matching `HomeStatusFilter.matches`:
 *   - Pending buckets provisioning / waiting-for-approval / coming-online
 *     (a box on its way up);
 *   - Offline buckets a genuinely-dead / offline / revoked / cert-expired
 *     box;
 *   - Online is strictly a live, checked-in box.
 * A pending ORDER (no registered twin) is always in the "pending" bucket.
 * @param {string} kind
 * @returns {"online"|"pending"|"offline"}
 */
export function statusBucketForKind(kind) {
  switch (kind) {
    case "online":
    case "cert-expiring-soon":
      return "online";
    case "waiting-for-approval":
    case "coming-online":
      return "pending";
    default:
      // never-seen, offline, revoked, cert-expired → offline bucket.
      return "offline";
  }
}

/** Whether an entry passes the active filter chip. `entry` is the bucket the
 *  card resolved to; `filter` is the active chip value ("all" never filters). */
export function homeFilterMatches(filter, bucket) {
  return filter === "all" || filter === bucket;
}

/**
 * Free-text search predicate over a server/pending card's display fields —
 * mirrors the iOS Home `.searchable` (name / fqdn). Case-insensitive
 * substring; an empty query matches everything. Pure so it's unit-testable.
 * @param {string} query
 * @param {{ name?:string, fqdn?:string }} fields
 */
export function homeSearchMatches(query, fields) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  const hay = [fields?.name ?? "", fields?.fqdn ?? ""].join(" ").toLowerCase();
  return hay.includes(q);
}

/**
 * Build the inner HTML of one server card. The header row shows the
 * server label + live dot; the meta row lists app count, cert expiry
 * countdown (if <30d), and the auto-unlock state.
 *
 * Auto-unlock state isn't in `/api/users/:u/pods` directly — the lease
 * records live on .com per-server but aren't aggregated into the pod
 * inventory yet. We hint at it via the routing target (long-lived
 * leases mean the daemon is reachable without phone tap) and otherwise
 * label the row as "phone-tap only" — accurate to the default.
 */
/** The services this pod currently LEADS, from `/pods` `leadsServices` (Phase 6).
 *  Tolerant of absence (the field is additive; a `.com`/box that doesn't relay it
 *  yields []). Returns a clean string[] of slugs. */
export function leadsOf(pod) {
  const raw = pod?.leadsServices;
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => String(s ?? "").trim()).filter(Boolean);
}

/**
 * Apply a direct-leads inverted map (from `invertLeadsMap`) to the pod
 * status map returned by `fetchPodInventory`. Returns a NEW Map whose
 * pod entries have `leadsServices` overlaid from the direct source when
 * the inverted map has data for that pod's FQDN; pods not in the inverted
 * map keep the relay's `leadsServices` as-is (fall-back).
 *
 * This is the prefer-then-fallback logic: direct read is fresher than the
 * ~5-min-stale relay snapshot, but any failure in the direct read leaves
 * an empty invertedMap and the relay data passes through untouched.
 *
 * @param {Map<string, object>} podStatusByDomain  fqdn → pod entry (from fetchPodInventory)
 * @param {Map<string, string[]>} invertedMap       fqdn → slug[] (from invertLeadsMap)
 * @returns {Map<string, object>}
 */
export function applyDirectLeads(podStatusByDomain, invertedMap) {
  if (!invertedMap || invertedMap.size === 0) return podStatusByDomain;
  const out = new Map();
  for (const [fqdn, pod] of podStatusByDomain) {
    const directSlugs = invertedMap.get(fqdn);
    if (directSlugs !== undefined) {
      // Prefer direct read: overlay leadsServices from the fresh box response.
      out.set(fqdn, { ...pod, leadsServices: directSlugs });
    } else {
      // No direct data for this pod — keep the relay's leadsServices (or none).
      out.set(fqdn, pod);
    }
  }
  return out;
}

export function renderServerCard(server, pod, opts = {}) {
  const c = classifyServer(server, pod, opts);
  const pillClass = c.kind === "online" ? "pill ok"
    : c.kind === "revoked" || c.kind === "cert-expired" ? "pill err"
    : c.kind === "cert-expiring-soon" || c.kind === "waiting-for-approval" ? "pill warn"
    : "pill";
  // Leading status-tinted icon — same semantic colour the dot used to carry.
  const bucket = statusBucketForKind(c.kind);
  const tone = bucket === "online" ? "success" : bucket === "pending" ? "warning"
    : c.kind === "revoked" || c.kind === "cert-expired" ? "danger" : "muted";
  const apps = pod?.appsServed ?? [];
  const serviceCount = Array.isArray(apps) ? apps.length : 0;
  const certCountdown = pod?.currentCert?.validUntil
    ? formatCertCountdown(pod.currentCert.validUntil) : "";
  const autoUnlock = pod?.routingTarget
    ? "auto-unlock on"
    : "phone-tap only";
  // Subtitle folds the app count + auto-unlock state into one muted line; the
  // cert countdown (when <30d) rides the mono detail line.
  let subtitle = `${serviceCount} service${serviceCount === 1 ? "" : "s"} · ${autoUnlock}`;
  // Per-service leadership (Phase 6): `/pods` relays `leadsServices: [slug]` —
  // the services THIS box currently leads (highest-clout live runner). Additive
  // + tolerant of absence: only append when the box actually leads ≥1 service.
  const leads = leadsOf(pod);
  if (leads.length) {
    subtitle += ` · leads ${leads.length === 1 ? leads[0] : `${leads.length} services`}`;
  }
  // A box that registered during install but whose daemon never checked in
  // (`never-seen`) is a dead install — offer the decommission / free-the-name
  // delete via the RELEASE flow (NOT the lost/stolen revoke). A live server is
  // never deletable from here. `data-fqdn` is read by the delegated handler.
  const deadDelete = c.kind === "never-seen"
    ? `<div class="row mt-2"><button class="secondary danger full-width js-delete-dead-server" data-fqdn="${escapeHtml(server.serverId)}">Delete server (free name)</button></div>`
    : "";
  // L3 — a box waiting for the owner to approve its boot/unlock is ACTIONABLE:
  // iOS/Android approve straight from the card, so the webapp card gets an
  // "Approve unlock" button that deep-links into the boot-approval screen
  // (the IRK-signed mailbox read + approve lives there). Without this the card
  // was a dead-end status pill.
  const approveUnlock = c.kind === "waiting-for-approval"
    ? `<div class="row mt-2"><button class="full-width js-approve-unlock">Approve unlock</button></div>`
    : "";
  const row = listRow({
    leading: { kind: "icon", svg: serverIcon, tone },
    title: String(server.serverId),
    subtitle,
    detail: certCountdown ? String(certCountdown) : "",
    // Status pill stacks UNDER the text — labels like "never came online" need a
    // full line rather than being crushed into the right margin against the title.
    // Per-service leadership (Phase 6): a "lead" pill rides alongside when this
    // box currently leads ≥1 service (additive; absent ⇒ no pill).
    trailing: `<span class="${pillClass}">${escapeHtml(c.label)}</span>${
      leads.length
        ? ` <span class="pill ok" title="leads ${escapeHtml(leads.join(", "))}">lead</span>`
        : ""
    }`,
    trailingBelow: true,
  });
  return `
    ${row}
    ${deadDelete}
    ${approveUnlock}
  `;
}

function formatCertCountdown(validUntilMs) {
  const ms = validUntilMs - Date.now();
  if (ms < 0) return "cert expired";
  if (ms < 30 * 86400_000) return `cert renews ${formatDays(ms)}`;
  return ""; // omit chip when comfortably valid — reduces visual noise
}

/** Render the zero-state card when the user has no servers yet.
 *
 *  Phase 2 (docs/login-and-account-redesign.md): an account is an
 *  IDENTITY, not a server. Once the account is open (a username is
 *  claimed + bound to this device key), the user lands here with ZERO
 *  servers — that's the normal, valid state, not an error. The CTA adds
 *  the FIRST server; the same flow adds the Nth. We distinguish:
 *    - account-open (username set) → "Your account is ready — add your
 *      first server." `CreateServer` is reachable as "Add a server".
 *    - unpaired (no username yet / mid-pair) → guide them to open an
 *      account / build a fresh server.
 */
function renderEmptyServersList(root, { reason, username } = {}) {
  const accountOpen = !!username;
  const headline = accountOpen
    ? "Your account is ready"
    : "Your first server is one tap away";
  const hint = accountOpen
    ? `Signed in as ${username}. Your account has no servers yet — add your first one whenever you're ready. You can run zero, one, or many.`
    : reason === "unpaired"
      ? "Pair the webapp to your phone or pod first, or jump straight in and build a fresh server."
      : "Mint a recipe, write it to a USB drive with the Flagship burner, and boot a spare machine — you're a few taps from your own cloud.";
  const ctaLabel = accountOpen ? "Add your first server" : "Create a server";
  root.innerHTML = `
    <div class="card empty-state">
      ${EMPTY_MARK_SVG}
      <h3 class="empty-headline">${escapeHtml(headline)}</h3>
      <p class="note empty-message">${escapeHtml(hint)}</p>
      <button class="primary full-width" id="empty-create-server">${escapeHtml(ctaLabel)}</button>
      ${accountOpen ? '<button class="linklike mt-2" id="empty-take-over">Someone handing you a box? Take over →</button>' : ""}
      <a class="pill mt-2" href="https://flagshipserver.com/" target="_blank" rel="noopener">
        Open flagshipserver.com →
      </a>
    </div>
  `;
  $("empty-take-over")?.addEventListener("click", async () => {
    const { enterTransferClaim } = await import("./transfer-claim.js");
    enterTransferClaim().catch((e) => {
      if (e?.code !== "cancelled") {
        console.error("transfer claim failed", e);
        toast(e?.message ?? String(e), "err");
      }
    });
  });
  $("empty-create-server")?.addEventListener("click", async () => {
    // The account is already open, so this is "Add a server" — a separate,
    // repeatable resource. "Add a server" now means PROVISION directly
    // (Slice A: the three-way chooser is gone — pairing is automatic via
    // auto-pair, and take-over is the /transfer deep-link + camera claim).
    // When the account isn't open yet, fall back to the wizard's
    // create-server step (which opens the account first).
    if (accountOpen) {
      const { enterCreateServer } = await import("./create-server.js");
      await enterCreateServer();
      return;
    }
    // No account yet — route through the wizard's OPEN-ACCOUNT step
    // first (claim a username, bind the device key). Server provisioning
    // happens after the account exists.
    try {
      const { enterWizard } = await import("./wizard.js");
      await enterWizard({ step: "username" });
    } catch {
      const { enterCreateServer } = await import("./create-server.js");
      await enterCreateServer();
    }
  });
}

// 30-minute cadence for the silent lease renewer. The renewer also
// fires opportunistically on every home-view enter, so this interval
// is a safety net for users who leave the webapp open all day.
const RENEWAL_TICK_MS = 30 * 60 * 1000;
let renewalTimer = null;
let renewalLastServerList = null; // dedupe: only kick a tick when servers change

const FLAGSHIP_PROMO_LABEL_PREFIX = "Flagship promo";

function isPromoEntry(e) {
  return e?.label?.startsWith(FLAGSHIP_PROMO_LABEL_PREFIX);
}

const COM_BASE_FOR_E7 = controlApex();
const ACCOUNT_RESET_BANNER_ID = "home-account-reset-banner";

// Mirrors wizard.js's `recoveryWarn` slot — the wizard SETs this to "true"
// when the user skips "Secure your account" and REMOVES it once a backup
// (cloud passkey or .flagshipkey file) actually completes. So a "true"
// value is the single, consistent signal that recovery is not enrolled.
// Pinned to the legacy flat key (unused at runtime; the homeRecoveryBanner
// test asserts the source string is identical on both surfaces).
const RECOVERY_WARN_KEY = "flagship.recovery.warn.v1";
// Per-device dismiss for the home nudge — local state only, no API. Mirrors
// the dismissable backup nudge on iOS/Android (a UI preference, not a
// security decision; clearing the warn key on real enrolment is the source
// of truth, this only quiets a still-unenrolled reminder the user has seen).
const RECOVERY_BANNER_DISMISS_KEY = "flagship.recovery.banner.dismissed.v1";
const RECOVERY_BANNER_ID = "home-recovery-banner";
// The above two constants are pinned-to-string for the homeRecoveryBanner
// static-source test (which asserts both home.js + wizard.js still use the
// same key strings). Runtime reads now go through the per-profile store.
void RECOVERY_WARN_KEY; void RECOVERY_BANNER_DISMISS_KEY;

/**
 * Pure predicate for the home backup-reminder banner. Show it iff the
 * wizard flagged recovery as not-yet-enrolled (`warn === "true"`) AND the
 * user hasn't dismissed the nudge on this device. Extracted so the rule
 * is testable without a DOM (mirrors accountReset.test.ts's approach).
 */
export function shouldShowRecoveryBanner({ warn, dismissed } = {}) {
  return warn === "true" && dismissed !== "true";
}

/**
 * Render (or remove) the dismissable "secure your account" nudge above the
 * server list. Routes into Settings → Recovery via the existing
 * enterRecovery(); the dismiss writes a local flag so it stays hidden.
 */
function renderRecoveryBanner() {
  let warn = null;
  let dismissed = null;
  try {
    // P12 — per-profile recovery flags. The store handles its own legacy
    // fallback at read time for the pre-migration case; we no longer need a
    // belt-and-braces localStorage probe here.
    warn = recoveryStoreGet("recoveryWarn");
    dismissed = recoveryStoreGet("recoveryBannerDismissed");
  } catch { /* localStorage disabled — treat as no banner */ }

  const existing = document.getElementById(RECOVERY_BANNER_ID);
  if (!shouldShowRecoveryBanner({ warn, dismissed })) {
    existing?.remove();
    return;
  }
  if (existing) return;

  // One clean teal announcement card (mirrors iOS FSAnnouncementCard) in
  // place of the old left-rule banner. CTA → recovery enrollment; the "x"
  // dismiss writes the per-device flag so it stays hidden.
  const host = document.createElement("div");
  host.id = RECOVERY_BANNER_ID;
  host.innerHTML = announcementCard({
    icon: keyIcon,
    title: "Your account isn't backed up yet",
    message:
      "If you lose this device, getting back in means a 3-day wait — and that same path lets anyone who knows your username try to claim your account. Set up recovery now (one minute) so you can restore instantly and privately from a fresh browser.",
    ctaLabel: "Secure my account",
    dismissible: true,
    tone: "teal",
  });
  const list = document.getElementById("servers-list");
  list?.parentNode?.insertBefore(host, list);

  host
    .querySelector("[data-ann-cta]")
    ?.addEventListener("click", async () => {
      const { enterRecovery } = await import("./recovery.js");
      if (typeof enterRecovery === "function") enterRecovery();
    });
  host
    .querySelector("[data-ann-dismiss]")
    ?.addEventListener("click", () => {
      try {
        // P12 — write to the active profile's slot (the store also mirrors
        // to the legacy flat key, so unmigrated read-sites stay aligned).
        recoveryStoreSet("recoveryBannerDismissed", "true");
      } catch { /* swallow */ }
      document.getElementById(RECOVERY_BANNER_ID)?.remove();
    });
}

/**
 * E7 — peer "your account was reset on another device" detector.
 *
 * Signal: this device's local `flagship.pushTokenId` is no longer
 * in `/api/users/:u/devices`. That can only happen if another device
 * on the account ran a Disconnect / Replace / Wipe against us, or
 * the Worker GC'd us as an orphan post-rotation.
 *
 * Effect: prepend a danger banner above #servers-list with a "Sign
 * in again" button that clears local session state and reloads. The
 * fresh load drops the user into the wizard / Welcome flow where
 * they can recover with their passkey.
 *
 * Both fetches are tolerated as missing — silent failure is the
 * right call (we'd rather under-warn than flash a banner on a
 * transient network blip).
 */
async function detectAccountReset(username) {
  if (!username) return;
  const localToken = recoveryStoreGet("pushTokenId");
  if (!localToken) return; // fresh install, no token → never orphaned
  let devices = [];
  try {
    const r = await fetch(
      `${COM_BASE_FOR_E7}/api/users/${encodeURIComponent(username)}/devices`,
      { cache: "no-store" },
    );
    if (!r.ok) return;
    const body = await r.json();
    devices = body.devices ?? [];
  } catch {
    return;
  }
  const present = devices.some((d) => d.tokenId === localToken);
  const banner = document.getElementById(ACCOUNT_RESET_BANNER_ID);
  if (present) {
    // Recovered (or never lost) — clean up the banner if previous
    // renders left one.
    banner?.remove();
    return;
  }
  // Insert the banner immediately above #servers-list. Replacing
  // rather than appending so we don't stack copies across renders.
  banner?.remove();
  // Danger-variant announcement card (mirrors iOS FSAnnouncementCard tint:
  // .danger) — not dismissible (the user must act), CTA → re-sign-in.
  const host = document.createElement("div");
  host.id = ACCOUNT_RESET_BANNER_ID;
  host.innerHTML = announcementCard({
    icon: alertCircleIcon,
    title: "This device was removed from your account",
    message:
      "Another device on this account ran Disconnect, Replace, or Wipe. Sign in again with your recovery passkey to get back in.",
    ctaLabel: "Sign in again",
    dismissible: false,
    tone: "danger",
  });
  const list = document.getElementById("servers-list");
  list?.parentNode?.insertBefore(host, list);
  host
    .querySelector("[data-ann-cta]")
    ?.addEventListener("click", () => {
      // Clear the per-device tokens + session so a reload drops the
      // user into recovery. We deliberately keep the wrappedUmk so
      // the recovery flow can re-bind without a fresh enrolment.
      profileRemove("pushTokenId");
      profileRemove("sessionId");
      profileRemove("sessionV1");
      window.location.reload();
    });
}

/**
 * v2 device-addressing — read the active profile's deviceCapability
 * block (the `<u>.<device-label>` restricted sub-identity). Returns
 * null for a legacy single-IRK session (no chip, all actions enabled),
 * mirroring iOS AppState.deviceCapability. The block is stored on the
 * profile descriptor by openAccount / accountResolve at sign-in.
 */
export function activeDeviceCapability() {
  try {
    return getActiveProfile()?.deviceCapability ?? null;
  } catch {
    return null;
  }
}

/**
 * Render (or clear) the "Device: <label> · browse-only" chip below the
 * username, mirroring iOS HomeScreen.deviceChip. The chip suppresses
 * for a fully-scoped device or a legacy single-IRK session (chipText
 * returns null) — same rule as iOS `!cap.isFullyScoped`.
 */
function renderDeviceCapabilityChip(cap) {
  const slot = $("home-device-capability");
  if (!slot) return;
  const text = deviceCapabilityChipText(cap);
  if (!text) {
    slot.innerHTML = "";
    slot.classList.add("hidden");
    return;
  }
  slot.classList.remove("hidden");
  slot.innerHTML = `
    <span class="device-cap-chip" data-device-capability-chip
          aria-label="${escapeHtml(text)}">
      <span aria-hidden="true">🛡</span> ${escapeHtml(text)}
    </span>
  `;
}

// In-memory model for the server list, plus the active filter chip + search
// query. Chip taps + typing re-paint from this model WITHOUT re-fetching —
// pure presentation, exactly like the iOS Home `.searchable` + chip filter.
let homeServerEntries = [];
let homeFilter = "all";
let homeQuery = "";

/**
 * Paint the home server list: the large collapsing title, the search field,
 * the All/Online/Pending/Offline filter chips (each with a live count), then
 * the filtered + searched cards. Re-runnable on every chip/search change.
 * Reads its model from `homeServerEntries`; never re-fetches.
 */
function renderServerCards() {
  const list = $("servers-list");
  if (!list) return;

  // Per-bucket counts for the chip badges (computed off the FULL set, not the
  // currently-filtered view, so the chips read as a stable summary).
  const counts = { all: homeServerEntries.length, online: 0, pending: 0, offline: 0 };
  for (const e of homeServerEntries) counts[e.bucket] = (counts[e.bucket] ?? 0) + 1;
  const chips = HOME_FILTERS.map((f) => ({
    value: f.value,
    label: f.label,
    count: counts[f.value] ?? 0,
  }));

  const visible = homeServerEntries.filter(
    (e) => homeFilterMatches(homeFilter, e.bucket) && homeSearchMatches(homeQuery, e.fields),
  );

  const cardsHtml = visible.length
    ? visible
        .map((e) => {
          // A registered (non-pending) card is tappable → opens server-detail.
          const openable = e.bucket !== "pending" && e.fields.fqdn;
          const attrs = openable
            ? ` data-open-fqdn="${escapeHtml(e.fields.fqdn)}"`
            : "";
          const cls = openable ? `${e.cardClass} is-tappable` : e.cardClass;
          return `<div class="card ${cls}"${attrs}>${e.html}</div>`;
        })
        .join("")
    : `<div class="card placeholder">${
        homeQuery || homeFilter !== "all"
          ? "No servers match this filter."
          : "No servers yet."
      }</div>`;

  list.innerHTML = `
    <div class="fs-hero-compact" data-home-compact aria-hidden="true">Servers</div>
    <div class="fs-hero">
      <h2 class="fs-hero-title" data-home-title>Servers</h2>
      ${searchField({ value: homeQuery, placeholder: "Search servers", id: "home-search" })}
      ${chipRow({ items: chips, selected: homeFilter, ariaLabel: "Filter servers" })}
      <button class="secondary mt-2" id="home-add-server">+ Add a server</button>
      <button class="linklike mt-1" id="home-take-over">Someone handing you a box? Take over →</button>
    </div>
    <div data-server-cards>${cardsHtml}</div>
  `;

  wireHomeListControls(list);
}

/**
 * Delegate the chip / search / clear / delete interactions on the freshly
 * painted list. Idempotent per render (the innerHTML reset above drops the
 * old nodes + their listeners, so re-binding can't stack handlers).
 */
function wireHomeListControls(list) {
  // "+ Add a server" — provision a brand-new box directly (Slice A: no more
  // chooser). Pairing is automatic (auto-pair); take-over is the separate
  // "Take over" link + the /transfer deep-link + camera claim.
  list.querySelector("#home-add-server")?.addEventListener("click", async () => {
    const { enterCreateServer } = await import("./create-server.js");
    await enterCreateServer();
  });
  // Tap a registered server card → open its detail screen. Clicks that
  // land on an inner control (approve / delete / links) are ignored so the
  // card tap never hijacks a button.
  list.querySelectorAll("[data-open-fqdn]").forEach((card) => {
    card.addEventListener("click", async (ev) => {
      if (ev.target.closest("button, a, input, label, select, textarea")) return;
      const fqdn = card.getAttribute("data-open-fqdn");
      if (!fqdn) return;
      const { enterServerDetail } = await import("./server-detail.js");
      await enterServerDetail(fqdn);
    });
  });
  // "Take over a box" — the standalone acquirer claim (paste / scan a
  // transfer link). The same view a `/transfer?o=` deep link routes into.
  list.querySelector("#home-take-over")?.addEventListener("click", async () => {
    const { enterTransferClaim } = await import("./transfer-claim.js");
    enterTransferClaim().catch((e) => {
      if (e?.code !== "cancelled") {
        console.error("transfer claim failed", e);
        toast(e?.message ?? String(e), "err");
      }
    });
  });
  // Filter chips — narrow the visible set, no re-fetch.
  list.querySelectorAll("[data-chip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      homeFilter = btn.getAttribute("data-chip-value") || "all";
      renderServerCards();
    });
  });
  // Search — live substring filter as the user types.
  const search = list.querySelector("[data-search]");
  if (search) {
    search.addEventListener("input", () => {
      homeQuery = search.value;
      // Re-paint, then restore focus + caret to the (recreated) field so
      // typing isn't interrupted by the innerHTML swap.
      renderServerCards();
      const next = $("home-search");
      if (next) {
        next.focus();
        const v = next.value;
        next.setSelectionRange(v.length, v.length);
      }
    });
  }
  const clear = list.querySelector("[data-search-clear]");
  if (clear) {
    clear.addEventListener("click", () => {
      homeQuery = "";
      renderServerCards();
      $("home-search")?.focus();
    });
  }
  // "Delete server (free name)" — same release flow as before.
  list.querySelectorAll(".js-delete-dead-server").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const fqdn = btn.getAttribute("data-fqdn") || "";
      void deleteDeadServer(fqdn, btn);
    });
  });
  // L3 — "Approve unlock" on a waiting-for-approval card deep-links into the
  // boot-approval screen (the biometric/IRK-gated mailbox read + approve),
  // matching iOS/Android approving from the card.
  list.querySelectorAll(".js-approve-unlock").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { enterBootApproval } = await import("./boot-approval.js");
      await enterBootApproval();
    });
  });
  // Collapsing-header reveal: show the compact sticky title once the large
  // one scrolls out of view. Progressive — absent IntersectionObserver the
  // compact title simply stays hidden and the large title scrolls normally.
  wireHeroCollapse(list);
}

/**
 * Reveal the compact sticky title when the large hero title scrolls past the
 * app header (WhatsApp large-title collapse). Uses IntersectionObserver so
 * it's cheap + passive; a missing observer leaves the compact title hidden.
 */
function wireHeroCollapse(root) {
  const title = root.querySelector("[data-home-title]");
  const compact = root.querySelector("[data-home-compact]");
  if (!title || !compact || typeof IntersectionObserver === "undefined") return;
  const io = new IntersectionObserver(
    (ents) => {
      for (const ent of ents) {
        compact.classList.toggle("is-revealed", !ent.isIntersecting);
      }
    },
    // Account for the ~54px app header so the swap happens as the title
    // tucks under the chrome, not when it fully leaves the viewport.
    { rootMargin: "-60px 0px 0px 0px", threshold: 0 },
  );
  io.observe(title);
}

export async function renderHome() {
  // A fresh render rebuilds the model; reset the transient filter/search view
  // so a re-entered Home doesn't inherit a stale "Offline"-only filter.
  homeFilter = "all";
  homeQuery = "";
  const session = getSession();
  setSubtitle(session.username ? `signed in as ${session.username}` : "signed in");
  $("home-username").textContent = session.username || "(not set)";
  $("home-irkpub").textContent = session.irk
    ? bytesToHex(session.irk.publicKey).slice(0, 16) + "…" + bytesToHex(session.irk.publicKey).slice(-4)
    : "—";

  // v2 device-addressing — chip + per-action scope gating. A nil
  // capability (legacy single-IRK path) enables everything; a restricted
  // sub-identity (e.g. reviewer = [browse]) greys out install / vibe-code.
  const deviceCap = activeDeviceCapability();
  renderDeviceCapabilityChip(deviceCap);
  applyScopeGateToButton(
    $("services-list-open-marketplace"),
    deviceCap,
    "install-service",
    "This device cannot install services. Use a primary device.",
  );
  applyScopeGateToButton(
    $("services-list-open-vibe-code"),
    deviceCap,
    "vibe-code",
    "This device cannot build new services. Use a primary device.",
  );

  // E7 — fire-and-forget account-reset detection. Renders a danger
  // banner above the server list if our locally-stored push tokenId
  // is no longer in /api/users/:u/devices. Silent on failure so a
  // transient network blip doesn't flash a banner.
  detectAccountReset(session.username).catch(() => {});

  // Post-creation backup nudge — shown when the wizard flagged recovery
  // as skipped (not enrolled) and the user hasn't dismissed it on this
  // device. Local-only signal; no API call.
  renderRecoveryBanner();

  // Always-available "Become a Pro member" support CTA — a gentle, on-brand
  // membership nudge (distinct from the cap-hit upgrade alert) for the ~95%
  // who never hit the bandwidth cap but would happily back the project.
  // Fully dismissible; once dismissed on this device it never re-appears.
  renderProBanner();

  const sid = recoveryStoreGet("sessionId");
  const sessionStatusEl = $("session-status");
  const list = $("servers-list");
  list.innerHTML = "";
  if (!sid) {
    sessionStatusEl.textContent = "Unpaired";
    sessionStatusEl.classList.remove("ok");
    // #36 — real empty state, not a "no paired session" stub. Phase 2:
    // if the account is already open (username claimed), this is the
    // valid "account ready, no servers yet" state and the CTA adds the
    // first server. Otherwise we guide them to open an account / build.
    renderEmptyServersList(list, { reason: "unpaired", username: session.username });
    activeOperations.syncDeployOperations([]);
    stopApprovalPoll();
    return;
  }
  try {
    const r = await fetch(`/api/me/servers?sessionId=${encodeURIComponent(sid)}`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    const body = await r.json();
    sessionStatusEl.textContent = "Paired";
    sessionStatusEl.classList.add("ok");
    // #31 / #56 — ONE unauthenticated fan-out to /api/users/:u/pods on .com
    // returns BOTH the registered pods (liveness/cert enrichment) AND the
    // in-flight install orders (`pending[]`). No second signed fetch — a
    // just-created, not-yet-registered server rides this same call.
    // Failures here are non-fatal: registered cards fall back to the bare
    // label + active/revoked pill and pending simply doesn't surface.
    let { statusByDomain: podStatusByDomain, pending } = await fetchPodInventory(
      session.username,
    );
    // Direct lead-read (Phase 6 follow-on): if any box is reachable, fetch
    // /api/leads directly for a fresher snapshot than the ~5-min relay.
    // Best-effort: any failure leaves podStatusByDomain untouched (fall back
    // to relay). We pick the first "live" pod as the source — its /api/leads
    // response covers the GLOBAL map for all boxes in this account.
    {
      let firstLiveFqdn = null;
      for (const [fqdn, pod] of podStatusByDomain) {
        if (pod?.liveness === "live" || (pod?.lastReported != null && Date.now() - pod.lastReported <= 15 * 60 * 1000)) {
          firstLiveFqdn = fqdn;
          break;
        }
      }
      if (firstLiveFqdn) {
        const leadsMap = await fetchLeads(firstLiveFqdn).catch(() => null);
        if (leadsMap) {
          podStatusByDomain = applyDirectLeads(podStatusByDomain, invertLeadsMap(leadsMap));
        }
      }
    }
    // L3 (docs §8b) — a box retired by "Replace this server" is suppressed from
    // the list so the phone never re-surfaces or re-approves the zombie instance
    // (the replacement re-registers under the same FQDN with a fresh STK; until
    // it does the old FQDN simply doesn't appear).
    body.servers = (body.servers ?? []).filter(
      (s) => !isServerDecommissioned(s.serverId),
    );
    // Registered server always supersedes a pending order with the same
    // fqdn (identity unified on the normalized fqdn).
    const pendingOrders = pendingWithoutRegisteredTwin(body.servers, pending).filter(
      (o) => !isServerDecommissioned(o.fqdn),
    );

    // Zero registered AND zero pending → the honest empty zero-state.
    if (!body.servers.length && !pendingOrders.length) {
      renderEmptyServersList(list, { reason: "no-servers", username: session.username });
      activeOperations.syncDeployOperations([]);
      stopApprovalPoll();
      return;
    }

    // Account-level "which boxes are waiting for my unlock approval?" — ONE
    // fetch, reused by every card so a registered-but-not-yet-checked-in box
    // with a LIVE unlock request reads "waiting for approval" (not "never
    // seen") and keeps its delete button hidden. Best-effort: a failure (no
    // UMK, network blip) leaves the set empty so cards fall back to the
    // age-based grace classification.
    const awaitingApproval = await fetchAwaitingApprovalSet();

    // Build the card model (registered first, pending below). Each entry
    // carries its rendered HTML, its status bucket (for the filter chips) and
    // its searchable fields (name / fqdn) so chip + search are pure local
    // re-renders that never re-fetch and never touch any server action.
    const entries = [];
    // A server still on its way up feeds the global operations sliver as a
    // "deploying server <name>" op (the WhatsApp-style active-operations bar).
    // We collect both registered-but-coming-up boxes and in-flight pending
    // orders into one `{podId,name,status:"pending"}` list and hand it to the
    // churn-free reconciler, so a deploying server stays in the sliver across
    // navigation and clears the moment it goes live.
    const deployPods = [];
    for (const s of body.servers) {
      const hasLiveUnlockRequest = awaitingApproval.has(
        String(s.serverId ?? "").toLowerCase(),
      );
      const pod = podStatusByDomain.get(s.serverId.toLowerCase());
      // Secret-free recipe: a registered box now has a directory identity to
      // seal the SWK to. No-ops unless a deposit is owed (idempotent via
      // swkDeposit.js); best-effort + non-blocking so it never delays a render.
      if (pod?.identityPubKey) {
        depositSwkIfNeeded({
          serverDomain: String(s.serverId),
          identityPubKeyHex: String(pod.identityPubKey),
        }).catch(() => {});
        // Secret-free CGK (Phase 6): every registered box is owed the per-cloud
        // gossip key so it can run per-service leadership. Seal + deposit it to
        // the box identity; no-ops once deposited (idempotent via cgkDeposit.js).
        depositCgkIfNeeded({
          serverDomain: String(s.serverId),
          identityPubKeyHex: String(pod.identityPubKey),
        }).catch(() => {});
        // Secret-free pairing: seal + deposit the stashed create-time order to
        // the box's directory identity so it pairs with no manual tap. No-ops
        // unless a deposit is owed (idempotent via pairingDeposit.js).
        depositPairingIfNeeded({
          serverDomain: String(s.serverId),
          identityPubKeyHex: String(pod.identityPubKey),
        }).catch(() => {});
      }
      const cls = classifyServer(s, pod, { hasLiveUnlockRequest });
      const bucket = statusBucketForKind(cls.kind);
      entries.push({
        html: renderServerCard(s, pod, { hasLiveUnlockRequest }),
        bucket,
        fields: { name: String(s.serverId ?? ""), fqdn: String(s.serverId ?? "") },
        cardClass: "server-card",
      });
      if (bucket === "pending") {
        deployPods.push({
          podId: String(s.serverId ?? ""),
          name: serverShortName(s.serverId),
          status: "pending",
          // A REGISTERED-but-not-yet-live server has already booted +
          // registered, so it is genuinely provisioning — flag it started so
          // it surfaces a "preparing <name>" sliver op.
          started: true,
        });
      }
    }
    for (const order of pendingOrders) {
      entries.push({
        html: renderPendingCard(order),
        bucket: "pending",
        fields: {
          name: String(order.serverName ?? order.fqdn ?? ""),
          fqdn: String(order.fqdn ?? ""),
        },
        cardClass: "server-card server-card--pending",
      });
      deployPods.push({
        podId: String(order.fqdn ?? ""),
        name: String(order.serverName || serverShortName(order.fqdn)),
        status: "pending",
        // Only a pending ORDER whose box has actually started booting/installing
        // (a real ladder phase, posted by the install beacons) gets a spinning
        // sliver op. An order merely AWAITING A BURN has no phase yet → no op
        // (the card's "pending" pill is the right, non-spinning signal).
        phase: order.phase ?? null,
      });
    }
    homeServerEntries = entries;
    renderServerCards();
    // Reconcile the sliver's deploy operations against this tick's pending
    // set. Build operations (vibe-code) are untouched.
    activeOperations.syncDeployOperations(deployPods);
    // LiveSync canal — instead of a standalone 5s `/pods` approval poll, Home
    // re-paints when the app-scope LiveSync stream reports a change (a box
    // starts/stops waiting, a pending order advances, a new pod appears). The
    // /stream long-poll returns the instant state changes, so a waiting box
    // lights up its Approve affordance with no separate poller. The
    // subscription is cleared on navigation away (flagship:view-shown) + lock.
    armHomeLiveSync();
    // Silent auto-renewal of long-lived leases. Fires on every home
    // enter (cheap — no-ops when no leases are close to expiry) and
    // refreshes the timer so the cadence resets each time the user
    // re-engages with the webapp.
    const liveServerIds = body.servers
      .filter((s) => !s.revoked)
      .map((s) => s.serverId);
    scheduleRenewals(liveServerIds);
  } catch (e) {
    // A user with no server should never see a "couldn't load" card —
    // the honest, non-alarming state is the same empty zero-state we
    // show when the list comes back empty. Keep the failure in the
    // console for debugging, but leave the surface clean.
    console.warn("home: servers list failed to load", e);
    sessionStatusEl.textContent = "No servers";
    sessionStatusEl.classList.remove("ok");
    renderEmptyServersList(list, { reason: "no-servers", username: session.username });
    activeOperations.syncDeployOperations([]);
    stopApprovalPoll();
  }
}

/**
 * Account-level set of lowercased fqdns that have a LIVE (non-expired) pending
 * boot-unlock request right now — the box is actively waiting for the owner's
 * approval. Reuses the same `fetchVerifiedRequests` the per-server approval
 * flow uses (IRK-signed mailbox-auth read; re-verified against the directory
 * STK). Best-effort: any failure (no UMK, network) yields an EMPTY set so the
 * card classification falls back to the registration-age grace window — never
 * mislabels a box as waiting on a blip.
 *
 * @returns {Promise<Set<string>>}
 */
async function fetchAwaitingApprovalSet() {
  try {
    const { fetchVerifiedRequests } = await import("../lib/bootApproval.js");
    const reqs = await fetchVerifiedRequests();
    return new Set(
      (reqs ?? [])
        .filter((r) => r.purpose === "unlock-key")
        .map((r) => String(r.serverDomain ?? "").toLowerCase()),
    );
  } catch {
    return new Set();
  }
}

/**
 * Decommission a registered-but-dead (never-came-online) or pending server
 * from the home list. Frees the name via the owner-IRK-signed
 * `ReleaseServerName` release — the SAME path the pending-server cancel uses
 * and distinct from the lost/stolen revoke (this is for a box that never
 * checked in, with no live state to brick). On success the list is re-rendered
 * so the card disappears; on failure the name stays reserved (we never strand
 * it half-deleted) and a toast surfaces the error.
 *
 * @param {string} serverDomain  `<server>.<user>.flagship.services`
 * @param {HTMLButtonElement} [btn]
 */
async function deleteDeadServer(serverDomain, btn) {
  if (!serverDomain) return;
  const session = getSession();
  const username = session.username;
  if (!username) {
    toast("Unlock the webapp first", "warn");
    return;
  }
  const ok = confirm(
    `Delete "${serverDomain}"? This frees the name for reuse and the box can no longer come online. This server never checked in.`,
  );
  if (!ok) return;
  if (btn) { btn.disabled = true; btn.textContent = "deleting…"; }
  try {
    const out = await releaseServerName({
      username,
      serverDomain,
      umk: session.umk,
      // Slice D: release-server-name is a SENSITIVE order (admin root when present).
      signWithIrk: sensitiveSigner(),
    });
    if (out && out.pending) {
      // P14 Phase 2 — companion profile (no local UMK): the release is queued
      // for the owner to approve. Surface the pending sheet; don't drop the
      // card locally (the name isn't freed until the owner signs).
      const { showCompanionPendingSheet, outcomeToastCopy } = await import(
        "../lib/companionPendingSheet.js"
      );
      const result = await showCompanionPendingSheet(out);
      if (result.outcome !== "approved") {
        const { text, kind } = outcomeToastCopy(result.outcome);
        toast(text, kind);
        if (btn) { btn.disabled = false; btn.textContent = "Delete server (free name)"; }
        return;
      }
    }
    toast(`Deleted — "${serverDomain}" is free again`);
    await renderHome();
  } catch (e) {
    // Keep the card: the name is still reserved, so re-render would just hide
    // a name the user can't reuse. Surface the error + re-enable the button.
    toast(`Delete failed: ${e.message ?? e}`, "err");
    if (btn) { btn.disabled = false; btn.textContent = "Delete server (free name)"; }
  }
}

export async function renderActiveProviderChip() {
  const session = getSession();
  const chip = $("home-active-provider");
  if (!chip || !session.umk) return;
  const stored = await loadProviders(session.umk);
  const e = stored.entries.find((x) => x.id === stored.activeId);
  if (!e) {
    chip.innerHTML = `
      <div class="row">
        <div>
          <div class="weight-600">No active provider</div>
          <div class="muted-sm">claim free credits or add your own key</div>
        </div>
        <button class="secondary" id="chip-settings">settings</button>
      </div>
    `;
  } else {
    const promo = isPromoEntry(e);
    chip.innerHTML = `
      <div class="row">
        <div>
          <div class="weight-600">${escapeHtml(e.label)} <span class="pill">${escapeHtml(e.provider)}</span></div>
          <div class="muted-sm">${promo ? "Flagship-issued key — flagshipserver.com cannot read prompts" : "key on this device — flagshipserver.com cannot read prompts"}</div>
        </div>
        <button class="secondary" id="chip-settings">manage</button>
      </div>
    `;
  }
  $("chip-settings")?.addEventListener("click", async () => {
    show("view-settings");
    const { renderProviders } = await import("./settings.js");
    await renderProviders();
  });
}

export async function enterHome() {
  show("view-home");
  decorateHomeGrid(document);
  await renderHome();
  await renderActiveProviderChip();
}

export function initHomeView({ onPair, onSettings }) {
  $("pair-with-server")?.addEventListener("click", onPair);
  $("open-settings")?.addEventListener("click", onSettings);
}

/**
 * Kick off the renewer for the user's known servers and (re)arm a
 * 30-min interval. The interval is deliberately a no-op until the
 * lease enters its 1-day pre-expiry window, so it's cheap to run
 * frequently. We dedupe by stringified server list so we don't
 * re-schedule on every render.
 */
function scheduleRenewals(serverFqdns) {
  const key = serverFqdns.slice().sort().join("|");
  if (key === renewalLastServerList && renewalTimer) {
    // Already running for the same server set — fire once now (cheap)
    // so app-open semantics hold, but don't reset the interval.
    void tickRenewals(serverFqdns).catch(() => {});
    return;
  }
  renewalLastServerList = key;
  if (renewalTimer) clearInterval(renewalTimer);
  void tickRenewals(serverFqdns).catch(() => {});
  if (serverFqdns.length === 0) {
    renewalTimer = null;
    return;
  }
  renewalTimer = setInterval(() => {
    void tickRenewals(serverFqdns).catch(() => {});
  }, RENEWAL_TICK_MS);
}

/** Stop the renewer (called on lock so a new account doesn't inherit timers). */
export function stopRenewals() {
  if (renewalTimer) clearInterval(renewalTimer);
  renewalTimer = null;
  renewalLastServerList = null;
  stopApprovalPoll();
}

// ── Home live updates via the LiveSync canal (replaces the L9 approval poll) ──
//
// iOS runs BootApprovalWatcher's ~5s `/pods`-driven loop while Home is on
// screen; Android runs the same cadence in a `LaunchedEffect`. The webapp used
// to arm its OWN 5s `/pods` interval on Home so a box that started waiting
// AFTER the paint surfaced its "Approve unlock" affordance. That standalone
// poll is now SUPERSEDED by the app-scope LiveSync stream: the /stream
// long-poll returns the instant ANY meaningful state changes (a box starts/
// stops waiting, a pending order advances a phase, a new pod appears), so Home
// simply subscribes to LiveSync and repaints on change — one canal, no second
// poller. The subscription is dropped the moment we navigate away (and on lock).
//
// `APPROVAL_POLL_MS` is retained as the documented cadence reference (iOS/
// Android still poll on it as their fallback) and `stopApprovalPoll` is kept as
// the lock-time teardown hook other modules call.
export const APPROVAL_POLL_MS = 5_000;
/** Unsubscribe handle for the Home LiveSync subscription, or null when idle. */
let homeLiveSyncUnsub = null;
// Churn-free change detection: a stable signature of the last snapshot we
// repainted for, so a re-emit with identical pod/pending state never triggers
// a needless repaint (mirrors the iOS Set compare before re-rendering).
let homeLiveSyncLastSig = null;

/** A stable signature for a LiveSync snapshot — the bits that change a card's
 *  classification (liveness, cert, the pendingRequests digest, pending phases). */
function liveSyncSnapshotSignature(snap) {
  const pods = (snap?.pods ?? [])
    .map((p) => {
      const reqs = (p.pendingRequests ?? [])
        .map((r) => `${r.id}:${r.type}:${r.expiresAt}`)
        .sort()
        .join(",");
      return [
        p.serverDomain,
        p.lastReported ?? "",
        p.currentCert?.sha256 ?? "",
        reqs,
      ].join("|");
    })
    .sort();
  const pending = (snap?.pending ?? [])
    .map((o) => `${o.fqdn}|${o.phase ?? ""}`)
    .sort();
  return JSON.stringify({ pods, pending });
}

/** Subscribe Home to the LiveSync canal. On a snapshot change (and only a real
 *  change) repaint Home — but only while Home is still the active view. The
 *  subscription replaces the old 5s setInterval; LiveSync runs app-scope so the
 *  stream is already live, we just react to it. Idempotent. */
function armHomeLiveSync() {
  if (homeLiveSyncUnsub) return;
  // Seed the signature with the current snapshot so the immediate replay the
  // subscribe fires doesn't trigger a redundant repaint of the paint we just did.
  homeLiveSyncLastSig = liveSyncSnapshotSignature(liveSync.get?.());
  homeLiveSyncUnsub = liveSync.subscribe((snap) => {
    const sig = liveSyncSnapshotSignature(snap);
    if (sig === homeLiveSyncLastSig) return;
    homeLiveSyncLastSig = sig;
    if (currentViewId() === "view-home") void renderHome().catch(() => {});
  });
}

/** Disarm the Home LiveSync subscription (navigation away from Home, or lock).
 *  Kept under the original `stopApprovalPoll` name so the lock-time teardown +
 *  the navigate-away listener that call it keep working unchanged. */
export function stopApprovalPoll() {
  if (homeLiveSyncUnsub) {
    homeLiveSyncUnsub();
    homeLiveSyncUnsub = null;
  }
  homeLiveSyncLastSig = null;
}

// Drop the Home subscription the moment any view OTHER than Home takes the
// stage. renderHome (re-)arms it on entry, so this only needs to handle leaving
// Home. Guarded for the headless unit environment (home.js is imported for its
// pure functions in `node` vitest, where there's no `document`).
if (typeof document !== "undefined") {
  document.addEventListener("flagship:view-shown", (ev) => {
    if (ev.detail?.id !== "view-home") stopApprovalPoll();
  });
}
