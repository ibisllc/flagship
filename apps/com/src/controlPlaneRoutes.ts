/**
 * Worker-side routing for the .com control-plane endpoints.
 *
 * These used to live on the Fly app behind Fastify. After the
 * .com (identity, persistent state) / .services (transient, runtime)
 * split they're now served directly by the Worker, with D1 as the
 * persistence layer. The handlers themselves live in
 * @flagship/control-plane and are runtime-agnostic.
 */

import {
  authorizeAdmin,
  handleSchemaStatus,
  handleStampSchemaVersion,
  handleCaLeaseStatus,
  BrokerDnsClient,
  caKeypairFromEnv,
  CloudflareDnsClient,
  proxyDns01DeleteToBroker,
  proxyDns01PublishToBroker,
  handleAuthCodeIssue,
  handleAuthCodeLookup,
  handleAuthCodeRevoke,
  handleCaCert,
  handleMaintainerBlessing,
  handleHubBlessing,
  handleStoreTrustException,
  handleListTrustExceptions,
  handleCreateServiceInvite,
  handleFetchServiceInviteCreate,
  handleRedeemServiceInvite,
  handleRevokeServiceInvite,
  handleListServiceInvites,
  handleRevokedSinceServiceInvites,
  handleCleanupApex,
  handleCompleteRePair,
  handleDeviceDisconnect,
  handleConsumeUnlockKey,
  handleDepositAutoUnlockLease,
  handleGetRePair,
  handleInitiateRePair,
  handleListAutoUnlockLeases,
  handlePostSecretRequest,
  handleGetSecretRequests,
  handlePostSecretResponse,
  handleGetSecretResponse,
  handlePostBoxSealedLease,
  handleReleaseBoxSealedLease,
  handleRevokeBoxSealedLease,
  handleListBoxSealedLeases,
  handlePostPairingDeposit,
  handleConsumePairingDeposit,
  handlePbRequestPeers,
  handlePeerStkLookup,
  handlePutBackupManifest,
  handleGetBackupManifest,
  handlePostEntitlementDeposit,
  handleConsumeEntitlementDeposit,
  handlePostSwkDeposit,
  handleConsumeSwkDeposit,
  handlePostCgkDeposit,
  handleConsumeCgkDeposit,
  handlePostSetLeaderDeposit,
  handleConsumeSetLeaderDeposit,
  handlePostUpdateDeposit,
  handleConsumeUpdateDeposit,
  handleConsumeSelfDeleteDeposit,
  handlePostDecommission,
  handleGetDecommission,
  handleGetEvictionChain,
  handlePostEpochComplete,
  handlePostAckOld,
  handlePostAckNew,
  handlePostMigrationStart,
  handleGetMigration,
  handleGetMigrationAssignment,
  handlePostMigrationAttach,
  handlePostMigrationPreSeeded,
  handlePostMigrationConfirmReady,
  handlePostMigrationFreeze,
  handlePostMigrationTakeOver,
  handlePostMigrationAbort,
  handlePostTransferOffer,
  handlePostTransferClaim,
  handleGetTransferClaim,
  handleGetTransferRehome,
  handlePostTransferRehomeAuth,
  handlePostTransferDiskKey,
  handleGetTransferDiskKey,
  handlePostTransferAdminHandoff,
  handleDepositAcmeAccountKey,
  handleReleaseAcmeAccountKey,
  handleRevokeAcmeAccountKeyDelivery,
  handleNotifyOwner,
  handleObjectRePair,
  handleTotpDisable,
  handleTotpEnrollBegin,
  handleTotpEnrollConfirm,
  handleTotpVerify,
  handleWipeRestart,
  handleServiceRename,
  handleGetAppLinks,
  handleListAppAliases,
  handleSetCustomDomain,
  handleGetCustomDomain,
  handleActiveRedirections,
  handleRedirectionLookup,
  pushRedirection,
  bearer,
  handleVoiciShorten,
  handleRevokeAutoUnlockLease,
  handleDns01Delete,
  handleDns01Publish,
  handleGetInstallEvents,
  handleIsoManifest,
  handleGetSealedLuksKey,
  handlePutSealedLuksKey,
  handlePostInstallEvent,
  handlePostProvisionStatus,
  handleGetProvisionStatus,
  handleRegisterRck,
  handleRepublishServerDns,
  handleRoutingLookup,
  handleServerLookup,
  handleServerRegister,
  handleRevokeServer,
  handleServerReleaseName,
  handleAccountDeletionBundle,
  handleAdminUsernameReclaim,
  handleServerRevokeBySelf,
  handleSetRoutingTarget,
  handleSuggestUsername,
  handleUsernameClaim,
  handleUsersCheck,
  parseTestAccountsEnv,
  handleUsernameLookup,
  handlePostUsernameRename,
  handleGetUsernameAlias,
  handleGetUserPods,
  handleUserStream,
  handleListOutstandingOrders,
  handleGetUsersDevices,
  handleAccountResolve,
  handleGetAuditEvents,
  handlePostDaemonStatus,
  handleUserPubKeyCert,
  buildPushForwarder,
  wrapForwarderAsV12Fanout,
  handleGetEntitlementRevocations,
  handleListRevocations,
  handlePostEntitlementRevocations,
  handlePushRegister,
  handlePushRelay,
  handlePushRevoke,
  handleUsageReport,
  handleUsageStatus,
  handleVouchedDeviceAdmit,
  handleLlmPromoIssue,
  handleLlmPromoStatus,
  handleLlmPromoUsage,
  parseBlessedInferenceEndpoint,
  mintScopedInferenceToken,
  verifyScopedInferenceToken,
  handleDeleteWebauthnRecovery,
  handleFetchWebauthnRecovery,
  handleFetchWrappedUmkWithToken,
  handleUploadWebauthnRecovery,
  handleGetUserIdentity,
  handlePutUserIdentity,
  handleCreateDemoUser,
  handleDeleteDemoUser,
  handleDemoUserConnect,
  handleDemoUserCancel,
  handleDemoUserHeartbeat,
  handleDemoUserInstallComplete,
  handleGetDemoUser,
  handleListDemoUsers,
  handleAdminClaimAndIssue,
  handleAdminMintDeviceGrant,
  handleAdminCloudInitNow,
  handleGymProvision,
  handleAdminSnapshotNow,
  handleMintDeviceGrant,
  handleListDeviceGrants,
  handleRevokeDeviceGrant,
  handleApplyAdminRootRotation,
  handleListAdminRootRotations,
  handleMintWatchDelegate,
  handleListWatchDelegates,
  handleRevokeWatchDelegate,
  handleMintAcmeAccountKeyGrant,
  handleListAcmeAccountKeyGrants,
  handleRevokeAcmeAccountKeyGrant,
  handleAcquireMintReservation,
  handleReleaseMintReservation,
  type CaIssuer,
  type CaGate,
  type HandlerResponse,
  type HandlerResponseWithHeaders,
  type IsoManifest,
} from "@flagship/control-plane";
import { D1Storage, D1DemoUsersStorage, D1UsageStorage, type D1Database } from "@flagship/storage";
import {
  routeBoot,
  AUTH_HEADER,
  D1NonceStore,
  type BootRouteDeps,
} from "@flagship/boot-core";
import { InProcessDirectoryClient, InProcessNotifyPipe } from "./bootInProcess.js";
import {
  workerCaTrustChain,
  caEnforceFromEnv,
  activeCaLeaseNotAfterMs,
  caTrustChainPublicMaterial,
} from "./caTrustChainLoader.js";
import { createHetznerClient } from "./hetzner.js";

export interface ControlPlaneEnv {
  DB?: D1Database;
  FLAGSHIP_CA_PRIV_HEX?: string;
  FLAGSHIP_CA_ISSUER?: string;
  /**
   * #30 maintainer→CA gate mode — the SINGLE documented switch.
   * Unset / anything other than the literal `"true"` ⇒ OBSERVE: the
   * gate runs the full pin→chain→endorsement verification and emits a
   * structured log line, but signing proceeds byte-for-byte as today
   * (DEPLOY-SAFE — there is no committed CaEndorsement until the human
   * YubiKey ceremony, so hard-enforcing would fail-close every live
   * directory attestation). `"true"` ⇒ ENFORCE: refuse to mint a
   * CA-signed artifact when the chain is unauthorized. A human flips
   * this to `"true"` ONLY after a valid CaEndorsement is committed and
   * verified — see docs/ca-operations.md. */
  CA_ENDORSEMENT_ENFORCE?: string;
  /** Shared bearer secret for the .com↔.services custom-domain
   *  control channel (#87). Also set as a Fly secret on .services. */
  SERVICES_CONTROL_SECRET?: string;
  /** Base URL of the `.services` control channel (the :8443 TLS-term
   *  host). Needed to push the replace-time DELETE(old fqdn). */
  SERVICES_BASE_URL?: string;
  /**
   * Public URL of the standalone dns-broker Worker (see
   * `apps/dns-broker`). When set, the main Worker delegates ALL DNS
   * mutations to the broker via RPC and does NOT use a direct CF API
   * token. This is the production posture as of Task #13.
   */
  DNS_BROKER_URL?: string;
  /**
   * Legacy direct-CF mode. Kept only for the local-dev / test path
   * where running the broker is overkill. PRODUCTION MUST USE THE
   * BROKER: if `DNS_BROKER_URL` is set this secret is ignored even if
   * present, and a predeploy check should flag the duplicate.
   */
  CLOUDFLARE_DNS_API_TOKEN?: string;
  /** Zone ID for flagship.services. Only used in the legacy direct mode. */
  CLOUDFLARE_SERVICES_ZONE_ID?: string;
  /**
   * The data-plane apex this control plane manages — `flagship.services`
   * in prod, `gym.flagship.services` for the test env (docs/ui-test-gym.md
   * §6.5). Threaded into serverDomain validation, the user-zone CAA
   * anchor, the DNS-01 own-name fence, and apex cleanup. Unset ⇒ the prod
   * literal, so prod (and every canonical-byte / serverDomain vector) is
   * byte-identical; the `gym.` test Worker overrides it via [vars].
   */
  SERVICES_APEX?: string;
  /**
   * The identity-plane apex this control plane serves —
   * `flagshipserver.com` in prod, `gym.flagshipserver.com` for the test
   * env. Unset ⇒ the prod literal. (The `comBaseUrl` defaults elsewhere
   * are already parameterized; this var is the single source for the test
   * Worker to set its own identity apex.)
   */
  CONTROL_APEX?: string;
  /** IPv4 of the .services SNI passthrough listener (Fly anycast). */
  SERVICES_PASSTHROUGH_IPV4?: string;
  SERVICES_PASSTHROUGH_IPV6?: string;
  /** Shared secret gating /api/admin/* operational endpoints. */
  FLAGSHIP_ADMIN_SECRET?: string;

  /**
   * The blessed Debian base-ISO manifest the desktop burner should hold,
   * as a JSON string of the `IsoManifest` shape:
   *   {"version","url","sha256","sizeBytes","attestation"}
   * Unset / unparseable / shape-invalid ⇒ treated as unconfigured, and
   * POST /api/iso-manifest responds `{ download: null }`. Changing this
   * value server-side IS the "ship a new release / hold an old one"
   * lever — there is no action/keep/urgent field on the wire. The
   * `sha256` MUST be pinned to Debian's official signed SHA256SUMS (the
   * `attestation` URL) so the burner can verify the download end-to-end.
   * Set via `wrangler secret put FLAGSHIP_ISO_MANIFEST` (or a [vars]
   * entry once values are public).
   */
  FLAGSHIP_ISO_MANIFEST?: string;

  /**
   * The blessed in-house inference endpoint that backs the free-credits
   * ("flagship") provider posture, as a JSON string of the
   * `InferenceEndpoint` shape: {"baseUrl","model"}. `baseUrl` is the
   * OpenAI-compatible RunPod/vLLM URL; `model` the served model id.
   * Unset / unparseable / non-https ⇒ treated as unconfigured, and a
   * `flagship` promo issue is refused (503) rather than minting a dead
   * key. Rotating the RunPod endpoint is purely a matter of changing this
   * value server-side — it never appears in a recipe or client build.
   * Set via `wrangler secret put FLAGSHIP_INFERENCE_ENDPOINT`.
   */
  FLAGSHIP_INFERENCE_ENDPOINT?: string;

  /**
   * HMAC-SHA256 secret used to sign the scoped inference tokens the promo
   * minter hands out for `provider:"flagship"`, and which the metering
   * shim in front of the RunPod endpoint verifies (and reports usage back
   * under, to POST /api/llm-promo/usage). Unset ⇒ a `flagship` issue is
   * refused (503). NOT in git — `wrangler secret put
   * FLAGSHIP_INFERENCE_TOKEN_SECRET`.
   */
  FLAGSHIP_INFERENCE_TOKEN_SECRET?: string;

  /**
   * Shared bearer secret for the dedicated boot worker's NOTIFY PIPE
   * (apps/boot → POST /api/internal/notify-owner). The boot worker holds
   * no push secrets; it calls this endpoint server-to-server so the
   * identity plane (which holds APNs/FCM/VAPID) fans out the push. Set
   * the SAME value as the boot worker's NOTIFY_SHARED_SECRET. When unset,
   * /api/internal/notify-owner returns 503 (the legacy direct
   * /api/server/:host/secret-request path is unaffected). NOT in git —
   * set via `wrangler secret put BOOT_NOTIFY_SECRET`.
   */
  BOOT_NOTIFY_SECRET?: string;

  /**
   * Shared bearer secret for the `.services` relay's usage-metering report
   * pipe (relay → POST /api/usage/report). Presented as `x-usage-secret`.
   * When unset, /api/usage/* return 503 (metering off). Set the SAME value as
   * the relay's USAGE_REPORT_SECRET. NOT in git — `wrangler secret put`.
   */
  USAGE_REPORT_SECRET?: string;

  /** APNs HTTP/2 token-auth credentials. Set together to enable APNs. */
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY_PEM?: string;
  APNS_BUNDLE_ID?: string;
  /** ES256 PKCS8 private key the Worker uses to sign VAPID JWTs. */
  WEBPUSH_VAPID_PRIVATE_KEY_PEM?: string;
  /** Uncompressed P-256 public key (65 bytes), base64url. Public — webapp fetches it. */
  WEBPUSH_VAPID_PUBLIC_KEY_B64URL?: string;
  /** Required `mailto:` for the VAPID `sub` claim (operator contact). */
  WEBPUSH_CONTACT?: string;
  /** Default api.push.apple.com; set to api.sandbox.push.apple.com for dev. */
  APNS_HOST?: string;

  /** FCM HTTP v1 service-account JSON (full file content). */
  FCM_SERVICE_ACCOUNT_JSON?: string;
  FCM_PROJECT_ID?: string;

  /**
   * Test-account list. JSON object: `{ "<username>": { "display": "...",
   * "ttlHours": 6 } }`. NOT in git — set via `wrangler secret put
   * TEST_ACCOUNTS`. Matching usernames return testAccount metadata on
   * POST /api/users/check so mobile clients enter a sandboxed demo
   * mode. The full list is never exposed; the handler only returns
   * the entry the caller asked about. See
   * packages/control-plane/src/usersCheck.ts and the
   * future-test-account-architecture memory note.
   */
  TEST_ACCOUNTS?: string;

  /**
   * Hetzner Cloud API token (Plan A — sample-user / on-connect VPS).
   * Worker uses it to provision / destroy demo-user servers from
   * pre-baked snapshots. NOT in git — set via `wrangler secret put
   * HCLOUD_TOKEN`. Scope to a dedicated Hetzner project so demo
   * provisioning can never reach unrelated infra. See
   * docs/sample-users.md §9.1.
   */
  HCLOUD_TOKEN?: string;

  /**
   * Public-half SSH key Hetzner attaches to demo servers. Operator's
   * laptop holds the private half (used by the rescue+dd path during
   * create-sample-user). Set via `wrangler secret put
   * DEMO_PUBLIC_SSH_KEY < ~/.ssh/flagship-demo-ssh.pub`. See
   * docs/sample-users.md §9.2. */
  DEMO_PUBLIC_SSH_KEY?: string;

  /**
   * Numeric Hetzner SSH key id (captured at first create-sample-user
   * run, recorded under [vars] in wrangler.toml). Not sensitive — the
   * id is the Hetzner-side handle for the public key above. See
   * docs/sample-users.md §9.3.
   */
  DEMO_PUBLIC_SSH_KEY_ID?: string;

  /**
   * v1.2 Plan B Phase 3 — 32-byte hex Worker secret used as the KEK
   * for `usernames.totp_secret_encrypted` (AES-GCM). When unset, the
   * four `/api/users/:u/totp/*` endpoints return 503
   * `{ error: "TOTP not configured" }` and the re-pair handler falls
   * back to its Phase 2 structural-only `totpProof` gate. Once set
   * via `wrangler secret put FLAGSHIP_TOTP_KEK`, all TOTP paths run
   * the real verification + atomic recovery-code consumption.
   */
  FLAGSHIP_TOTP_KEK?: string;

  /**
   * v2 device-addressing (S3.3) — 32-byte hex Worker secret used as
   * the KEK from which `admin-claim-and-issue` derives a deterministic
   * User IRK for a demo username (HKDF salt="flagship-demo-irk-v1",
   * info="user-irk"; see packages/control-plane/src/demoUsersAdmin.ts).
   * Generate once via `openssl rand -hex 32` and set via
   * `wrangler secret put DEMO_IRK_KEK`. When unset, both new admin
   * endpoints (admin-claim-and-issue + admin-mint-device-grant) return
   * 503; legacy demo handlers (create/connect/heartbeat) keep working.
   * NEVER appears in code, logs, or D1.
   */
  DEMO_IRK_KEK?: string;

  /**
   * W11 — base Alpine ISO bucket binding. Holds the unmodified
   * Alpine + apkovl ISO that the build-relay serves to the browser
   * AND the W11 admin-snapshot-now handler streams through
   * `streamPersonalize` into ISO_TEMP_BUCKET. Bound via
   * `[[r2_buckets]] binding = "ISO_BUCKET"`.
   */
  ISO_BUCKET?: ProvisioningBaseBucket;

  /**
   * W11 — temp bucket for personalized demo ISOs. The cloud-init
   * `user_data` script wgets from this bucket's public dev-url.
   * Bound via `[[r2_buckets]] binding = "ISO_TEMP_BUCKET"`.
   */
  ISO_TEMP_BUCKET?: ProvisioningTempBucket;

  /**
   * W11 — public dev-url base for `ISO_TEMP_BUCKET`. Set in
   * `wrangler.toml [vars]` once the bucket has public access enabled
   * via `wrangler r2 bucket dev-url enable flagship-iso-temp`. The
   * cloud-init script wgets `${base}/${key}`.
   */
  FLAGSHIP_R2_TEMP_PUBLIC_BASE?: string;

  /**
   * W11 — base ISO key inside `ISO_BUCKET`. Defaults to the
   * `flagship-base-alpine-…iso` path the build-relay serves. Set in
   * `wrangler.toml [vars]` if you bump Alpine versions.
   */
  FLAGSHIP_BASE_ISO_KEY?: string;

  /**
   * W12 — public URL of the Debian-12-netinst-based netboot ISO used
   * by the cloud demo (admin-snapshot-now) path. Cloud-init wgets
   * this directly from the VPS. Build with
   *   scripts/build-flagship-netboot-iso.sh out/flagship-netboot.iso
   * and upload to R2. Falls back to FLAGSHIP_NETBOOT_ISO_URL → the
   * pinned default below.
   */
  FLAGSHIP_NETBOOT_ISO_URL?: string;
  /** R2 object key for the netboot ISO inside `ISO_BUCKET`. */
  FLAGSHIP_NETBOOT_ISO_KEY?: string;
}

// Structural shapes for the R2 bindings the W11 handler uses. Kept
// inline so the control-plane package's structural types stay
// decoupled from @cloudflare/workers-types.
interface ProvisioningBaseBucket {
  get(key: string): Promise<{
    body: ReadableStream<Uint8Array> | null;
    size: number;
  } | null>;
}

interface ProvisioningTempBucket {
  put(
    key: string,
    value: ReadableStream<Uint8Array> | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  /** Used by W12 debug log-exfil (POST/GET /api/dev/late-log/:label). */
  list(options: {
    prefix?: string;
    limit?: number;
  }): Promise<{ objects: Array<{ key: string }> }>;
  /** Used by W12 debug log-exfil. */
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

const ROUTE_RE = {
  USAGE_REPORT: /^\/api\/usage\/report$/,
  USAGE_STATUS: /^\/api\/usage\/status$/,
  USERNAME_CLAIM: /^\/api\/username\/claim$/,
  USERNAME_SUGGEST: /^\/api\/username\/suggest$/,
  USERS_CHECK: /^\/api\/users\/check$/,
  ACCOUNT_RESOLVE: /^\/api\/account\/resolve\/([^/]+)$/,
  USERNAME_RENAME: /^\/api\/username\/rename$/,
  USERNAME_ALIAS: /^\/api\/username\/alias\/([^/]+)$/,
  USERNAME_LOOKUP: /^\/api\/username\/([^/]+)$/,
  AUTH_CODE_ISSUE: /^\/api\/auth-code\/issue$/,
  AUTH_CODE_REVOKE: /^\/api\/auth-code\/([^/]+)\/revoke$/,
  AUTH_CODE_LOOKUP: /^\/api\/auth-code\/([^/]+)$/,
  SERVER_REGISTER: /^\/api\/server\/register$/,
  SERVER_RELEASE: /^\/api\/server\/release$/,
  SERVER_LOOKUP: /^\/api\/server\/by-domain\/([^/]+)$/,
  SERVER_REVOKE_BY_SELF: /^\/api\/server\/by-domain\/([^/]+)\/revoke$/,
  // P13 — IRK-signed user-initiated server revocation (lost / stolen /
  // decommissioned). Cascades through the boot-unlock leases so the
  // box bricks on its next reboot.
  SERVER_REGISTRY_REVOKE: /^\/api\/server-registry\/revoke$/,
  PUBKEY_CERT: /^\/api\/users\/([^/]+)\/pubkey-cert$/,
  CA_CERT: /^\/api\/ca\/cert$/,
  MAINTAINER_BLESSING: /^\/api\/maintainer-blessing$/,
  // Relay blessing — the `.services` hub asks `.com` to bless its
  // self-generated key (docs/maintainer-trust-enforcement.md). ~daily.
  HUB_BLESSING: /^\/api\/services\/hub-blessing$/,
  // Owner-signed, per-cert maintainer-trust exceptions, synced via `.com`.
  TRUST_EXCEPTIONS: /^\/api\/users\/([^/]+)\/trust-exceptions$/,
  // Service-access capability invites (docs/service-access-gating.md).
  // create (POST) + list (GET) on the base path; revoke is a distinct sub-path
  // checked first; redeem is account-agnostic (the friend may be a stranger).
  SERVICE_INVITE_REVOKE: /^\/api\/users\/([^/]+)\/service-invites\/revoke$/,
  SERVICE_INVITE_REVOKED_SINCE: /^\/api\/users\/([^/]+)\/service-invites\/revoked-since$/,
  SERVICE_INVITE_CREATE_FETCH: /^\/api\/users\/([^/]+)\/service-invites\/([^/]+)\/create$/,
  SERVICE_INVITES: /^\/api\/users\/([^/]+)\/service-invites$/,
  SERVICE_INVITE_REDEEM: /^\/api\/service-invites\/redeem$/,
  RCK_REGISTER: /^\/api\/routing\/register-rck$/,
  RCK_SET_TARGET: /^\/api\/routing\/set-target$/,
  ROUTING_LOOKUP: /^\/api\/routing\/lookup$/,
  INSTALL_EVENTS: /^\/api\/install-events\/([^/]+)$/,
  // Desktop-burner base-ISO manifest channel. The burner POSTs what it
  // currently holds on every launch; the server decides whether/where to
  // fetch the blessed Debian base ISO. Unauthenticated, rate-limited.
  ISO_MANIFEST: /^\/api\/iso-manifest$/,
  // Provisioning-status channel — per-order install progress keyed by the
  // auth-code serial. The box POSTs a named phase; the phone polls it.
  PROVISION_STATUS: /^\/api\/order\/([^/]+)\/status$/,
  DNS01_PUBLISH: /^\/api\/dns-01\/publish$/,
  DNS01_DELETE: /^\/api\/dns-01\/delete$/,
  LUKS_SEALED: /^\/api\/server\/([^/]+)\/sealed-luks-key$/,
  LUKS_UNLOCK_CONSUME: /^\/api\/server\/([^/]+)\/unlock-key\/consume$/,
  LUKS_LEASE_DEPOSIT: /^\/api\/server\/([^/]+)\/unlock-key\/lease$/,
  LUKS_LEASE_REVOKE: /^\/api\/server\/([^/]+)\/unlock-key\/lease\/([^/]+)$/,
  LUKS_LEASE_LIST: /^\/api\/server\/([^/]+)\/unlock-key\/leases$/,
  // Phone-as-unlock-endpoint RELAY (docs/security-phone-as-unlock-
  // endpoint.md). The box POSTs an STK-signed SecretRequest to its
  // mailbox; the phone GETs pending + POSTs the sealed reply; the box
  // polls for it. The lease-v2 quartet is the box-sealed lease (the
  // `-v2` literals keep them clear of the legacy `/lease` matchers
  // above; the `/leases-v2` list literal can't collide with
  // `/lease-v2/:id` since it has no trailing path segment). Box-sealed
  // lease list must be tested BEFORE the bare lease-v2 GET in dispatch.
  SECRET_REQUEST_POST: /^\/api\/server\/([^/]+)\/secret-request$/,
  SECRET_RESPONSE_GET: /^\/api\/server\/([^/]+)\/secret-response$/,
  SECRET_REQUESTS_LIST: /^\/api\/secret-requests$/,
  SECRET_RESPONSE_POST: /^\/api\/secret-response$/,
  // Identity-plane half of the dedicated boot worker's NOTIFY PIPE
  // (apps/boot calls this server-to-server; shared-secret auth).
  INTERNAL_NOTIFY_OWNER: /^\/api\/internal\/notify-owner$/,
  LEASE_V2_DEPOSIT: /^\/api\/server\/([^/]+)\/unlock-key\/lease-v2$/,
  LEASE_V2_REVOKE: /^\/api\/server\/([^/]+)\/unlock-key\/lease-v2\/([^/]+)$/,
  LEASE_V2_LIST: /^\/api\/server\/([^/]+)\/unlock-key\/leases-v2$/,
  // Deposit-on-unlock pairing. ONE path discriminated by method:
  //   POST  phone deposit (IRK mailbox-auth, sealed for the box STK)
  //   GET   box consume-once read (public — sealed blob only)
  PAIRING_DEPOSIT: /^\/api\/server\/([^/]+)\/pairing-deposit$/,
  // Entitlement deposit-on-unlock: POST phone deposit (IRK mailbox-auth, the
  // PUBLIC IRK-signed entitlement) / GET box consume-once read.
  ENTITLEMENT_DEPOSIT: /^\/api\/server\/([^/]+)\/entitlement-deposit$/,
  // Secret-free-recipe SWK delivery: POST phone deposit (IRK mailbox-auth, the
  // SEALED SWK-delivery carrier) / GET box consume-once read (sealed only).
  SWK_DEPOSIT: /^\/api\/server\/([^/]+)\/swk-deposit$/,
  // Post-boot CGK delivery (Phase 6): POST phone deposit (IRK mailbox-auth, the
  // SEALED CGK-delivery carrier) / GET box consume-once read (sealed only).
  CGK_DEPOSIT: /^\/api\/server\/([^/]+)\/cgk-deposit$/,
  // Owner preferred-server vote (Phase 6): POST phone deposit (IRK mailbox-auth,
  // owner-IRK set-leader vote, verified before storing) / GET box consume-once read.
  SET_LEADER_DEPOSIT: /^\/api\/server\/([^/]+)\/set-leader$/,
  // Admin-authorized in-place server-update order (docs/server-update-mechanism.md):
  //   POST  phone deposits the admin-signed UpdateOrder (mailbox-auth + Slice-D
  //         admin-authority gate — the sensitive-op check)
  //   GET   the box fetches its own order (PUBLIC consume-once; re-verifies box-side)
  UPDATE_DEPOSIT: /^\/api\/server\/([^/]+)\/update$/,
  SELF_DELETE_DEPOSIT: /^\/api\/server\/([^/]+)\/self-delete$/,
  // Peer-backup (server-migration Layer 0). request-peers is the STK-signed
  // matchmaker (same-account pods, v0); stk is the exact-match directory
  // lookup a receiving peer resolves a shard-caller's STK with; the
  // backup-manifest path is method-discriminated:
  //   PUT  box deposits its SWK-sealed shard-placement manifest (STK-signed,
  //        monotonic generation — latest-wins)
  //   GET  public non-consuming read (ciphertext only; a fresh replacement
  //        box re-derives the SWK and opens it)
  PB_REQUEST_PEERS: /^\/api\/peer-backup\/request-peers$/,
  PB_STK_LOOKUP: /^\/api\/peer-backup\/stk\/([^/]+)$/,
  BACKUP_MANIFEST: /^\/api\/server\/([^/]+)\/backup-manifest$/,
  // Graceful server-replacement decommission (docs/server-replacement-graceful-
  // decommission.md). The bare `decommission` path is method-discriminated:
  //   POST  owner deposits the IRK-signed ServerDecommission order (mailbox-auth)
  //   GET   the retiring box fetches its own order by ?stk= (PUBLIC, revoke-tolerant)
  // The sub-path literals (epoch-complete / ack-old / ack-new) are anchored with
  // `$` so they can't collide with the bare matcher; the eviction-chain is the
  // successor's full-chain read.
  DECOMMISSION_EPOCH_COMPLETE: /^\/api\/server\/([^/]+)\/decommission\/epoch-complete$/,
  DECOMMISSION_ACK_OLD: /^\/api\/server\/([^/]+)\/decommission\/ack-old$/,
  DECOMMISSION_ACK_NEW: /^\/api\/server\/([^/]+)\/decommission\/ack-new$/,
  DECOMMISSION: /^\/api\/server\/([^/]+)\/decommission$/,
  EVICTION_CHAIN: /^\/api\/server\/([^/]+)\/eviction-chain$/,
  // Server-migration orchestration (docs/server-migration.md). The bare
  // `migration` path is method-discriminated (POST admin-signed initiate /
  // GET public phase state); the sub-path literals are anchored with `$` and
  // matched BEFORE the bare path. `migration-assignment` is the NEW box's
  // discovery read, keyed by ITS OWN registered pod FQDN.
  MIGRATION_ATTACH: /^\/api\/server\/([^/]+)\/migration\/attach$/,
  MIGRATION_PRE_SEEDED: /^\/api\/server\/([^/]+)\/migration\/pre-seeded$/,
  MIGRATION_CONFIRM_READY: /^\/api\/server\/([^/]+)\/migration\/confirm-ready$/,
  MIGRATION_FREEZE: /^\/api\/server\/([^/]+)\/migration\/freeze$/,
  MIGRATION_TAKE_OVER: /^\/api\/server\/([^/]+)\/migration\/take-over$/,
  MIGRATION_ABORT: /^\/api\/server\/([^/]+)\/migration\/abort$/,
  MIGRATION: /^\/api\/server\/([^/]+)\/migration$/,
  MIGRATION_ASSIGNMENT: /^\/api\/server\/([^/]+)\/migration-assignment$/,
  // Transfer-a-box broker (docs/account-deletion-and-name-reclaim.md §4). ONE
  // path discriminated by method:
  //   POST .../transfer/offer       giver deposit (IRK mailbox-auth, signed offer)
  //   POST .../transfer/claim       acquirer claim (signed ServerTransferClaim)
  //   POST .../transfer/claim-poll  giver claim-poll (IRK mailbox-auth → acquirer
  //                                 IRK for the disk-key re-seal). POST (not GET)
  //                                 because the IRK mailbox-auth rides the body
  //                                 (a GET-with-body is non-portable) — mirrors
  //                                 the secret-requests listing's POST alias.
  TRANSFER_OFFER: /^\/api\/server\/([^/]+)\/transfer\/offer$/,
  TRANSFER_CLAIM: /^\/api\/server\/([^/]+)\/transfer\/claim$/,
  TRANSFER_CLAIM_POLL: /^\/api\/server\/([^/]+)\/transfer\/claim-poll$/,
  // Box-side re-home read (Layer A): the BOX polls its OLD canonical to learn
  // "did my owner change?". PUBLIC (the payload is already-public identity); the
  // box re-verifies the fresh acquirer-IRK entitlement + the giver-signed
  // re-sealed lease before serving. 404 when never transferred.
  TRANSFER_REHOME: /^\/api\/server\/([^/]+)\/transfer\/rehome$/,
  // Layer B disk-key handoff: giver deposits the re-sealed-to-acquirer-IRK disk
  // key (POST, giver IRK mailbox-auth); acquirer reads it (POST, acquirer IRK
  // mailbox-auth — the auth rides the body, mirroring claim-poll).
  TRANSFER_DISK_KEY: /^\/api\/server\/([^/]+)\/transfer\/disk-key$/,
  TRANSFER_DISK_KEY_CLAIM: /^\/api\/server\/([^/]+)\/transfer\/disk-key-claim$/,
  // Slice D §9.8 — the giver deposits the admin-root handoff proof (the
  // giver-admin-root SIGNATURE is the auth; the box re-verifies vs its pin).
  TRANSFER_ADMIN_HANDOFF: /^\/api\/server\/([^/]+)\/transfer\/admin-handoff$/,
  // v1-sec GAP 3 — the LEGACY (no-admin-root) sibling: the giver deposits the
  // giver-owner-IRK-signed re-home authorization (the SIGNATURE is the auth; a
  // box with no pinned admin root re-verifies it vs its pinned owner IRK).
  TRANSFER_REHOME_AUTH: /^\/api\/server\/([^/]+)\/transfer\/rehome-auth$/,
  // #28 Option B — seal-to-box ACME account-key delivery. ONE path
  // (singular `acme-account-key`) discriminated by method:
  //   POST   deposit (IRK-signed grant, sealed to the box STK)
  //   GET    release (public box poll — sealed blob only)
  //   DELETE delivery-revoke (IRK-signed)
  ACME_ACCOUNT_KEY_DELIVERY: /^\/api\/server\/([^/]+)\/acme-account-key$/,
  USER_PODS: /^\/api\/users\/([^/]+)\/pods$/,
  // Unified live-update channel — a single foreground long-poll that returns
  // the same payload as /pods PLUS a change-detection `cursor`, holding until
  // the user's meaningful state changes (or ~25s). Unauthenticated, like /pods.
  USER_STREAM: /^\/api\/users\/([^/]+)\/stream$/,
  // #43 — IRK-signed list of the account's IN-FLIGHT install orders, the
  // authority the phone reconciles its local pending-server cache against.
  USER_OUTSTANDING_ORDERS: /^\/api\/users\/([^/]+)\/outstanding-orders$/,
  USER_DEVICES: /^\/api\/users\/([^/]+)\/devices$/,
  // Phase 3b — vouched cross-device admit. The admin signs a
  // DeviceAdmit (under the account IRK) binding the incoming device's
  // fresh pubkey; the incoming device presents it here on register and
  // is admitted QUARANTINED. The `/admit` literal can't collide with
  // the disconnect matcher (which requires a trailing `/disconnect`).
  USER_DEVICE_ADMIT: /^\/api\/users\/([^/]+)\/devices\/admit$/,
  // v1.2 Phase 2 — IRK-signed disconnect-a-sibling. Quarantine-gated
  // on the caller's push_token row.
  USER_DEVICE_DISCONNECT: /^\/api\/users\/([^/]+)\/devices\/([^/]+)\/disconnect$/,
  USER_AUDIT: /^\/api\/users\/([^/]+)\/audit$/,
  DAEMON_STATUS: /^\/api\/daemon-status$/,
  RE_PAIR_INITIATE: /^\/api\/users\/([^/]+)\/re-pair$/,
  RE_PAIR_OBJECT: /^\/api\/users\/([^/]+)\/re-pair\/object$/,
  RE_PAIR_COMPLETE: /^\/api\/users\/([^/]+)\/re-pair\/complete$/,
  RE_PAIR_GET: /^\/api\/users\/([^/]+)\/re-pair$/,
  // v1.2 Plan B Phase 3 — TOTP 2FA enrollment + verification.
  TOTP_ENROLL_BEGIN: /^\/api\/users\/([^/]+)\/totp\/enroll-begin$/,
  TOTP_ENROLL_CONFIRM: /^\/api\/users\/([^/]+)\/totp\/enroll-confirm$/,
  TOTP_VERIFY: /^\/api\/users\/([^/]+)\/totp\/verify$/,
  TOTP_DISABLE: /^\/api\/users\/([^/]+)\/totp\/disable$/,
  WIPE_RESTART: /^\/api\/users\/([^/]+)\/wipe-restart$/,
  APP_RENAME: /^\/api\/users\/([^/]+)\/apps\/([^/]+)\/rename$/,
  APP_LINKS: /^\/api\/users\/([^/]+)\/apps\/([^/]+)\/links$/,
  CUSTOM_DOMAIN: /^\/api\/users\/([^/]+)\/apps\/([^/]+)\/custom-domain$/,
  APP_ALIASES: /^\/api\/users\/([^/]+)\/apps\/aliases$/,
  VOICI_SHORTEN: /^\/api\/voici\/shorten$/,
  ADMIN_REPUBLISH: /^\/api\/admin\/republish-server-dns$/,
  ADMIN_CLEANUP_APEX: /^\/api\/admin\/cleanup-apex$/,
  ADMIN_SCHEMA_STATUS: /^\/api\/admin\/schema-status$/,
  ADMIN_SCHEMA_STAMP: /^\/api\/admin\/schema-version\/([^/]+)$/,
  ADMIN_CA_LEASE_STATUS: /^\/api\/admin\/ca-lease-status$/,
  ADMIN_USERNAME_RECLAIM: /^\/api\/admin\/username\/([^/]+)\/reclaim$/,
  ACCOUNT_SELF_DELETE: /^\/api\/account\/self-delete$/,
  PUSH_REGISTER: /^\/api\/push\/register$/,
  PUSH_RELAY: /^\/api\/push\/relay$/,
  PUSH_VAPID_KEY: /^\/api\/push\/vapid-public-key$/,
  PUSH_REVOKE: /^\/api\/push\/([^/]+)$/,
  LLM_PROMO_ISSUE: /^\/api\/llm-promo\/issue$/,
  LLM_PROMO_STATUS: /^\/api\/llm-promo\/status\/([^/]+)$/,
  LLM_PROMO_USAGE: /^\/api\/llm-promo\/usage$/,
  CERT_REVOCATIONS_POST: /^\/api\/cert-revocations$/,
  CERT_REVOCATIONS_GET: /^\/api\/cert-revocations\/([^/]+)$/,
  REVOCATIONS_LIST: /^\/api\/revocations$/,
  RECOVERY_UPLOAD: /^\/api\/recovery$/,
  RECOVERY_FETCH_GATED: /^\/api\/recovery\/by-username\/([^/]+)\/fetch$/,
  RECOVERY_BY_USERNAME: /^\/api\/recovery\/by-username\/([^/]+)$/,
  USER_IDENTITY_PUT: /^\/api\/user-identity$/,
  USER_IDENTITY_GET: /^\/api\/user-identity\/([^/]+)$/,
  INTERNAL_ACTIVE_REDIRECTIONS: /^\/api\/internal\/active-redirections$/,
  INTERNAL_REDIRECTION_LOOKUP: /^\/api\/internal\/redirection-lookup$/,
  // Plan A — demo-user / Hetzner on-connect provisioning. The two
  // public-rate-limited endpoints (connect, heartbeat) live above the
  // bare GET in matching order so `/connect` and `/heartbeat` win
  // over the `/:u` matcher.
  DEMO_USER_CREATE: /^\/api\/dev\/sample-user\/create$/,
  DEMO_USER_DELETE: /^\/api\/dev\/sample-user\/delete$/,
  // v2 device-addressing admin endpoints (S3.3). The
  // `/admin-claim-and-issue` literal must hit BEFORE the bare
  // `/sample-user/{u}` GET (since "admin-claim-and-issue" would
  // otherwise be parsed as a username); the per-user
  // `/admin-mint-device-grant` matches similarly to /install-complete.
  DEMO_USER_ADMIN_CLAIM_AND_ISSUE: /^\/api\/dev\/sample-user\/admin-claim-and-issue$/,
  DEMO_USER_ADMIN_MINT_DEVICE_GRANT: /^\/api\/dev\/sample-user\/([^/]+)\/admin-mint-device-grant$/,
  // W11 — Worker-side provisioning kickoff. Replaces the laptop's
  // SSH+dd dance with a cloud-init `user_data` script the Worker
  // hands to Hetzner. Path must be matched BEFORE the bare
  // `/sample-user/{u}` GET below.
  DEMO_USER_ADMIN_SNAPSHOT_NOW: /^\/api\/dev\/sample-user\/([^/]+)\/admin-snapshot-now$/,
  // W13 — cloud-init-direct alternative to admin-snapshot-now. Uses
  // Hetzner's pre-built debian-12 image (no custom ISO, no trailer,
  // no rescue mode); cloud-init's user_data carries the install-blob
  // and the bootstrap that does the install work.
  DEMO_USER_ADMIN_CLOUD_INIT_NOW: /^\/api\/dev\/sample-user\/([^/]+)\/admin-cloud-init-now$/,
  DEMO_USER_INSTALL_COMPLETE: /^\/api\/dev\/sample-user\/([^/]+)\/install-complete$/,
  DEMO_USER_CONNECT: /^\/api\/dev\/sample-user\/([^/]+)\/connect$/,
  DEMO_USER_CANCEL: /^\/api\/dev\/sample-user\/([^/]+)\/cancel$/,
  DEMO_USER_HEARTBEAT: /^\/api\/dev\/sample-user\/([^/]+)\/heartbeat$/,
  DEMO_USER_GET: /^\/api\/dev\/sample-user\/([^/]+)$/,
  DEMO_USER_LIST: /^\/api\/dev\/sample-user$/,
  // Phase 1 of the gym recipe→Hetzner pipeline. GYM-ONLY: provisions a box
  // from an app-signed recipe + the app's TEST IRK priv. Gated on the gym env
  // in the dispatcher below — must never run on prod.
  GYM_PROVISION: /^\/api\/gym\/provision$/,
  // v2 device-addressing public endpoints (S3.3).
  DEVICE_GRANTS_LIST: /^\/api\/users\/([^/]+)\/device-grants$/,
  DEVICE_GRANTS_REVOKE: /^\/api\/users\/([^/]+)\/device-grants\/revoke$/,
  // Slice D §5 — admin master-root recovery rotation.
  ADMIN_ROOT_ROTATION_APPLY: /^\/api\/users\/([^/]+)\/admin-root-rotation$/,
  ADMIN_ROOT_ROTATIONS_LIST: /^\/api\/users\/([^/]+)\/admin-root-rotations$/,
  // Watch delegate keys (Phase 2c) — opt-in quick-approve from the Watch.
  WATCH_DELEGATES_LIST: /^\/api\/users\/([^/]+)\/watch-delegates$/,
  WATCH_DELEGATES_REVOKE: /^\/api\/users\/([^/]+)\/watch-delegates\/revoke$/,
  // Per-user-cert ACME account-key grants — distribute the (sealed) minting
  // authority to admin devices; revoke-by-accountKeyId rotates a retired key.
  ACME_ACCOUNT_KEYS_LIST: /^\/api\/users\/([^/]+)\/acme-account-keys$/,
  ACME_ACCOUNT_KEYS_REVOKE: /^\/api\/users\/([^/]+)\/acme-account-keys\/revoke$/,
  // Per-user-cert mint-reservation lease — the dead-lead-safe CAS lock that
  // serializes who re-mints the per-user cert this cycle.
  MINT_RESERVATION: /^\/api\/users\/([^/]+)\/mint-reservation$/,
  MINT_RESERVATION_RELEASE: /^\/api\/users\/([^/]+)\/mint-reservation\/release$/,
  // W12 debug — observability for the d-i+late-command pipeline. The
  // installer POSTs short progress markers via curl; the operator GETs
  // the concatenated log. Backed by ISO_TEMP_BUCKET (already provisioned
  // for W11). Unauthenticated for dev; remove before public launch.
  DEV_LATE_LOG: /^\/api\/dev\/late-log\/([^/]+)$/,
  // W12 debug — put a Hetzner server into rescue mode + return its
  // root password. The Worker has HCLOUD_TOKEN; the operator's laptop
  // intentionally does not (W11 design). Unauthenticated for dev.
  DEV_RESCUE: /^\/api\/dev\/rescue\/([0-9]+)$/,
  // W12 debug — destroy a Hetzner server by ID (cleanup after rescue
  // forensics or for orphaned VPSes the W11 cron lost track of).
  DEV_DESTROY: /^\/api\/dev\/destroy\/([0-9]+)$/,
  // W12 debug — GET /api/dev/server/<id> returns Hetzner's full server
  // record (IP, status, etc.) so the operator can SSH after rescue.
  DEV_SERVER_INFO: /^\/api\/dev\/server\/([0-9]+)$/,
  // W12 debug — PUT a binary blob into ISO_BUCKET via the same Worker
  // path that admin-snapshot-now uses for the trailer. Diagnoses the
  // "wrangler PUT → R2 → dev-url" sync gap.
  DEV_UPLOAD_ISO: /^\/api\/dev\/upload-iso\/([A-Za-z0-9._-]+)$/,
};

/**
 * Serve the `/api/boot/*` contract on the identity plane itself
 * (boot.flagshipserver.com collapsed onto flagship-com — see
 * docs/boot-worker-consolidation.md). The hostname + every path/shape is
 * byte-identical to the standalone `apps/boot` worker, so the box, the
 * burner, and the phone are wire-transparent; only the backing changes:
 *
 *   - storage → `flagship-state` (the `secret_mailbox` / `box_sealed_leases`
 *     / `boot_nonces` tables — the SAME D1 the rest of `.com` uses).
 *   - directory → resolved IN-PROCESS from that storage (no self-fetch).
 *   - notify → the owner push fires IN-PROCESS via the local forwarder (no
 *     cross-worker `/api/internal/notify-owner` call, no shared secret).
 *
 * The box's request is self-authenticating: the gate re-verifies its
 * Ed25519 STK signature against the directory-bound STK before the router
 * parks it, so dropping the shared secret removes no real security — it
 * only removes the fragile two-mailbox sync that silently 401'd in prod.
 *
 * Returns null for any non-boot path on this host (the caller 404s).
 */
export async function tryBootHost(
  request: Request,
  env: ControlPlaneEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/health") {
    return bootJson({ ok: true, service: "flagship-com", surface: "boot" }, 200);
  }
  if (!path.startsWith("/api/boot/")) {
    return bootJson({ error: "not found" }, 404);
  }
  if (!env.DB) {
    return bootJson({ error: "boot operations not configured (DB)" }, 503);
  }

  const storage = new D1Storage(env.DB);
  const forwarder = buildOptionalPushForwarder(env);
  const directory = new InProcessDirectoryClient({
    servers: storage.servers,
    usernames: storage.usernames,
    watchDelegates: storage.watchDelegates,
  });
  const notify = new InProcessNotifyPipe({
    servers: storage.servers,
    ...(forwarder
      ? { pushUserDevices: buildPushUserDevices(storage.pushTokens, forwarder) }
      : {}),
  });

  const deps: BootRouteDeps = {
    boxSealedLeases: storage.boxSealedLeases,
    secretMailbox: storage.secretMailbox,
    directory,
    notify,
    gate: { directory, nonces: new D1NonceStore(env.DB) },
  };

  const authHeader = request.headers.get(AUTH_HEADER);
  const body = await readJson(request);
  const result = await routeBoot(deps, request.method, path, authHeader, body);
  if (!result) return bootJson({ error: "not found" }, 404);
  return bootJson(result.body, result.status);
}

/** Boot responses are single-use + account-scoped — never cache (rule 5). */
function bootJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function tryControlPlane(
  request: Request,
  env: ControlPlaneEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (!env.DB) return null;
  const storage = new D1Storage(env.DB);
  const ca: CaIssuer = caKeypairFromEnv({
    FLAGSHIP_CA_PRIV_HEX: env.FLAGSHIP_CA_PRIV_HEX,
    FLAGSHIP_CA_ISSUER: env.FLAGSHIP_CA_ISSUER,
  });
  // #30 maintainer→CA gate. The trust chain is the REAL forward
  // verifier over the committed ca-track mandate chain + endorsement
  // bundle (see caTrustChainLoader). `enforce` is the single
  // documented switch — unset ⇒ OBSERVE ⇒ identical-to-today signing
  // plus a structured log line. Built once per request; the chain's
  // lease resolution re-runs at the handler's `now`.
  const caGate: CaGate = {
    caTrustChain: workerCaTrustChain(),
    enforce: caEnforceFromEnv({
      CA_ENDORSEMENT_ENFORCE: env.CA_ENDORSEMENT_ENFORCE,
    }),
  };

  let m: RegExpMatchArray | null;

  // Usage metering (feat/metering) — the relay reports per-account egress
  // deltas and reads quota status. Shared-secret authed (x-usage-secret),
  // internal infra, not a user signature.
  if (method === "POST" && ROUTE_RE.USAGE_REPORT.test(path)) {
    return finishPlain(
      await handleUsageReport(
        { usage: new D1UsageStorage(env.DB), tiers: storage.tiers },
        request.headers.get("x-usage-secret"),
        env.USAGE_REPORT_SECRET,
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && ROUTE_RE.USAGE_STATUS.test(path)) {
    return finishPlain(
      await handleUsageStatus(
        { usage: new D1UsageStorage(env.DB), tiers: storage.tiers },
        request.headers.get("x-usage-secret"),
        env.USAGE_REPORT_SECRET,
        url.searchParams.get("username"),
      ),
    );
  }

  if (method === "POST" && ROUTE_RE.USERNAME_CLAIM.test(path)) {
    return finish(
      await handleUsernameClaim(
        { storage: storage.usernames, offers: storage.usernameOffers },
        await readJson(request),
      ),
    );
  }
  // MUST precede USERNAME_LOOKUP (`/api/username/:u`) — "suggest" would otherwise
  // be read as a username lookup. Hands ONE random handle for sign-up, popped from
  // the pre-validated queue + escalating per-device throttle.
  if (method === "POST" && ROUTE_RE.USERNAME_SUGGEST.test(path)) {
    return finish(
      await handleSuggestUsername(
        {
          queue: storage.suggestionQueue,
          usernames: storage.usernames,
          throttle: storage.suggestThrottle,
          offers: storage.usernameOffers,
        },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && ROUTE_RE.USERS_CHECK.test(path)) {
    return finish(
      await handleUsersCheck(
        {
          storage: storage.usernames,
          testAccounts: parseTestAccountsEnv(env.TEST_ACCOUNTS),
          ca,
          caGate,
          // Plan A — when demo-user storage is wired, /users/check
          // embeds a `demoServer` block for matched usernames. The
          // storage call is cheap (PK lookup) so we don't gate it
          // behind HCLOUD_TOKEN presence.
          demoUsers: storage.demoUsers,
          // v2 device-addressing — wires the <u>.<device-label> dot-split
          // path in handleUsersCheck. Without this, the dot-form falls
          // through to the legacy validateUserLabel which rejects it.
          // See docs/v2-device-addressing-and-real-ticket.md §5.1.
          deviceCapabilityGrants: storage.deviceCapabilityGrants,
        },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && ROUTE_RE.USERNAME_RENAME.test(path)) {
    return finish(
      await handlePostUsernameRename(
        { usernames: storage.usernames, aliases: storage.usernameAliases },
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.USERNAME_ALIAS))) {
    return finish(
      await handleGetUsernameAlias(
        { usernames: storage.usernames, aliases: storage.usernameAliases },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.USERNAME_LOOKUP))) {
    if (m[1] === "claim" || m[1] === "rename") return null;
    return finish(await handleUsernameLookup(storage.usernames, decodeURIComponent(m[1]!)));
  }

  if (method === "POST" && ROUTE_RE.AUTH_CODE_ISSUE.test(path)) {
    return finish(
      await handleAuthCodeIssue(
        { storage: storage.authCodes, usernames: storage.usernames, apex: env.SERVICES_APEX },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.AUTH_CODE_REVOKE))) {
    return finish(
      await handleAuthCodeRevoke(
        { storage: storage.authCodes, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.AUTH_CODE_LOOKUP))) {
    if (m[1] === "issue") return null;
    return finish(
      await handleAuthCodeLookup(
        { storage: storage.authCodes, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
      ),
    );
  }

  // Build-ticket flow removed (QR-pipe is the only path). The phone
  // posts the signed blob directly to a per-session DO and the
  // desktop reads from it; .com no longer stores the blob at rest.

  if (method === "POST" && ROUTE_RE.SERVER_REGISTER.test(path)) {
    // Prefer the broker (production posture). Fall back to direct
    // CloudflareDnsClient only when no broker URL is configured —
    // typically the local-dev path.
    // The direct CloudflareDnsClient also speaks CAA (type:"CAA" with a
    // structured `data` field); the broker has no CAA RPC yet, so CAA is
    // published only on the direct path.
    const cfDnsClient =
      !env.DNS_BROKER_URL && env.CLOUDFLARE_DNS_API_TOKEN && env.CLOUDFLARE_SERVICES_ZONE_ID
        ? new CloudflareDnsClient({
            apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
            zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID,
          })
        : null;
    const dnsClient = env.DNS_BROKER_URL
      ? new BrokerDnsClient({ brokerUrl: env.DNS_BROKER_URL })
      : cfDnsClient;
    const dns =
      dnsClient && env.SERVICES_PASSTHROUGH_IPV4
        ? {
            client: dnsClient,
            servicesIpv4: env.SERVICES_PASSTHROUGH_IPV4,
            servicesIpv6: env.SERVICES_PASSTHROUGH_IPV6,
            ...(cfDnsClient ? { caa: { client: cfDnsClient } } : {}),
          }
        : undefined;
    const srForwarder = buildOptionalPushForwarder(env);
    return finish(
      await handleServerRegister(
        {
          authCodes: storage.authCodes,
          servers: storage.servers,
          routing: storage.routing,
          dns,
          // N0d-2: nudge the device family on a new registration.
          pushTokens: storage.pushTokens,
          installPolicyFanout: storage.installPolicyFanout,
          // Activity feed: record `server-created` on first registration.
          auditEvents: storage.auditEvents,
          ...(srForwarder ? { forwardToProviders: srForwarder } : {}),
          apex: env.SERVICES_APEX,
        },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && ROUTE_RE.SERVER_RELEASE.test(path)) {
    // Owner-signed "cancel the server / free the name". Releases the RCK
    // routing record + any active auth-codes + the server record so a
    // failed install's name can be re-claimed. Auth = the IRK signature
    // verified against the username's registered key.
    return finish(
      await handleServerReleaseName(
        {
          usernames: storage.usernames,
          routing: storage.routing,
          authCodes: storage.authCodes,
          servers: storage.servers,
          luksKeys: storage.luksKeys,
          grants: storage.deviceCapabilityGrants,
          apex: env.SERVICES_APEX,
        },
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.SERVER_LOOKUP))) {
    return finish(
      await handleServerLookup(
        { authCodes: storage.authCodes, servers: storage.servers },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.SERVER_REVOKE_BY_SELF))) {
    return finishPlain(
      await handleServerRevokeBySelf(
        { servers: storage.servers },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && ROUTE_RE.SERVER_REGISTRY_REVOKE.test(path)) {
    // P13 — IRK-signed user-initiated server revocation. Marks the
    // server record revoked, tears down every active boot-unlock
    // lease (the "brick on next boot" effect), and appends a
    // `server-revoked` audit row.
    // DNS cleanup on revoke: delete the box's per-box A/AAAA records so
    // the zone doesn't accumulate orphans (a leak that already exhausted
    // the 200-record cap + broke cert issuance). Prefer the direct
    // CloudflareDnsClient (it has deleteByName); the broker has no delete
    // RPC. Omitted when the token isn't configured (the handler skips
    // cleanup but still revokes).
    const revokeDns =
      env.CLOUDFLARE_DNS_API_TOKEN && env.CLOUDFLARE_SERVICES_ZONE_ID
        ? new CloudflareDnsClient({
            apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
            zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID,
          })
        : undefined;
    return finish(
      await handleRevokeServer(
        {
          usernames: storage.usernames,
          servers: storage.servers,
          auditEvents: storage.auditEvents,
          autoUnlockLeases: storage.autoUnlockLeases,
          boxSealedLeases: storage.boxSealedLeases,
          // Device-authorized revocation: a 2nd device holding a
          // `revoke-others`/`admin` DeviceCapabilityGrant may revoke a server
          // by passing `signerPubHex`. Same grant storage the device-grant
          // mint/list/revoke handlers use, so a revoked grant stops working
          // here immediately. Absent `signerPubHex` → owner-IRK path.
          grants: {
            storage: storage.deviceCapabilityGrants,
            usernames: storage.usernames,
          },
          ...(revokeDns ? { dns: revokeDns } : {}),
        },
        await readJson(request),
      ),
    );
  }

  // POST /api/account/self-delete — last-device account-death bundle-ingest.
  // Verifies the owner-IRK account-self-delete (+ enforces last-device: zero
  // active device grants), hard-deletes the username row (the name frees
  // immediately) and tears down every owned server. An optional bundled
  // servers-self-delete content-wipe order is accepted ONLY atomically with a
  // valid account-self-delete (§5 invariant) — a bad/absent companion or a
  // non-last-device caller rejects the WHOLE bundle.
  if (method === "POST" && ROUTE_RE.ACCOUNT_SELF_DELETE.test(path)) {
    const delDns =
      env.CLOUDFLARE_DNS_API_TOKEN && env.CLOUDFLARE_SERVICES_ZONE_ID
        ? new CloudflareDnsClient({
            apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
            zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID,
          })
        : undefined;
    return finish(
      await handleAccountDeletionBundle(
        {
          usernames: storage.usernames,
          servers: storage.servers,
          routing: storage.routing,
          authCodes: storage.authCodes,
          deviceCapabilityGrants: storage.deviceCapabilityGrants,
          auditEvents: storage.auditEvents,
          autoUnlockLeases: storage.autoUnlockLeases,
          boxSealedLeases: storage.boxSealedLeases,
          luksKeys: storage.luksKeys,
          webauthnRecovery: storage.webauthnRecovery,
          pushTokens: storage.pushTokens,
          // §5 box-side delivery: deposit the content-wipe order for each owned
          // server so an online box consumes it on its heartbeat and wipes.
          secretMailbox: storage.secretMailbox,
          ...(delDns ? { dns: delDns } : {}),
        },
        await readJson(request),
      ),
    );
  }
  // POST /api/admin/username/:u/reclaim[?dryRun=1] — admin-gated reclaim of a
  // ≥90-day-inactive name (same teardown as account-self-delete). Never bulk.
  if (method === "POST" && (m = path.match(ROUTE_RE.ADMIN_USERNAME_RECLAIM))) {
    const auth = authorizeAdmin({
      expected: env.FLAGSHIP_ADMIN_SECRET,
      provided: request.headers.get("x-admin-secret"),
    });
    if (auth) return finishPlain(auth);
    const reclaimDns =
      env.CLOUDFLARE_DNS_API_TOKEN && env.CLOUDFLARE_SERVICES_ZONE_ID
        ? new CloudflareDnsClient({
            apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
            zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID,
          })
        : undefined;
    const dryRun =
      url.searchParams.get("dryRun") === "1" ||
      url.searchParams.get("dryRun") === "true";
    return finish(
      await handleAdminUsernameReclaim(
        {
          usernames: storage.usernames,
          servers: storage.servers,
          routing: storage.routing,
          authCodes: storage.authCodes,
          deviceCapabilityGrants: storage.deviceCapabilityGrants,
          auditEvents: storage.auditEvents,
          autoUnlockLeases: storage.autoUnlockLeases,
          boxSealedLeases: storage.boxSealedLeases,
          luksKeys: storage.luksKeys,
          webauthnRecovery: storage.webauthnRecovery,
          pushTokens: storage.pushTokens,
          ...(reclaimDns ? { dns: reclaimDns } : {}),
        },
        decodeURIComponent(m[1]!),
        { dryRun },
      ),
    );
  }

  if (method === "GET" && (m = path.match(ROUTE_RE.PUBKEY_CERT))) {
    return finish(
      await handleUserPubKeyCert(
        { ca, usernames: storage.usernames, caGate },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  if (method === "GET" && ROUTE_RE.CA_CERT.test(path)) {
    return finish(handleCaCert({ ca, usernames: storage.usernames }));
  }
  // Clients fetch this and verify, against their OWN baked pin + clock,
  // that the served CA key is maintainer-authorized (the basis for the
  // app trust gate + the box relay blessing). Safe even if `.com` is the
  // suspected party — a rogue `.com` cannot forge a chain hashing to the
  // baked pin.
  if (method === "GET" && ROUTE_RE.MAINTAINER_BLESSING.test(path)) {
    return finish(
      handleMaintainerBlessing({
        ca,
        material: caTrustChainPublicMaterial(),
        caTrustChain: caGate.caTrustChain,
      }),
    );
  }
  // The `.services` hub asks `.com` to bless its self-generated key. `.com`
  // signs a short-lived (~26h) ServiceBlessing with the live hot CA key; a
  // box verifies it through the maintainer chain before relaying. An
  // operator evicts a rogue Fly by ceasing to bless it (lapses within a
  // day).
  if (method === "POST" && ROUTE_RE.HUB_BLESSING.test(path)) {
    return finish(handleHubBlessing({ ca }, await readJson(request)));
  }
  // Owner-signed, per-cert TrustException sync. `.com` is an untrusted
  // carrier: the envelope is device-key-signed + cert-hash-scoped, so it
  // can drop or replay but not forge it. The consuming box re-verifies
  // against its IRK-anchored device set.
  if (method === "POST" && (m = path.match(ROUTE_RE.TRUST_EXCEPTIONS))) {
    return finish(
      await handleStoreTrustException(
        { storage: storage.trustExceptions },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.TRUST_EXCEPTIONS))) {
    return finish(
      await handleListTrustExceptions(
        { storage: storage.trustExceptions },
        decodeURIComponent(m[1]!),
      ),
    );
  }

  // Service-access capability invites (docs/service-access-gating.md). create +
  // revoke are author-IRK-signed + gated on the registered IRK; redeem is
  // friend-AID-signed + account-agnostic. `.com` stores ciphertext + the
  // secretHash only; the box does the authoritative allow-list write at redeem.
  if (method === "POST" && ROUTE_RE.SERVICE_INVITE_REDEEM.test(path)) {
    return finish(
      await handleRedeemServiceInvite(
        { invites: storage.serviceInvites, usernames: storage.usernames },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.SERVICE_INVITE_REVOKE))) {
    return finish(
      await handleRevokeServiceInvite(
        {
          invites: storage.serviceInvites,
          usernames: storage.usernames,
          grants: storage.deviceCapabilityGrants,
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.SERVICE_INVITES))) {
    return finish(
      await handleCreateServiceInvite(
        {
          invites: storage.serviceInvites,
          usernames: storage.usernames,
          grants: storage.deviceCapabilityGrants,
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  // revoked-since (GET) — the box revocation poller; owner-signed. Checked
  // BEFORE the base list path (it's a longer sub-path of the same prefix).
  if (method === "GET" && (m = path.match(ROUTE_RE.SERVICE_INVITE_REVOKED_SINCE))) {
    return finish(
      await handleRevokedSinceServiceInvites(
        { invites: storage.serviceInvites, usernames: storage.usernames, servers: storage.servers },
        decodeURIComponent(m[1]!),
        {
          authorAID: url.searchParams.get("authorAID"),
          scope: url.searchParams.get("scope"),
          cursor: url.searchParams.get("cursor"),
          issuedAt: url.searchParams.get("issuedAt"),
          sig: url.searchParams.get("sig"),
          serverDomain: url.searchParams.get("serverDomain"),
        },
      ),
    );
  }
  // create fetch (GET) — the author's box re-fetches the OWNER's signed create by
  // inviteId to verify it at manual-finalize (box-as-authority, any-device). Box
  // STK-signed; checked BEFORE the base list path (a longer sub-path of the same
  // prefix). The `[^/]+` inviteId segment can't collide with `revoke` /
  // `revoked-since` (those are exact sub-paths already matched above).
  if (method === "GET" && (m = path.match(ROUTE_RE.SERVICE_INVITE_CREATE_FETCH))) {
    return finish(
      await handleFetchServiceInviteCreate(
        { invites: storage.serviceInvites, usernames: storage.usernames, servers: storage.servers },
        decodeURIComponent(m[1]!),
        decodeURIComponent(m[2]!),
        {
          serverDomain: url.searchParams.get("serverDomain"),
          issuedAt: url.searchParams.get("issuedAt"),
          sig: url.searchParams.get("sig"),
        },
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.SERVICE_INVITES))) {
    return finish(
      await handleListServiceInvites(
        { invites: storage.serviceInvites, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
        {
          authorAID: url.searchParams.get("authorAID"),
          scope: url.searchParams.get("scope"),
          cursor: url.searchParams.get("cursor"),
          issuedAt: url.searchParams.get("issuedAt"),
          sig: url.searchParams.get("sig"),
        },
      ),
    );
  }

  if (method === "POST" && ROUTE_RE.RCK_REGISTER.test(path)) {
    return finish(
      await handleRegisterRck(
        {
          routing: storage.routing,
          usernames: storage.usernames,
          grants: storage.deviceCapabilityGrants,
          apex: env.SERVICES_APEX,
        },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && ROUTE_RE.RCK_SET_TARGET.test(path)) {
    return finish(
      await handleSetRoutingTarget(
        { routing: storage.routing, usernames: storage.usernames },
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && ROUTE_RE.ROUTING_LOOKUP.test(path)) {
    const host = url.searchParams.get("host");
    if (!host) return jsonResponse({ error: "host query param required" }, 400);
    return finish(
      await handleRoutingLookup(
        { routing: storage.routing, usernames: storage.usernames },
        host,
      ),
    );
  }

  if (method === "POST" && (ROUTE_RE.DNS01_PUBLISH.test(path) || ROUTE_RE.DNS01_DELETE.test(path))) {
    // Broker-first: the main Worker no longer holds the CF DNS API
    // token in production. The daemon-signed envelope arrives here,
    // gets translated into a typed broker RPC, and the broker
    // independently re-verifies before talking to Cloudflare.
    if (env.DNS_BROKER_URL) {
      const body = await readJson(request);
      const res = ROUTE_RE.DNS01_PUBLISH.test(path)
        ? await proxyDns01PublishToBroker({ brokerUrl: env.DNS_BROKER_URL, body })
        : await proxyDns01DeleteToBroker({ brokerUrl: env.DNS_BROKER_URL, body });
      return finishPlain(res);
    }
    // Legacy dev/test fallback — direct CF API token. Production must
    // configure `DNS_BROKER_URL` and drop this secret.
    if (
      !env.CLOUDFLARE_DNS_API_TOKEN ||
      !env.CLOUDFLARE_SERVICES_ZONE_ID
    ) {
      return jsonResponse({ error: "DNS-01 not configured on this control plane" }, 503);
    }
    const dns = new CloudflareDnsClient({
      apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
      zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID,
    });
    const handler = ROUTE_RE.DNS01_PUBLISH.test(path) ? handleDns01Publish : handleDns01Delete;
    const res = await handler(
      // `usernames` is required for the tier-2 service-cert DNS-01 path
      // (resolving the user IRK to verify a phone-issued ServiceCertAuthority).
      // Without it, a `<svc>.<user>` challenge 403s "service-cert authority not
      // supported here". The gym uses this legacy direct-CF path (no broker).
      { servers: storage.servers, usernames: storage.usernames, dns, apex: env.SERVICES_APEX },
      await readJson(request),
    );
    return finishPlain(res);
  }

  if (method === "POST" && (m = path.match(ROUTE_RE.LUKS_SEALED))) {
    return finishPlain(
      await handlePutSealedLuksKey(
        {
          servers: storage.servers,
          usernames: storage.usernames,
          luksKeys: storage.luksKeys,
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.LUKS_SEALED))) {
    return finishPlain(
      await handleGetSealedLuksKey(
        {
          servers: storage.servers,
          usernames: storage.usernames,
          luksKeys: storage.luksKeys,
        },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.LUKS_UNLOCK_CONSUME))) {
    const host = decodeURIComponent(m[1]!);
    return finishPlain(
      await handleConsumeUnlockKey(
        {
          servers: storage.servers,
          usernames: storage.usernames,
          luksKeys: storage.luksKeys,
          autoUnlockLeases: storage.autoUnlockLeases,
        },
        host,
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.LUKS_LEASE_DEPOSIT))) {
    const host = decodeURIComponent(m[1]!);
    return finishPlain(
      await handleDepositAutoUnlockLease(
        {
          servers: storage.servers,
          usernames: storage.usernames,
          luksKeys: storage.luksKeys,
          autoUnlockLeases: storage.autoUnlockLeases,
          grants: storage.deviceCapabilityGrants,
        },
        host,
        await readJson(request),
      ),
    );
  }
  if (method === "DELETE" && (m = path.match(ROUTE_RE.LUKS_LEASE_REVOKE))) {
    const host = decodeURIComponent(m[1]!);
    const leaseId = decodeURIComponent(m[2]!);
    return finishPlain(
      await handleRevokeAutoUnlockLease(
        {
          servers: storage.servers,
          usernames: storage.usernames,
          luksKeys: storage.luksKeys,
          autoUnlockLeases: storage.autoUnlockLeases,
          grants: storage.deviceCapabilityGrants,
        },
        host,
        leaseId,
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.LUKS_LEASE_LIST))) {
    const host = decodeURIComponent(m[1]!);
    return finishPlain(
      await handleListAutoUnlockLeases(
        {
          servers: storage.servers,
          usernames: storage.usernames,
          luksKeys: storage.luksKeys,
          autoUnlockLeases: storage.autoUnlockLeases,
        },
        host,
      ),
    );
  }
  // ── Phone-as-unlock-endpoint RELAY (sealed mailbox + box-sealed lease) ──
  {
    const buildSecretMailboxDeps = () => {
      const forwarder = buildOptionalPushForwarder(env);
      return {
        servers: storage.servers,
        usernames: storage.usernames,
        secretMailbox: storage.secretMailbox,
        boxSealedLeases: storage.boxSealedLeases,
        grants: storage.deviceCapabilityGrants,
        ...(forwarder
          ? { pushUserDevices: buildPushUserDevices(storage.pushTokens, forwarder) }
          : {}),
      };
    };
    if (method === "POST" && (m = path.match(ROUTE_RE.SECRET_REQUEST_POST))) {
      return finishPlain(
        await handlePostSecretRequest(
          buildSecretMailboxDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.SECRET_RESPONSE_GET))) {
      return finishPlain(
        await handleGetSecretResponse(
          buildSecretMailboxDeps(),
          decodeURIComponent(m[1]!),
          url.searchParams.get("nonce"),
        ),
      );
    }
    if (method === "GET" && ROUTE_RE.SECRET_REQUESTS_LIST.test(path)) {
      return finishPlain(
        await handleGetSecretRequests(buildSecretMailboxDeps(), await readJson(request)),
      );
    }
    if (method === "POST" && ROUTE_RE.SECRET_REQUESTS_LIST.test(path)) {
      // Phone mailbox-auth is IRK-signed in the body, so the listing is
      // exposed as POST as well as GET (a GET with a body is awkward for
      // some HTTP clients). Both share the handler.
      return finishPlain(
        await handleGetSecretRequests(buildSecretMailboxDeps(), await readJson(request)),
      );
    }
    if (method === "POST" && ROUTE_RE.SECRET_RESPONSE_POST.test(path)) {
      return finishPlain(
        await handlePostSecretResponse(buildSecretMailboxDeps(), await readJson(request)),
      );
    }
    // Box-sealed lease (v2). List must precede the bare lease-v2 GET; the
    // distinct `/leases-v2` literal makes the order-independence explicit.
    if (method === "GET" && (m = path.match(ROUTE_RE.LEASE_V2_LIST))) {
      return finishPlain(
        await handleListBoxSealedLeases(buildSecretMailboxDeps(), decodeURIComponent(m[1]!)),
      );
    }
    if (method === "POST" && (m = path.match(ROUTE_RE.LEASE_V2_DEPOSIT))) {
      return finishPlain(
        await handlePostBoxSealedLease(
          buildSecretMailboxDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.LEASE_V2_DEPOSIT))) {
      return finishPlain(
        await handleReleaseBoxSealedLease(buildSecretMailboxDeps(), decodeURIComponent(m[1]!)),
      );
    }
    if (method === "DELETE" && (m = path.match(ROUTE_RE.LEASE_V2_REVOKE))) {
      return finishPlain(
        await handleRevokeBoxSealedLease(
          buildSecretMailboxDeps(),
          decodeURIComponent(m[1]!),
          decodeURIComponent(m[2]!),
          await readJson(request),
        ),
      );
    }
    // Peer-backup matchmaker + manifest lane (server-migration Layer 0).
    if (method === "POST" && path.match(ROUTE_RE.PB_REQUEST_PEERS)) {
      return finishPlain(
        await handlePbRequestPeers(
          { servers: storage.servers, daemonStatus: storage.daemonStatus },
          await readJson(request),
        ),
      );
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.PB_STK_LOOKUP))) {
      return finishPlain(
        await handlePeerStkLookup({ servers: storage.servers }, decodeURIComponent(m[1]!)),
      );
    }
    if (method === "PUT" && (m = path.match(ROUTE_RE.BACKUP_MANIFEST))) {
      return finishPlain(
        await handlePutBackupManifest(
          { servers: storage.servers, peerBackupManifests: storage.peerBackupManifests },
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.BACKUP_MANIFEST))) {
      return finishPlain(
        await handleGetBackupManifest(
          { peerBackupManifests: storage.peerBackupManifests },
          decodeURIComponent(m[1]!),
        ),
      );
    }
    // Deposit-on-unlock pairing — phone deposit (IRK mailbox-auth) +
    // box consume-once read (public, sealed-for-STK).
    if (method === "POST" && (m = path.match(ROUTE_RE.PAIRING_DEPOSIT))) {
      return finishPlain(
        await handlePostPairingDeposit(
          buildSecretMailboxDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.PAIRING_DEPOSIT))) {
      return finishPlain(
        await handleConsumePairingDeposit(buildSecretMailboxDeps(), decodeURIComponent(m[1]!)),
      );
    }
    // Entitlement deposit-on-unlock — phone deposit (IRK mailbox-auth, the
    // PUBLIC IRK-signed entitlement) + box consume-once read.
    if (method === "POST" && (m = path.match(ROUTE_RE.ENTITLEMENT_DEPOSIT))) {
      return finishPlain(
        await handlePostEntitlementDeposit(
          buildSecretMailboxDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.ENTITLEMENT_DEPOSIT))) {
      return finishPlain(
        await handleConsumeEntitlementDeposit(buildSecretMailboxDeps(), decodeURIComponent(m[1]!)),
      );
    }
    // Secret-free-recipe SWK delivery — phone deposit (IRK mailbox-auth, the
    // SEALED SWK-delivery carrier) + box consume-once read (sealed-only, public).
    if (method === "POST" && (m = path.match(ROUTE_RE.SWK_DEPOSIT))) {
      return finishPlain(
        await handlePostSwkDeposit(
          buildSecretMailboxDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.SWK_DEPOSIT))) {
      return finishPlain(
        await handleConsumeSwkDeposit(buildSecretMailboxDeps(), decodeURIComponent(m[1]!)),
      );
    }
    // Post-boot CGK delivery (Phase 6) — phone deposit (IRK mailbox-auth, the
    // SEALED CGK-delivery carrier) + box consume-once read (sealed-only, public).
    if (method === "POST" && (m = path.match(ROUTE_RE.CGK_DEPOSIT))) {
      return finishPlain(
        await handlePostCgkDeposit(
          buildSecretMailboxDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.CGK_DEPOSIT))) {
      return finishPlain(
        await handleConsumeCgkDeposit(buildSecretMailboxDeps(), decodeURIComponent(m[1]!)),
      );
    }
    // Owner preferred-server vote (Phase 6) — phone deposit (IRK mailbox-auth, the
    // owner-IRK set-leader vote, signature-verified before storing) + box
    // consume-once read (the box re-verifies under the owner IRK).
    if (method === "POST" && (m = path.match(ROUTE_RE.SET_LEADER_DEPOSIT))) {
      return finishPlain(
        await handlePostSetLeaderDeposit(
          buildSecretMailboxDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.SET_LEADER_DEPOSIT))) {
      return finishPlain(
        await handleConsumeSetLeaderDeposit(buildSecretMailboxDeps(), decodeURIComponent(m[1]!)),
      );
    }
    // Admin-authorized in-place server-update order — phone deposit (IRK mailbox-
    // auth + the Slice-D admin-authority gate, the sensitive-op check) + box
    // consume-once read (the box re-verifies the order under its pinned admin root).
    if (method === "POST" && (m = path.match(ROUTE_RE.UPDATE_DEPOSIT))) {
      return finishPlain(
        await handlePostUpdateDeposit(
          buildSecretMailboxDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.UPDATE_DEPOSIT))) {
      return finishPlain(
        await handleConsumeUpdateDeposit(buildSecretMailboxDeps(), decodeURIComponent(m[1]!)),
      );
    }
    // Account-death content-wipe — box consume-once read of the owner-IRK-signed
    // servers-self-delete order .com deposited at the last-device deletion (the
    // consume is revoke-tolerant; the box re-verifies the order under the owner IRK).
    if (method === "GET" && (m = path.match(ROUTE_RE.SELF_DELETE_DEPOSIT))) {
      return finishPlain(
        await handleConsumeSelfDeleteDeposit(buildSecretMailboxDeps(), decodeURIComponent(m[1]!)),
      );
    }
    // Graceful server-replacement decommission (docs/server-replacement-graceful-
    // decommission.md). The deposit is owner mailbox-authed; the box-fetch +
    // chain-fetch + epoch/ack reports are public (the order is owner-IRK-signed
    // and re-verified box-side). The sub-path matchers run BEFORE the bare
    // `decommission` matcher so a method-discriminated bare path can't swallow them.
    const buildDecommissionDeps = () => ({
      servers: storage.servers,
      usernames: storage.usernames,
      serverEvictions: storage.serverEvictions,
      mailbox: buildSecretMailboxDeps(),
      grants: storage.deviceCapabilityGrants,
    });
    if (method === "POST" && (m = path.match(ROUTE_RE.DECOMMISSION_EPOCH_COMPLETE))) {
      return finishPlain(
        await handlePostEpochComplete(
          buildDecommissionDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "POST" && (m = path.match(ROUTE_RE.DECOMMISSION_ACK_OLD))) {
      return finishPlain(
        await handlePostAckOld(
          buildDecommissionDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "POST" && (m = path.match(ROUTE_RE.DECOMMISSION_ACK_NEW))) {
      return finishPlain(
        await handlePostAckNew(buildDecommissionDeps(), decodeURIComponent(m[1]!)),
      );
    }
    if (method === "POST" && (m = path.match(ROUTE_RE.DECOMMISSION))) {
      return finishPlain(
        await handlePostDecommission(
          buildDecommissionDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.DECOMMISSION))) {
      return finishPlain(
        await handleGetDecommission(
          buildDecommissionDeps(),
          decodeURIComponent(m[1]!),
          url.searchParams.get("stk"),
        ),
      );
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.EVICTION_CHAIN))) {
      return finishPlain(
        await handleGetEvictionChain(buildDecommissionDeps(), decodeURIComponent(m[1]!)),
      );
    }
    // Server-migration orchestration (docs/server-migration.md). Initiate /
    // confirm-ready / abort are admin-signed + owner mailbox-authed (SENSITIVE);
    // attach / pre-seeded / take-over are the new box's STK-signed phase acks;
    // freeze delegates into the eviction lane after session validation. The
    // GETs are public — everything served is admin-signed or phase state, and
    // both boxes re-verify the order under their pinned authority.
    const buildMigrationDeps = () => ({
      servers: storage.servers,
      usernames: storage.usernames,
      serverMigrations: storage.serverMigrations,
      serverEvictions: storage.serverEvictions,
      mailbox: buildSecretMailboxDeps(),
      grants: storage.deviceCapabilityGrants,
    });
    if (method === "POST" && (m = path.match(ROUTE_RE.MIGRATION_ATTACH))) {
      return finishPlain(
        await handlePostMigrationAttach(
          buildMigrationDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "POST" && (m = path.match(ROUTE_RE.MIGRATION_PRE_SEEDED))) {
      return finishPlain(
        await handlePostMigrationPreSeeded(
          buildMigrationDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "POST" && (m = path.match(ROUTE_RE.MIGRATION_CONFIRM_READY))) {
      return finishPlain(
        await handlePostMigrationConfirmReady(
          buildMigrationDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "POST" && (m = path.match(ROUTE_RE.MIGRATION_FREEZE))) {
      return finishPlain(
        await handlePostMigrationFreeze(
          { ...buildMigrationDeps(), decommission: buildDecommissionDeps() },
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "POST" && (m = path.match(ROUTE_RE.MIGRATION_TAKE_OVER))) {
      return finishPlain(
        await handlePostMigrationTakeOver(
          buildMigrationDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "POST" && (m = path.match(ROUTE_RE.MIGRATION_ABORT))) {
      return finishPlain(
        await handlePostMigrationAbort(
          buildMigrationDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "POST" && (m = path.match(ROUTE_RE.MIGRATION))) {
      return finishPlain(
        await handlePostMigrationStart(
          buildMigrationDeps(),
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.MIGRATION))) {
      return finishPlain(
        await handleGetMigration(buildMigrationDeps(), decodeURIComponent(m[1]!)),
      );
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.MIGRATION_ASSIGNMENT))) {
      return finishPlain(
        await handleGetMigrationAssignment(buildMigrationDeps(), decodeURIComponent(m[1]!)),
      );
    }
    // Box-side re-home read (Layer A) — the box polls its OLD canonical to
    // learn its new owner/namespace after a completed transfer. PUBLIC read; no
    // DNS deps needed (it only reads the transfer row + re-derives the FQDN).
    if (method === "GET" && (m = path.match(ROUTE_RE.TRANSFER_REHOME))) {
      return finishPlain(
        await handleGetTransferRehome(
          {
            servers: storage.servers,
            usernames: storage.usernames,
            routing: storage.routing,
            serverTransfers: storage.serverTransfers,
            apex: env.SERVICES_APEX,
          },
          decodeURIComponent(m[1]!),
        ),
      );
    }
    // Layer B disk-key handoff — the giver deposits the disk key re-sealed to
    // the acquirer IRK; the acquirer reads it. Both IRK mailbox-auth in the body;
    // no DNS deps needed (content-blind blob store on the transfer row).
    if (
      method === "POST" &&
      (m = path.match(ROUTE_RE.TRANSFER_DISK_KEY) || path.match(ROUTE_RE.TRANSFER_DISK_KEY_CLAIM))
    ) {
      const isClaim = ROUTE_RE.TRANSFER_DISK_KEY_CLAIM.test(path);
      const xferDeps = {
        servers: storage.servers,
        usernames: storage.usernames,
        routing: storage.routing,
        serverTransfers: storage.serverTransfers,
        apex: env.SERVICES_APEX,
      };
      const domain = decodeURIComponent(m[1]!);
      return finishPlain(
        isClaim
          ? await handleGetTransferDiskKey(xferDeps, domain, await readJson(request))
          : await handlePostTransferDiskKey(xferDeps, domain, await readJson(request)),
      );
    }
    // Slice D §9.8 — the giver deposits the admin-root handoff proof. No
    // mailbox-auth: the giver-admin-root signature IS the authorization (the
    // handler verifies it against the giver account's registered admin root as
    // a garbage filter; the box re-verifies against its PINNED root).
    if (method === "POST" && (m = path.match(ROUTE_RE.TRANSFER_ADMIN_HANDOFF))) {
      return finishPlain(
        await handlePostTransferAdminHandoff(
          {
            servers: storage.servers,
            usernames: storage.usernames,
            routing: storage.routing,
            serverTransfers: storage.serverTransfers,
            apex: env.SERVICES_APEX,
          },
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    // v1-sec GAP 3 — the giver deposits the LEGACY owner-IRK re-home
    // authorization. No mailbox-auth: the giver-owner-IRK signature IS the
    // authorization (the handler verifies it against the giver account's
    // registered owner IRK as a garbage filter; the box re-verifies against its
    // PINNED owner IRK). No DNS deps — a content-blind proof store on the row.
    if (method === "POST" && (m = path.match(ROUTE_RE.TRANSFER_REHOME_AUTH))) {
      return finishPlain(
        await handlePostTransferRehomeAuth(
          {
            servers: storage.servers,
            usernames: storage.usernames,
            routing: storage.routing,
            serverTransfers: storage.serverTransfers,
            apex: env.SERVICES_APEX,
          },
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    // Transfer-a-box broker — the cross-account ownership handoff. The claim
    // handler does the .com-side NAMESPACE MIGRATION (servers + routing + DNS).
    // DNS uses the same per-box upsert posture as registration (direct
    // CloudflareDnsClient when no broker is configured).
    if (
      method &&
      (path.match(ROUTE_RE.TRANSFER_OFFER) ||
        path.match(ROUTE_RE.TRANSFER_CLAIM) ||
        path.match(ROUTE_RE.TRANSFER_CLAIM_POLL))
    ) {
      const xferM =
        path.match(ROUTE_RE.TRANSFER_OFFER) ??
        path.match(ROUTE_RE.TRANSFER_CLAIM) ??
        path.match(ROUTE_RE.TRANSFER_CLAIM_POLL);
      const isOffer = ROUTE_RE.TRANSFER_OFFER.test(path);
      const isPoll = ROUTE_RE.TRANSFER_CLAIM_POLL.test(path);
      const xferCfDns =
        !env.DNS_BROKER_URL && env.CLOUDFLARE_DNS_API_TOKEN && env.CLOUDFLARE_SERVICES_ZONE_ID
          ? new CloudflareDnsClient({
              apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
              zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID,
            })
          : null;
      const xferDnsClient = env.DNS_BROKER_URL
        ? new BrokerDnsClient({ brokerUrl: env.DNS_BROKER_URL })
        : xferCfDns;
      const buildTransferDeps = () => ({
        servers: storage.servers,
        usernames: storage.usernames,
        routing: storage.routing,
        serverTransfers: storage.serverTransfers,
        auditEvents: storage.auditEvents,
        grants: storage.deviceCapabilityGrants,
        ...(xferDnsClient && env.SERVICES_PASSTHROUGH_IPV4
          ? {
              dns: {
                client: xferDnsClient,
                servicesIpv4: env.SERVICES_PASSTHROUGH_IPV4,
                servicesIpv6: env.SERVICES_PASSTHROUGH_IPV6,
              },
            }
          : {}),
        apex: env.SERVICES_APEX,
      });
      const domain = decodeURIComponent(xferM![1]!);
      if (method === "POST" && isOffer) {
        return finishPlain(
          await handlePostTransferOffer(buildTransferDeps(), domain, await readJson(request)),
        );
      }
      if (method === "POST" && isPoll) {
        // Giver re-seal discovery — IRK mailbox-auth in the body.
        return finishPlain(
          await handleGetTransferClaim(buildTransferDeps(), domain, await readJson(request)),
        );
      }
      if (method === "POST") {
        // The acquirer claim (TRANSFER_CLAIM).
        return finishPlain(
          await handlePostTransferClaim(buildTransferDeps(), domain, await readJson(request)),
        );
      }
    }
    // #28 Option B — seal-to-box ACME account-key delivery (deposit / release
    // / revoke). Same deposit-and-release shape as the box-sealed lease above;
    // the deposit ALSO records the grant (for audit + requireMinter) so the
    // rotation sweep + the mint-coordination path already cover the box's copy.
    {
      const buildAcmeDeliveryDeps = () => ({
        servers: storage.servers,
        usernames: storage.usernames,
        delivery: storage.acmeAccountKeyDelivery,
        acmeAccountKeyGrants: storage.acmeAccountKeyGrants,
      });
      if (method === "POST" && (m = path.match(ROUTE_RE.ACME_ACCOUNT_KEY_DELIVERY))) {
        return finishPlain(
          await handleDepositAcmeAccountKey(
            buildAcmeDeliveryDeps(),
            decodeURIComponent(m[1]!),
            await readJson(request),
          ),
        );
      }
      if (method === "GET" && (m = path.match(ROUTE_RE.ACME_ACCOUNT_KEY_DELIVERY))) {
        return finishPlain(
          await handleReleaseAcmeAccountKey(
            buildAcmeDeliveryDeps(),
            decodeURIComponent(m[1]!),
          ),
        );
      }
      if (method === "DELETE" && (m = path.match(ROUTE_RE.ACME_ACCOUNT_KEY_DELIVERY))) {
        return finishPlain(
          await handleRevokeAcmeAccountKeyDelivery(
            buildAcmeDeliveryDeps(),
            decodeURIComponent(m[1]!),
            await readJson(request),
          ),
        );
      }
    }
    // Identity-plane half of the boot worker's NOTIFY PIPE. The boot
    // worker (apps/boot) calls this server-to-server with a shared
    // secret; we re-verify the box's SecretRequest against THIS
    // directory and fan out the push (the boot worker holds no push
    // secrets, so it cannot do this itself).
    if (method === "POST" && ROUTE_RE.INTERNAL_NOTIFY_OWNER.test(path)) {
      const forwarder = buildOptionalPushForwarder(env);
      return finishPlain(
        await handleNotifyOwner(
          {
            servers: storage.servers,
            usernames: storage.usernames,
            secretMailbox: storage.secretMailbox,
            ...(env.BOOT_NOTIFY_SECRET ? { notifySharedSecret: env.BOOT_NOTIFY_SECRET } : {}),
            ...(forwarder
              ? { pushUserDevices: buildPushUserDevices(storage.pushTokens, forwarder) }
              : {}),
          },
          request.headers.get("x-boot-notify-secret"),
          await readJson(request),
        ),
      );
    }
  }

  // ---- Webapp cloud-shard recovery (WebAuthn PRF) ----
  if (method === "POST" && ROUTE_RE.RECOVERY_UPLOAD.test(path)) {
    return finishPlain(
      await handleUploadWebauthnRecovery(
        {
          usernames: storage.usernames,
          webauthnRecovery: storage.webauthnRecovery,
        },
        await readJson(request),
      ),
    );
  }
  // Task #74 — Argon2id-gated fetch. The more-specific `/fetch` path
  // must precede the `/by-username/<u>` regex below or it would never
  // match (the catch-all regex would short-circuit first).
  if (method === "POST" && (m = path.match(ROUTE_RE.RECOVERY_FETCH_GATED))) {
    return finishPlain(
      await handleFetchWrappedUmkWithToken(
        {
          usernames: storage.usernames,
          webauthnRecovery: storage.webauthnRecovery,
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.RECOVERY_BY_USERNAME))) {
    return finishPlain(
      await handleFetchWebauthnRecovery(
        {
          usernames: storage.usernames,
          webauthnRecovery: storage.webauthnRecovery,
        },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  if (method === "DELETE" && (m = path.match(ROUTE_RE.RECOVERY_BY_USERNAME))) {
    return finishPlain(
      await handleDeleteWebauthnRecovery(
        {
          usernames: storage.usernames,
          webauthnRecovery: storage.webauthnRecovery,
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }

  // ---- Encrypted user-identity mandate store (#71) ----
  if (method === "POST" && ROUTE_RE.USER_IDENTITY_PUT.test(path)) {
    return finishPlain(
      await handlePutUserIdentity(
        { storage: storage.userIdentity },
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.USER_IDENTITY_GET))) {
    return finishPlain(
      await handleGetUserIdentity(
        { storage: storage.userIdentity },
        decodeURIComponent(m[1]!),
      ),
    );
  }

  // ---- Recovery re-pair (J.3) ----
  // Order matters: /re-pair/object + /re-pair/complete must be matched
  // before /re-pair (the latter regex matches their paths' prefix).
  if (method === "POST" && (m = path.match(ROUTE_RE.RE_PAIR_OBJECT))) {
    return finishPlain(
      await handleObjectRePair(
        { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.RE_PAIR_COMPLETE))) {
    // /complete is body-OPTIONAL: legacy clients POST with no body and
    // still get a 200; W6 clients POST `{ refreshedGrants }` so the
    // graceful path can re-sign the cloud's grants in one round-trip.
    // `readJson` returns null/undefined on an empty body — the handler
    // tolerates both shapes.
    let parsedBody: unknown = undefined;
    try {
      parsedBody = await readJson(request);
    } catch {
      parsedBody = undefined;
    }
    return finishPlain(
      await handleCompleteRePair(
        {
          usernames: storage.usernames,
          pendingRePairs: storage.pendingRePairs,
          // v1.2 Phase 2 — wired so completion stamps the 14-day
          // quarantine on every push_token row for the user.
          pushTokens: storage.pushTokens,
          // v1.2 Phase 5 — emits `device-replaced` + `device-added`
          // rows on a successful swap so the Activity feed shows the
          // takeover under the right account-type snapshot.
          auditEvents: storage.auditEvents,
          // v2.1 (W6) — honor the cloud's recovery_wipe_policy:
          // 'strict' revokes every grant; 'graceful' (default)
          // accepts the recovering device's re-signed grants in the
          // /complete body.
          deviceCapabilityGrants: storage.deviceCapabilityGrants,
        },
        decodeURIComponent(m[1]!),
        (parsedBody ?? undefined) as
          | import("@flagship/control-plane").CompleteRePairBody
          | undefined,
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.USER_PODS))) {
    return finish(
      await handleGetUserPods(
        {
          daemonStatus: storage.daemonStatus,
          servers: storage.servers,
          routing: storage.routing,
          authCodes: storage.authCodes,
          provisionStatus: storage.provisionStatus,
          secretMailbox: storage.secretMailbox,
        },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.USER_STREAM))) {
    return finish(
      await handleUserStream(
        {
          daemonStatus: storage.daemonStatus,
          servers: storage.servers,
          routing: storage.routing,
          authCodes: storage.authCodes,
          provisionStatus: storage.provisionStatus,
          secretMailbox: storage.secretMailbox,
        },
        decodeURIComponent(m[1]!),
        url.searchParams.get("cursor"),
      ),
    );
  }
  if (
    method === "POST" &&
    (m = path.match(ROUTE_RE.USER_OUTSTANDING_ORDERS))
  ) {
    return finish(
      await handleListOutstandingOrders(
        {
          authCodes: storage.authCodes,
          usernames: storage.usernames,
          provisionStatus: storage.provisionStatus,
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.USER_DEVICES))) {
    return finish(
      await handleGetUsersDevices(
        { pushTokens: storage.pushTokens },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  // Login/join preflight — 200 always; a missing account is
  // kind:"unknown", never a 404. Drives the username-first login
  // state machine. See docs/login-and-account-redesign.md.
  if (method === "GET" && (m = path.match(ROUTE_RE.ACCOUNT_RESOLVE))) {
    return finish(
      await handleAccountResolve(
        {
          usernames: storage.usernames,
          webauthnRecovery: storage.webauthnRecovery,
          demoUsers: storage.demoUsers,
          pushTokens: storage.pushTokens,
        },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  // v2 device-addressing public endpoints (S3.3). The revoke route's
  // `/revoke` suffix must hit BEFORE the bare DEVICE_GRANTS_LIST match
  // for the same path prefix.
  if (method === "POST" && (m = path.match(ROUTE_RE.DEVICE_GRANTS_REVOKE))) {
    return finish(
      await handleRevokeDeviceGrant(
        {
          storage: storage.deviceCapabilityGrants,
          usernames: storage.usernames,
        },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.DEVICE_GRANTS_LIST))) {
    return finish(
      await handleMintDeviceGrant(
        {
          storage: storage.deviceCapabilityGrants,
          usernames: storage.usernames,
        },
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.DEVICE_GRANTS_LIST))) {
    return finish(
      await handleListDeviceGrants(
        {
          storage: storage.deviceCapabilityGrants,
          usernames: storage.usernames,
        },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  // Slice D §5 — admin master-root recovery rotation. The apply endpoint
  // verifies the OLD-root-signed proof against the account's STORED admin root
  // (never `.com`'s own prior word), swaps it, and appends to the served lane a
  // box replays. The list is the ordered chain.
  if (method === "POST" && (m = path.match(ROUTE_RE.ADMIN_ROOT_ROTATION_APPLY))) {
    return finish(
      await handleApplyAdminRootRotation(
        {
          usernames: storage.usernames,
          rotations: storage.adminRootRotations,
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.ADMIN_ROOT_ROTATIONS_LIST))) {
    return finish(
      await handleListAdminRootRotations(
        {
          usernames: storage.usernames,
          rotations: storage.adminRootRotations,
        },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  // Watch delegate keys (Phase 2c). Same ordering hazard as device grants:
  // the `/revoke` suffix must hit BEFORE the bare list/mint path.
  if (method === "POST" && (m = path.match(ROUTE_RE.WATCH_DELEGATES_REVOKE))) {
    return finish(
      await handleRevokeWatchDelegate(
        {
          storage: storage.watchDelegates,
          usernames: storage.usernames,
          grants: storage.deviceCapabilityGrants,
        },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.WATCH_DELEGATES_LIST))) {
    return finish(
      await handleMintWatchDelegate(
        {
          storage: storage.watchDelegates,
          usernames: storage.usernames,
          grants: storage.deviceCapabilityGrants,
        },
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.WATCH_DELEGATES_LIST))) {
    return finish(
      await handleListWatchDelegates(
        {
          storage: storage.watchDelegates,
          usernames: storage.usernames,
        },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  // Per-user-cert ACME account-key grants. Same ordering hazard as device
  // grants / watch delegates: the `/revoke` suffix must hit BEFORE the bare
  // list/mint path. List + mint are metadata-only / public-field replies —
  // the sealed account key is NEVER echoed (delivery is the request's job).
  if (method === "POST" && (m = path.match(ROUTE_RE.ACME_ACCOUNT_KEYS_REVOKE))) {
    return finish(
      await handleRevokeAcmeAccountKeyGrant(
        {
          storage: storage.acmeAccountKeyGrants,
          usernames: storage.usernames,
          // #28 — a grant-key rotation ALSO drops the box's seal-to-box
          // delivery slot for that key (so a stolen box can't re-release it).
          delivery: storage.acmeAccountKeyDelivery,
        },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.ACME_ACCOUNT_KEYS_LIST))) {
    return finish(
      await handleMintAcmeAccountKeyGrant(
        {
          storage: storage.acmeAccountKeyGrants,
          usernames: storage.usernames,
        },
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.ACME_ACCOUNT_KEYS_LIST))) {
    return finish(
      await handleListAcmeAccountKeyGrants(
        {
          storage: storage.acmeAccountKeyGrants,
          usernames: storage.usernames,
        },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  // Per-user-cert mint-reservation lease. `/release` before the bare acquire.
  if (method === "POST" && (m = path.match(ROUTE_RE.MINT_RESERVATION_RELEASE))) {
    return finish(
      await handleReleaseMintReservation(
        {
          reservations: storage.mintReservations,
          acmeGrants: storage.acmeAccountKeyGrants,
          usernames: storage.usernames,
        },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.MINT_RESERVATION))) {
    return finish(
      await handleAcquireMintReservation(
        {
          reservations: storage.mintReservations,
          acmeGrants: storage.acmeAccountKeyGrants,
          usernames: storage.usernames,
        },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.USER_DEVICE_DISCONNECT))) {
    const ddFanout = buildOptionalV12PushFanout(env);
    return finishPlain(
      await handleDeviceDisconnect(
        {
          pushTokens: storage.pushTokens,
          usernames: storage.usernames,
          auditEvents: storage.auditEvents,
          // v1.2 Phase 5 — when a quarantined device's
          // disconnect attempt is blocked, the user's OTHER trusted
          // devices get a push alert (and the audit log captures
          // the attempt under accountTypeAtEvent).
          ...(ddFanout ? { pushFanout: ddFanout } : {}),
        },
        decodeURIComponent(m[1]!),
        decodeURIComponent(m[2]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.USER_AUDIT))) {
    const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10) || 50;
    return finish(
      await handleGetAuditEvents(
        { auditEvents: storage.auditEvents },
        decodeURIComponent(m[1]!),
        since,
        limit,
      ),
    );
  }
  if (method === "POST" && ROUTE_RE.DAEMON_STATUS.test(path)) {
    return finish(
      await handlePostDaemonStatus(
        {
          daemonStatus: storage.daemonStatus,
          servers: storage.servers,
          routing: storage.routing,
          // 0058 — coarse "account in use" bump for the username-reclaim tool.
          usernames: storage.usernames,
        },
        await readJson(request),
      ),
    );
  }
  // NOTE: the legacy signed provision-event channel (C) is RETIRED — the box +
  // daemon now report every provisioning phase to the single canonical
  // order-status channel (POST /api/order/<serial>/status), and the demo VPS
  // bootstrap posts there too. The provision_event D1 table is retained as a
  // workspace artifact, but there is no route in front of it.
  if (method === "POST" && (m = path.match(ROUTE_RE.RE_PAIR_INITIATE))) {
    const rePairFanout = buildOptionalV12PushFanout(env);
    return finishPlain(
      await handleInitiateRePair(
        {
          usernames: storage.usernames,
          pendingRePairs: storage.pendingRePairs,
          pushTokens: storage.pushTokens,
          // v1.2 Phase 5 — audit emission + push fan-out on initiate.
          // Audit captures recovery-code-consumed (when applicable);
          // push fans out a T+0 "new device taking over" alert to
          // every trusted device.
          auditEvents: storage.auditEvents,
          ...(rePairFanout ? { pushFanout: rePairFanout } : {}),
          // v1.2 Phase 3 — when the env var is wired, this turns on
          // real TOTP verification + atomic recovery-code consumption
          // for multi-device re-pair attempts. Absent ⇒ Phase 2
          // structural-only check (deploy-safe degrade).
          ...(env.FLAGSHIP_TOTP_KEK ? { totpKekHex: env.FLAGSHIP_TOTP_KEK } : {}),
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
        request.headers.get("if-match") ?? undefined,
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.TOTP_ENROLL_BEGIN))) {
    return finishPlain(
      await handleTotpEnrollBegin(
        {
          usernames: storage.usernames,
          ...(env.FLAGSHIP_TOTP_KEK ? { kekHex: env.FLAGSHIP_TOTP_KEK } : {}),
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.TOTP_ENROLL_CONFIRM))) {
    return finishPlain(
      await handleTotpEnrollConfirm(
        {
          usernames: storage.usernames,
          // v1.2 Phase 5 — appends `account-type-changed-…` +
          // `totp-enrolled` rows on success so the Activity feed shows
          // the upgrade.
          auditEvents: storage.auditEvents,
          ...(env.FLAGSHIP_TOTP_KEK ? { kekHex: env.FLAGSHIP_TOTP_KEK } : {}),
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.TOTP_VERIFY))) {
    const totpFanout = buildOptionalV12PushFanout(env);
    return finishPlain(
      await handleTotpVerify(
        {
          usernames: storage.usernames,
          // v1.2 Phase 5 — pushTokens + auditEvents enable the
          // failed-rate alert: when the 5-in-15-min counter trips,
          // we fan a push out to all the user's trusted devices
          // AND append a `totp-failed-rate` audit row.
          pushTokens: storage.pushTokens,
          auditEvents: storage.auditEvents,
          ...(env.FLAGSHIP_TOTP_KEK ? { kekHex: env.FLAGSHIP_TOTP_KEK } : {}),
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
        totpFanout ?? undefined,
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.TOTP_DISABLE))) {
    return finishPlain(
      await handleTotpDisable(
        {
          usernames: storage.usernames,
          pushTokens: storage.pushTokens,
          // v1.2 Phase 5 — appends `account-type-changed-…` +
          // `totp-disabled` rows on success.
          auditEvents: storage.auditEvents,
          ...(env.FLAGSHIP_TOTP_KEK ? { kekHex: env.FLAGSHIP_TOTP_KEK } : {}),
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.RE_PAIR_GET))) {
    return finishPlain(
      await handleGetRePair(
        { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.WIPE_RESTART))) {
    return finish(
      await handleWipeRestart(
        {
          usernames: storage.usernames,
          webauthnRecovery: storage.webauthnRecovery,
          auditEvents: storage.auditEvents,
          pushTokens: storage.pushTokens,
          // v2 — wipe also revokes every active DeviceCapabilityGrant
          // on the cloud (their old-IRK signatures are now dead anyway).
          deviceCapabilityGrants: storage.deviceCapabilityGrants,
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
        request.headers.get("if-match") ?? undefined,
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.APP_RENAME))) {
    return finish(
      await handleServiceRename(
        {
          usernames: storage.usernames,
          userServiceAliases: storage.userServiceAliases,
          voiciLinks: storage.voiciLinks,
          servers: storage.servers,
          auditEvents: storage.auditEvents,
          // publishDns hook intentionally omitted in the Worker
          // wiring for now — the services-zone publisher integration
          // is a follow-up. The alias + short-link cascade still
          // completes; the daemon-side Caddy refresh will pick up
          // the new label on the next status sync.
        },
        decodeURIComponent(m[1]!),
        decodeURIComponent(m[2]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.APP_LINKS))) {
    return finish(
      await handleGetAppLinks(
        {
          usernames: storage.usernames,
          userServiceAliases: storage.userServiceAliases,
          voiciLinks: storage.voiciLinks,
          servers: storage.servers,
          auditEvents: storage.auditEvents,
          customDomainOrders: storage.customDomainOrders,
        },
        decodeURIComponent(m[1]!),
        decodeURIComponent(m[2]!),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.CUSTOM_DOMAIN))) {
    return finish(
      await handleSetCustomDomain(
        {
          usernames: storage.usernames,
          customDomainOrders: storage.customDomainOrders,
          grants: storage.deviceCapabilityGrants,
          // Replace-time DELETE(old fqdn): only wired when the control
          // channel is configured (same gate as the verifier cron).
          ...(env.SERVICES_BASE_URL && env.SERVICES_CONTROL_SECRET
            ? {
                pushRedirection: async (
                  op: "add" | "delete",
                  fqdn: string,
                  podCanonical?: string,
                ) => {
                  await pushRedirection(
                    {
                      servicesBaseUrl: env.SERVICES_BASE_URL!,
                      secret: env.SERVICES_CONTROL_SECRET!,
                    },
                    { op, fqdn, podCanonical },
                  );
                },
              }
            : {}),
        },
        decodeURIComponent(m[1]!),
        decodeURIComponent(m[2]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.CUSTOM_DOMAIN))) {
    return finish(
      await handleGetCustomDomain(
        { usernames: storage.usernames, customDomainOrders: storage.customDomainOrders },
        decodeURIComponent(m[1]!),
        decodeURIComponent(m[2]!),
      ),
    );
  }
  if (method === "GET" && ROUTE_RE.INTERNAL_ACTIVE_REDIRECTIONS.test(path)) {
    return finish(
      await handleActiveRedirections(
        { customDomainOrders: storage.customDomainOrders },
        bearer(request.headers.get("authorization")),
        env.SERVICES_CONTROL_SECRET,
      ),
    );
  }
  if (method === "GET" && ROUTE_RE.INTERNAL_REDIRECTION_LOOKUP.test(path)) {
    return finish(
      await handleRedirectionLookup(
        { customDomainOrders: storage.customDomainOrders },
        bearer(request.headers.get("authorization")),
        env.SERVICES_CONTROL_SECRET,
        url.searchParams.get("fqdn"),
      ),
    );
  }
  if (method === "POST" && ROUTE_RE.VOICI_SHORTEN.test(path)) {
    return finish(
      await handleVoiciShorten(
        { usernames: storage.usernames, voiciLinks: storage.voiciLinks },
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.APP_ALIASES))) {
    return finish(
      await handleListAppAliases(
        { userServiceAliases: storage.userServiceAliases },
        decodeURIComponent(m[1]!),
      ),
    );
  }

  if (method === "POST" && (ROUTE_RE.ADMIN_REPUBLISH.test(path) || ROUTE_RE.ADMIN_CLEANUP_APEX.test(path))) {
    const auth = authorizeAdmin({
      expected: env.FLAGSHIP_ADMIN_SECRET,
      provided: request.headers.get("x-admin-secret"),
    });
    if (auth) return finishPlain(auth);
    if (
      !env.CLOUDFLARE_DNS_API_TOKEN ||
      !env.CLOUDFLARE_SERVICES_ZONE_ID
    ) {
      return jsonResponse({ error: "DNS API not configured" }, 503);
    }
    const dns = new CloudflareDnsClient({
      apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
      zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID,
    });
    if (ROUTE_RE.ADMIN_REPUBLISH.test(path)) {
      if (!env.SERVICES_PASSTHROUGH_IPV4) {
        return jsonResponse({ error: "SERVICES_PASSTHROUGH_IPV4 not set" }, 503);
      }
      return finishPlain(
        await handleRepublishServerDns({
          servers: storage.servers,
          dns,
          servicesIpv4: env.SERVICES_PASSTHROUGH_IPV4,
          servicesIpv6: env.SERVICES_PASSTHROUGH_IPV6,
        }),
      );
    }
    return finishPlain(
      await handleCleanupApex({ dns, apex: env.SERVICES_APEX ?? "flagship.services" }),
    );
  }

  // ── Admin: migration-ledger visibility (OPS-2) ────────────────
  // GET /api/admin/schema-status — diff the recorded ledger against the
  // repo's known migration set so prod D1 drift is visible at a glance.
  if (method === "GET" && ROUTE_RE.ADMIN_SCHEMA_STATUS.test(path)) {
    const auth = authorizeAdmin({
      expected: env.FLAGSHIP_ADMIN_SECRET,
      provided: request.headers.get("x-admin-secret"),
    });
    if (auth) return finishPlain(auth);
    return finishPlain(
      await handleSchemaStatus({ schemaVersion: storage.schemaVersion }),
    );
  }
  // POST /api/admin/schema-version/:version — admin-gated ledger backfill
  // (stamp a version as applied; idempotent).
  if (method === "POST" && (m = path.match(ROUTE_RE.ADMIN_SCHEMA_STAMP))) {
    const auth = authorizeAdmin({
      expected: env.FLAGSHIP_ADMIN_SECRET,
      provided: request.headers.get("x-admin-secret"),
    });
    if (auth) return finishPlain(auth);
    return finishPlain(
      await handleStampSchemaVersion(
        { schemaVersion: storage.schemaVersion, now: () => Date.now() },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  // ── Admin: CA-endorsement lease health (OPS-3) ────────────────
  // GET /api/admin/ca-lease-status — queryable lapse warning so the
  // 14-day YubiKey ceremony happens BEFORE the lease lapses (a hard
  // pubkey-cert outage under ENFORCE).
  if (method === "GET" && ROUTE_RE.ADMIN_CA_LEASE_STATUS.test(path)) {
    const auth = authorizeAdmin({
      expected: env.FLAGSHIP_ADMIN_SECRET,
      provided: request.headers.get("x-admin-secret"),
    });
    if (auth) return finishPlain(auth);
    return finishPlain(
      await handleCaLeaseStatus({
        activeLeaseNotAfterMs: activeCaLeaseNotAfterMs,
        now: () => Date.now(),
      }),
    );
  }

  if (method === "POST" && (m = path.match(ROUTE_RE.INSTALL_EVENTS))) {
    return finish(
      await handlePostInstallEvent(
        // Pass authCodes so the handler gates on serial-existence (#18).
        { storage: storage.installEvents, authCodes: storage.authCodes },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.INSTALL_EVENTS))) {
    const sinceSeq = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
    return finish(
      await handleGetInstallEvents(
        { storage: storage.installEvents },
        decodeURIComponent(m[1]!),
        sinceSeq,
      ),
    );
  }

  // ── Desktop-burner base-ISO manifest ──────────────────────────
  // Unauthenticated + rate-limited (the "iso-manifest" bucket lives in
  // rateLimit.ts and is applied at the edge in route.ts). The server is
  // the sole decider; the burner is a dumb executor.
  if (method === "POST" && ROUTE_RE.ISO_MANIFEST.test(path)) {
    return finish(
      handleIsoManifest(
        { blessedManifest: parseBlessedIsoManifest(env.FLAGSHIP_ISO_MANIFEST) },
        await readJson(request),
      ),
    );
  }

  // ── Provisioning-status channel (per-order install progress) ──
  if (method === "POST" && (m = path.match(ROUTE_RE.PROVISION_STATUS))) {
    const psFanout = buildOptionalV12PushFanout(env);
    return finish(
      await handlePostProvisionStatus(
        {
          storage: storage.provisionStatus,
          // Resolve SERIAL → owner (the auth-code records the username
          // that created the order) → push subscriptions, so each status
          // change wakes the owner's devices. All best-effort inside the
          // handler — a push failure never fails the status write.
          authCodes: storage.authCodes,
          pushTokens: storage.pushTokens,
          // Mirror the canonical phase onto the owner's demo_users row so the
          // demo install-progress timeline reads off this same channel (the
          // demo VPS bootstrap posts here now). Best-effort inside the handler.
          demoUsers: storage.demoUsers,
          // Activity feed: emit `server-online` on the first `live` report.
          auditEvents: storage.auditEvents,
          ...(psFanout ? { pushFanout: psFanout } : {}),
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.PROVISION_STATUS))) {
    return finish(
      await handleGetProvisionStatus(
        { storage: storage.provisionStatus },
        decodeURIComponent(m[1]!),
      ),
    );
  }

  // ── Push notifications ──────────────────────────────────────
  if (method === "GET" && ROUTE_RE.PUSH_VAPID_KEY.test(path)) {
    // Public endpoint — webapp fetches this to subscribe via the
    // PushManager. Key rotation is just a wrangler-secret swap; the
    // webapp re-fetches every time settings opens.
    if (!env.WEBPUSH_VAPID_PUBLIC_KEY_B64URL) {
      return finishPlain({
        status: 503,
        body: { error: "web push not configured on this deployment" },
      });
    }
    return finishPlain({
      status: 200,
      body: { key: env.WEBPUSH_VAPID_PUBLIC_KEY_B64URL },
    });
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.USER_DEVICE_ADMIT))) {
    // Phase 3b — vouched cross-device admit. Verifies the DeviceAdmit
    // envelope under the account's registered IRK, then admits the
    // incoming device QUARANTINED + fires a device-added audit row.
    return finish(
      await handleVouchedDeviceAdmit(
        {
          pushTokens: storage.pushTokens,
          usernames: storage.usernames,
          auditEvents: storage.auditEvents,
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && ROUTE_RE.PUSH_REGISTER.test(path)) {
    return finish(
      await handlePushRegister(
        { pushTokens: storage.pushTokens, usernames: storage.usernames },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && ROUTE_RE.PUSH_RELAY.test(path)) {
    // Build the forwarder iff at least one provider's secrets are
    // wired. Otherwise the handler short-circuits with simulated:true
    // (preserves the dev-environment loop).
    const forwarder = buildOptionalPushForwarder(env);
    return finish(
      await handlePushRelay(
        {
          pushTokens: storage.pushTokens,
          usernames: storage.usernames,
          servers: storage.servers,
          ...(forwarder ? { forwardToProviders: forwarder } : {}),
        },
        await readJson(request),
      ),
    );
  }
  if (method === "DELETE" && (m = path.match(ROUTE_RE.PUSH_REVOKE))) {
    // Admin override: only when the x-admin-secret header is present AND
    // matches. A present-but-wrong header is NOT admin (and is NOT a hard
    // 401/503 here) — it simply falls through to the owner-signed path,
    // which fails closed on its own if no valid envelope is supplied.
    const adminHeader = request.headers.get("x-admin-secret");
    const isAdmin =
      adminHeader != null &&
      authorizeAdmin({ expected: env.FLAGSHIP_ADMIN_SECRET, provided: adminHeader }) === null;
    return finish(
      await handlePushRevoke(
        { pushTokens: storage.pushTokens, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
        await readJson(request),
        { isAdmin },
      ),
    );
  }

  // ── LLM promo ──────────────────────────────────────────────
  if (method === "POST" && ROUTE_RE.LLM_PROMO_ISSUE.test(path)) {
    const inferenceEndpoint = parseBlessedInferenceEndpoint(env.FLAGSHIP_INFERENCE_ENDPOINT);
    const inferenceSecret = env.FLAGSHIP_INFERENCE_TOKEN_SECRET;
    return finish(
      await handleLlmPromoIssue(
        {
          llmPromo: storage.llmPromo,
          tiers: storage.tiers,
          usernames: storage.usernames,
          // #85 — enforce the demo rolling-token ceiling in production.
          demoLlmLedger: storage.demoLlmLedger,
          // Both the endpoint AND the signing secret must be present for
          // a `flagship` issue; missing either ⇒ the handler's 503.
          inferenceEndpoint: inferenceSecret ? inferenceEndpoint : null,
          // For `provider:"flagship"` mint a scoped, short-lived (1h)
          // `.com`-signed token the metering shim verifies — NOT a real
          // upstream key. Refuse if the signing secret is unset (belt to
          // the handler's endpoint-configured check). Upstream providers
          // (anthropic/openai/google) keep the deterministic stub until
          // their real scoped-key APIs are wired.
          mintProviderKey: async (args) => {
            if (args.provider === "flagship") {
              if (!inferenceSecret) throw new Error("inference token secret not configured");
              const keyId = `fp-${crypto.randomUUID()}`;
              const key = await mintScopedInferenceToken(
                {
                  username: args.username,
                  keyId,
                  iat: Date.now(),
                  exp: args.expiresAt,
                  dailyInputTokenCap: args.dailyInputTokenCap,
                  dailyOutputTokenCap: args.dailyOutputTokenCap,
                  serverFqdn: args.serverFqdn,
                },
                inferenceSecret,
              );
              return { key, providerKeyId: keyId };
            }
            return {
              key: `fk-${args.provider}-${args.username}-${args.expiresAt}`,
              providerKeyId: `pkid-${args.expiresAt}`,
            };
          },
        },
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.LLM_PROMO_STATUS))) {
    return finish(
      await handleLlmPromoStatus(
        {
          llmPromo: storage.llmPromo,
          tiers: storage.tiers,
          usernames: storage.usernames,
          mintProviderKey: async () => ({ key: "", providerKeyId: "" }),
        },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  // Metering webhook — the in-house inference shim reports TRUE token
  // usage (model (b)). Authenticated by the scoped token the shim
  // re-presents; refused if the signing secret is unset.
  if (method === "POST" && ROUTE_RE.LLM_PROMO_USAGE.test(path)) {
    const inferenceSecret = env.FLAGSHIP_INFERENCE_TOKEN_SECRET;
    if (!inferenceSecret) {
      return finishPlain({ status: 503, body: { error: "in-house inference not configured" } });
    }
    return finish(
      await handleLlmPromoUsage(
        {
          llmPromo: storage.llmPromo,
          verifyToken: async (token) => {
            const v = await verifyScopedInferenceToken(token, inferenceSecret);
            return v.ok ? { ok: true, username: v.claims.username } : { ok: false };
          },
        },
        await readJson(request),
      ),
    );
  }

  // ── Entitlement revocation lists (N12c) ───────────────────────
  if (method === "POST" && ROUTE_RE.CERT_REVOCATIONS_POST.test(path)) {
    return finishPlain(
      await handlePostEntitlementRevocations(
        {
          storage: storage.entitlementRevocations,
          usernames: storage.usernames,
          grants: storage.deviceCapabilityGrants,
        },
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.CERT_REVOCATIONS_GET))) {
    return finishPlain(
      await handleGetEntitlementRevocations(
        {
          storage: storage.entitlementRevocations,
          usernames: storage.usernames,
        },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  // #88 — flexible-query revocation API. Daemons + webapp/phone fetch
  // with ?since=<ts> for incremental sync; ?certId=<hex> for an
  // interactive lookup.
  if (method === "GET" && ROUTE_RE.REVOCATIONS_LIST.test(path)) {
    const since = parseInt(url.searchParams.get("since") ?? "", 10);
    return finishPlain(
      await handleListRevocations(
        {
          storage: storage.entitlementRevocations,
          usernames: storage.usernames,
        },
        {
          username: url.searchParams.get("username") ?? undefined,
          since: Number.isFinite(since) ? since : undefined,
          certId: url.searchParams.get("certId") ?? undefined,
        },
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Plan A — demo-user / on-connect Hetzner provisioning
  //
  // The 5 admin endpoints (create / delete / install-complete / GET /
  // LIST) gate behind FLAGSHIP_ADMIN_SECRET. The 2 public endpoints
  // (connect / heartbeat) are rate-limited at the edge by the
  // Worker's main fetch handler (see apps/com/src/index.ts); we only
  // dispatch here.
  //
  // Important matching order: `/create`, `/delete`, `/sample-user`
  // (list) must hit BEFORE the bare `/sample-user/{u}` GET (which
  // would otherwise swallow the literal "create" as a username).
  //
  // Lazy-construct Hetzner deps so the bootstrap path works:
  //   - `create` writes a D1 row; doesn't touch Hetzner at all.
  //   - `install-complete` updates the D1 row with snapshot_id;
  //     also doesn't touch Hetzner.
  //   - `delete` / `connect` / `heartbeat` / `get` / `list` need
  //     Hetzner only when an active server actually exists.
  //
  // The operator's first `create-sample-user` run is the chicken-
  // and-egg break: the CLI uses its OWN HCLOUD_TOKEN to upload an
  // SSH key to Hetzner and gets back the numeric DEMO_PUBLIC_SSH_KEY_ID,
  // which the operator THEN sets in wrangler.toml [vars] + redeploys.
  // A pre-deploy gate that required DEMO_PUBLIC_SSH_KEY_ID would block
  // the first create — bootstrap-impossible. Instead the deps stub
  // throws lazily if a request actually tries to use the Worker-side
  // Hetzner client without configuration.
  if (path.startsWith("/api/dev/sample-user")) {
    const lazyHetzner = env.HCLOUD_TOKEN
      ? createHetznerClient(env.HCLOUD_TOKEN)
      : {
          createServerFromSnapshot() {
            throw new Error("HCLOUD_TOKEN is not configured on the Worker");
          },
          getServerStatus() {
            throw new Error("HCLOUD_TOKEN is not configured on the Worker");
          },
          destroyServer() {
            throw new Error("HCLOUD_TOKEN is not configured on the Worker");
          },
        };
    const sshKeyIdRaw = env.DEMO_PUBLIC_SSH_KEY_ID;
    const sshKeyId = sshKeyIdRaw ? parseInt(sshKeyIdRaw, 10) : 0;
    // DNS cleanup on demo teardown: when the CF token is configured, hand
    // the demo handlers a CloudflareDnsClient so deleting a demo user also
    // reaps the per-box + per-user DNS records its server published —
    // otherwise the zone accumulates orphans (the leak that exhausted the
    // 200-record cap + broke cert issuance). Direct client (has
    // deleteByName); the broker has no delete RPC.
    const demoDns =
      env.CLOUDFLARE_DNS_API_TOKEN && env.CLOUDFLARE_SERVICES_ZONE_ID
        ? new CloudflareDnsClient({
            apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
            zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID,
          })
        : undefined;
    const demoDeps = {
      storage: storage.demoUsers,
      usernames: storage.usernames,
      hetzner: lazyHetzner,
      sshKeyId,
      audit: storage.auditEvents,
      ...(demoDns ? { dns: demoDns } : {}),
      apex: env.SERVICES_APEX ?? "flagship.services",
    };
    // The v2 admin routes additionally need the auth-codes, build-tickets,
    // and device-capability-grants storages PLUS the DEMO_IRK_KEK
    // worker-secret. Built lazily so the legacy demo endpoints don't
    // fail-closed when the new KEK isn't configured.
    const adminDeps = env.DEMO_IRK_KEK
      ? {
          ...demoDeps,
          authCodes: storage.authCodes,
          buildTickets: storage.buildTickets,
          deviceCapabilityGrants: storage.deviceCapabilityGrants,
          demoIrkKek: hexDecode(env.DEMO_IRK_KEK),
          apex: env.SERVICES_APEX ?? "flagship.services",
        }
      : null;
    if (
      method === "POST" &&
      ROUTE_RE.DEMO_USER_ADMIN_CLAIM_AND_ISSUE.test(path)
    ) {
      {
        const _adminAuth = authorizeAdmin({
          expected: env.FLAGSHIP_ADMIN_SECRET,
          provided: request.headers.get("x-admin-secret"),
        });
        if (_adminAuth) return finishPlain(_adminAuth);
      }
      if (!adminDeps) {
        return jsonResponse(
          { error: "DEMO_IRK_KEK not configured on this Worker" },
          503,
        );
      }
      return finishPlain(await handleAdminClaimAndIssue(adminDeps, await readJson(request)));
    }
    if (
      method === "POST" &&
      (m = path.match(ROUTE_RE.DEMO_USER_ADMIN_MINT_DEVICE_GRANT))
    ) {
      {
        const _adminAuth = authorizeAdmin({
          expected: env.FLAGSHIP_ADMIN_SECRET,
          provided: request.headers.get("x-admin-secret"),
        });
        if (_adminAuth) return finishPlain(_adminAuth);
      }
      if (!adminDeps) {
        return jsonResponse(
          { error: "DEMO_IRK_KEK not configured on this Worker" },
          503,
        );
      }
      return finishPlain(
        await handleAdminMintDeviceGrant(
          adminDeps,
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    // W11 — admin-snapshot-now. Worker-side provisioning kickoff
    // (replaces the laptop's HCLOUD_TOKEN + SSH+dd dance with a
    // cloud-init `user_data` script). Fails closed when the W11 deps
    // (DEMO_IRK_KEK + HCLOUD_TOKEN + ISO_BUCKET + ISO_TEMP_BUCKET +
    // FLAGSHIP_R2_TEMP_PUBLIC_BASE) aren't all configured.
    if (
      method === "POST" &&
      (m = path.match(ROUTE_RE.DEMO_USER_ADMIN_SNAPSHOT_NOW))
    ) {
      {
        const _adminAuth = authorizeAdmin({
          expected: env.FLAGSHIP_ADMIN_SECRET,
          provided: request.headers.get("x-admin-secret"),
        });
        if (_adminAuth) return finishPlain(_adminAuth);
      }
      if (!adminDeps) {
        return jsonResponse(
          { error: "DEMO_IRK_KEK not configured on this Worker" },
          503,
        );
      }
      if (
        !env.HCLOUD_TOKEN ||
        !env.ISO_TEMP_BUCKET ||
        !env.FLAGSHIP_R2_TEMP_PUBLIC_BASE
      ) {
        return jsonResponse(
          {
            error:
              "W11 admin-snapshot-now requires HCLOUD_TOKEN + ISO_TEMP_BUCKET + FLAGSHIP_R2_TEMP_PUBLIC_BASE on the Worker",
          },
          503,
        );
      }
      const provisionHetzner = createHetznerClient(env.HCLOUD_TOKEN);
      const provisionDeps = {
        storage: adminDeps.storage,
        usernames: adminDeps.usernames,
        authCodes: adminDeps.authCodes,
        buildTickets: adminDeps.buildTickets,
        deviceCapabilityGrants: adminDeps.deviceCapabilityGrants,
        isoTempBucket: env.ISO_TEMP_BUCKET,
        isoTempPublicBase: env.FLAGSHIP_R2_TEMP_PUBLIC_BASE,
        // Public URL of the base ISO; cloud-init wgets it directly,
        // bypassing the Worker. W12: prefer the Debian-12-netinst-based
        // netboot ISO (Alpine apkovl-mode doesn't load kernel modules on
        // Hetzner cloud VMs). Falls back to the netboot default URL,
        // then to the legacy Alpine BASE_ISO_URL.
        baseIsoUrl:
          env.FLAGSHIP_NETBOOT_ISO_URL ??
          env.BASE_ISO_URL ??
          "https://flagshipserver.com/build/iso/flagship-netboot-trixie-amd64.iso",
        hetzner: provisionHetzner,
        demoIrkKek: adminDeps.demoIrkKek,
        apex: env.SERVICES_APEX ?? "flagship.services",
        controlApex: env.CONTROL_APEX ?? "flagshipserver.com",
        ...(sshKeyId ? { demoSshKeyId: sshKeyId } : {}),
        defaultRegion: "fsn1",
        defaultSize: "cpx11",
        // Server types known available + non-deprecated in fsn1 as of
        // 2026-05-21. cx22 + cx32 are deprecated; cx23 is the in-place
        // upgrade and is what worked on the legacy CLI's live runs.
        fallbackServerTypes: ["cx23", "cpx21", "cpx22"] as const,
      };
      return finishPlain(
        await handleAdminSnapshotNow(
          provisionDeps,
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "POST" && ROUTE_RE.DEMO_USER_CREATE.test(path)) {
      {
        const _adminAuth = authorizeAdmin({
          expected: env.FLAGSHIP_ADMIN_SECRET,
          provided: request.headers.get("x-admin-secret"),
        });
        if (_adminAuth) return finishPlain(_adminAuth);
      }
      return finishPlain(await handleCreateDemoUser(demoDeps, await readJson(request)));
    }
    if (method === "POST" && ROUTE_RE.DEMO_USER_DELETE.test(path)) {
      {
        const _adminAuth = authorizeAdmin({
          expected: env.FLAGSHIP_ADMIN_SECRET,
          provided: request.headers.get("x-admin-secret"),
        });
        if (_adminAuth) return finishPlain(_adminAuth);
      }
      return finishPlain(await handleDeleteDemoUser(demoDeps, await readJson(request)));
    }
    // W13 — cloud-init-direct provisioning. Same admin gate +
    // DEMO_IRK_KEK requirement as snapshot-now; does NOT need R2 or
    // a base ISO URL (no ISO is involved). Fails closed if HCLOUD_TOKEN
    // isn't configured.
    if (
      method === "POST" &&
      (m = path.match(ROUTE_RE.DEMO_USER_ADMIN_CLOUD_INIT_NOW))
    ) {
      {
        const _adminAuth = authorizeAdmin({
          expected: env.FLAGSHIP_ADMIN_SECRET,
          provided: request.headers.get("x-admin-secret"),
        });
        if (_adminAuth) return finishPlain(_adminAuth);
      }
      if (!adminDeps) {
        return jsonResponse(
          { error: "DEMO_IRK_KEK not configured on this Worker" },
          503,
        );
      }
      if (!env.HCLOUD_TOKEN) {
        return jsonResponse(
          { error: "W13 admin-cloud-init-now requires HCLOUD_TOKEN on the Worker" },
          503,
        );
      }
      const cloudInitHetzner = createHetznerClient(env.HCLOUD_TOKEN);
      const cloudInitDeps = {
        storage: adminDeps.storage,
        usernames: adminDeps.usernames,
        authCodes: adminDeps.authCodes,
        buildTickets: adminDeps.buildTickets,
        deviceCapabilityGrants: adminDeps.deviceCapabilityGrants,
        hetzner: cloudInitHetzner,
        demoIrkKek: adminDeps.demoIrkKek,
        apex: env.SERVICES_APEX ?? "flagship.services",
        controlApex: env.CONTROL_APEX ?? "flagshipserver.com",
        ...(sshKeyId ? { demoSshKeyId: sshKeyId } : {}),
        defaultRegion: "fsn1",
        defaultSize: "cpx11",
        fallbackServerTypes: ["cx23", "cpx21", "cpx22"] as const,
      };
      return finishPlain(
        await handleAdminCloudInitNow(
          cloudInitDeps,
          decodeURIComponent(m[1]!),
          await readJson(request),
        ),
      );
    }
    if (method === "POST" && (m = path.match(ROUTE_RE.DEMO_USER_INSTALL_COMPLETE))) {
      {
        const _adminAuth = authorizeAdmin({
          expected: env.FLAGSHIP_ADMIN_SECRET,
          provided: request.headers.get("x-admin-secret"),
        });
        if (_adminAuth) return finishPlain(_adminAuth);
      }
      return finishPlain(
        await handleDemoUserInstallComplete(demoDeps, decodeURIComponent(m[1]!), await readJson(request)),
      );
    }
    if (method === "POST" && (m = path.match(ROUTE_RE.DEMO_USER_CONNECT))) {
      return finishPlain(await handleDemoUserConnect(demoDeps, decodeURIComponent(m[1]!)));
    }
    if (method === "POST" && (m = path.match(ROUTE_RE.DEMO_USER_CANCEL))) {
      return finishPlain(await handleDemoUserCancel(demoDeps, decodeURIComponent(m[1]!)));
    }
    if (method === "POST" && (m = path.match(ROUTE_RE.DEMO_USER_HEARTBEAT))) {
      return finishPlain(await handleDemoUserHeartbeat(demoDeps, decodeURIComponent(m[1]!)));
    }
    if (method === "GET" && ROUTE_RE.DEMO_USER_LIST.test(path)) {
      {
        const _adminAuth = authorizeAdmin({
          expected: env.FLAGSHIP_ADMIN_SECRET,
          provided: request.headers.get("x-admin-secret"),
        });
        if (_adminAuth) return finishPlain(_adminAuth);
      }
      return finishPlain(await handleListDemoUsers(demoDeps));
    }
    if (method === "GET" && (m = path.match(ROUTE_RE.DEMO_USER_GET))) {
      {
        const _adminAuth = authorizeAdmin({
          expected: env.FLAGSHIP_ADMIN_SECRET,
          provided: request.headers.get("x-admin-secret"),
        });
        if (_adminAuth) return finishPlain(_adminAuth);
      }
      return finishPlain(await handleGetDemoUser(demoDeps, decodeURIComponent(m[1]!)));
    }
  }

  // Phase 1 of the gym recipe→Hetzner pipeline (docs/gym-recipe-to-hetzner.md).
  // gym-only; accepts an IRK priv to self-mint entitlements — must never be
  // enabled on prod. The dispatch is fenced THREE ways: (1) the env must be the
  // gym env (CONTROL_APEX is the gym apex — prod leaves it unset / a non-gym
  // literal), (2) the admin secret header (same x-admin-secret gate as the demo
  // provision routes), and (3) HCLOUD_TOKEN must be configured. Any miss → the
  // request never reaches handleGymProvision. Prod uses the entitlement relay
  // instead (out of scope here).
  if (method === "POST" && ROUTE_RE.GYM_PROVISION.test(path)) {
    const controlApex = env.CONTROL_APEX ?? "flagshipserver.com";
    const isGymEnv = controlApex.startsWith("gym.");
    if (!isGymEnv) {
      // Fail as if the route does not exist on prod — never reveal the gym
      // affordance off the gym env.
      return jsonResponse({ error: "not found" }, 404);
    }
    {
      const _adminAuth = authorizeAdmin({
        expected: env.FLAGSHIP_ADMIN_SECRET,
        provided: request.headers.get("x-admin-secret"),
      });
      if (_adminAuth) return finishPlain(_adminAuth);
    }
    if (!env.HCLOUD_TOKEN) {
      return jsonResponse(
        { error: "gym provision requires HCLOUD_TOKEN on the Worker" },
        503,
      );
    }
    const gymHetzner = createHetznerClient(env.HCLOUD_TOKEN);
    const gymSshKeyRaw = env.DEMO_PUBLIC_SSH_KEY_ID;
    const gymSshKeyId = gymSshKeyRaw ? parseInt(gymSshKeyRaw, 10) : 0;
    return finishPlain(
      await handleGymProvision(
        {
          usernames: storage.usernames,
          authCodes: storage.authCodes,
          hetzner: gymHetzner,
          ...(gymSshKeyId ? { demoSshKeyId: gymSshKeyId } : {}),
          // Hetzner stock-gates the CPX line (cpx31/41/51) to ash/hil — it is
          // NOT available in fsn1, so a cpx* size + fsn1 fails Hetzner 422
          // "unsupported location for server type". ash is the proven combo
          // for the full-platform size below (validated live 2026-06-18).
          defaultRegion: "ash",
          // Full-platform gym boxes run the data-services docker stack; cpx11
          // is too small for it (per docs/gym-recipe-to-hetzner.md + the
          // 2026-06-18 full-platform notes). cpx31 has the headroom.
          defaultSize: "cpx31",
          fallbackServerTypes: ["cpx41", "cpx51"] as const,
        },
        await readJson(request),
      ),
    );
  }

  // W12 debug — unauthenticated late-command log exfil. Returns 503
  // when ISO_TEMP_BUCKET isn't bound. Each POST stores one timestamped
  // chunk under `late-log/<label>/<ts>.txt`; GET lists + concatenates.
  // The label is opaque (typically `<serverDomain>` or `<username>`).
  if ((m = path.match(ROUTE_RE.DEV_LATE_LOG))) {
    if (!env.ISO_TEMP_BUCKET) {
      return new Response("ISO_TEMP_BUCKET unbound\n", { status: 503 });
    }
    const label = decodeURIComponent(m[1]!);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(label)) {
      return new Response("invalid label\n", { status: 400 });
    }
    if (method === "POST") {
      const body = await request.text();
      if (body.length > 64 * 1024) {
        return new Response("chunk too large\n", { status: 413 });
      }
      const ts = Date.now();
      const key = `late-log/${label}/${ts}-${Math.random().toString(36).slice(2, 8)}.txt`;
      await env.ISO_TEMP_BUCKET.put(key, body, {
        httpMetadata: { contentType: "text/plain" },
      });
      return new Response(`stored ${body.length}B as ${key}\n`, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (method === "GET") {
      const listed = await env.ISO_TEMP_BUCKET.list({
        prefix: `late-log/${label}/`,
        limit: 1000,
      });
      const keys = (listed.objects ?? []).map((o) => o.key).sort();
      const chunks: string[] = [];
      for (const k of keys) {
        const obj = await env.ISO_TEMP_BUCKET.get(k);
        if (obj) chunks.push(`# ── ${k} ──\n${await obj.text()}\n`);
      }
      return new Response(chunks.length > 0 ? chunks.join("") : `no entries for ${label}\n`, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("method not allowed\n", { status: 405 });
  }

  // W12 debug — Hetzner rescue mode enabler. POST returns the rescue
  // root password; the operator SSHes in with it. Admin-gated.
  if (method === "POST" && (m = path.match(ROUTE_RE.DEV_RESCUE))) {
    const _adminAuth = authorizeAdmin({
      expected: env.FLAGSHIP_ADMIN_SECRET,
      provided: request.headers.get("x-admin-secret"),
    });
    if (_adminAuth) return finishPlain(_adminAuth);
    if (!env.HCLOUD_TOKEN) {
      return new Response("HCLOUD_TOKEN unbound\n", { status: 503 });
    }
    const serverId = m[1]!;
    // 1. Enable rescue mode (requires server to be powered ON or OFF;
    //    we don't enforce — the API will reject if mid-action).
    const enableResp = await fetch(
      `https://api.hetzner.cloud/v1/servers/${serverId}/actions/enable_rescue`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.HCLOUD_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "linux64" }),
      },
    );
    const enableBody = await enableResp.text();
    if (!enableResp.ok) {
      return new Response(
        `enable_rescue failed: ${enableResp.status}\n${enableBody}\n`,
        { status: 502 },
      );
    }
    // 2. Power-cycle the server so it boots into rescue.
    const cycleResp = await fetch(
      `https://api.hetzner.cloud/v1/servers/${serverId}/actions/reset`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.HCLOUD_TOKEN}` },
      },
    );
    const cycleBody = await cycleResp.text();
    // Reset returns 200 on success; surface failure but still echo
    // the rescue password from step 1.
    return new Response(
      `# rescue mode enabled for server ${serverId}\n` +
        `# (boots into rescue on next power cycle; SSH root@<ip> with the password below)\n` +
        `enable_rescue: ${enableResp.status}\n${enableBody}\n` +
        `reset: ${cycleResp.status}\n${cycleBody}\n`,
      {
        status: 200,
        headers: { "content-type": "text/plain" },
      },
    );
  }

  // W12 debug — GET Hetzner server info (IP, status). Admin-gated.
  if (method === "GET" && (m = path.match(ROUTE_RE.DEV_SERVER_INFO))) {
    const _adminAuth = authorizeAdmin({
      expected: env.FLAGSHIP_ADMIN_SECRET,
      provided: request.headers.get("x-admin-secret"),
    });
    if (_adminAuth) return finishPlain(_adminAuth);
    if (!env.HCLOUD_TOKEN) {
      return new Response("HCLOUD_TOKEN unbound\n", { status: 503 });
    }
    const serverId = m[1]!;
    const r = await fetch(`https://api.hetzner.cloud/v1/servers/${serverId}`, {
      headers: { authorization: `Bearer ${env.HCLOUD_TOKEN}` },
    });
    return new Response(await r.text(), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }

  // W12 debug — Worker-side ISO upload to ISO_BUCKET. Admin-gated.
  if (method === "PUT" && (m = path.match(ROUTE_RE.DEV_UPLOAD_ISO))) {
    const _adminAuth = authorizeAdmin({
      expected: env.FLAGSHIP_ADMIN_SECRET,
      provided: request.headers.get("x-admin-secret"),
    });
    if (_adminAuth) return finishPlain(_adminAuth);
    if (!env.ISO_BUCKET) {
      return new Response("ISO_BUCKET unbound\n", { status: 503 });
    }
    const key = m[1]!;
    const cl = request.headers.get("content-length");
    if (!cl) return new Response("content-length required\n", { status: 411 });
    const len = Number(cl);
    if (!Number.isFinite(len) || len <= 0 || len > 200 * 1024 * 1024) {
      return new Response("invalid content-length\n", { status: 413 });
    }
    if (!request.body) return new Response("no body\n", { status: 400 });
    const stream = (request.body as ReadableStream<Uint8Array>).pipeThrough(
      new FixedLengthStream(len),
    );
    await (env.ISO_BUCKET as ProvisioningTempBucket).put(key, stream, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    return new Response(`uploaded ${len}B as ISO_BUCKET/${key}\n`, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  // W12 debug — destroy a server by id. Admin-gated.
  if (method === "POST" && (m = path.match(ROUTE_RE.DEV_DESTROY))) {
    const _adminAuth = authorizeAdmin({
      expected: env.FLAGSHIP_ADMIN_SECRET,
      provided: request.headers.get("x-admin-secret"),
    });
    if (_adminAuth) return finishPlain(_adminAuth);
    if (!env.HCLOUD_TOKEN) {
      return new Response("HCLOUD_TOKEN unbound\n", { status: 503 });
    }
    const serverId = m[1]!;
    const r = await fetch(`https://api.hetzner.cloud/v1/servers/${serverId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${env.HCLOUD_TOKEN}` },
    });
    return new Response(`destroy ${serverId}: ${r.status}\n${await r.text()}\n`, {
      status: r.ok ? 200 : 502,
      headers: { "content-type": "text/plain" },
    });
  }

  return null;
}

/** v1.2 Phase 5 — null when no push provider is configured. */
function buildOptionalV12PushFanout(env: ControlPlaneEnv) {
  const forwarder = buildOptionalPushForwarder(env);
  return forwarder ? wrapForwarderAsV12Fanout(forwarder) : null;
}

function buildOptionalPushForwarder(env: ControlPlaneEnv) {
  const apnsConfigured =
    !!env.APNS_KEY_ID &&
    !!env.APNS_TEAM_ID &&
    !!env.APNS_PRIVATE_KEY_PEM &&
    !!env.APNS_BUNDLE_ID;
  const fcmConfigured = !!env.FCM_SERVICE_ACCOUNT_JSON && !!env.FCM_PROJECT_ID;
  const webpushConfigured =
    !!env.WEBPUSH_VAPID_PRIVATE_KEY_PEM &&
    !!env.WEBPUSH_VAPID_PUBLIC_KEY_B64URL &&
    !!env.WEBPUSH_CONTACT;
  if (!apnsConfigured && !fcmConfigured && !webpushConfigured) return null;
  return buildPushForwarder({
    ...(apnsConfigured
      ? {
          apns: {
            keyId: env.APNS_KEY_ID!,
            teamId: env.APNS_TEAM_ID!,
            privateKeyPem: env.APNS_PRIVATE_KEY_PEM!,
            bundleId: env.APNS_BUNDLE_ID!,
            host: env.APNS_HOST,
          },
        }
      : {}),
    ...(fcmConfigured
      ? {
          fcm: {
            serviceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON!,
            projectId: env.FCM_PROJECT_ID!,
          },
        }
      : {}),
    ...(webpushConfigured
      ? {
          webpush: {
            vapidPrivateKeyPem: env.WEBPUSH_VAPID_PRIVATE_KEY_PEM!,
            vapidPublicKeyB64Url: env.WEBPUSH_VAPID_PUBLIC_KEY_B64URL!,
            contact: env.WEBPUSH_CONTACT!,
          },
        }
      : {}),
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Returns `any` because the handlers in @flagship/control-plane all
// re-validate input shape internally. Casting to specific body types here
// would be busy-work without adding safety.
async function readJson(request: Request): Promise<any> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const text = await request.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Parse the `FLAGSHIP_ISO_MANIFEST` env var (a JSON string of the
 * IsoManifest shape) into a manifest, or null when unset / unparseable /
 * shape-invalid. NEVER throws — a bad config simply degrades to
 * "unconfigured", and POST /api/iso-manifest then answers
 * `{ download: null }` rather than failing the burner's launch.
 */
function parseBlessedIsoManifest(raw: string | undefined): IsoManifest | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as Record<string, unknown>;
  if (
    typeof m.version !== "string" ||
    typeof m.url !== "string" ||
    typeof m.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(m.sha256) ||
    typeof m.sizeBytes !== "number" ||
    !Number.isInteger(m.sizeBytes) ||
    typeof m.attestation !== "string"
  ) {
    return null;
  }
  return {
    version: m.version,
    url: m.url,
    sha256: m.sha256,
    sizeBytes: m.sizeBytes,
    attestation: m.attestation,
  };
}

function finish(r: HandlerResponseWithHeaders): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (r.headers) for (const [k, v] of Object.entries(r.headers)) headers.set(k, v);
  return new Response(JSON.stringify(r.body), { status: r.status, headers });
}

function finishPlain(r: HandlerResponse): Response {
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Build the `pushUserDevices` closure handed to the consume handler.
 * Returns silently when the user has no registered tokens or the
 * forwarder has no provider configured. The wrapper swallows errors
 * because /consume's response time shouldn't be held back by push
 * provider round-trips, and a failed push isn't an unlock failure.
 */
function buildPushUserDevices(
  pushTokens: import("@flagship/storage").PushTokenStorage,
  forwarder: NonNullable<ReturnType<typeof buildOptionalPushForwarder>>,
): (username: string, category: string, payload?: Uint8Array) => Promise<void> {
  return async (username, category, payload) => {
    try {
      const tokens = await pushTokens.listByUser(username);
      if (tokens.length === 0) return;
      await forwarder({
        targets: tokens.map((t) => ({
          tokenId: t.tokenId,
          platform: t.platform,
          providerToken: t.providerToken,
        })),
        category,
        // APNs/FCM use the sealed-payload story (encrypted by the
        // daemon under the device's pushX25519Pub) — empty here for
        // the consume-trigger path since we don't have a pre-sealed
        // blob to forward. Web Push uses RFC 8291 with the plaintext
        // payload below; the SW decrypts and personalises the
        // notification.
        sealedPayloadHex: "",
        ...(payload ? { webpushPayloadBytes: payload } : {}),
      });
    } catch {
      // Silently swallow — push failures shouldn't surface as boot
      // failures. The pending row stays around so the next /consume
      // poll within the dedup window will skip the push, and a
      // later poll outside the window will retry.
    }
  };
}

/** Decode a hex string into bytes. Used by the DEMO_IRK_KEK secret
 *  loader; throws on non-hex / odd-length input so a malformed secret
 *  surfaces at deploy time rather than at the first admin-claim
 *  request. */
function hexDecode(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("DEMO_IRK_KEK must be even-length hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(v)) throw new Error("DEMO_IRK_KEK contains non-hex characters");
    out[i] = v;
  }
  return out;
}
