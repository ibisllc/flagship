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
  /** Composite id `<creator>--<slug>`. Stable across re-deploys. */
  appId: string;
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
  appId: string;
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
  appCount: number;
  pairedSessionCount: number;
  recentInstallEvents: RecentInstallEvent[];
}

// ---------- P1.2 — /api/screens/apps-list ------------------------------

export interface AppsListResponse {
  apps: AppSummary[];
}

// ---------- P1.3 — /api/screens/app-detail/:appId ----------------------

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
  | { kind: "deploy"; appId: string; url: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

// ---------- P1.7 — /api/screens/vibe-code/:id --------------------------

export interface VibeCodeStatusResponse {
  status: "streaming" | "ready-to-deploy" | "deploying" | "deployed" | "failed" | "cancelled";
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
  appId: string;
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

// ---------- P1.19 / P1.20 — /api/screens/app-backup --------------------

export interface AppBackupStartRequest {
  appId: string;
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
