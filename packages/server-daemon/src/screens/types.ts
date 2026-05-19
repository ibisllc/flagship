/**
 * BFF (Backend-For-Frontend) types for `/api/screens/*`.
 *
 * Each webapp view calls exactly one endpoint, and that endpoint is
 * shaped for the view. These types are also the authoritative mobile
 * contract — the iOS + Android apps mirror them in Swift / Kotlin
 * (P4 in the cycle plan).
 *
 * Conventions:
 *   - Response shapes are JSON-serializable (no Buffer, Date, etc.).
 *     Timestamps are unix-millis (number).
 *   - Wherever a field is a "snapshot of an underlying type," we copy
 *     in only the parts the view needs — so refactors in the
 *     implementation don't ripple to the wire.
 *   - Errors are `{ error: string }` with HTTP 4xx/5xx; the webapp
 *     surfaces them via the unified toast layer.
 */

// ---------- Shared shapes ----------------------------------------------

export interface AppSummary {
  /** Composite id `<creator>-<slug>`. Immutable for the life of the
   *  package — survives re-deploys and URL-stem renames. */
  serviceId: string;
  creator: string;
  slug: string;
  /** Human label used in URLs: `<slug>` or `<slug>-<creator>`. */
  urlLabel: string;
  /** Manifest summary (one-liner). */
  summary?: string;
  /** Default URL the app lives at: `https://<urlLabel>.<serverFqdn>`. */
  url: string;
  /** Currently-known status (best-effort; see daemon AppRunner). */
  status: "running" | "stopped" | "unknown";
  /** Manifest version, e.g. "0.1.0". */
  version?: string;
  /** Unix-ms; when the app was installed on this pod. */
  installedAt: number;
}

export interface RecentInstallEvent {
  /** Unix-ms. */
  at: number;
  kind: "installed" | "uninstalled" | "deploy" | "update-pulled";
  serviceId: string;
  /** Human-friendly one-liner. */
  detail?: string;
}

// ---------- P1.1 — /api/screens/server-detail --------------------------

export interface ServerDetailResponse {
  serverFqdn: string;
  username: string;
  daemonVersion: string;
  /** Unix-ms; when this daemon process started. */
  startedAt: number;
  uptimeMs: number;
  /** Unix-ms of the live cert's notAfter, if known. */
  certNotAfter?: number;
  /** Live cert's notBefore, if known. */
  certNotBefore?: number;
  /** SAN list from the live cert, if known. */
  certSans?: string[];
  serviceCount: number;
  pairedSessionCount: number;
  recentInstallEvents: RecentInstallEvent[];
}

// ---------- P1.2 — /api/screens/apps-list ------------------------------

export interface AppsListResponse {
  apps: AppSummary[];
}

// ---------- P1.3 — /api/screens/app-detail/:serviceId ----------------------

export interface AppDetailResponse {
  app: AppSummary;
  /** Full manifest JSON (parsed). */
  manifest: Record<string, unknown>;
  /** Per-store handles the app uses (postgres / minio / redis). */
  dataLayerInstances: Array<{ store: string; instanceName: string }>;
  /** App membership view (count + list of stable-id prefixes). */
  members: Array<{ stableIdPrefix: string; role: string; addedAt: number }>;
  /** Browser tab handles owned by this app (empty when no browser bundle). */
  browserTabs: Array<{ tabId: string }>;
  /** Most-recent backup record (if any). */
  lastBackup?: { backupId: string; createdAt: number; bytes: number };
  /** Recent log lines tailed from the container, when available. */
  recentLogs: string[];
}

// ---------- P1.4 — /api/screens/marketplace-browse ---------------------

export interface MarketplaceListing {
  creator: string;
  slug: string;
  title: string;
  summary: string;
  screenshots: string[];
  installCount: number;
  requiresLlmKey: boolean;
  alreadyInstalled: boolean;
}

export interface MarketplaceBrowseResponse {
  listings: MarketplaceListing[];
}

// ---------- P1.5 — /api/screens/vibe-code/start ------------------------

export interface VibeCodeStartRequest {
  prompt: string;
  /** Optional model identifier; daemon picks a default if omitted. */
  model?: string;
}

export interface VibeCodeStartResponse {
  sessionId: string;
}

// ---------- P1.6 — /api/screens/vibe-code/:id/stream (WS frames) -------

export type VibeCodeFrame =
  | { kind: "token"; text: string }
  | { kind: "manifest-emit"; manifestJson: string }
  | { kind: "repo-create"; repoFullName: string }
  | { kind: "build-start" }
  | { kind: "build-log"; line: string }
  | { kind: "deploy"; serviceId: string; url: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

// ---------- P1.7 — /api/screens/vibe-code/:id --------------------------

export interface VibeCodeStatusResponse {
  status:
    | "streaming"
    | "awaiting-tool-response"
    | "ready-to-deploy"
    | "deploying"
    | "deployed"
    | "failed"
    | "cancelled";
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  files: Record<string, string>;
  deployedUrl?: string;
  errorReason?: string;
}

// ---------- P1.8 / P1.9 — /api/screens/unlock-approvals --------------

export interface PendingUnlockApproval {
  serverFqdn: string;
  requestId: string;
  requestedAt: number;
  ip?: string;
  userAgent?: string;
}

export interface UnlockApprovalsPendingResponse {
  pending: PendingUnlockApproval[];
}

export interface UnlockApprovalApproveRequest {
  /** Hex-encoded IRK signature over the unlock-key envelope. */
  signature: string;
  /** The unlock-key envelope bytes (base64). */
  envelope: string;
}

// ---------- P1.10 / P1.11 — /api/screens/browser-tabs ------------------

export interface BrowserTab {
  tabId: string;
  serviceId: string;
  currentUrl?: string;
  title?: string;
  /** Object key in the browser-screenshot store, when available. */
  screenshotKey?: string;
  /**
   * If the daemon detected a focused field needing user input,
   * this is the input kind the phone should prompt for.
   */
  needsField?: "password" | "text" | "code";
}

export interface BrowserTabsListResponse {
  tabs: BrowserTab[];
}

// ---------- P1.12 / P1.13 — /api/screens/paired-sessions ---------------

export interface PairedSessionSummary {
  /** First 12 chars of the token; full token never returned. */
  tokenPrefix: string;
  label: string;
  addedAt: number;
  /** True if this is the calling client's own session. */
  current: boolean;
}

export interface PairedSessionsListResponse {
  sessions: PairedSessionSummary[];
}

// ---------- P1.14 — /api/screens/orders/send ---------------------------

export interface OrdersSendRequest {
  /** PhoneOrder envelope (base64) — the daemon dispatches it through orders. */
  envelope: string;
  /** Convenience: which order kind the envelope contains, for routing/UX. */
  kind: string;
}

export interface OrdersSendResponse {
  ok: boolean;
  /** Optional response payload from the executor. */
  response?: Record<string, unknown>;
}

// ---------- P1.15 — /api/screens/install-events/:serial (SSE) ----------

export type InstallEvent =
  | { kind: "registered"; serial: string; at: number }
  | { kind: "boot"; at: number }
  | { kind: "tunnel-online"; at: number }
  | { kind: "cert-issued"; at: number }
  | { kind: "ready"; serverFqdn: string; at: number }
  | { kind: "failed"; reason: string; at: number };

// ---------- P1.16 — /api/screens/tier-status ---------------------------

export interface TierStatusResponse {
  tier: "free" | "promo" | "byok";
  llmCreditsRemainingDay?: number;
  llmCreditsRemainingTotal?: number;
  dispatcherUsageGBmonth?: number;
  dispatcherFreeQuotaGBmonth?: number;
  customDomains: string[];
  reservedNames: string[];
}

// ---------- P1.17 / P1.18 — /api/screens/url-controller ----------------

export interface OwnedUrl {
  fqdn: string;
  kind: "canonical" | "alias" | "custom";
  claimedAt: number;
}

export interface UrlControllerOwnedResponse {
  urls: OwnedUrl[];
}

export interface UrlControllerClaimRequest {
  fqdn: string;
}

export interface UrlControllerClaimResponse {
  ok: boolean;
}

// ---------- P1.22 — /api/screens/url-controller/verify -----------------
//
// Phone asks the daemon to confirm a user-claimed custom FQDN is
// actually pointing at this pod. The daemon resolves
// `_flagship.<fqdn>` TXT records and matches the expected token. The
// expected token is a per-(serverFqdn, customFqdn) digest so the user
// can pre-publish the value before claiming.

export interface VerifyCustomDomainRequest {
  fqdn: string;
}

export interface VerifyCustomDomainResponse {
  fqdn: string;
  status: "pending" | "verified" | "failed";
  expectedTxtRecord: string;
  observedTxtRecord?: string;
  reason?: string;
}

// ---------- P1.21 — /api/screens/server-metrics/:podId -----------------
//
// CPU% / load / mem used / disk used / I/O + network rates with a
// 60-sample 1-min trailing window for each. Reads from /proc on Linux
// (the daemon's production substrate); falls back to a degraded zero-
// values response on darwin so the dev cycle still works.

export interface ServerMetricsTimedSample {
  at: number;
  value: number;
}

export interface ServerMetricsIOSample {
  at: number;
  read: number;
  write: number;
}

export interface ServerMetricsResponse {
  collectedAt: number;
  cpuPercent: number;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  diskIOReadBytesPerSec: number;
  diskIOWriteBytesPerSec: number;
  netRxBytesPerSec: number;
  netTxBytesPerSec: number;
  cpuHistory: ServerMetricsTimedSample[];
  memHistory: ServerMetricsTimedSample[];
  ioHistory: ServerMetricsIOSample[];
  netHistory: ServerMetricsIOSample[];
}

// ---------- P1.19 / P1.20 — /api/screens/app-backup --------------------

export interface AppBackupStartRequest {
  serviceId: string;
  /** Optional symmetric password to encrypt the archive end-to-end. */
  password?: string;
  includeUserData?: boolean;
}

export interface AppBackupStartResponse {
  backupId: string;
  fetchPath: string;
  expiresAt: number;
  bytes: number;
  encrypted: boolean;
}

// ---------- /api/screens/lineage-resolve -------------------------------
//
// Resolves an update-pack lineage-break. The daemon's update-puller
// auto-pauses any app whose new pack fails the lineage check, then
// emits a phone alert with `kind: "lineage-break"`. The phone view
// shows the break context (creator, prior tip, new tip, verifier
// reason) and offers two choices:
//
//   accept — the user has verified the new chain is legitimate (e.g.
//            the creator publicly announced a key rotation). The
//            daemon rolls the lineage anchor forward to the new tip
//            and unpauses; subsequent pulls trust this lineage going
//            forward.
//
//   revoke — the user no longer trusts the canonical home; the app
//            is uninstalled (container stopped, data dropped, pull
//            state cleared) per the existing uninstall path.
//
// Both decisions require the paired-session token gate to be open.
// In webapp world, the paired-session token IS the PSK-equivalent;
// the same gate guards every /api/screens/* endpoint.

export interface LineagePauseSummary {
  serviceId: string;
  creator: string;
  slug: string;
  canonicalUrl: string;
  /** When the puller detected the break (unix-ms). */
  detectedAt: number;
  /** The trust root — what this pod anchored to at install time. */
  lineageAnchor: string;
  /** The commit the pod is currently running. */
  priorTip: string;
  /** The upstream tip the puller refused. */
  upstreamTip: string;
  /** Verifier reason (anchor-unreachable | prior-tip-not-ancestor | ...). */
  reason: string;
  /** Human-readable detail; safe to surface in the "more info" panel. */
  detail: string;
}

export interface LineagePausedListResponse {
  paused: LineagePauseSummary[];
}

export interface LineageResolveRequest {
  serviceId: string;
  /** "accept" rolls the anchor forward; "revoke" uninstalls. */
  decision: "accept" | "revoke";
}

export interface LineageResolveResponse {
  ok: boolean;
  outcome: "accepted" | "revoked" | "already-clear";
}

// ---------- /api/screens/release-status --------------------------------
//
// Surfaces the daemon's offline-verified view of Flagship's own
// `.maintainers/` folder (see packages/server-daemon/src/releaseVerifier.ts).
// The webapp + phone-app render this so users can see:
//   - which commit + semver tag the current authority has endorsed
//   - the list of valid endorsements (chain history)
//   - a takeover-alarm banner when the release track changed hands

export interface ReleaseStatusTrackSummary {
  track: string;
  hasPolicy: boolean;
  totalMandates: number;
  validMandates: number;
  currentHolderPubkey: string | null;
  currentMandateExpiresAt: string | null;
  /** First-12-chars-of-hex view, mirroring the cli's `status` UI. */
  successorPubkeyPrefixes: string[];
  rejectionReasons: string[];
}

export interface ReleaseStatusEndorsementSummary {
  releaseId: string;
  semverTag: string;
  commitHash: string;
  previousReleaseId: string | null;
  previousCommitHash: string | null;
  intermediateCount: number;
  issuedAt: string;
  signedByPubkey: string;
}

export interface ReleaseStatusTakeoverAlarm {
  track: string;
  previousMandateId: string;
  newMandateId: string;
  previousHolder: { displayName: string; email: string; pubkey: string };
  newHolder: { displayName: string; email: string; pubkey: string };
  detectedAt: string;
}

export interface ReleaseStatusResponse {
  /** True if `.maintainers/policy.json` was readable on disk. */
  rootPolicyPresent: boolean;
  /** Per-track summary. Always includes release/ca/ops when present. */
  tracks: ReleaseStatusTrackSummary[];
  /** Most-recent VALID endorsement, or null if none exists yet. */
  currentRelease: ReleaseStatusEndorsementSummary | null;
  /** Full chain of valid endorsements, oldest-first. */
  validEndorsements: ReleaseStatusEndorsementSummary[];
  /** Endorsements rejected during verification, with reason. */
  endorsementErrors: Array<{ releaseId: string; reason: string; detail?: string }>;
  /** Set when the release track changed hands; null otherwise. */
  pendingTakeoverAlarm: ReleaseStatusTakeoverAlarm | null;
}
