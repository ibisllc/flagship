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
  /**
   * The env-var NAME an `requiresLlmKey` app reads its key from (e.g.
   * `OPENAI_API_KEY`). Carried so the client can deep-link the owner to
   * "Configure environment" with the right name PREFILLED after install —
   * the value itself is set on the box (sealed env store), never here.
   * Absent ⇒ the client falls back to `LLM_KEY_ENV_DEFAULT`.
   */
  llmKeyEnvVar?: string;
  /**
   * Marketplace scanner verdict: "A" | "B" | "C" | "D" | "F", or absent
   * when the listing hasn't been scanned yet (the scanner service is still
   * in flight — see CLAUDE.md "Current status & open work"). Relayed
   * verbatim from `.com`'s `scan_grade`; clients render an "ungraded" pill
   * when absent.
   */
  scanGrade?: string;
  alreadyInstalled: boolean;
}

/**
 * Fallback env-var name for an `requiresLlmKey` listing that doesn't carry
 * an explicit `llmKeyEnvVar`. Kept in sync byte-for-byte with the webapp
 * (`lib/marketplaceLlmKey.js`), iOS (`MarketplaceLlmKey`), and Android
 * (`MarketplaceLlmKey`) so the prefilled-name UX is identical everywhere.
 */
export const LLM_KEY_ENV_DEFAULT = "OPENAI_API_KEY";

export interface MarketplaceBrowseResponse {
  listings: MarketplaceListing[];
}

// ---------- P1.5 — /api/screens/vibe-code/start ------------------------

export interface VibeCodeStartRequest {
  prompt: string;
  /** Optional model identifier; daemon picks a default if omitted. */
  model?: string;
  /**
   * Optional multimodal attachments on the opening user turn (a
   * screenshot/mockup or a text file the app should use). Inlined as
   * base64 — no separate upload endpoint. Server-validated: ≤6 per turn,
   * image ≤4 MB decoded, text ≤256 KB, common image/* + text only.
   * VALUE-FREE w.r.t. secrets by contract — the chat is not a secret
   * channel.
   */
  attachments?: VibeCodeAttachment[];
  /**
   * BYOK provider credential the box uses to drive this session's model
   * calls. Delivered ONCE here over the paired-session-gated pinned pipe
   * (the box terminates TLS); the daemon seals it for the session and
   * REUSES it on every subsequent turn — no re-send needed. flagshipserver
   * .com is NEVER in this path: the box calls the provider directly with
   * this key. The daemon never echoes it back, never logs it, and never
   * journals the value (the journal records only that a provider was set,
   * and at most the provider NAME).
   */
  credential?: LlmProviderCredential;
}

/**
 * A BYOK LLM-provider credential. Travels phone/webapp → box ONLY. Never
 * relayed by .com, never echoed, never logged.
 */
export interface LlmProviderCredential {
  /** Provider name, e.g. "anthropic" | "openai" | "google". */
  provider: string;
  /** The owner's API key. SECRET. */
  apiKey: string;
  /** Optional override base URL for an OpenAI-compatible / proxy endpoint. */
  baseUrl?: string;
}

export type VibeCodeAttachment =
  | { kind: "image"; mediaType: string; dataBase64: string; name?: string }
  | { kind: "text"; text: string; name?: string };

export interface VibeCodeStartResponse {
  sessionId: string;
  /**
   * Graceful-absence signal: `true` when the session was created but NO
   * model is driving it because no BYOK credential is available (none was
   * delivered on this request and none is stored for the session). The
   * client surfaces this as "add an AI key" — the session exists (the
   * owner can still deliver a credential + retry), it just isn't
   * streaming. Omitted / `false` when a model IS driving the session.
   */
  needsCredential?: boolean;
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

// ---------- W10 — per-app env vars (KV editor) -------------------------
//
// /api/screens/services/:appId/env
//   - GET    → { names } — env var NAMES set on this app. NEVER values.
//   - POST  /set    body { name, value, request, signature } where
//                    `request` is the SetServiceEnvRequest envelope (the
//                    full canonical-bytes-signed envelope per
//                    @flagship/protocol auth.ts; `value` mirrors the
//                    only entry of `request.env` and is carried as a
//                    separate field purely for UI clarity — the daemon
//                    cross-checks). On success the response is a bare
//                    { ok: true }; the value is NEVER echoed.
//   - POST  /unset  body { name, request, signature } where `request` is
//                    the full SetServiceEnvRequest carrying the desired
//                    set MINUS the dropped name. Same gate as /set.
//
// The values flow ONLY over the daemon's TLS surface; the phone never
// persists them and they never appear in any log.

export interface ServiceEnvListResponse {
  /** Sorted env var NAMES set on this app. */
  names: string[];
}

export interface ServiceEnvSetRequest {
  /** Env var name being set (mirrors the only key in request.env). */
  name: string;
  /** Env var value. NEVER logged. NEVER echoed by the daemon. */
  value: string;
  /**
   * Owner-IRK-signed SetServiceEnvRequest envelope (canonical bytes per
   * @flagship/protocol auth.ts → signSetServiceEnv). The daemon
   * re-verifies under the host's IRK and rejects on mismatch.
   */
  request: {
    serverId: string;
    creator: string;
    slug: string;
    /** Full desired env map for the app. Values are SECRET. */
    env: Record<string, string>;
    issuedAt: number;
  };
  /** Hex Ed25519 signature over canonicalSetServiceEnv(request). */
  signature: string;
}

export interface ServiceEnvUnsetRequest {
  /** Env var name being removed. */
  name: string;
  /** Owner-IRK-signed envelope — same canonical-bytes contract. */
  request: ServiceEnvSetRequest["request"];
  /** Hex Ed25519 signature. */
  signature: string;
}

export interface ServiceEnvOpResponse {
  ok: boolean;
}

// ---------- W10 — vibe-code session public state + reply --------------
//
// /api/screens/llm/sessions/:sessionId  → { id, appId, status, messages,
//                                            pendingRequest? }
// /api/screens/llm/sessions/:sessionId/reply  body { text }
//   - If `pendingRequest.kind === "talkToUser"`: relays to pushUserReply.
//   - If `pendingRequest.kind === "requestEnvVar"`: the caller has
//     ALREADY POSTed `value` to /api/screens/services/<appId>/env/set
//     (which is what carries the secret). This endpoint then resolves
//     the tool-ack with status="set" and a value-FREE EnvVarAckPayload —
//     the value never traverses /reply.
//
// `pendingRequest.payload` for requestEnvVar surfaces only the metadata
// the model emitted (name, description, why, example, secret) — never a
// value.

export interface VibeCodeSessionMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  /**
   * Multimodal attachments the owner sent on this turn (user messages
   * only). Surfaced so a reload re-renders the thumbnails/chips. The
   * chat is paired-session gated on the owner's own box and attachments
   * are value-free w.r.t. secrets by contract.
   */
  attachments?: VibeCodeAttachment[];
}

export interface VibeCodePendingTalkToUser {
  kind: "talkToUser";
  toolUseId: string;
  payload: { message: string };
}

export interface VibeCodePendingRequestEnvVar {
  kind: "requestEnvVar";
  toolUseId: string;
  payload: {
    name: string;
    description: string;
    why: string;
    example?: string;
    secret?: boolean;
  };
}

export type VibeCodePendingRequest =
  | VibeCodePendingTalkToUser
  | VibeCodePendingRequestEnvVar;

export interface VibeCodeSessionPublicState {
  id: string;
  /** App id the session is editing, when resolvable. Null pre-manifest. */
  appId: string | null;
  status:
    | "streaming"
    | "awaiting-tool-response"
    | "ready-to-deploy"
    | "deploying"
    | "deployed"
    | "failed"
    | "cancelled";
  messages: VibeCodeSessionMessage[];
  /** The tool the AI is waiting on, when status === "awaiting-tool-response". */
  pendingRequest?: VibeCodePendingRequest;
}

export interface VibeCodeReplyRequest {
  /** Free-form text — relayed verbatim for talkToUser; ignored when
   *  the pending tool is requestEnvVar (the value flows through /env/set). */
  text?: string;
  /**
   * Optional multimodal attachments on a talkToUser reply turn — same
   * shape + caps as `VibeCodeStartRequest.attachments`. Ignored on the
   * requestEnvVar path. VALUE-FREE w.r.t. secrets by contract.
   */
  attachments?: VibeCodeAttachment[];
  /**
   * BYOK provider credential. Normally the credential delivered on
   * `start` is reused for the whole session, so a reply need NOT carry
   * one. Supplied here only to seed a session that started without a
   * credential (the `needsCredential` case) before resuming it. Same
   * box-only, never-echoed, never-logged contract as the start path.
   */
  credential?: LlmProviderCredential;
  /**
   * When the pending tool is `requestEnvVar`, the phone signals the
   * outcome here. The value itself is NEVER carried by /reply — the
   * value MUST be POSTed to /api/screens/services/:appId/env/set
   * first. This endpoint only resolves the model-facing ack with
   * status "set" | "declined" | "deferred".
   */
  envVarStatus?: "set" | "declined" | "deferred";
}

export interface VibeCodeReplyResponse {
  ok: boolean;
}

// ---------- P9 — /api/screens/peer-backup ----------------------------------
//
// Two endpoints power the webapp / mobile peer-backup management view:
//   GET  /api/screens/peer-backup/status        → PeerBackupStatusResponse
//   POST /api/screens/peer-backup/toggle        → PeerBackupStatusResponse
//                                                 body { participate: boolean }
//
// Shape matches `apps/web/public/webapp/views/peer-backup.js` byte-for-byte.
// Fields the underlying daemon state does NOT yet capture (per-peer
// online/lastSeen, repair-tick history, per-shard byte size for "my"
// shards) are reported as honest empty/zero values — never fabricated.

export interface PeerBackupPeerHostingYou {
  /** Peer's serverId. Reused as the "fqdn" for display. */
  peerFqdn: string;
  /** Count of this server's shards the peer hosts. */
  shardsHosted: number;
  /** Last time we saw a successful challenge / placement (unix-ms). */
  lastSeenMs: number;
  /** Best-effort online signal (false when no recent activity). */
  online: boolean;
}

export interface PeerBackupPeerYouHost {
  peerFqdn: string;
  /** Count of distinct shards this server hosts for the peer. */
  shardsHosted: number;
  /** Sum of `sizeBytes` across all hosted shards for this peer. */
  bytesHosted: number;
  /** Last time the peer pulled / verified a shard (unix-ms). */
  lastFetchedMs: number;
}

export interface PeerBackupShardSummary {
  /** Hex of `encChunkId`; unique per chunk on this server. */
  shardId: string;
  /** Surviving replicas across all peers (challengeStreak < 3). */
  replicas: number;
  /** Erasure-coding k — the minimum required to reconstruct. */
  minReplicas: number;
  /** Best-effort size; 0 when not yet tracked at the my-shard layer. */
  bytes: number;
}

export interface PeerBackupRepairStatus {
  /** "idle" | "running" | "error" — current repair-daemon state. */
  state: "idle" | "running" | "error";
  /** Unix-ms of the last completed repair tick, or null. */
  lastTickMs: number | null;
  /** Shards queued for re-placement right now. */
  queued: number;
  /** Repairs successfully completed in the last 24h. */
  completed24h: number;
  /** Last error message (if any). */
  lastError?: string;
}

export interface PeerBackupStats {
  /** Total chunks this server has shards for. */
  total: number;
  /** Chunks with ≥ k surviving replicas. */
  durable: number;
  /** Chunks with < k surviving replicas. */
  atRisk: number;
  /** Bytes of this server's data currently placed on peers (best-effort). */
  yourBytesStored: number;
  /** Bytes this server hosts for peers (sum of theirShards.sizeBytes). */
  peerBytesHosted: number;
}

export interface PeerBackupStatusResponse {
  participating: boolean;
  peersBackingYouUp: PeerBackupPeerHostingYou[];
  peersYouBackUp: PeerBackupPeerYouHost[];
  shards: PeerBackupShardSummary[];
  repair: PeerBackupRepairStatus;
  stats: PeerBackupStats;
}

export interface PeerBackupToggleRequest {
  participate: boolean;
}

// ---------- P6 — /api/screens/app-invite/* ----------------------------------
//
// Collaborator-invite BFF surface. The phone / webapp drives:
//   POST   /api/screens/app-invite/issue                → AppInviteIssueResponse
//   GET    /api/screens/app-invite/list/:serviceId      → AppInviteListResponse
//   GET    /api/screens/app-invite/access/:serviceId    → AppInviteAccessResponse
//   POST   /api/screens/app-invite/revoke               → { ok: true }
//
// Shape matches `apps/web/public/webapp/views/invite-issue.js` +
// `invite-manage.js` byte-for-byte. The daemon never sees the local
// label-book (displayName / channel / sentTo / notes) — those stay on
// the webapp + mobile client side. The wire intentionally carries only
// the `opaqueTag` (16-byte client-issued handle) and the IRK pubkey hex.

export interface AppInviteIssueRequest {
  /** `<creator>-<slug>` composite id. */
  serviceId: string;
  /** Role to grant on redeem. Free-form; see Role in inviteHandler. */
  role: string;
  /** 16-byte hex tag the client minted — the daemon's only routing key. */
  opaqueTag: string;
  /** Optional issuer note rendered to the consumer before they redeem. */
  contextNote: string | null;
}

export interface AppInviteIssueResponse {
  /** 32-byte hex — the bearer secret the issuer shares with the recipient. */
  secret: string;
  /** Unix-ms; invite TTL hard cap. */
  expiresAt: number;
}

export interface AppInvitePendingSummary {
  /** 16-byte hex — the client's opaque tag for label-book lookup. */
  opaqueTag: string;
  inviteId: string;
  role: string;
  expiresAt: number;
}

export interface AppInviteListResponse {
  pending: AppInvitePendingSummary[];
}

export interface AppInviteAccessSummary {
  opaqueTag: string;
  /** Hex Ed25519 IRK pubkey of the redeeming peer. */
  irkPubHex: string;
  role: string;
  grantedAt: number;
}

export interface AppInviteAccessResponse {
  access: AppInviteAccessSummary[];
}

/**
 * Discriminated revoke request. `scope: "invite"` soft-deletes a single
 * pending invite by id; `scope: "access"` soft-deletes a single redeemed
 * access row by IRK pubkey hex.
 */
export type AppInviteRevokeRequest =
  | { serviceId: string; inviteId: string; scope: "invite" }
  | { serviceId: string; irkPubKey: string; scope: "access" };

export interface AppInviteRevokeResponse {
  ok: boolean;
  /** True when the row was already in a terminal state — idempotent. */
  alreadyRevoked?: boolean;
}
