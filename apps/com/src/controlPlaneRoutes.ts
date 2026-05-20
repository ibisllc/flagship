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
  BrokerDnsClient,
  caKeypairFromEnv,
  CloudflareDnsClient,
  proxyDns01DeleteToBroker,
  proxyDns01PublishToBroker,
  handleAuthCodeIssue,
  handleAuthCodeLookup,
  handleAuthCodeRevoke,
  handleBuildTicketIssue,
  handleBuildTicketLookup,
  handleBuildTicketRedeem,
  handleBuildTicketRefresh,
  handleCaCert,
  handleCleanupApex,
  handleCompleteRePair,
  handleDeviceDisconnect,
  handleConsumeUnlockKey,
  handleDepositAutoUnlockLease,
  handleDepositUnlockKey,
  handleGetPendingUnlockApproval,
  handleGetRePair,
  handleInitiateRePair,
  handleListAutoUnlockLeases,
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
  handleGetSealedLuksKey,
  handlePutSealedLuksKey,
  handlePostInstallEvent,
  handleRegisterRck,
  handleRepublishServerDns,
  handleRoutingLookup,
  handleServerLookup,
  handleServerRegister,
  handleServerRevokeBySelf,
  handleSetRoutingTarget,
  handleUsernameClaim,
  handleUsersCheck,
  parseTestAccountsEnv,
  handleUsernameLookup,
  handlePostUsernameRename,
  handleGetUsernameAlias,
  handleGetUserPods,
  handleGetUsersDevices,
  handleGetAuditEvents,
  handlePostDaemonStatus,
  handleUserPubKeyCert,
  handleMarketplaceList,
  handleMarketplaceGet,
  handleMarketplaceSearch,
  handleMarketplaceRemove,
  handleMarketplaceInstall,
  handleMarketplaceScanResult,
  handleMarketplaceScanQueue,
  buildPushForwarder,
  wrapForwarderAsV12Fanout,
  handleGetEntitlementRevocations,
  handleListRevocations,
  handlePostEntitlementRevocations,
  handlePushRegister,
  handlePushRelay,
  handlePushRevoke,
  handleLlmPromoIssue,
  handleLlmPromoStatus,
  handleDeleteWebauthnRecovery,
  handleFetchWebauthnRecovery,
  handleFetchWrappedUmkWithToken,
  handleUploadWebauthnRecovery,
  handleGetUserIdentity,
  handlePutUserIdentity,
  handleCreateDemoUser,
  handleDeleteDemoUser,
  handleDemoUserConnect,
  handleDemoUserHeartbeat,
  handleDemoUserInstallComplete,
  handleGetDemoUser,
  handleListDemoUsers,
  handleAdminClaimAndIssue,
  handleAdminMintDeviceGrant,
  handleMintDeviceGrant,
  handleListDeviceGrants,
  handleRevokeDeviceGrant,
  type CaIssuer,
  type CaGate,
  type HandlerResponse,
  type HandlerResponseWithHeaders,
} from "@flagship/control-plane";
import { D1Storage, D1DemoUsersStorage, type D1Database } from "@flagship/storage";
import { workerCaTrustChain, caEnforceFromEnv } from "./caTrustChainLoader.js";
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
  /** IPv4 of the .services SNI passthrough listener (Fly anycast). */
  SERVICES_PASSTHROUGH_IPV4?: string;
  SERVICES_PASSTHROUGH_IPV6?: string;
  /** Hex-encoded Ed25519 pubkey of the marketplace scanner (Flagship-operated). */
  MARKETPLACE_SCANNER_PUBKEY_HEX?: string;
  /** Shared secret gating /api/admin/* operational endpoints. */
  FLAGSHIP_ADMIN_SECRET?: string;

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
}

const ROUTE_RE = {
  USERNAME_CLAIM: /^\/api\/username\/claim$/,
  USERS_CHECK: /^\/api\/users\/check$/,
  USERNAME_RENAME: /^\/api\/username\/rename$/,
  USERNAME_ALIAS: /^\/api\/username\/alias\/([^/]+)$/,
  USERNAME_LOOKUP: /^\/api\/username\/([^/]+)$/,
  AUTH_CODE_ISSUE: /^\/api\/auth-code\/issue$/,
  AUTH_CODE_REVOKE: /^\/api\/auth-code\/([^/]+)\/revoke$/,
  AUTH_CODE_LOOKUP: /^\/api\/auth-code\/([^/]+)$/,
  BUILD_TICKET_ISSUE: /^\/api\/build-tickets\/issue$/,
  BUILD_TICKET_REDEEM: /^\/api\/build-tickets\/redeem$/,
  BUILD_TICKET_REFRESH: /^\/api\/build-tickets\/([^/]+)\/refresh$/,
  BUILD_TICKET_LOOKUP: /^\/api\/build-tickets\/([^/]+)$/,
  SERVER_REGISTER: /^\/api\/server\/register$/,
  SERVER_LOOKUP: /^\/api\/server\/by-domain\/([^/]+)$/,
  SERVER_REVOKE_BY_SELF: /^\/api\/server\/by-domain\/([^/]+)\/revoke$/,
  PUBKEY_CERT: /^\/api\/users\/([^/]+)\/pubkey-cert$/,
  CA_CERT: /^\/api\/ca\/cert$/,
  RCK_REGISTER: /^\/api\/routing\/register-rck$/,
  RCK_SET_TARGET: /^\/api\/routing\/set-target$/,
  ROUTING_LOOKUP: /^\/api\/routing\/lookup$/,
  INSTALL_EVENTS: /^\/api\/install-events\/([^/]+)$/,
  DNS01_PUBLISH: /^\/api\/dns-01\/publish$/,
  DNS01_DELETE: /^\/api\/dns-01\/delete$/,
  LUKS_SEALED: /^\/api\/server\/([^/]+)\/sealed-luks-key$/,
  LUKS_UNLOCK_DEPOSIT: /^\/api\/server\/([^/]+)\/unlock-key$/,
  LUKS_UNLOCK_CONSUME: /^\/api\/server\/([^/]+)\/unlock-key\/consume$/,
  LUKS_LEASE_DEPOSIT: /^\/api\/server\/([^/]+)\/unlock-key\/lease$/,
  LUKS_LEASE_REVOKE: /^\/api\/server\/([^/]+)\/unlock-key\/lease\/([^/]+)$/,
  LUKS_LEASE_LIST: /^\/api\/server\/([^/]+)\/unlock-key\/leases$/,
  UNLOCK_APPROVALS_PENDING: /^\/api\/unlock\/approvals\/pending$/,
  USER_PODS: /^\/api\/users\/([^/]+)\/pods$/,
  USER_DEVICES: /^\/api\/users\/([^/]+)\/devices$/,
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
  MARKETPLACE_LIST: /^\/api\/marketplace\/list$/,
  MARKETPLACE_SEARCH: /^\/api\/marketplace\/search$/,
  MARKETPLACE_GET: /^\/api\/marketplace\/([^/]+)\/([^/]+)$/,
  MARKETPLACE_INSTALL: /^\/api\/marketplace\/([^/]+)\/([^/]+)\/install$/,
  MARKETPLACE_SCAN_RESULT: /^\/api\/marketplace\/([^/]+)\/([^/]+)\/scan$/,
  PUSH_REGISTER: /^\/api\/push\/register$/,
  PUSH_RELAY: /^\/api\/push\/relay$/,
  PUSH_VAPID_KEY: /^\/api\/push\/vapid-public-key$/,
  PUSH_REVOKE: /^\/api\/push\/([^/]+)$/,
  LLM_PROMO_ISSUE: /^\/api\/llm-promo\/issue$/,
  LLM_PROMO_STATUS: /^\/api\/llm-promo\/status\/([^/]+)$/,
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
  INTERNAL_MARKETPLACE_SCAN_QUEUE: /^\/api\/internal\/marketplace-scan-queue$/,
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
  DEMO_USER_INSTALL_COMPLETE: /^\/api\/dev\/sample-user\/([^/]+)\/install-complete$/,
  DEMO_USER_CONNECT: /^\/api\/dev\/sample-user\/([^/]+)\/connect$/,
  DEMO_USER_HEARTBEAT: /^\/api\/dev\/sample-user\/([^/]+)\/heartbeat$/,
  DEMO_USER_GET: /^\/api\/dev\/sample-user\/([^/]+)$/,
  DEMO_USER_LIST: /^\/api\/dev\/sample-user$/,
  // v2 device-addressing public endpoints (S3.3).
  DEVICE_GRANTS_LIST: /^\/api\/users\/([^/]+)\/device-grants$/,
  DEVICE_GRANTS_REVOKE: /^\/api\/users\/([^/]+)\/device-grants\/revoke$/,
};

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
  if (method === "POST" && ROUTE_RE.USERNAME_CLAIM.test(path)) {
    return finish(await handleUsernameClaim({ storage: storage.usernames }, await readJson(request)));
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
        { storage: storage.authCodes, usernames: storage.usernames },
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

  if (method === "POST" && ROUTE_RE.BUILD_TICKET_ISSUE.test(path)) {
    return finish(
      await handleBuildTicketIssue(
        { storage: storage.buildTickets, usernames: storage.usernames },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && ROUTE_RE.BUILD_TICKET_REDEEM.test(path)) {
    return finish(
      await handleBuildTicketRedeem(
        { storage: storage.buildTickets, usernames: storage.usernames },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.BUILD_TICKET_REFRESH))) {
    return finish(
      await handleBuildTicketRefresh(
        { storage: storage.buildTickets, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.BUILD_TICKET_LOOKUP))) {
    if (m[1] === "issue" || m[1] === "redeem") return null;
    return finish(
      await handleBuildTicketLookup(
        { storage: storage.buildTickets, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
      ),
    );
  }

  if (method === "POST" && ROUTE_RE.SERVER_REGISTER.test(path)) {
    // Prefer the broker (production posture). Fall back to direct
    // CloudflareDnsClient only when no broker URL is configured —
    // typically the local-dev path.
    const dnsClient = env.DNS_BROKER_URL
      ? new BrokerDnsClient({ brokerUrl: env.DNS_BROKER_URL })
      : env.CLOUDFLARE_DNS_API_TOKEN && env.CLOUDFLARE_SERVICES_ZONE_ID
        ? new CloudflareDnsClient({
            apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
            zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID,
          })
        : null;
    const dns =
      dnsClient && env.SERVICES_PASSTHROUGH_IPV4
        ? {
            client: dnsClient,
            servicesIpv4: env.SERVICES_PASSTHROUGH_IPV4,
            servicesIpv6: env.SERVICES_PASSTHROUGH_IPV6,
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
          ...(srForwarder ? { forwardToProviders: srForwarder } : {}),
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

  if (method === "POST" && ROUTE_RE.RCK_REGISTER.test(path)) {
    return finish(
      await handleRegisterRck(
        { routing: storage.routing, usernames: storage.usernames },
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
    const res = await handler({ servers: storage.servers, dns }, await readJson(request));
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
    const forwarder = buildOptionalPushForwarder(env);
    return finishPlain(
      await handleConsumeUnlockKey(
        {
          servers: storage.servers,
          usernames: storage.usernames,
          luksKeys: storage.luksKeys,
          autoUnlockLeases: storage.autoUnlockLeases,
          pendingUnlockApprovals: storage.pendingUnlockApprovals,
          pushUserDevices: forwarder
            ? buildPushUserDevices(storage.pushTokens, forwarder)
            : undefined,
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
          pendingUnlockApprovals: storage.pendingUnlockApprovals,
        },
        host,
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && ROUTE_RE.UNLOCK_APPROVALS_PENDING.test(path)) {
    const serverFqdn = url.searchParams.get("serverFqdn");
    if (!serverFqdn) {
      return finishPlain({
        status: 400,
        body: { error: "serverFqdn query param required" },
      });
    }
    return finishPlain(
      await handleGetPendingUnlockApproval(
        {
          servers: storage.servers,
          usernames: storage.usernames,
          luksKeys: storage.luksKeys,
          pendingUnlockApprovals: storage.pendingUnlockApprovals,
        },
        serverFqdn,
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
  if (method === "POST" && (m = path.match(ROUTE_RE.LUKS_UNLOCK_DEPOSIT))) {
    const host = decodeURIComponent(m[1]!);
    return finishPlain(
      await handleDepositUnlockKey(
        {
          servers: storage.servers,
          usernames: storage.usernames,
          luksKeys: storage.luksKeys,
        },
        host,
        await readJson(request),
      ),
    );
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
        },
        decodeURIComponent(m[1]!),
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
        },
        decodeURIComponent(m[1]!),
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
        },
        await readJson(request),
      ),
    );
  }
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
  if (method === "GET" && ROUTE_RE.INTERNAL_MARKETPLACE_SCAN_QUEUE.test(path)) {
    const sd = parseInt(url.searchParams.get("staleDays") ?? "", 10);
    return finish(
      await handleMarketplaceScanQueue(
        { marketplace: storage.marketplace },
        bearer(request.headers.get("authorization")),
        env.SERVICES_CONTROL_SECRET,
        Number.isFinite(sd) ? sd : undefined,
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
      await handleCleanupApex({ dns, apex: "flagship.services" }),
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

  // ── Marketplace ──────────────────────────────────────────────
  if (method === "POST" && ROUTE_RE.MARKETPLACE_LIST.test(path)) {
    return finish(
      await handleMarketplaceList(
        { marketplace: storage.marketplace, usernames: storage.usernames },
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && ROUTE_RE.MARKETPLACE_SEARCH.test(path)) {
    const limit = parseInt(url.searchParams.get("limit") ?? "30", 10) || 30;
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10) || 0;
    const sortRaw = url.searchParams.get("sort");
    const sort = sortRaw === "newest" || sortRaw === "name" || sortRaw === "popular" ? sortRaw : undefined;
    return finish(
      await handleMarketplaceSearch(
        { marketplace: storage.marketplace, usernames: storage.usernames },
        {
          text: url.searchParams.get("q") ?? undefined,
          category: url.searchParams.get("cat") ?? undefined,
          verifiedOnly: url.searchParams.get("verified") === "1",
          limit,
          offset,
          sort,
        },
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.MARKETPLACE_GET))) {
    return finish(
      await handleMarketplaceGet(
        { marketplace: storage.marketplace, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
        decodeURIComponent(m[2]!),
      ),
    );
  }
  if (method === "DELETE" && (m = path.match(ROUTE_RE.MARKETPLACE_GET))) {
    return finish(
      await handleMarketplaceRemove(
        { marketplace: storage.marketplace, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
        decodeURIComponent(m[2]!),
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.MARKETPLACE_INSTALL))) {
    return finish(
      await handleMarketplaceInstall(
        { marketplace: storage.marketplace, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
        decodeURIComponent(m[2]!),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.MARKETPLACE_SCAN_RESULT))) {
    if (!env.MARKETPLACE_SCANNER_PUBKEY_HEX) {
      return finishPlain({
        status: 503,
        body: { error: "marketplace scanner not configured on this deployment" },
      });
    }
    let scannerPubkey: Uint8Array;
    try {
      const hex = env.MARKETPLACE_SCANNER_PUBKEY_HEX;
      scannerPubkey = new Uint8Array(hex.length / 2);
      for (let i = 0; i < scannerPubkey.length; i++) {
        scannerPubkey[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
    } catch {
      return finishPlain({ status: 500, body: { error: "scanner pubkey misconfigured" } });
    }
    return finish(
      await handleMarketplaceScanResult(
        { marketplace: storage.marketplace, scannerPubkey },
        await readJson(request),
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
          ...(forwarder ? { forwardToProviders: forwarder } : {}),
        },
        await readJson(request),
      ),
    );
  }
  if (method === "DELETE" && (m = path.match(ROUTE_RE.PUSH_REVOKE))) {
    return finish(
      await handlePushRevoke(
        { pushTokens: storage.pushTokens, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }

  // ── LLM promo ──────────────────────────────────────────────
  if (method === "POST" && ROUTE_RE.LLM_PROMO_ISSUE.test(path)) {
    return finish(
      await handleLlmPromoIssue(
        {
          llmPromo: storage.llmPromo,
          tiers: storage.tiers,
          usernames: storage.usernames,
          // #85 — enforce the demo rolling-token ceiling in production.
          demoLlmLedger: storage.demoLlmLedger,
          // Stub minter: returns a deterministic fake key. Real Worker
          // wiring calls the upstream provider's scoped-key API.
          mintProviderKey: async (args) => ({
            key: `fk-${args.provider}-${args.username}-${args.expiresAt}`,
            providerKeyId: `pkid-${args.expiresAt}`,
          }),
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

  // ── Entitlement revocation lists (N12c) ───────────────────────
  if (method === "POST" && ROUTE_RE.CERT_REVOCATIONS_POST.test(path)) {
    return finishPlain(
      await handlePostEntitlementRevocations(
        {
          storage: storage.entitlementRevocations,
          usernames: storage.usernames,
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
    const demoDeps = {
      storage: storage.demoUsers,
      usernames: storage.usernames,
      hetzner: lazyHetzner,
      sshKeyId,
      audit: storage.auditEvents,
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
