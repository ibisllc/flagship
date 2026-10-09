import { bytesToHex, signWithIrk } from "../keystore.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import { decorateHomeGrid, serverIcon, alertCircleIcon, keyIcon } from "../lib/icons.js";
import { renderSharedWithMe } from "./shared-server.js";
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
import { renderDibsBanner } from "../lib/nameDibs.js";
import { enterNameDibs } from "./name-dibs.js";
import { isDemoProfile } from "../lib/demoAccount.js";
import { getActiveProfile } from "../lib/profiles.js";
import { demoLifecycle, ensureDemoServerPairing } from "../lib/usersCheck.js";
import {
  deviceCapabilityChipText,
  applyScopeGateToButton,
} from "../lib/usersCheck.js";
import { loadProviders } from "../providers.js";
import { renderListProgressBar } from "../lib/provisionProgress.js";
import { renderAllowanceCard } from "../lib/allowance.js";
import {
  get as recoveryStoreGet,
  set as recoveryStoreSet,
  remove as profileRemove,
} from "../lib/profilesStore.js";
import { controlApex } from "../lib/apex.js";
import { isServerDecommissioned } from "../lib/serverReplacement.js";
import {
  isListableRevocation,
  isRecentlyDeleted,
  openDeleteServerDialog,
} from "../lib/deleteServer.js";
import { humanError } from "../lib/humanError.js";
import { depositSwkIfNeeded } from "../lib/swkDeposit.js";
import { depositCgkIfNeeded } from "../lib/cgkDeposit.js";
import { depositPairingIfNeeded } from "../lib/pairingDeposit.js";
import { liveSync } from "../lib/liveSync.js";
import { fetchLeads, invertLeadsMap } from "../lib/directLeads.js";
import { fetchDecryptedDirectory } from "../lib/accountDirectory.js";
import { accountReadFetch, clearAccountReadTokens, onAccountReadPausedChange } from "../lib/accountRead.js";
import { isCompanionProfile } from "../lib/companionGuard.js";
import { ADD_SERVERS_ADMIN_ONLY, canAddServers } from "../lib/addServerGate.js";
import {
  currentServerOrder,
  isLeaderConfirmed,
  leadershipOf,
  moveItem,
  onServerOrderChange,
  orderAckOf,
  rankByServerOrder,
  rememberServerOrder,
  saveServerOrder,
  serverOrderFailureText,
  serverOrderOf,
} from "../lib/serverOrder.js";
import { preferLeaderAsCurrent } from "../lib/appPlacement.js";
import { ADD_IMPORT_LABEL, openAddOrImport } from "./import-backup.js";

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
  // `status`: "ok" (read), "refused" (`.com` wouldn't show this browser the
  // account's servers: no read token), or "error" (offline, a 5xx).
  const out = { statusByDomain: new Map(), pending: [], status: "error" };
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
    out.status = "ok";
    return out;
  }
  try {
    const r = await accountReadFetch(
      `${controlApex()}/api/users/${encodeURIComponent(username)}/pods`,
    );
    if (r.status === 401 || r.status === 403) out.status = "refused";
    if (!r.ok) return out;
    const body = await r.json();
    out.status = "ok";
    for (const p of body.pods ?? []) {
      out.statusByDomain.set(String(p.serverDomain ?? "").toLowerCase(), p);
    }
    rememberServerOrder(username, body.serverOrder);
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
 * Resolve the Home data source for the active account. Demo login does not
 * create a paired-session id: its server capability is the `demoServer` block
 * persisted on the profile by `activateDemoAccount`. Treat that block as one
 * registered server so demo accounts reach the normal server-card renderer
 * instead of falling into the unpaired empty state.
 */
export function homeServerSource(sessionId, profile, now = Date.now(), { username = "", companion = false } = {}) {
  const block = profile?.demoServer;
  const fqdn = typeof block?.fqdn === "string" ? block.fqdn.trim().toLowerCase() : "";
  if (fqdn) {
    const online = demoLifecycle(block) === "up";
    return {
      kind: "demo",
      server: { serverId: fqdn, revoked: null },
      fallbackPod: {
        serverDomain: fqdn,
        ...(online
          ? { liveness: "live", lastReported: now }
          : { registeredAt: now }),
      },
    };
  }
  if (sessionId) return { kind: "paired", sessionId };
  // An open account lists its servers from `.com`'s /pods, as iOS and
  // Android do. A keyless remote browser never reads the account's servers.
  if (username && !companion) return { kind: "account" };
  return { kind: "empty" };
}

/** The account's servers as the list rows `.com`'s /pods names (revocations
 *  are applied later from the same rows by reconcileRevokedServers). */
export function serversFromPods(statusByDomain) {
  return [...statusByDomain.keys()].filter(Boolean).map((serverId) => ({ serverId, revoked: null }));
}

export const SERVER_LIST_LOCKED_TITLE = "Your server list is locked";
export const SERVER_LIST_LOCKED_NOTE =
  "Flagship only shows your servers to your own devices. Unlock once in this browser to show them.";
export const SHOW_MY_SERVERS = "Show my servers";

/** `.com` refused the list and there's nothing to show: say it's locked, with
 *  "Show my servers" (iOS's home-locked-state / home-show-my-servers). */
export function renderLockedServersList(root, { onShow } = {}) {
  root.innerHTML = `
    <div class="card empty-state" id="home-locked-state">
      <h3 class="empty-headline">${escapeHtml(SERVER_LIST_LOCKED_TITLE)}</h3>
      <p class="note empty-message">${escapeHtml(SERVER_LIST_LOCKED_NOTE)}</p>
      <button class="primary full-width" id="home-show-my-servers" type="button">${escapeHtml(SHOW_MY_SERVERS)}</button>
    </div>
  `;
  const btn = root.querySelector("#home-show-my-servers");
  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Unlocking…";
    try {
      await onShow?.();
    } finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.textContent = SHOW_MY_SERVERS;
      }
    }
  });
}

/** "Show my servers": with the account keys unlocked here, mint a fresh read
 *  token and reload; otherwise unlock first (PIN screen when one is set). */
async function showMyServers() {
  if (getSession()?.umk instanceof Uint8Array) {
    clearAccountReadTokens();
    await renderHome();
    return;
  }
  let pinSet = false;
  try {
    const { hasPin } = await import("../lib/pinLock.js");
    pinSet = await hasPin();
  } catch {
    pinSet = false;
  }
  show(pinSet ? "view-pin-unlock" : "view-unlock");
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
  // Clean list row: the server glyph and reserved name, the fqdn subtitle +
  // "installing" detail, and a "pending" pill trailing.
  const row = listRow({
    leading: { kind: "html", html: `<span class="server-order-slot" aria-hidden="true"></span>` },
    titleIcon: serverIcon,
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
  if (server.revoked) return { kind: "revoked", label: "Revoked" };
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
    // Box registered but never sent a heartbeat. Approval and the grace window
    // decide it, exactly like the no-lastReported path below; without the
    // grace check a box that died during install read "coming up" forever.
    if (opts.hasLiveUnlockRequest || (pod?.pendingRequests?.length ?? 0) > 0) {
      return { kind: "waiting-for-approval", label: "Waiting for approval" };
    }
    const registeredAt = pod?.registeredAt;
    if (registeredAt != null && now - registeredAt <= COMING_ONLINE_GRACE_MS) {
      return { kind: "coming-online", label: "Coming online…" };
    }
    return { kind: "never-seen", label: "Never came online" };
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
  // A server created to restore a backup, until the backup is in
  // (docs/server-backup-and-clone.md).
  if (pod.awaitingBackup?.state === "restoring") return { kind: "restoring-backup", label: "Restoring its backup" };
  if (pod.awaitingBackup) return { kind: "awaiting-backup", label: "Waiting for its backup" };
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
    case "awaiting-backup":
    case "restoring-backup":
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
    : c.kind === "cert-expiring-soon" || c.kind === "waiting-for-approval" || c.kind === "awaiting-backup" ? "pill warn"
    : "pill";
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
  const standingIn = opts.order?.isLeader ? standingInText(opts.order.standingInFor) : "";
  if (standingIn) subtitle += ` · ${standingIn}`;
  // A box that registered but never came online is a dead install: put Delete
  // on the card itself. Every other server deletes from its own page.
  const deadDelete = c.kind === "never-seen"
    ? `<div class="row mt-2"><button class="secondary danger full-width js-delete-server" data-fqdn="${escapeHtml(server.serverId)}">Delete server</button></div>`
    : "";
  // A server waiting for its backup: send it (pick the files again), or give
  // up and delete it, right from the card.
  const awaitingBackup = c.kind === "awaiting-backup"
    ? `<div class="row-2 mt-2"><button class="full-width js-send-backup" data-fqdn="${escapeHtml(server.serverId)}">Send the backup</button>` +
      `<button class="secondary danger full-width js-delete-server" data-fqdn="${escapeHtml(server.serverId)}">Delete server</button></div>`
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
    // The status lives in the pill; the leading column is the drag handle.
    leading: { kind: "html", html: orderControlsHtml(server, opts.order) },
    titleIcon: serverIcon,
    title: String(server.serverId),
    subtitle,
    detail: certCountdown ? String(certCountdown) : "",
    // Status pill stacks UNDER the text — labels like "never came online" need a
    // full line rather than being crushed into the right margin against the title.
    // The server order (docs/server-order.md): only the leader wears a badge;
    // the order itself is read from position.
    trailing: `${orderPillHtml(opts.order)}<span class="${pillClass}">${escapeHtml(c.label)}</span>`,
    trailingBelow: true,
  });
  return `
    ${row}
    ${deadDelete}
    ${awaitingBackup}
    ${approveUnlock}
  `;
}

export const LEADER_LABEL = "Leader";
export const LEADER_PENDING_LABEL = "Leader, waiting for the server to confirm";

/** The Leader badge: gray until the leader confirms it holds the order. */
export function orderPillHtml(order) {
  if (!order?.isLeader) return "";
  if (order.confirmed === false) {
    return `<span class="pill" data-order-leader data-order-leader-pending title="${LEADER_PENDING_LABEL}" aria-label="${LEADER_PENDING_LABEL}">${LEADER_LABEL}</span>`;
  }
  return `<span class="pill ok" data-order-leader>${LEADER_LABEL}</span>`;
}

/** The leading column: a drag handle (plus up/down buttons that show only
 *  for the keyboard) on a reorderable server, an empty slot otherwise so the
 *  names line up. CSS hides both when the list can't be reordered. */
function orderControlsHtml(server, order) {
  if (!order?.reorderable) return `<span class="server-order-slot" aria-hidden="true"></span>`;
  const name = escapeHtml(serverShortName(server.serverId));
  return `<span class="server-order-controls">
      <button type="button" class="server-order-step js-order-up" aria-label="Move ${name} up"${order.first ? " disabled" : ""}>↑</button>
      <span class="server-order-handle js-order-handle" aria-hidden="true">⠿</span>
      <button type="button" class="server-order-step js-order-down" aria-label="Move ${name} down"${order.last ? " disabled" : ""}>↓</button>
    </span>`;
}

/** "standing in for home3" when servers above the leader are down. */
export function standingInText(standingInFor) {
  if (!standingInFor?.length) return "";
  const names = standingInFor.map((n) => serverShortName(n));
  return `standing in for ${names.length === 1 ? names[0] : `${names[0]} and ${names.length - 1} more`}`;
}

function formatCertCountdown(validUntilMs) {
  const ms = validUntilMs - Date.now();
  if (ms < 0) return "cert expired";
  if (ms < 30 * 86400_000) return `cert renews ${formatDays(ms)}`;
  return ""; // omit chip when comfortably valid — reduces visual noise
}

// Only an admin device of the account adds servers to it (lib/addServerGate.js).
export { canAddServers, ADD_SERVERS_ADMIN_ONLY };

const TAKE_OVER_LINK = "Someone handing you a box? Take over →";

/** Home's one way to bring a server in: "Add/Import a server" opens the
 *  Create / Co-manage / Import menu, whether or not the account has servers. */
function wireAddServer(root) {
  root.querySelector("#home-add-server")?.addEventListener("click", () => {
    openAddOrImport({
      onAdd: async () => {
        const { enterCreateServer } = await import("./create-server.js");
        await enterCreateServer();
      },
      onCoManage: async () => {
        const { promptShareLink } = await import("./share-accept.js");
        await promptShareLink();
      },
    });
  });
}

/** "Take over a box": the standalone acquirer claim (paste / scan a transfer
 *  link), the same view a `/transfer?o=` deep link routes into. */
function wireTakeOver(root) {
  root.querySelector("#home-take-over")?.addEventListener("click", async () => {
    const { enterTransferClaim } = await import("./transfer-claim.js");
    enterTransferClaim().catch((e) => {
      if (e?.code !== "cancelled") {
        console.error("transfer claim failed", e);
        toast(e?.message ?? String(e), "err");
      }
    });
  });
}

/** Render the zero-state card when the user has no servers yet.
 *
 *  An account is an IDENTITY, not a server (docs/login-and-account-redesign.md):
 *  once it is open (a username is claimed + bound to this device key), zero
 *  servers is the normal state. An admin device gets the same "Add/Import a
 *  server" button as a populated list; any other device of the account is
 *  told only an admin device can add one. With no account yet (no username /
 *  mid-pair), "Create a server" opens the account first.
 */
export function renderEmptyServersList(root, { reason, username, canAdd = canAddServers() } = {}) {
  const accountOpen = !!username;
  if (accountOpen && !canAdd) {
    root.innerHTML = `
    <div class="card empty-state" data-home-empty-non-admin>
      ${EMPTY_MARK_SVG}
      <h3 class="empty-headline">No servers yet</h3>
      <p class="note empty-message">${escapeHtml(ADD_SERVERS_ADMIN_ONLY)}</p>
    </div>
  `;
    return;
  }
  const headline = accountOpen
    ? "Your account is ready"
    : "Your first server is one tap away";
  const hint = accountOpen
    ? "Add your first server to start running your own services."
    : reason === "unpaired"
      ? "Pair the webapp to your phone or pod first, or jump straight in and build a fresh server."
      : "Mint a recipe, write it to a USB drive with the Flagship builder, and boot a spare machine — you're a few taps from your own cloud.";
  const action = accountOpen
    ? `<button class="primary full-width" id="home-add-server">${escapeHtml(ADD_IMPORT_LABEL)}</button>
      <button class="linklike mt-2" id="home-take-over">${escapeHtml(TAKE_OVER_LINK)}</button>`
    : '<button class="primary full-width" id="empty-create-server">Create a server</button>';
  root.innerHTML = `
    <div class="card empty-state">
      ${EMPTY_MARK_SVG}
      <h3 class="empty-headline">${escapeHtml(headline)}</h3>
      <p class="note empty-message">${escapeHtml(hint)}</p>
      ${action}
      <a class="pill mt-2" href="https://flagshipserver.com/studio" target="_blank" rel="noopener">
        Get Flagship Studio →
      </a>
    </div>
  `;
  wireAddServer(root);
  wireTakeOver(root);
  // No account yet: open it first (claim a username, bind the device key);
  // the server comes after.
  root.querySelector("#empty-create-server")?.addEventListener("click", async () => {
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
      "Save a passkey so you can recover your account if you get a new device.",
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

const ALLOWANCE_CARD_ID = "home-allowance-card";

/**
 * #6 / #7 — fetch + render the bandwidth usage/allowance card (with the
 * over-allowance upgrade alert) above the server list. Best-effort: the
 * allowance lib resolves to null on any failure / `!ok` / missing endpoint,
 * in which case the host is left empty and removed — Home never breaks.
 */
async function renderAllowance(username) {
  if (!username) {
    document.getElementById(ALLOWANCE_CARD_ID)?.remove();
    return;
  }
  let host = document.getElementById(ALLOWANCE_CARD_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = ALLOWANCE_CARD_ID;
    const list = document.getElementById("servers-list");
    list?.parentNode?.insertBefore(host, list);
  }
  const status = await renderAllowanceCard(host, username);
  if (!status) {
    host.remove();
    return;
  }
  // The upgrade CTA is a plain anchor to /pro; nothing to wire (full-page nav).
}

/**
 * E7 — peer "your account was reset on another device" detector.
 *
 * Signal: this profile's immutable account-scoped device ID is no longer
 * present in the signed directory. That can only happen if another device
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
  const localDeviceId = getActiveProfile()?.deviceId;
  if (!localDeviceId) return;
  let devices = [];
  try {
    devices = (await fetchDecryptedDirectory()).devices;
  } catch {
    return;
  }
  const present = devices.some((device) => device.deviceId === localDeviceId && device.revokedAt == null);
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
 * Read the active profile's opaque deviceCapability block. Returns
 * null when the session has no restricted grant (no chip, all actions enabled),
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
 * Render (or clear) the restricted-device scope chip below the
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
/** The registered servers in the owner's committed order
 *  (docs/server-order.md): `{server, pod, hasLiveUnlockRequest, bucket}` each. */
let homeRegistered = [];
let homePods = [];
let homeDemo = false;
let orderSaving = false;
/** While a server is dragged, the order on screen (STKs of the reorderable
 *  servers); null otherwise. Rows and labels both come from it, so they can
 *  never disagree mid-drag. */
let orderDraft = null;
let draggingStk = "";
let refreshAfterDrag = false;
let suppressCardClickUntil = 0;

function orderKey(r) {
  return {
    stk: r.pod?.identityPubKey ?? "",
    birthDate: r.pod?.registeredAt ?? 0,
    domain: String(r.server.serverId ?? "").toLowerCase(),
  };
}

function rowStk(r) {
  return String(r.pod?.identityPubKey ?? "").toLowerCase();
}

function isRevokedRow(r) {
  return !!r.server?.revoked || r.pod?.revokedAt != null;
}

/** A server that can take a place in the order: registered with a box key. */
function isOrderable(r) {
  return !!rowStk(r) && !isRevokedRow(r);
}

/**
 * Card entries for the ranked registered servers. Only the leader (the first
 * one online) is labelled; its badge is gray while a drag is on and until the
 * leader holds the order on screen (`orderIssuedAt`; see isLeaderConfirmed,
 * orderAckOf).
 */
export function registeredEntries(ranked, { orderIssuedAt = 0, dragging = false } = {}) {
  const { leaderIndex, standingInFor } = leadershipOf(ranked, (r) => r.bucket === "online");
  const confirmed = isLeaderConfirmed({
    dragging,
    orderIssuedAt,
    leaderOrderIssuedAt: orderAckOf(ranked[leaderIndex]?.pod),
  });
  const orderable = ranked.filter(isOrderable);
  const reorderable = orderable.length > 1;
  return ranked.map((r, i) => {
    const slot = orderable.indexOf(r);
    const order = {
      first: slot === 0,
      last: slot === orderable.length - 1,
      isLeader: i === leaderIndex,
      confirmed,
      standingInFor: i === leaderIndex
        ? standingInFor.filter((x) => !isRevokedRow(x) && x.bucket !== "pending").map((x) => String(x.server.serverId))
        : [],
      reorderable: reorderable && slot >= 0,
    };
    return {
      html: renderServerCard(r.server, r.pod, { hasLiveUnlockRequest: r.hasLiveUnlockRequest, order }),
      bucket: r.bucket,
      fields: { name: String(r.server.serverId ?? ""), fqdn: String(r.server.serverId ?? "") },
      cardClass: "server-card",
      // undefined (no pod row) lets the delete flow look the box key up itself.
      identityPubKey: r.pod ? (r.pod.identityPubKey ?? null) : undefined,
      orderStk: order.reorderable ? rowStk(r) : "",
    };
  });
}

/** The registered servers as Home shows them: the drag's draft order while
 *  one is on, else the committed order. */
function shownRegistered() {
  return orderDraft ? rankByServerOrder(homeRegistered, orderDraft, orderKey) : homeRegistered;
}

/** `issuedAt` of the order on screen; 0 for a demo account, whose order never
 *  reaches a box to be confirmed. */
function shownOrderIssuedAt() {
  if (homeDemo) return 0;
  return serverOrderOf(getSession()?.username)?.issuedAt ?? 0;
}

function shownEntries() {
  return registeredEntries(shownRegistered(), { orderIssuedAt: shownOrderIssuedAt(), dragging: orderDraft !== null });
}

// One order state for Home and server detail: when it changes anywhere (Make
// leader on a server's page, a revert after a failed save, a newer order from
// `.com`), Home re-ranks what it shows.
onServerOrderChange(() => {
  if (!homeRegistered.length) return;
  paintRegistered(rankByServerOrder(homeRegistered, currentServerOrder(), orderKey));
});

/** The registered servers' STKs in Home's current order. */
export function homeOrderStks() {
  return shownRegistered().map(rowStk).filter(Boolean);
}

/** What Home shows now: each registered server in order, and which leads. */
export function homeOrderView() {
  const shown = shownRegistered();
  const { leaderIndex } = leadershipOf(shown, (r) => r.bucket === "online");
  return shown.map((r, i) => ({ fqdn: String(r.server.serverId).toLowerCase(), leader: i === leaderIndex }));
}

/** Test seam: the registered servers Home last loaded. */
export function _setHomeServersForTests(registered, { demo = false } = {}) {
  homeServerEntries = [];
  orderDraft = null;
  draggingStk = "";
  orderSaving = false;
  homeDemo = demo;
  paintRegistered(rankByServerOrder(registered, currentServerOrder(), orderKey));
}

/** Test seam: whether Home's Leader badge is confirmed right now. */
export function _homeLeaderConfirmedForTests() {
  const shown = shownRegistered();
  const { leaderIndex } = leadershipOf(shown, (r) => r.bucket === "online");
  return isLeaderConfirmed({
    dragging: orderDraft !== null,
    orderIssuedAt: shownOrderIssuedAt(),
    leaderOrderIssuedAt: orderAckOf(shown[leaderIndex]?.pod),
  });
}

/** Test seam: drive the drag the pointer handlers drive. */
export const _orderDragForTests = {
  start: (stk) => startOrderDrag(stk),
  moveTo: (stks) => moveOrderDraft(stks),
  end: (commit) => endOrderDrag(commit),
  state: () => ({ draft: orderDraft ? [...orderDraft] : null, dragging: draggingStk, saving: orderSaving }),
};

/** Repaint Home with the registered servers in `ranked` (committed) order. */
function paintRegistered(ranked) {
  homeRegistered = ranked;
  repaintRegistered();
}

function repaintRegistered() {
  const pending = homeServerEntries.filter((e) => e.cardClass.includes("--pending"));
  homeServerEntries = [...shownEntries(), ...pending];
  renderServerCards();
}

/**
 * Save a new order (the reorderable servers' STKs). saveServerOrder shows it
 * at once and puts the old one back on failure, both through
 * onServerOrderChange; whatever happens, Home ends on the committed order
 * with no draft left. A newer order elsewhere reloads Home.
 */
async function commitServerOrder(stks, { focus = null } = {}) {
  orderDraft = null;
  if (orderSaving) {
    repaintRegistered();
    return;
  }
  orderSaving = true;
  const saving = saveServerOrder({ stks }, { demo: homeDemo, pods: homePods });
  if (focus) focusOrderStep(focus.stk, focus.selector);
  try {
    await saving;
    preferLeaderAsCurrent(homePods);
  } catch (e) {
    toast(serverOrderFailureText(e, humanError), "err");
    if (e?.status === 409) void renderHome().catch(() => {});
  } finally {
    orderSaving = false;
    if (homeRegistered.length) paintRegistered(rankByServerOrder(homeRegistered, currentServerOrder(), orderKey));
    if (focus) focusOrderStep(focus.stk, focus.selector);
  }
}

/** Keep keyboard focus on a moved server's up/down button across repaints. */
function focusOrderStep(stk, selector) {
  const card = globalThis.document?.querySelector?.(`#servers-list [data-order-stk="${stk}"]`);
  if (!card) return;
  const btn = card.querySelector(selector);
  const target = btn && !btn.disabled ? btn : card.querySelector(".js-order-up:not([disabled]), .js-order-down:not([disabled])");
  target?.focus?.();
}

function committedOrderableStks() {
  return homeRegistered.filter(isOrderable).map(rowStk);
}

/** A drag begins: the draft starts as the committed order. */
function startOrderDrag(stk) {
  if (orderSaving || draggingStk || !committedOrderableStks().includes(stk)) return false;
  draggingStk = stk;
  orderDraft = committedOrderableStks();
  repaintRegistered();
  return true;
}

/** The dragged server moved: repaint only when the draft actually changes. */
function moveOrderDraft(stks) {
  if (!draggingStk || !orderDraft) return;
  if (stks.join(",") === orderDraft.join(",")) return;
  orderDraft = stks;
  repaintRegistered();
}

/**
 * A drag ends (drop, cancel, or lost pointer). A drop that moved something
 * saves; anything else clears the draft. Either way the list repaints, so
 * the Leader badge settles on the first server that's online.
 */
function endOrderDrag(commit) {
  if (!draggingStk) return;
  const draft = orderDraft;
  draggingStk = "";
  suppressCardClickUntil = Date.now() + 400;
  if (commit && draft && draft.join(",") !== committedOrderableStks().join(",")) {
    void commitServerOrder(draft);
  } else {
    orderDraft = null;
    repaintRegistered();
  }
  if (refreshAfterDrag) {
    refreshAfterDrag = false;
    if (currentViewId() === "view-home") void renderHome().catch(() => {});
  }
}

/** The draft with the dragged server placed where `clientY` points. Reads
 *  the live cards, since every draft change repaints them. */
function draftOrderAt(clientY) {
  const cards = [...(document.querySelectorAll("#servers-list [data-server-cards] [data-order-stk]") ?? [])];
  const others = cards.filter((c) => c.getAttribute("data-order-stk") !== draggingStk);
  const slot = others.filter((c) => {
    const r = c.getBoundingClientRect();
    return clientY > r.top + r.height / 2;
  }).length;
  const stks = others.map((c) => c.getAttribute("data-order-stk"));
  stks.splice(slot, 0, draggingStk);
  return stks;
}
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
  // Reordering works on the whole list only, so not while filtered or searched.
  const reorderable = homeFilter === "all" && !homeQuery.trim()
    && homeServerEntries.filter((e) => e.orderStk).length > 1;
  const showDragging = reorderable && !!draggingStk;

  const cardsHtml = visible.length
    ? visible
        .map((e) => {
          // A registered (non-pending) card is tappable → opens server-detail.
          const openable = e.bucket !== "pending" && e.fields.fqdn;
          let attrs = openable
            ? ` data-open-fqdn="${escapeHtml(e.fields.fqdn)}"`
            : "";
          if (reorderable && e.orderStk) attrs += ` data-order-stk="${escapeHtml(e.orderStk)}"`;
          let cls = openable ? `${e.cardClass} is-tappable` : e.cardClass;
          if (showDragging && e.orderStk === draggingStk) cls += " is-dragging";
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
      ${canAddServers() ? `<button class="secondary" id="home-add-server">${escapeHtml(ADD_IMPORT_LABEL)}</button>
      <button class="linklike mt-1" id="home-take-over">${escapeHtml(TAKE_OVER_LINK)}</button>` : ""}
      ${searchField({ value: homeQuery, placeholder: "Search servers", id: "home-search" })}
      ${chipRow({ items: chips, selected: homeFilter, ariaLabel: "Filter servers" })}
    </div>
    <div data-server-cards${reorderable ? " data-reorderable" : ""}>${cardsHtml}</div>
  `;

  wireHomeListControls(list);
}

/**
 * Delegate the chip / search / clear / delete interactions on the freshly
 * painted list. Idempotent per render (the innerHTML reset above drops the
 * old nodes + their listeners, so re-binding can't stack handlers).
 */
function wireHomeListControls(list) {
  // "+ Add/Import a server" (admin devices only): create a brand-new box,
  // co-manage someone else's server from their share link, or import a backup.
  wireAddServer(list);
  // Tap a registered server card → open its detail screen. Clicks that
  // land on an inner control (approve / delete / links) are ignored so the
  // card tap never hijacks a button.
  list.querySelectorAll("[data-open-fqdn]").forEach((card) => {
    card.addEventListener("click", async (ev) => {
      if (ev.target.closest("button, a, input, label, select, textarea, .server-order-controls")) return;
      if (Date.now() < suppressCardClickUntil) return;
      const fqdn = card.getAttribute("data-open-fqdn");
      if (!fqdn) return;
      const profile = getActiveProfile();
      if (profile?.demoServer?.fqdn?.toLowerCase() === fqdn.toLowerCase()) {
        try {
          await ensureDemoServerPairing(profile.cloudName, profile.demoServer);
        } catch {
          toast(
            "The demo server is online, but this browser couldn't create a paired session. Tap the server to retry.",
            "err",
          );
          return;
        }
      }
      const { enterServerDetail } = await import("./server-detail.js");
      await enterServerDetail(fqdn);
    });
  });
  wireTakeOver(list);
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
  list.querySelectorAll(".js-delete-server").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const fqdn = btn.getAttribute("data-fqdn") || "";
      const entry = homeServerEntries.find((x) => x.fields.fqdn.toLowerCase() === fqdn.toLowerCase());
      void deleteRegisteredServer(fqdn, entry?.identityPubKey);
    });
  });
  list.querySelectorAll(".js-send-backup").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { openImportBackup } = await import("./import-backup.js");
      openImportBackup({ targetFqdn: btn.getAttribute("data-fqdn") || "" }).catch((err) => {
        if (err?.code !== "cancelled") toast(humanError(err), "err");
      });
    });
  });
  // A pending order (never registered) keeps the plain free-the-name release.
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
  wireServerOrder(list);
  // Collapsing-header reveal: show the compact sticky title once the large
  // one scrolls out of view. Progressive — absent IntersectionObserver the
  // compact title simply stays hidden and the large title scrolls normally.
  wireHeroCollapse(list);
}

/**
 * The server order on Home (docs/server-order.md): drag a card by its handle,
 * or use its up/down buttons from the keyboard. The drag's listeners live on
 * `window`, not the handle, because every draft change repaints the cards
 * (the handle the drag began on is gone by the drop).
 */
function wireServerOrder(list) {
  const container = list.querySelector("[data-server-cards][data-reorderable]");
  if (!container) return;
  const move = (btn, delta, selector) => {
    const stk = btn.closest("[data-order-stk]")?.getAttribute("data-order-stk");
    if (!stk || orderSaving || draggingStk) return;
    const stks = committedOrderableStks();
    const from = stks.indexOf(stk);
    if (from < 0) return;
    void commitServerOrder(moveItem(stks, from, from + delta), { focus: { stk, selector } });
  };
  container.querySelectorAll(".js-order-up").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); move(b, -1, ".js-order-up"); }));
  container.querySelectorAll(".js-order-down").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); move(b, 1, ".js-order-down"); }));
  container.querySelectorAll(".js-order-handle").forEach((handle) => {
    handle.addEventListener("click", (e) => e.stopPropagation());
    handle.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      const stk = handle.closest("[data-order-stk]")?.getAttribute("data-order-stk");
      if (!stk) return;
      e.preventDefault();
      if (!startOrderDrag(stk)) return;
      const pointerId = e.pointerId;
      const finish = (commit) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onBlur);
        endOrderDrag(commit);
      };
      const onMove = (ev) => {
        if (ev.pointerId !== pointerId) return;
        // A mouse released outside the window sends no pointerup.
        if (ev.pointerType === "mouse" && ev.buttons === 0) return finish(true);
        moveOrderDraft(draftOrderAt(ev.clientY));
      };
      const onUp = (ev) => { if (ev.pointerId === pointerId) finish(true); };
      const onCancel = (ev) => { if (ev.pointerId === pointerId) finish(false); };
      const onBlur = () => finish(false);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onBlur);
    });
  });
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
  void renderWelcomeHierarchy(session);
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
  // banner above the server list if our account-scoped device ID
  // is no longer in the signed directory. Silent on failure so a
  // transient network blip doesn't flash a banner.
  detectAccountReset(session.username).catch(() => {});

  // Post-creation backup nudge — shown when the wizard flagged recovery
  // as skipped (not enrolled) and the user hasn't dismissed it on this
  // device. Local-only signal; no API call.
  renderRecoveryBanner();

  void renderSharedWithMe();
  // Always-available "Become a Pro member" support CTA — a gentle, on-brand
  // membership nudge (distinct from the cap-hit upgrade alert) for the ~95%
  // who never hit the bandwidth cap but would happily back the project.
  // Fully dismissible; once dismissed on this device it never re-appears.
  renderProBanner();
  // Name dibs — while the one-year window is open, tell .com holders they can
  // claim the matching name. Dismissible; fetches the window itself. Not for a
  // demo, whose operator-managed name can't change.
  if (!isDemoProfile(getActiveProfile())) {
    renderDibsBanner({ onClaim: () => enterNameDibs() }).catch(() => {});
  }

  // #6 / #7 — bandwidth usage/allowance card + over-allowance upgrade alert.
  // Fire-and-forget; best-effort so a metering hiccup never blocks Home.
  renderAllowance(session.username).catch(() => {});

  const sid = recoveryStoreGet("sessionId");
  const serverSource = homeServerSource(sid, getActiveProfile(), Date.now(), {
    username: session.username,
    companion: isCompanionProfile(),
  });
  const sessionStatusEl = $("session-status");
  const list = $("servers-list");
  list.innerHTML = "";
  if (serverSource.kind === "empty") {
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
    let body;
    let inventory = null;
    if (serverSource.kind === "demo") {
      body = { servers: [serverSource.server] };
      sessionStatusEl.textContent = "Demo";
    } else if (serverSource.kind === "account") {
      inventory = await fetchPodInventory(session.username);
      if (inventory.status === "refused" && inventory.statusByDomain.size === 0 && inventory.pending.length === 0) {
        sessionStatusEl.textContent = "Locked";
        sessionStatusEl.classList.remove("ok");
        $("home-status-paused")?.classList.add("hidden");
        renderLockedServersList(list, { onShow: showMyServers });
        activeOperations.syncDeployOperations([]);
        stopApprovalPoll();
        return;
      }
      body = { servers: serversFromPods(inventory.statusByDomain) };
      sessionStatusEl.textContent = "Signed in";
    } else {
      const r = await fetch(
        `/api/me/servers?sessionId=${encodeURIComponent(serverSource.sessionId)}`,
      );
      if (!r.ok) throw new Error(`status ${r.status}`);
      body = await r.json();
      sessionStatusEl.textContent = "Paired";
    }
    sessionStatusEl.classList.add("ok");
    // #31 / #56 — ONE fan-out to /api/users/:u/pods on .com (account read token)
    // returns BOTH the registered pods (liveness/cert enrichment) AND the
    // in-flight install orders (`pending[]`). No second signed fetch — a
    // just-created, not-yet-registered server rides this same call.
    // Failures here are non-fatal: registered cards fall back to the bare
    // label + active/revoked pill and pending simply doesn't surface.
    let { statusByDomain: podStatusByDomain, pending } = inventory ?? await fetchPodInventory(
      session.username,
    );
    if (
      serverSource.kind === "demo" &&
      !podStatusByDomain.has(serverSource.server.serverId)
    ) {
      podStatusByDomain.set(serverSource.server.serverId, serverSource.fallbackPod);
    }
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
    body.servers = reconcileRevokedServers(body.servers, podStatusByDomain).filter(
      (s) => !isServerDecommissioned(s.serverId) && !isRecentlyDeleted(s.serverId),
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
    const registered = [];
    for (const s of body.servers) {
      const hasLiveUnlockRequest = awaitingApproval.has(
        String(s.serverId ?? "").toLowerCase(),
      );
      const pod = podStatusByDomain.get(s.serverId.toLowerCase());
      // Secret-free recipe: a registered box now has a directory identity to
      // seal the SWK to. No-ops unless a deposit is owed (idempotent via
      // swkDeposit.js); best-effort + non-blocking so it never delays a render.
      if (pod?.identityPubKey && !s.revoked) {
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
      registered.push({ server: s, pod, hasLiveUnlockRequest, bucket });
      // A server waiting for its backup is up, not deploying: no sliver op.
      if (bucket === "pending" && cls.kind !== "awaiting-backup" && cls.kind !== "restoring-backup") {
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
    homeRegistered = rankByServerOrder(registered, currentServerOrder(), orderKey);
    homePods = [...podStatusByDomain.values()];
    homeDemo = serverSource.kind === "demo";
    entries.push(...shownEntries());
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
 * The registered servers to list, reconciled with `.com`'s `/pods` revocation
 * state (authoritative over the session's list). A server revoked as lost,
 * stolen or decommissioned stays listed as "Revoked" so it can be un-revoked or
 * deleted; one revoked for any other reason (released, transferred, deleted
 * account, the box's own self-delete) is gone and is hidden. An older Worker
 * without `revocationReason` falls back to the session list's reason.
 *
 * @param {Array<{serverId:string, revoked?: {reason:string, at:number}|null}>} servers
 * @param {Map<string, object>} podsByDomain  lower-cased fqdn → /pods entry
 */
export function reconcileRevokedServers(servers, podsByDomain) {
  const out = [];
  for (const s of servers ?? []) {
    const pod = podsByDomain?.get(String(s.serverId ?? "").toLowerCase());
    if (pod && "revokedAt" in pod) {
      if (pod.revokedAt == null) {
        out.push(s.revoked ? { ...s, revoked: null } : s);
        continue;
      }
      const reason = pod.revocationReason !== undefined
        ? pod.revocationReason
        : (s.revoked?.reason ?? null);
      if (isListableRevocation(reason)) {
        out.push({ ...s, revoked: { reason, at: pod.revokedAt } });
      }
      continue;
    }
    if (s.revoked && !isListableRevocation(s.revoked.reason)) continue;
    out.push(s);
  }
  return out;
}

/** Delete a registered server from its home card (typed-name gate, then the
 *  erase-and-release flow in lib/deleteServer.js). */
async function deleteRegisteredServer(serverDomain, identityPubKey) {
  if (!serverDomain) return;
  const session = getSession();
  if (!session.username || !session.umk) {
    toast("Unlock the webapp first", "warn");
    return;
  }
  await openDeleteServerDialog(
    { serverDomain, username: session.username, identityPubKey },
    {
      session,
      // One sensitive signer for the whole flow (order + release).
      signer: sensitiveSigner(),
      irkPubHex: session.irk ? bytesToHex(session.irk.publicKey) : "",
      toast,
      humanError,
      onDeleted: () => {
        void liveSync.refresh?.().catch(() => {});
        void renderHome();
      },
    },
  );
}

/**
 * Cancel a pending (never registered) server from the home list. Frees the
 * name via the owner-IRK-signed `ReleaseServerName` release — there is no box
 * key to send an erase order to yet. On success the list is re-rendered
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
          <div class="weight-600">Flagship Inference</div>
          <div class="muted-sm">We use third-party providers and anonymize your requests.</div>
        </div>
        <button class="secondary" id="chip-settings">settings</button>
      </div>
    `;
  } else {
    chip.innerHTML = `
      <div class="row">
        <div>
          <div class="weight-600">${escapeHtml(e.label)} <span class="pill">${escapeHtml(e.provider)}</span></div>
          <div class="muted-sm">key on this device — flagshipserver.com cannot read prompts</div>
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

export function initHomeView({ onSettings }) {
  $("open-settings")?.addEventListener("click", onSettings);
  onAccountReadPausedChange((paused) => $("home-status-paused")?.classList.toggle("hidden", !paused));
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
 *  classification (liveness, cert, revocation, the pendingRequests digest,
 *  pending phases). */
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
        p.revokedAt ?? "",
        p.orderIssuedAt ?? "",
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
    // A repaint mid-drag would rebuild the list under the finger; run it at the drop.
    if (draggingStk) refreshAfterDrag = true;
    else if (currentViewId() === "view-home") void renderHome().catch(() => {});
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


export function homeIdentityLine({ accountDisplayName, username, deviceDisplayName } = {}) {
  const account = accountDisplayName || username || "";
  return deviceDisplayName ? `${account} > ${deviceDisplayName}` : account;
}

/** Fill the compact account > device breadcrumb from the decrypted directory. */
async function renderWelcomeHierarchy(session) {
  const welcome = $("home-welcome");
  if (!welcome) return;
  welcome.textContent = homeIdentityLine({ username: session?.username });
  try {
    const directory = await fetchDecryptedDirectory();
    const account = directory?.accountDisplayName;
    const self = (directory?.devices ?? []).find((d) => d.isCurrent);
    const deviceName = self?.displayName;
    welcome.textContent = homeIdentityLine({
      accountDisplayName: account,
      username: session?.username,
      deviceDisplayName: deviceName,
    });
  } catch {
    /* locked, offline, or not yet provisioned — the username stands alone */
  }
}
