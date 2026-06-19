/**
 * `/api/screens/*` BFF endpoints.
 *
 * One handler module, per-endpoint dispatch. All routes are paired-
 * session gated. Each handler returns a view-shaped response (see
 * `./types.ts`) tailored to a single webapp / mobile screen.
 *
 * Deps are injected — handlers degrade with `503 not configured` when
 * an underlying subsystem is null. This keeps the dispatch layer
 * agnostic to which features the calling daemon happens to have wired
 * (browser bundle, backups, vibe-code, Forgejo, ...).
 */

import type { PairedSessionGate } from "../alertInboxHttp.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { ServicePlatform, InstalledService } from "../servicePlatform.js";
import type { AppBackupService } from "../serviceBackup.js";
import type { AppMembership } from "../membership.js";
import type { FilePairedSessionStore } from "../pairedSessionStore.js";
import type { TabRegistry } from "../browser/tabRegistry.js";
import type {
  VibeCodeSession,
  VibeCodeSessionRegistry,
} from "../llm/vibeCodeSession.js";
import type { AppEnvStore } from "../serviceEnvStore.js";
import type { BuildCredentialStore } from "../llm/buildCredentialStore.js";
import type { LlmCredential } from "../llmHarness.js";
import {
  summarizeAttachment,
  validateAttachments,
} from "../llm/vibeCodeAttachments.js";
import type { Attachment, FetchLike } from "@flagship/llm-providers";
import { verifySetServiceEnv } from "@flagship/protocol";
import type {
  AppBackupStartRequest,
  AppBackupStartResponse,
  AppDetailResponse,
  AppInviteAccessResponse,
  AppInviteIssueRequest,
  AppInviteIssueResponse,
  AppInviteListResponse,
  AppInviteRevokeRequest,
  AppInviteRevokeResponse,
  AppsListResponse,
  AppSummary,
  BrowserTab,
  BrowserTabsListResponse,
  LineagePausedListResponse,
  LineagePauseSummary,
  LineageResolveRequest,
  LineageResolveResponse,
  OrdersSendRequest,
  OrdersSendResponse,
  OwnedUrl,
  PairedSessionsListResponse,
  PeerBackupStatusResponse,
  PeerBackupToggleRequest,
  RecentInstallEvent,
  ReleaseStatusResponse,
  ServerDetailResponse,
  ServiceEnvListResponse,
  ServiceEnvOpResponse,
  ServiceEnvSetRequest,
  ServiceEnvUnsetRequest,
  UrlControllerClaimRequest,
  UrlControllerOwnedResponse,
  VerifyCustomDomainRequest,
  VerifyCustomDomainResponse,
  ServerMetricsResponse,
  VibeCodeReplyRequest,
  VibeCodeReplyResponse,
  VibeCodeSessionPublicState,
  VibeCodeStartRequest,
  VibeCodeStartResponse,
  VibeCodeStatusResponse,
} from "./types.js";
import {
  buildPeerBackupStatus,
  type PeerBackupSnapshotDeps,
} from "./peerBackupStatus.js";
import {
  issueAppInvite,
  projectAccessRows,
  projectPendingInvites,
  type AppInviteBffDeps,
} from "./appInvite.js";
import type { AppInviteStore } from "../inviteHandler.js";
import {
  denyCompanionWrite,
  handleListCompanions,
  handleMintTicket,
  handleRedeemTicket,
  handleRevokeCompanion,
  type CompanionBffDeps,
} from "./companion.js";
import {
  handleMyPending,
  handlePendingWrites,
  handleRequestWrite,
  handleResolvePending,
  type CompanionWriteRelayDeps,
} from "./companionWriteRelay.js";
import type { BackupLoop } from "../backupLoop.js";
import { collectServerMetrics, type ServerMetricsProvider } from "./serverMetrics.js";
import { verifyCustomDomain, type DnsResolver } from "./verifyCustomDomain.js";
import {
  toReleaseStatusResponse,
  type ReleaseStatusProvider,
} from "../releaseStatusProvider.js";

const J = { "content-type": "application/json" } as const;

export interface UrlControllerLike {
  claim(fqdn: string): Promise<void>;
  release(fqdn: string): Promise<void>;
  list(): string[];
}

export interface InstallEventLog {
  /** Most-recent first; capped to N at the source. */
  recent(): RecentInstallEvent[];
}

/**
 * Phone-tap resolver for the update-pack lineage-break auto-pause.
 *
 * The daemon's update-puller marks an app `lineagePaused: true` when
 * the lineage verifier refuses a new pack. The phone view fetches the
 * paused list, then POSTs `{ serviceId, decision }` to roll the anchor
 * forward (`accept`) or uninstall the app entirely (`revoke`).
 *
 * Wiring: production daemon supplies an adapter that:
 *   - `list()` walks the AppPullStateStore for entries with `lineagePaused`
 *   - `accept(serviceId)` delegates to `UpdateClient.acceptLineageBreak`
 *   - `revoke(serviceId)` calls `ServicePlatform.uninstall` directly (it's a
 *     phone-gated action; the BFF's paired-session check is the trust
 *     equivalent of the host's IRK signature in this context)
 */
export interface LineageResolverLike {
  list(): Promise<LineagePauseSummary[]>;
  accept(serviceId: string): Promise<{ ok: boolean; outcome: "accepted" | "already-clear"; reason?: string }>;
  revoke(serviceId: string): Promise<{ ok: boolean; reason?: string }>;
}

export interface ScreensHttpDeps {
  gate: PairedSessionGate;
  serverFqdn: string;
  username: string;
  daemonVersion: string;
  /** Unix-ms when the daemon started. */
  startedAt: number;
  servicePlatform?: ServicePlatform | null;
  pairedSessions?: FilePairedSessionStore | null;
  /**
   * Live cert info for server-detail. The runtime supplies a small
   * snapshot here at install time; the screens layer doesn't read the
   * cert chain itself (no PEM parsing in the BFF).
   */
  certInfo?: (() => { notAfter?: number; notBefore?: number; sans?: string[] } | null) | null;
  /** Recent install/uninstall events for server-detail. */
  installEventLog?: InstallEventLog | null;
  /** Tab ownership for app-detail / browser-tabs. */
  tabRegistry?: TabRegistry | null;
  /** Backups for app-detail "lastBackup" + backup start. */
  appBackup?: AppBackupService | null;
  /** Url-controller for owned + claim. */
  urlController?: UrlControllerLike | null;
  /** Vibe-code orchestration. Required by P1.5/P1.7. */
  vibeCode?: VibeCodeRuntime | null;
  /** Phone-orders dispatcher. Required by P1.14. */
  ordersDispatch?: OrdersDispatchLike | null;
  /** .com control plane URL for proxy endpoints (tier, install-events). */
  controlPlaneBaseUrl?: string | null;
  /** Override fetch for .com proxies (tests inject; production uses globalThis.fetch). */
  fetchImpl?: FetchLike;
  /** Test seam — derives the calling client's session token from the request. */
  resolveCallerToken?: (req: HttpRequest) => string | null;
  /** Test seam — clock for any timing-sensitive responses. */
  now?: () => number;
  /**
   * Optional offline-verified view of Flagship's own `.maintainers/`
   * folder. Powers GET /api/screens/release-status. When unset, the
   * endpoint reports an empty status — the daemon may have been
   * deployed outside a git clone with `.maintainers/`.
   */
  releaseStatus?: ReleaseStatusProvider | null;
  /**
   * Snapshot provider for the J.4 post-recovery membership re-attach
   * report. The webapp polls this after a recovery completes; the
   * daemon-side runner stashes the latest ReissuanceReport in a slot
   * that this thunk reads. Null when no recovery has happened on this
   * daemon since boot.
   */
  postRecoveryStatus?: (() => unknown | null) | null;
  /**
   * Resolver for the update-pack lineage-break auto-pause. Powers
   * `GET + POST /api/screens/lineage-resolve`. When unset, the GET
   * returns an empty list and POST returns 503.
   */
  lineageResolver?: LineageResolverLike | null;
  /**
   * Snapshot provider for /api/screens/server-metrics/:podId. The
   * default reads from /proc on Linux and returns zero-valued
   * placeholders on darwin. Tests inject a deterministic provider.
   */
  serverMetrics?: ServerMetricsProvider | null;
  /**
   * DNS resolver for /api/screens/url-controller/verify. The default
   * uses Cloudflare DoH (no native dependency); tests inject a stub.
   */
  dnsResolver?: DnsResolver | null;
  /**
   * W10 — per-app env-var store. Required by the
   * /api/screens/services/:appId/env/* handlers. Same store the
   * `vibeCode.appEnvStore` injection point uses; surfaces names ONLY
   * (the .names() accessor) for `GET /env`, and routes signed
   * SetServiceEnvRequest envelopes into the running ServicePlatform's
   * setEnv() for /set + /unset. Values never echo through any response.
   */
  appEnvStore?: AppEnvStore | null;
  /**
   * W10 — resolver for the vibe-code session's editing app id. The
   * /api/screens/llm/sessions/<id>/reply handler uses this to decide
   * which app to credit a requestEnvVar ack against. Same shape as
   * VibeCodeHttpDeps.resolveAppId; default is "first installed app's
   * id" in tests, production reads from the session's pending manifest.
   */
  resolveSessionAppId?: ((session: VibeCodeSession) => string | null) | null;
  /**
   * P9 — Snapshot-builder deps for the /api/screens/peer-backup/*
   * endpoints. The toggle handler reuses `peerBackup.backupLoop` to
   * flip the participation flag; the status handler projects the
   * combined view from the registry + repair stats. All sub-deps are
   * optional — the BFF surfaces an honest "not participating, empty"
   * payload when no peer-backup state is wired.
   */
  peerBackup?: PeerBackupSnapshotDeps | null;
  /**
   * P6 — Collaborator-invite endpoints (`/api/screens/app-invite/*`).
   * The webapp's `invite-issue.js` + `invite-manage.js` drive these.
   * When unset, the four endpoints respond 503 — the webapp degrades
   * gracefully ("BFF wrapper not yet wired; access list not available
   * in this build"). Production should pass the same
   * `AppInviteStore` that `buildInviteHandler` uses so the bearer +
   * signed surfaces share state.
   */
  appInvite?: AppInviteBffDeps | null;
  /**
   * P14 — Companion-browser dock. Wires the four
   * /api/screens/companion/* endpoints + the PUBLIC /api/companion/
   * redeem endpoint into the screens dispatch. The redeem path is
   * intentionally NOT gated by the paired-session check — the
   * ticketId+secret IS the proof of authorization (the owner minted
   * the ticket via the gated mint-ticket endpoint and handed it to
   * the companion via a QR code).
   *
   * When unset, all four endpoints return 503 — the webapp + mobile
   * surfaces degrade with an empty companion-list rather than
   * pretending the feature is on.
   */
  companion?: CompanionBffDeps | null;
}

export interface VibeCodeRuntime {
  registry: VibeCodeSessionRegistry;
  /** Username on whose behalf to spawn sessions. */
  username: string;
  /** Server FQDN for the spawned session metadata. */
  serverFqdn: string;
  /**
   * Transient, sealed-at-rest BYOK credential store keyed by sessionId.
   * The start/reply handlers store a delivered credential here; the
   * `startStreaming` thunk opens it just-in-time for the provider call.
   * When omitted, the start path can never stream (always
   * `needsCredential: true`) — the daemon was wired without BYOK.
   *
   * flagshipserver.com is NEVER in this path — the credential arrives
   * over the paired-session-gated pinned pipe and never leaves the box.
   */
  credentials?: BuildCredentialStore;
  /**
   * Non-streaming convenience: when supplied, P1.5's "start" handler
   * fires-and-forgets a session-driving task that pushes assistant
   * tokens into the session. P1.6 (WS stream) replays them. When
   * omitted, the session is created empty and the consumer must drive
   * it some other way (e.g. via the existing /api/llm/sessions feed).
   */
  startStreaming?: (args: {
    sessionId: string;
    prompt: string;
    model?: string;
    attachments?: Attachment[];
  }) => Promise<void>;
  /**
   * Re-invoke the model after the owner answered a `talkToUser` question or
   * acked a `requestEnvVar`. Without this, a reply appends to the session and
   * flips it back to `streaming` but the LLM is never resumed — so a
   * chat-guided build stalls forever after the first question. The thunk
   * rebuilds the request from the FULL conversation history so the model
   * continues. Same box-only / value-free contract as `startStreaming`.
   * Optional: when omitted, replies are recorded but the model is not resumed
   * (the pre-existing behaviour).
   */
  resumeStreaming?: (sessionId: string, model?: string) => Promise<void>;
  /**
   * Value-free journal hook for a scratch chat turn. The daemon wires
   * this to the shared build journal (buildId = the vibe sessionId) so
   * scratch turns appear alongside git/mcp builds. `attachmentSummaries`
   * are NAME + kind + size strings ONLY — never the content/base64 — so
   * the journal never captures an attachment value. Fire-and-forget;
   * never blocks the chat. Optional: omitted in tests that don't assert
   * journaling.
   */
  recordScratchTurn?: (args: {
    sessionId: string;
    text: string;
    attachmentSummaries: string[];
  }) => void;
}

export interface OrdersDispatchLike {
  /** Dispatch an already-verified PhoneOrder envelope. Returns optional response payload. */
  dispatch(args: {
    envelope: Buffer;
  }): Promise<{ ok: boolean; response?: Record<string, unknown> }>;
}

export function buildScreensHttp(deps: ScreensHttpDeps) {
  const now = deps.now ?? (() => Date.now());

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    const rawPath = req.path.split("?")[0]!;

    // ---- P14 PUBLIC /api/companion/redeem ----
    //
    // Mounted on a NON-/api/screens/ path because there is no
    // paired-session token yet — the ticket itself is the proof. The
    // owner minted it via the gated /api/screens/companion/mint-ticket
    // endpoint; this is where the holder exchanges it for a
    // 4-hour companion paired-session.
    if (rawPath === "/api/companion/redeem" && req.method.toUpperCase() === "POST") {
      if (!deps.companion) return jerr(503, "companion dock not configured");
      return await handleRedeemTicket(deps.companion, req);
    }

    // ---- P14 Phase 2 — companion-side write-relay endpoints ----
    //
    // These live OUTSIDE /api/screens/ (the companion's webapp/SDK
    // calls them with a companion paired-session token), but they are
    // STILL gated — the redeem endpoint is the only truly public
    // companion path. We explicitly run the paired-session gate here
    // before dispatching.
    if (
      (rawPath === "/api/companion/request-write" &&
        req.method.toUpperCase() === "POST") ||
      (rawPath === "/api/companion/my-pending" &&
        req.method.toUpperCase() === "GET")
    ) {
      if (!deps.companion) return jerr(503, "companion dock not configured");
      if (!deps.companion.writeRequestStore) {
        return jerr(503, "companion write-relay not configured");
      }
      const denied = deps.gate.check(req);
      if (denied) return denied;
      const relayDeps: CompanionWriteRelayDeps = {
        writeRequestStore: deps.companion.writeRequestStore,
        pairedSessions: deps.companion.pairedSessions,
      };
      if (deps.companion.now) relayDeps.now = deps.companion.now;
      if (deps.companion.randomBytes) relayDeps.randomBytes = deps.companion.randomBytes;
      if (typeof deps.companion.writeRequestTtlMs === "number") {
        relayDeps.ttlMs = deps.companion.writeRequestTtlMs;
      }
      if (rawPath === "/api/companion/request-write") {
        return await handleRequestWrite(relayDeps, req);
      }
      return await handleMyPending(relayDeps, req);
    }

    if (!req.path.startsWith("/api/screens/")) return null;
    const denied = deps.gate.check(req);
    if (denied) return denied;

    const path = rawPath;
    const method = req.method.toUpperCase();

    // ---- P14 companion-write guard ----
    //
    // Companions are read-only on destination endpoints. Any path
    // that mutates paired-session-bound state returns 403 with
    // `companion-write-not-allowed` — the webapp catches it and tells
    // the user to open their owner app to approve. Phase 2 (above)
    // adds an *opt-in* relay path (`/api/companion/request-write`)
    // companions take to queue an intent for the owner to sign +
    // dispatch; this 403 gate STAYS as the default.
    //
    // The list of representative write endpoints is the set that
    // performs signed-envelope mutations OR paired-session-authorized
    // mutations on this pod: app-invite issue/revoke, peer-backup
    // toggle, env-var set/unset, lineage-resolve POST,
    // app-backup/start, orders/send, url-controller/claim, and the
    // mint-ticket itself (a companion shouldn't be able to mint more
    // companions). The gate already authenticated; this is just the
    // companion-write check on top.
    if (method !== "GET" && isWriteScopedPath(path)) {
      const denied = denyCompanionWrite(deps.pairedSessions ?? null, req);
      if (denied) return denied;
    }

    // ---- P14 /api/screens/companion/* ----
    //
    // Owner-gated companion-dock administration. Mint a ticket the QR
    // code carries; list active companions; revoke by tokenPrefix.
    // The write-guard above already returned 403 if a companion is
    // calling mint-ticket / revoke.
    if (path === "/api/screens/companion/mint-ticket" && method === "POST") {
      if (!deps.companion) return jerr(503, "companion dock not configured");
      return await handleMintTicket(deps.companion, req);
    }
    if (path === "/api/screens/companion/list" && method === "GET") {
      if (!deps.companion) return jerr(503, "companion dock not configured");
      return await handleListCompanions(deps.companion);
    }
    if (path === "/api/screens/companion/revoke" && method === "POST") {
      if (!deps.companion) return jerr(503, "companion dock not configured");
      return await handleRevokeCompanion(deps.companion, req);
    }

    // ---- P14 Phase 2 — owner-side write-relay endpoints ----
    //
    // GET /pending-writes lists every unresolved+non-expired row;
    // POST /resolve-pending marks a row approved/denied. Both are
    // owner-gated (the write-scope guard above already 403'd a
    // companion calling /resolve-pending — see isWriteScopedPath()).
    //
    // PHASE 2.5 HOOK: the resolve-pending handler currently relies
    // on the companion to POLL /api/companion/my-pending for the
    // outcome. When push lands, fire a per-companion
    // `notifyCompanion(row.companionTokenPrefix, { kind: "write-resolved",
    // requestId, outcome })` from inside handleResolvePending.
    if (
      (path === "/api/screens/companion/pending-writes" && method === "GET") ||
      (path === "/api/screens/companion/resolve-pending" && method === "POST")
    ) {
      if (!deps.companion) return jerr(503, "companion dock not configured");
      if (!deps.companion.writeRequestStore) {
        return jerr(503, "companion write-relay not configured");
      }
      const relayDeps: CompanionWriteRelayDeps = {
        writeRequestStore: deps.companion.writeRequestStore,
        pairedSessions: deps.companion.pairedSessions,
      };
      if (deps.companion.now) relayDeps.now = deps.companion.now;
      if (deps.companion.randomBytes) relayDeps.randomBytes = deps.companion.randomBytes;
      if (typeof deps.companion.writeRequestTtlMs === "number") {
        relayDeps.ttlMs = deps.companion.writeRequestTtlMs;
      }
      if (path === "/api/screens/companion/pending-writes") {
        return await handlePendingWrites(relayDeps);
      }
      return await handleResolvePending(relayDeps, req);
    }

    // ---- WS-upgrade-only endpoints (P1.6 + P1.11)
    // These paths normally don't reach the HTTP dispatch at all — the
    // runtime's upgrade-handler chain detects WebSocket upgrades and
    // detaches the socket before this function is called. If a
    // non-WS GET lands here (e.g. a curl probe), respond 501 with a
    // hint. P1.6 vibe-code-stream is wired in screens/screensWs.ts;
    // P1.11 browser-tabs framebuffer is still unimplemented.
    if (path.startsWith("/api/screens/vibe-code/") && path.endsWith("/stream")) {
      return jerr(
        501,
        "use a WebSocket upgrade; or poll /api/screens/vibe-code/<id>",
      );
    }
    if (path.startsWith("/api/screens/browser-tabs/") && path.endsWith("/stream")) {
      return jerr(
        501,
        "framebuffer streaming not yet implemented; poll /api/screens/browser-tabs/list/<serviceId>",
      );
    }
    if (path.startsWith("/api/screens/install-events/") && method === "GET") {
      // P1.15 — JSON poll proxy for install events.
      //
      // The cycle plan calls for SSE here. The .com side returns
      // plain JSON (`GET /api/install-events/<serial>?since=N`), and
      // the daemon's HTTP handler chain doesn't currently support
      // streaming responses. So we ship a thin polling proxy: webapp
      // / mobile clients call this every ~2s during install and we
      // relay the upstream payload. SSE on top can land later as a
      // pure server-side optimisation without any client change.
      const f = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
      if (!deps.controlPlaneBaseUrl) return jerr(503, "control plane not configured");
      const serial = decodeURIComponent(
        path.slice("/api/screens/install-events/".length),
      );
      if (!serial) return jerr(400, "serial required");
      const sinceParam = (() => {
        const qIdx = req.path.indexOf("?");
        if (qIdx < 0) return "0";
        return new URLSearchParams(req.path.slice(qIdx + 1)).get("since") ?? "0";
      })();
      const upstreamUrl =
        `${trimSlash(deps.controlPlaneBaseUrl)}/api/install-events/${encodeURIComponent(serial)}?since=${encodeURIComponent(sinceParam)}`;
      try {
        const r = await f(upstreamUrl, { method: "GET" });
        if (!r.ok) return jerr(502, `install-events upstream: ${r.status}`);
        const text = await r.text();
        return { status: 200, headers: { ...J, "cache-control": "no-store" }, body: text };
      } catch (e) {
        return jerr(502, `install-events fetch failed: ${(e as Error).message}`);
      }
    }
    if (path.startsWith("/api/screens/install-events/")) {
      return jerr(405, "method not allowed");
    }

    // ---- P1.1 GET /api/screens/server-detail
    if (path === "/api/screens/server-detail" && method === "GET") {
      return jok(serverDetail(deps, now));
    }

    // ---- P1.2 GET /api/screens/apps-list
    if (path === "/api/screens/apps-list" && method === "GET") {
      const apps = deps.servicePlatform
        ? deps.servicePlatform.list().map((a) => toSummary(a, deps.serverFqdn))
        : [];
      const body: AppsListResponse = { apps };
      return jok(body);
    }

    // ---- P1.3 GET /api/screens/app-detail/:serviceId
    if (path.startsWith("/api/screens/app-detail/") && method === "GET") {
      const serviceId = decodeURIComponent(path.slice("/api/screens/app-detail/".length));
      if (!deps.servicePlatform) return jerr(503, "app-platform not configured");
      const app = deps.servicePlatform.byServiceId(serviceId);
      if (!app) return jerr(404, "app not found");
      return jok(appDetail(app, deps));
    }

    // ---- P1.12 GET /api/screens/paired-sessions/list
    if (path === "/api/screens/paired-sessions/list" && method === "GET") {
      if (!deps.pairedSessions) return jerr(503, "paired-sessions not configured");
      const callerToken = (deps.resolveCallerToken ?? defaultResolveCallerToken)(req);
      const sessions = deps.pairedSessions.list().map((s) => ({
        tokenPrefix: s.token.slice(0, 12),
        label: s.label,
        addedAt: s.addedAt,
        current: callerToken !== null && s.token === callerToken,
      }));
      const body: PairedSessionsListResponse = { sessions };
      return jok(body);
    }

    // ---- P1.13 DELETE /api/screens/paired-sessions/:tokenPrefix
    if (
      path.startsWith("/api/screens/paired-sessions/") &&
      method === "DELETE" &&
      path !== "/api/screens/paired-sessions/list"
    ) {
      if (!deps.pairedSessions) return jerr(503, "paired-sessions not configured");
      const prefix = decodeURIComponent(
        path.slice("/api/screens/paired-sessions/".length),
      );
      if (prefix.length < 8) return jerr(400, "tokenPrefix must be at least 8 chars");
      const match = deps.pairedSessions
        .list()
        .filter((s) => s.token.startsWith(prefix));
      if (match.length === 0) return jerr(404, "no session matches that prefix");
      if (match.length > 1) return jerr(409, "ambiguous prefix; provide more chars");
      await deps.pairedSessions.remove(match[0]!.token);
      return jok({ ok: true });
    }

    // ---- P1.17 GET /api/screens/url-controller/owned
    if (path === "/api/screens/url-controller/owned" && method === "GET") {
      const fqdns = deps.urlController?.list() ?? [];
      const urls: OwnedUrl[] = [
        // The canonical FQDN is always owned implicitly.
        {
          fqdn: deps.serverFqdn,
          kind: "canonical",
          claimedAt: deps.startedAt,
        },
        ...fqdns.map((fqdn) => ({
          fqdn,
          kind: classifyClaimedFqdn(fqdn, deps.serverFqdn),
          claimedAt: deps.startedAt,
        })),
      ];
      const body: UrlControllerOwnedResponse = { urls };
      return jok(body);
    }

    // ---- P1.18 POST /api/screens/url-controller/claim
    if (path === "/api/screens/url-controller/claim" && method === "POST") {
      if (!deps.urlController) return jerr(503, "url-controller not configured");
      const body = parseJson(req.body) as UrlControllerClaimRequest | null;
      if (!body || typeof body.fqdn !== "string" || body.fqdn.length === 0) {
        return jerr(400, "fqdn required");
      }
      try {
        await deps.urlController.claim(body.fqdn);
      } catch (e) {
        return jerr(502, `claim failed: ${(e as Error).message}`);
      }
      return jok({ ok: true });
    }

    // ---- P1.22 POST /api/screens/url-controller/verify
    if (path === "/api/screens/url-controller/verify" && method === "POST") {
      const body = parseJson(req.body) as VerifyCustomDomainRequest | null;
      if (!body || typeof body.fqdn !== "string" || body.fqdn.length === 0) {
        return jerr(400, "fqdn required");
      }
      const result = await verifyCustomDomain({
        fqdn: body.fqdn,
        serverFqdn: deps.serverFqdn,
        resolver: deps.dnsResolver ?? null,
        fetchImpl: deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
      });
      const out: VerifyCustomDomainResponse = result;
      return jok(out);
    }

    // ---- P1.21 GET /api/screens/server-metrics/:podId
    if (path.startsWith("/api/screens/server-metrics/") && method === "GET") {
      const podId = decodeURIComponent(
        path.slice("/api/screens/server-metrics/".length),
      );
      if (!podId) return jerr(400, "podId required");
      const snapshot = await collectServerMetrics({
        provider: deps.serverMetrics ?? null,
        now,
      });
      const out: ServerMetricsResponse = snapshot;
      return jok(out);
    }

    // ---- P1.5 POST /api/screens/vibe-code/start
    if (path === "/api/screens/vibe-code/start" && method === "POST") {
      if (!deps.vibeCode) return jerr(503, "vibe-code not configured");
      const body = parseJson(req.body) as VibeCodeStartRequest | null;
      if (!body || typeof body.prompt !== "string" || body.prompt.length === 0) {
        return jerr(400, "prompt required");
      }
      const attach = validateAttachments(body.attachments);
      if (!attach.ok) return jerr(400, attach.reason);
      const cred = parseCredential((body as { credential?: unknown }).credential);
      if (cred === "invalid") return jerr(400, "malformed credential");
      const session = deps.vibeCode.registry.create({
        username: deps.vibeCode.username,
        serverFqdn: deps.vibeCode.serverFqdn,
      });
      session.pushUserMessage(body.prompt, attach.attachments);
      // Value-free journal: a short text preview + per-attachment
      // name/kind/size summaries (NEVER the content/base64). The
      // credential is NEVER journalled — at most the provider NAME, below.
      deps.vibeCode.recordScratchTurn?.({
        sessionId: session.meta.sessionId,
        text: body.prompt,
        attachmentSummaries: attach.attachments.map(summarizeAttachment),
      });
      // Seal the delivered BYOK credential for the session, if one came
      // (and a store is wired). flagshipserver.com is never in this path —
      // the credential arrived over the pinned pipe and stays on the box.
      if (cred && deps.vibeCode.credentials) {
        try {
          await deps.vibeCode.credentials.put(session.meta.sessionId, cred);
        } catch {
          return jerr(500, "failed to store credential");
        }
      }
      // Graceful absence: only stream if a model can actually drive the
      // session — startStreaming wired AND a credential available (just
      // delivered or already stored for this fresh session).
      const haveCredential =
        !!cred ||
        (!!deps.vibeCode.credentials && deps.vibeCode.credentials.has(session.meta.sessionId));
      if (deps.vibeCode.startStreaming && haveCredential) {
        // Fire-and-forget. Streaming consumers attach via P1.6 WS;
        // P1.7 replays whatever's been emitted so far.
        void deps.vibeCode.startStreaming({
          sessionId: session.meta.sessionId,
          prompt: body.prompt,
          model: body.model,
          ...(attach.attachments.length > 0 ? { attachments: attach.attachments } : {}),
        }).catch((e: Error) => {
          session.fail(e.message ?? "stream failed", true);
        });
        const out: VibeCodeStartResponse = { sessionId: session.meta.sessionId };
        return jok(out);
      }
      // No model is driving the session — tell the client to add an AI key.
      // The session still exists; the owner can deliver a credential on a
      // /reply turn and resume.
      const out: VibeCodeStartResponse = {
        sessionId: session.meta.sessionId,
        needsCredential: true,
      };
      return jok(out);
    }

    // ---- P1.7 GET /api/screens/vibe-code/:id
    if (path.startsWith("/api/screens/vibe-code/") && method === "GET") {
      const id = decodeURIComponent(path.slice("/api/screens/vibe-code/".length));
      if (!deps.vibeCode) return jerr(503, "vibe-code not configured");
      const session = deps.vibeCode.registry.get(id);
      if (!session) return jerr(404, "session not found");
      const out: VibeCodeStatusResponse = {
        status: session.meta.status,
        transcript: [...session.conversation()],
        files: session.files(),
        deployedUrl: session.meta.url,
      };
      return jok(out);
    }

    // ---- P1.14 POST /api/screens/orders/send
    if (path === "/api/screens/orders/send" && method === "POST") {
      if (!deps.ordersDispatch) return jerr(503, "orders dispatcher not configured");
      const body = parseJson(req.body) as OrdersSendRequest | null;
      if (!body || typeof body.envelope !== "string" || body.envelope.length === 0) {
        return jerr(400, "envelope required");
      }
      let envelopeBytes: Buffer;
      try {
        envelopeBytes = Buffer.from(body.envelope, "base64");
      } catch {
        return jerr(400, "envelope must be base64");
      }
      try {
        const r = await deps.ordersDispatch.dispatch({ envelope: envelopeBytes });
        const out: OrdersSendResponse = r;
        return jok(out);
      } catch (e) {
        return jerr(502, `dispatch failed: ${(e as Error).message}`);
      }
    }

    // ---- P1.19 POST /api/screens/app-backup/start
    if (path === "/api/screens/app-backup/start" && method === "POST") {
      if (!deps.appBackup) return jerr(503, "app-backup not configured");
      const body = parseJson(req.body) as AppBackupStartRequest | null;
      if (!body || typeof body.serviceId !== "string" || body.serviceId.length === 0) {
        return jerr(400, "serviceId required");
      }
      // `<creator>-<slug>`, single dash. Split at the FIRST hyphen —
      // creator (a username) is hyphen-free, so everything after the
      // first '-' is the slug (which itself may contain hyphens).
      const dashIdx = body.serviceId.indexOf("-");
      const creator = dashIdx > 0 ? body.serviceId.slice(0, dashIdx) : "";
      const slug = dashIdx > 0 ? body.serviceId.slice(dashIdx + 1) : "";
      if (!creator || !slug) {
        return jerr(400, "serviceId must be '<creator>-<slug>'");
      }
      try {
        const record = await deps.appBackup.createBackup({
          creator,
          slug,
          includeUserData: !!body.includeUserData,
          password: body.password,
        });
        const out: AppBackupStartResponse = {
          backupId: record.backupId,
          fetchPath: record.fetchPath,
          expiresAt: record.expiresAt,
          bytes: record.bytes,
          encrypted: record.encrypted,
        };
        return jok(out);
      } catch (e) {
        return jerr(502, `backup failed: ${(e as Error).message}`);
      }
    }

    // ---- P1.20 GET /api/screens/app-backup/:backupId
    // Internal redirect to the existing /api/backups/<id> stream so the
    // webapp doesn't have to know about the legacy path. This keeps the
    // BFF discipline (one URL per view) intact.
    if (path.startsWith("/api/screens/app-backup/") && method === "GET") {
      const id = decodeURIComponent(path.slice("/api/screens/app-backup/".length));
      if (!/^[0-9a-f]+$/.test(id)) return jerr(400, "invalid backupId");
      // 307 keeps the method (GET) AND tells the client this is a
      // permanent location for fetches; the paired-session token has
      // already been verified by the gate, so the browser/webapp's
      // automatic redirect-follow re-uses its credentials.
      return {
        status: 307,
        headers: {
          ...J,
          location: `/api/backups/${encodeURIComponent(id)}`,
        },
        body: JSON.stringify({ redirect: `/api/backups/${id}` }),
      };
    }

    // ---- GET /api/screens/lineage-resolve
    //
    // List every app currently auto-paused by the update-pack lineage
    // verifier. The phone view renders one card per paused app showing
    // creator name, prior tip, new tip, and the verifier reason so the
    // user can investigate before tapping accept-or-revoke.
    if (path === "/api/screens/lineage-resolve" && method === "GET") {
      if (!deps.lineageResolver) {
        const empty: LineagePausedListResponse = { paused: [] };
        return jok(empty);
      }
      try {
        const paused = await deps.lineageResolver.list();
        const out: LineagePausedListResponse = { paused };
        return jok(out);
      } catch (e) {
        return jerr(502, `lineage-resolve list failed: ${(e as Error).message}`);
      }
    }

    // ---- POST /api/screens/lineage-resolve
    //
    // Phone tap on a paused app. `accept` rolls the lineage anchor
    // forward to the upstream tip the puller refused — subsequent
    // pulls will trust that chain going forward. `revoke` uninstalls
    // the app entirely. The paired-session gate has already
    // authenticated; in webapp world the token IS the PSK equivalent.
    if (path === "/api/screens/lineage-resolve" && method === "POST") {
      if (!deps.lineageResolver) return jerr(503, "lineage-resolver not configured");
      const body = parseJson(req.body) as LineageResolveRequest | null;
      if (!body || typeof body.serviceId !== "string" || body.serviceId.length === 0) {
        return jerr(400, "serviceId required");
      }
      if (body.decision !== "accept" && body.decision !== "revoke") {
        return jerr(400, "decision must be 'accept' or 'revoke'");
      }
      try {
        if (body.decision === "accept") {
          const r = await deps.lineageResolver.accept(body.serviceId);
          if (!r.ok) return jerr(502, r.reason ?? "accept failed");
          const out: LineageResolveResponse = { ok: true, outcome: r.outcome };
          return jok(out);
        }
        const r = await deps.lineageResolver.revoke(body.serviceId);
        if (!r.ok) return jerr(502, r.reason ?? "revoke failed");
        const out: LineageResolveResponse = { ok: true, outcome: "revoked" };
        return jok(out);
      } catch (e) {
        return jerr(502, `lineage-resolve failed: ${(e as Error).message}`);
      }
    }

    // ---- GET /api/screens/release-status
    //
    // Offline-verified view of Flagship's own .maintainers/ folder.
    // The webapp + phone-app render this so users can see who is
    // currently authorized to ship Flagship updates, the most recent
    // valid release endorsement, and a takeover-alarm banner when the
    // release track changed hands.
    if (path === "/api/screens/release-status" && method === "GET") {
      if (!deps.releaseStatus) {
        const empty: ReleaseStatusResponse = {
          rootPolicyPresent: false,
          tracks: [],
          currentRelease: null,
          validEndorsements: [],
          endorsementErrors: [],
          pendingTakeoverAlarm: null,
        };
        return jok(empty);
      }
      try {
        const verdict = deps.releaseStatus.status();
        return jok(toReleaseStatusResponse(verdict));
      } catch (e) {
        return jerr(502, `release-status failed: ${(e as Error).message}`);
      }
    }

    // ---- P1.10 GET /api/screens/browser-tabs/list/:serviceId
    if (path.startsWith("/api/screens/browser-tabs/list/") && method === "GET") {
      const serviceId = decodeURIComponent(path.slice("/api/screens/browser-tabs/list/".length));
      if (!deps.servicePlatform) return jerr(503, "app-platform not configured");
      const app = deps.servicePlatform.byServiceId(serviceId);
      if (!app) return jerr(404, "app not found");
      const tabs: BrowserTab[] = (deps.tabRegistry?.tabsForApp(serviceId) ?? []).map(
        (tabId) => ({ tabId, serviceId }),
      );
      const out: BrowserTabsListResponse = { tabs };
      return jok(out);
    }

    // ---- J.4 GET /api/screens/post-recovery/status
    // Webapp's reattach-progress screen polls this every ~1s after a
    // recovery binds. Returns 200 + `{ report: null }` when no recovery
    // has run on this daemon since boot — the view treats that as "all
    // done, nothing to show."
    if (path === "/api/screens/post-recovery/status" && method === "GET") {
      const report = deps.postRecoveryStatus ? deps.postRecoveryStatus() : null;
      return jok({ report: report ?? null });
    }

    // ---- W10 — per-app env-var KV editor ------------------------------
    //
    // GET  /api/screens/services/:appId/env         → list NAMES (no values)
    // POST /api/screens/services/:appId/env/set     → IRK-signed set
    // POST /api/screens/services/:appId/env/unset   → IRK-signed unset
    //
    // Values flow ONLY over the request body of /set. The /get path
    // returns names only (the appEnvStore.names() accessor is the only
    // non-runtime accessor exposed by the sealed store). The response
    // shape NEVER echoes a value, and the error path never interpolates
    // one — defense in depth on the "values never leave" invariant.
    const envBaseM = /^\/api\/screens\/services\/([^/]+)\/env$/.exec(path);
    if (envBaseM && method === "GET") {
      if (!deps.appEnvStore) return jerr(503, "env store not configured");
      const appId = decodeURIComponent(envBaseM[1]!);
      try {
        const names = await deps.appEnvStore.names(appId);
        const out: ServiceEnvListResponse = { names };
        return jok(out);
      } catch {
        return jerr(502, "failed to list env names");
      }
    }
    const envSetM = /^\/api\/screens\/services\/([^/]+)\/env\/set$/.exec(path);
    if (envSetM && method === "POST") {
      if (!deps.servicePlatform) return jerr(503, "service platform not configured");
      const appId = decodeURIComponent(envSetM[1]!);
      const body = parseJson(req.body) as ServiceEnvSetRequest | null;
      if (!body || typeof body.name !== "string" || body.name.length === 0) {
        return jerr(400, "name required");
      }
      if (typeof body.value !== "string") return jerr(400, "value required");
      if (typeof body.signature !== "string") return jerr(400, "signature required");
      const r = body.request;
      if (!r || typeof r.serverId !== "string" || typeof r.creator !== "string" ||
          typeof r.slug !== "string" || typeof r.issuedAt !== "number" ||
          typeof r.env !== "object" || r.env === null) {
        return jerr(400, "malformed request envelope");
      }
      // Cross-check: the envelope's (creator,slug) must compose to the
      // URL's appId, and `name`+`value` must be present in `request.env`.
      const expectedAppId = `${r.creator}-${r.slug}`;
      if (expectedAppId !== appId) {
        return jerr(400, "envelope (creator,slug) does not match :appId");
      }
      if (!(body.name in r.env) || r.env[body.name] !== body.value) {
        return jerr(400, "name/value not present in request.env");
      }
      let signatureBytes: Uint8Array;
      try {
        signatureBytes = hexToBytesLocal(body.signature);
      } catch {
        return jerr(400, "invalid hex signature");
      }
      const result = await deps.servicePlatform.setEnv({
        request: r,
        signature: signatureBytes,
        verify: verifySetServiceEnv,
      });
      if (!result.ok) {
        // Generic reason — never include the value.
        return jerr(400, result.reason);
      }
      const out: ServiceEnvOpResponse = { ok: true };
      return jok(out);
    }
    const envUnsetM = /^\/api\/screens\/services\/([^/]+)\/env\/unset$/.exec(path);
    if (envUnsetM && method === "POST") {
      if (!deps.servicePlatform) return jerr(503, "service platform not configured");
      const appId = decodeURIComponent(envUnsetM[1]!);
      const body = parseJson(req.body) as ServiceEnvUnsetRequest | null;
      if (!body || typeof body.name !== "string" || body.name.length === 0) {
        return jerr(400, "name required");
      }
      if (typeof body.signature !== "string") return jerr(400, "signature required");
      const r = body.request;
      if (!r || typeof r.serverId !== "string" || typeof r.creator !== "string" ||
          typeof r.slug !== "string" || typeof r.issuedAt !== "number" ||
          typeof r.env !== "object" || r.env === null) {
        return jerr(400, "malformed request envelope");
      }
      const expectedAppId = `${r.creator}-${r.slug}`;
      if (expectedAppId !== appId) {
        return jerr(400, "envelope (creator,slug) does not match :appId");
      }
      // Defense-in-depth: the new env map must NOT include the unset
      // name. The owner is asserting "the new state lacks this name."
      if (body.name in r.env) {
        return jerr(400, "request.env still contains the name being unset");
      }
      let signatureBytes: Uint8Array;
      try {
        signatureBytes = hexToBytesLocal(body.signature);
      } catch {
        return jerr(400, "invalid hex signature");
      }
      const result = await deps.servicePlatform.setEnv({
        request: r,
        signature: signatureBytes,
        verify: verifySetServiceEnv,
      });
      if (!result.ok) return jerr(400, result.reason);
      const out: ServiceEnvOpResponse = { ok: true };
      return jok(out);
    }

    // ---- W10 — vibe-code session public state + reply -----------------
    //
    // GET  /api/screens/llm/sessions/:sessionId   → public state
    // POST /api/screens/llm/sessions/:sessionId/reply  → owner reply
    const sessionM = /^\/api\/screens\/llm\/sessions\/([^/]+)$/.exec(path);
    if (sessionM && method === "GET") {
      if (!deps.vibeCode) return jerr(503, "vibe-code not configured");
      const sessionId = decodeURIComponent(sessionM[1]!);
      const session = deps.vibeCode.registry.get(sessionId);
      if (!session) return jerr(404, "session not found");
      const out: VibeCodeSessionPublicState =
        toVibeCodePublicState(session, deps);
      return jok(out);
    }
    const replyM = /^\/api\/screens\/llm\/sessions\/([^/]+)\/reply$/.exec(path);
    if (replyM && method === "POST") {
      if (!deps.vibeCode) return jerr(503, "vibe-code not configured");
      const sessionId = decodeURIComponent(replyM[1]!);
      const session = deps.vibeCode.registry.get(sessionId);
      if (!session) return jerr(404, "session not found");
      const body = parseJson(req.body) as VibeCodeReplyRequest | null;
      if (!body) return jerr(400, "body required");
      // A reply may carry a BYOK credential to seed/replace the session's
      // stored credential (the needsCredential resume case). Same box-only
      // contract as the start path; never echoed, never logged.
      const replyCred = parseCredential((body as { credential?: unknown }).credential);
      if (replyCred === "invalid") return jerr(400, "malformed credential");
      if (replyCred && deps.vibeCode.credentials) {
        try {
          await deps.vibeCode.credentials.put(session.meta.sessionId, replyCred);
        } catch {
          return jerr(500, "failed to store credential");
        }
      }
      const pending = session.pendingRequest();
      if (!pending) return jerr(409, "no pending tool to reply to");
      if (pending.kind === "talkToUser") {
        if (typeof body.text !== "string") return jerr(400, "text required");
        const attach = validateAttachments(body.attachments);
        if (!attach.ok) return jerr(400, attach.reason);
        const r = session.pushUserReply({
          toolUseId: pending.toolUseId,
          text: body.text,
          ...(attach.attachments.length > 0 ? { attachments: attach.attachments } : {}),
        });
        if (!r.ok) return jerr(409, r.reason ?? "reply rejected");
        deps.vibeCode.recordScratchTurn?.({
          sessionId: session.meta.sessionId,
          text: body.text,
          attachmentSummaries: attach.attachments.map(summarizeAttachment),
        });
        // Resume the model so the conversation actually continues — the reply
        // alone only flips the session back to `streaming`; without this the
        // build stalls forever after the first clarifying question.
        if (deps.vibeCode.resumeStreaming) {
          void deps.vibeCode.resumeStreaming(session.meta.sessionId).catch(
            (e: Error) => session.fail(e.message ?? "resume failed", true),
          );
        }
        const out: VibeCodeReplyResponse = { ok: true };
        return jok(out);
      }
      // pending.kind === "requestEnvVar"
      const status = body.envVarStatus;
      if (status !== "set" && status !== "declined" && status !== "deferred") {
        return jerr(400, "envVarStatus must be 'set' | 'declined' | 'deferred'");
      }
      const name = typeof pending.input.name === "string" ? pending.input.name : "";
      let currentlySet = false;
      if (deps.appEnvStore && deps.resolveSessionAppId) {
        const sid = deps.resolveSessionAppId(session);
        if (sid && name.length > 0) {
          try {
            const names = await deps.appEnvStore.names(sid);
            currentlySet = names.includes(name);
          } catch {
            currentlySet = false;
          }
        }
      }
      const ack = {
        acknowledged: true as const,
        name,
        status,
        currentlySet,
      };
      const r = session.pushEnvVarAck({ toolUseId: pending.toolUseId, ack });
      if (!r.ok) return jerr(409, r.reason ?? "ack rejected");
      // Resume the model so it incorporates the env-var ack and continues.
      if (deps.vibeCode.resumeStreaming) {
        void deps.vibeCode.resumeStreaming(session.meta.sessionId).catch(
          (e: Error) => session.fail(e.message ?? "resume failed", true),
        );
      }
      const out: VibeCodeReplyResponse = { ok: true };
      return jok(out);
    }

    // ---- P9 GET /api/screens/peer-backup/status ----
    //
    // Snapshot of the daemon's peer-backup participation, shard health,
    // peer topology, and repair history. Empty/zero values stand in for
    // any underlying state the daemon hasn't wired yet — never fabricated.
    if (path === "/api/screens/peer-backup/status" && method === "GET") {
      const out: PeerBackupStatusResponse = buildPeerBackupStatus(
        deps.peerBackup ?? {},
      );
      return jok(out);
    }

    // ---- P6 POST /api/screens/app-invite/issue ----
    //
    // Mints a fresh bearer invite for `serviceId` with the supplied role +
    // opaqueTag + contextNote. Returns `{ secret, expiresAt }`. The
    // webapp's `invite-issue.js` builds the shareable URL from the
    // returned secret entirely client-side — the secret never persists
    // in any log here. See `appInvite.ts` for the projection rules.
    if (path === "/api/screens/app-invite/issue" && method === "POST") {
      const store: AppInviteStore | null | undefined = deps.appInvite?.store;
      if (!deps.appInvite || !store) return jerr(503, "app-invite store not configured");
      const body = parseJson(req.body) as AppInviteIssueRequest | null;
      if (!body) return jerr(400, "body required");
      if (typeof body.serviceId !== "string" || body.serviceId.length === 0) {
        return jerr(400, "serviceId required");
      }
      if (typeof body.role !== "string" || body.role.length === 0 || body.role.length > 64) {
        return jerr(400, "role required (1-64 chars)");
      }
      if (typeof body.opaqueTag !== "string") return jerr(400, "opaqueTag required");
      let opaqueTag: Uint8Array;
      try {
        opaqueTag = hexToBytesLocal(body.opaqueTag);
      } catch {
        return jerr(400, "opaqueTag must be hex");
      }
      if (opaqueTag.length !== 16) return jerr(400, "opaqueTag must be 16 bytes");

      let contextNote: string | null;
      if (body.contextNote === undefined || body.contextNote === null) {
        contextNote = null;
      } else if (typeof body.contextNote === "string") {
        if (body.contextNote.length > 280) return jerr(400, "contextNote too long (max 280 chars)");
        contextNote = body.contextNote;
      } else {
        return jerr(400, "contextNote must be a string or null");
      }

      try {
        const r = await issueAppInvite(
          { ...deps.appInvite, store },
          {
            serviceId: body.serviceId,
            role: body.role,
            opaqueTag,
            contextNote,
          },
        );
        const out: AppInviteIssueResponse = {
          secret: r.secret,
          expiresAt: r.expiresAt,
        };
        return jok(out);
      } catch (e) {
        return jerr(502, `issue failed: ${(e as Error).message}`);
      }
    }

    // ---- P6 GET /api/screens/app-invite/list/:serviceId ----
    if (path.startsWith("/api/screens/app-invite/list/") && method === "GET") {
      const store: AppInviteStore | null | undefined = deps.appInvite?.store;
      if (!deps.appInvite || !store) return jerr(503, "app-invite store not configured");
      const serviceId = decodeURIComponent(
        path.slice("/api/screens/app-invite/list/".length),
      );
      if (!serviceId) return jerr(400, "serviceId required");
      try {
        const rows = await store.listPendingInvites(serviceId);
        const out: AppInviteListResponse = {
          pending: projectPendingInvites(rows, now()),
        };
        return jok(out);
      } catch (e) {
        return jerr(502, `list failed: ${(e as Error).message}`);
      }
    }

    // ---- P6 GET /api/screens/app-invite/access/:serviceId ----
    if (path.startsWith("/api/screens/app-invite/access/") && method === "GET") {
      const store: AppInviteStore | null | undefined = deps.appInvite?.store;
      if (!deps.appInvite || !store) return jerr(503, "app-invite store not configured");
      const serviceId = decodeURIComponent(
        path.slice("/api/screens/app-invite/access/".length),
      );
      if (!serviceId) return jerr(400, "serviceId required");
      try {
        const rows = await store.listActiveAccess(serviceId);
        const out: AppInviteAccessResponse = {
          access: projectAccessRows(rows),
        };
        return jok(out);
      } catch (e) {
        return jerr(502, `access list failed: ${(e as Error).message}`);
      }
    }

    // ---- P6 POST /api/screens/app-invite/revoke ----
    //
    // Discriminated by `scope`. `invite` soft-revokes a single pending
    // invite by id; `access` soft-revokes a single redeemed access row
    // by IRK pubkey hex. Both are idempotent — re-revoking returns
    // 200 with `alreadyRevoked: true`.
    if (path === "/api/screens/app-invite/revoke" && method === "POST") {
      const store: AppInviteStore | null | undefined = deps.appInvite?.store;
      if (!deps.appInvite || !store) return jerr(503, "app-invite store not configured");
      const body = parseJson(req.body) as AppInviteRevokeRequest | null;
      if (!body || typeof (body as { serviceId?: unknown }).serviceId !== "string") {
        return jerr(400, "serviceId required");
      }
      const serviceId = (body as { serviceId: string }).serviceId;
      const scope = (body as { scope?: unknown }).scope;
      if (scope === "invite") {
        const inviteId = (body as { inviteId?: unknown }).inviteId;
        if (typeof inviteId !== "string" || inviteId.length === 0) {
          return jerr(400, "inviteId required for scope='invite'");
        }
        try {
          const ok = await store.revokeInvite({
            serviceId,
            inviteId,
            revokedAt: now(),
          });
          const out: AppInviteRevokeResponse = { ok: true, alreadyRevoked: !ok };
          return jok(out);
        } catch (e) {
          return jerr(502, `revoke failed: ${(e as Error).message}`);
        }
      }
      if (scope === "access") {
        const irkPubKey = (body as { irkPubKey?: unknown }).irkPubKey;
        if (typeof irkPubKey !== "string" || irkPubKey.length === 0) {
          return jerr(400, "irkPubKey required for scope='access'");
        }
        // Validate hex shape early so the store layer never sees garbage.
        if (!/^[0-9a-fA-F]+$/.test(irkPubKey) || irkPubKey.length !== 64) {
          return jerr(400, "irkPubKey must be 32-byte hex");
        }
        try {
          const ok = await store.revokeAccess({
            serviceId,
            irkPubHex: irkPubKey.toLowerCase(),
            revokedAt: now(),
          });
          const out: AppInviteRevokeResponse = { ok: true, alreadyRevoked: !ok };
          return jok(out);
        } catch (e) {
          return jerr(502, `revoke failed: ${(e as Error).message}`);
        }
      }
      return jerr(400, "scope must be 'invite' or 'access'");
    }

    // ---- P9 POST /api/screens/peer-backup/toggle ----
    //
    // Flips peer-backup participation. The paired-session gate has
    // already authenticated; in webapp world the session token IS the
    // PSK-equivalent (mirrors the lineage-resolve handler's design).
    // Returns the post-toggle full status payload so the webapp can
    // re-render without a second GET.
    if (path === "/api/screens/peer-backup/toggle" && method === "POST") {
      const loop: BackupLoop | null | undefined = deps.peerBackup?.backupLoop;
      if (!loop) return jerr(503, "peer-backup not configured");
      const body = parseJson(req.body) as PeerBackupToggleRequest | null;
      if (!body || typeof body.participate !== "boolean") {
        return jerr(400, "participate (boolean) required");
      }
      loop.setEnabled(body.participate, now());
      const out: PeerBackupStatusResponse = buildPeerBackupStatus(
        deps.peerBackup ?? {},
      );
      return jok(out);
    }

    return jerr(404, "screen route not found");
  };
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function serverDetail(deps: ScreensHttpDeps, now: () => number): ServerDetailResponse {
  const cert = deps.certInfo?.() ?? null;
  const recentInstallEvents = deps.installEventLog?.recent() ?? [];
  return {
    serverFqdn: deps.serverFqdn,
    username: deps.username,
    daemonVersion: deps.daemonVersion,
    startedAt: deps.startedAt,
    uptimeMs: now() - deps.startedAt,
    certNotAfter: cert?.notAfter,
    certNotBefore: cert?.notBefore,
    certSans: cert?.sans,
    serviceCount: deps.servicePlatform?.list().length ?? 0,
    pairedSessionCount: deps.pairedSessions?.list().length ?? 0,
    recentInstallEvents,
  };
}

function toSummary(app: InstalledService, serverFqdn: string): AppSummary {
  return {
    serviceId: app.serviceId,
    creator: app.creator,
    slug: app.slug,
    urlLabel: app.urlLabel,
    summary: typeof app.manifest.description === "string" ? app.manifest.description : undefined,
    url: `https://${app.urlLabel}.${serverFqdn}`,
    status: "unknown",
    version: app.manifest.version,
    installedAt: app.installedAt,
  };
}

function appDetail(app: InstalledService, deps: ScreensHttpDeps): AppDetailResponse {
  const dataLayerInstances = collectDataLayerInstances(app);
  const members = collectMembers(app.membership);
  const browserTabs = (deps.tabRegistry?.tabsForApp(app.serviceId) ?? []).map((tabId) => ({
    tabId,
  }));
  return {
    app: toSummary(app, deps.serverFqdn),
    manifest: app.manifest as unknown as Record<string, unknown>,
    dataLayerInstances,
    members,
    browserTabs,
    recentLogs: [],
  };
}

function collectDataLayerInstances(app: InstalledService): Array<{ store: string; instanceName: string }> {
  if (!app.data) return [];
  const out: Array<{ store: string; instanceName: string }> = [];
  for (const store of ["postgres", "objects", "kv"] as const) {
    const inst = (app.data as unknown as Record<string, unknown>)[store];
    if (!inst) continue;
    if (Array.isArray(inst)) {
      for (const i of inst as Array<{ instanceName?: string }>) {
        if (i?.instanceName) out.push({ store, instanceName: i.instanceName });
      }
    } else if (typeof inst === "object" && inst !== null) {
      const i = inst as { instanceName?: string };
      if (i.instanceName) out.push({ store, instanceName: i.instanceName });
    }
  }
  return out;
}

function collectMembers(
  membership: AppMembership,
): Array<{ stableIdPrefix: string; role: string; addedAt: number }> {
  // AppMembership.members exposes list() returning IRK-pubkey-hex
  // entries. We surface only the first 12 chars so the view can render
  // an identicon without leaking the full handle.
  const list = membership.members.list();
  return list.map((m) => ({
    stableIdPrefix: m.irkPubHex.slice(0, 12),
    role: m.role,
    addedAt: m.addedAt,
  }));
}

function classifyClaimedFqdn(fqdn: string, serverFqdn: string): "alias" | "custom" {
  // Anything inside the user's flagship.services zone is an alias of
  // the canonical pod; anything else is a user-supplied custom domain.
  const userZone = serverFqdn.split(".").slice(1).join(".");
  if (userZone && fqdn.endsWith(`.${userZone}`)) return "alias";
  return "custom";
}

function defaultResolveCallerToken(req: HttpRequest): string | null {
  // Mirror PairedSessionGate's resolution rules:
  //   - Cookie: flagship_session=<token>
  //   - Query string: ?sessionToken=<token>
  //   - Header: x-flagship-session
  // We accept any of the three; the gate has already authenticated.
  const cookie = req.headers.cookie ?? req.headers.Cookie;
  if (typeof cookie === "string") {
    const m = /(?:^|;\s*)flagship_session=([^;]+)/.exec(cookie);
    if (m && typeof m[1] === "string") return m[1];
  }
  const qIdx = req.path.indexOf("?");
  if (qIdx >= 0) {
    const sp = new URLSearchParams(req.path.slice(qIdx + 1));
    const t = sp.get("sessionToken");
    if (t) return t;
  }
  const h = req.headers["x-flagship-session"];
  if (typeof h === "string" && h.length > 0) return h;
  return null;
}

function parseJson(buf: Buffer): unknown {
  if (buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Validate an optional BYOK credential off a request body.
 *   - absent / null / undefined → `null` (no credential delivered)
 *   - well-formed → the `LlmCredential` (provider + apiKey [+ baseUrl])
 *   - present-but-malformed → the sentinel string `"invalid"`
 * The value is NEVER logged here — only shape-checked.
 */
function parseCredential(raw: unknown): LlmCredential | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const o = raw as Record<string, unknown>;
  if (typeof o.provider !== "string" || o.provider.length === 0) return "invalid";
  if (typeof o.apiKey !== "string" || o.apiKey.length === 0) return "invalid";
  if (o.baseUrl !== undefined && typeof o.baseUrl !== "string") return "invalid";
  const out: LlmCredential = { provider: o.provider, apiKey: o.apiKey };
  if (typeof o.baseUrl === "string" && o.baseUrl.length > 0) out.baseUrl = o.baseUrl;
  return out;
}

function jok(body: unknown): HttpResponse {
  return { status: 200, headers: J, body: JSON.stringify(body) };
}

function jerr(status: number, message: string): HttpResponse {
  return { status, headers: J, body: JSON.stringify({ error: message }) };
}

/**
 * P14 — predicate: does the given /api/screens/* path mutate
 * paired-session-bound state? Companions are blocked from these in
 * v1. Wave 9 will add the write-relay so the owner can approve
 * companion-initiated writes after the fact; until then, returning
 * 403 here is the honest user experience ("open your owner app").
 *
 * Conservative inclusion rule: anything that POSTs/PUTs/DELETEs
 * under /api/screens/ AND mutates pod state. Read endpoints
 * (GET) are not included — companions are read-only, not blind.
 *
 * Companion-dock paths themselves (mint-ticket / revoke) are gated
 * separately in the dispatcher above (a companion shouldn't mint
 * NEW companion sessions).
 */
function isWriteScopedPath(path: string): boolean {
  if (!path.startsWith("/api/screens/")) return false;
  // app-invite issue + revoke
  if (path === "/api/screens/app-invite/issue") return true;
  if (path === "/api/screens/app-invite/revoke") return true;
  // peer-backup toggle
  if (path === "/api/screens/peer-backup/toggle") return true;
  // env-var set + unset
  if (/^\/api\/screens\/services\/[^/]+\/env\/(set|unset)$/.test(path)) return true;
  // lineage-resolve POST
  if (path === "/api/screens/lineage-resolve") return true;
  // app-backup start
  if (path === "/api/screens/app-backup/start") return true;
  // orders/send
  if (path === "/api/screens/orders/send") return true;
  // url-controller claim
  if (path === "/api/screens/url-controller/claim") return true;
  // url-controller verify (POST, but it's a read-shaped network probe)
  // — explicitly EXCLUDED so companions can preview cert health.
  // vibe-code start + reply — mutate session state; companion-blocked
  // (Wave 9 will surface a companion-side compose UI that proxies through).
  if (path === "/api/screens/vibe-code/start") return true;
  if (/^\/api\/screens\/llm\/sessions\/[^/]+\/reply$/.test(path)) return true;
  // paired-session revoke (DELETE) — also written below as DELETE.
  if (path.startsWith("/api/screens/paired-sessions/")) return true;
  // companion mint-ticket itself — block here too as belt-and-braces
  // (the dispatcher above handles this before reaching here, but in
  // case the order ever changes).
  if (path === "/api/screens/companion/mint-ticket") return true;
  if (path === "/api/screens/companion/revoke") return true;
  // P14 Phase 2 — resolve-pending is owner-only by definition (a
  // companion approving its own queued write would defeat the whole
  // relay). Block here belt-and-braces; the relay handler also
  // requires the resolver token to be a non-companion paired-session
  // implicitly (the gate accepts both, but a companion that POSTs to
  // /resolve-pending lands in this 403 before reaching the handler).
  if (path === "/api/screens/companion/resolve-pending") return true;
  return false;
}

function hexToBytesLocal(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toVibeCodePublicState(
  session: VibeCodeSession,
  deps: ScreensHttpDeps,
): VibeCodeSessionPublicState {
  const pending = session.pendingRequest();
  const appId = (() => {
    if (deps.resolveSessionAppId) {
      try {
        return deps.resolveSessionAppId(session) ?? null;
      } catch {
        return null;
      }
    }
    // Fallback — if the session has emitted a manifest, derive from it.
    const mj = session.manifestJson();
    if (!mj) return null;
    try {
      const m = JSON.parse(mj) as { name?: unknown };
      if (typeof m.name === "string") {
        return `${session.meta.username}-${m.name}`;
      }
    } catch {
      // ignore
    }
    return null;
  })();
  const out: VibeCodeSessionPublicState = {
    id: session.meta.sessionId,
    appId,
    status: session.meta.status,
    messages: session.messages(),
  };
  if (pending) {
    if (pending.kind === "talkToUser") {
      const message =
        typeof pending.input.message === "string" ? pending.input.message : "";
      out.pendingRequest = {
        kind: "talkToUser",
        toolUseId: pending.toolUseId,
        payload: { message },
      };
    } else {
      const name =
        typeof pending.input.name === "string" ? pending.input.name : "";
      const description =
        typeof pending.input.description === "string" ? pending.input.description : "";
      const why = typeof pending.input.why === "string" ? pending.input.why : "";
      const example =
        typeof pending.input.example === "string" ? pending.input.example : undefined;
      const secret =
        typeof pending.input.secret === "boolean" ? pending.input.secret : undefined;
      out.pendingRequest = {
        kind: "requestEnvVar",
        toolUseId: pending.toolUseId,
        payload: { name, description, why, example, secret },
      };
    }
  }
  return out;
}
