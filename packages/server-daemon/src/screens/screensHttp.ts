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
import type { AppPlatform, InstalledApp } from "../appPlatform.js";
import type { AppBackupService } from "../appBackup.js";
import type { AppMembership } from "../membership.js";
import type { FilePairedSessionStore } from "../pairedSessionStore.js";
import type { TabRegistry } from "../browser/tabRegistry.js";
import type { VibeCodeSessionRegistry } from "../llm/vibeCodeSession.js";
import type { FetchLike } from "@flagship/llm-providers";
import type {
  AppBackupStartRequest,
  AppBackupStartResponse,
  AppDetailResponse,
  AppsListResponse,
  AppSummary,
  BrowserTab,
  BrowserTabsListResponse,
  LineagePausedListResponse,
  LineagePauseSummary,
  LineageResolveRequest,
  LineageResolveResponse,
  MarketplaceBrowseResponse,
  OrdersSendRequest,
  OrdersSendResponse,
  OwnedUrl,
  PairedSessionsListResponse,
  PendingUnlockApproval,
  RecentInstallEvent,
  ReleaseStatusResponse,
  ServerDetailResponse,
  TierStatusResponse,
  UnlockApprovalApproveRequest,
  UnlockApprovalsPendingResponse,
  UrlControllerClaimRequest,
  UrlControllerOwnedResponse,
  VibeCodeStartRequest,
  VibeCodeStartResponse,
  VibeCodeStatusResponse,
} from "./types.js";
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
 * paused list, then POSTs `{ appId, decision }` to roll the anchor
 * forward (`accept`) or uninstall the app entirely (`revoke`).
 *
 * Wiring: production daemon supplies an adapter that:
 *   - `list()` walks the AppPullStateStore for entries with `lineagePaused`
 *   - `accept(appId)` delegates to `UpdateClient.acceptLineageBreak`
 *   - `revoke(appId)` calls `AppPlatform.uninstall` directly (it's a
 *     phone-gated action; the BFF's paired-session check is the trust
 *     equivalent of the host's IRK signature in this context)
 */
export interface LineageResolverLike {
  list(): Promise<LineagePauseSummary[]>;
  accept(appId: string): Promise<{ ok: boolean; outcome: "accepted" | "already-clear"; reason?: string }>;
  revoke(appId: string): Promise<{ ok: boolean; reason?: string }>;
}

export interface ScreensHttpDeps {
  gate: PairedSessionGate;
  serverFqdn: string;
  username: string;
  daemonVersion: string;
  /** Unix-ms when the daemon started. */
  startedAt: number;
  appPlatform?: AppPlatform | null;
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
  /** .com control plane URL for proxy endpoints (marketplace, tier, unlock-approvals, install-events). */
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
}

export interface VibeCodeRuntime {
  registry: VibeCodeSessionRegistry;
  /** Username on whose behalf to spawn sessions. */
  username: string;
  /** Server FQDN for the spawned session metadata. */
  serverFqdn: string;
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
  }) => Promise<void>;
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
    if (!req.path.startsWith("/api/screens/")) return null;
    const denied = deps.gate.check(req);
    if (denied) return denied;

    const path = req.path.split("?")[0]!;
    const method = req.method.toUpperCase();

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
        "framebuffer streaming not yet implemented; poll /api/screens/browser-tabs/list/<appId>",
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
      const apps = deps.appPlatform
        ? deps.appPlatform.list().map((a) => toSummary(a, deps.serverFqdn))
        : [];
      const body: AppsListResponse = { apps };
      return jok(body);
    }

    // ---- P1.3 GET /api/screens/app-detail/:appId
    if (path.startsWith("/api/screens/app-detail/") && method === "GET") {
      const appId = decodeURIComponent(path.slice("/api/screens/app-detail/".length));
      if (!deps.appPlatform) return jerr(503, "app-platform not configured");
      const app = deps.appPlatform.byAppId(appId);
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

    // ---- P1.4 GET /api/screens/marketplace-browse (proxied to .com)
    if (path === "/api/screens/marketplace-browse" && method === "GET") {
      const f = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
      if (!deps.controlPlaneBaseUrl) return jerr(503, "control plane not configured");
      const r = await f(
        `${trimSlash(deps.controlPlaneBaseUrl)}/api/marketplace/search`,
        { method: "GET" },
      );
      if (!r.ok) return jerr(502, `marketplace fetch failed: ${r.status}`);
      const upstream = (await r.json()) as { listings?: unknown[] };
      const installed = new Set(
        (deps.appPlatform?.list() ?? []).map((a) => `${a.creator}/${a.slug}`),
      );
      const listings = (upstream.listings ?? []).map((raw) =>
        parseListing(raw, installed),
      );
      const body: MarketplaceBrowseResponse = { listings };
      return jok(body);
    }

    // ---- P1.16 GET /api/screens/tier-status (proxied to .com)
    if (path === "/api/screens/tier-status" && method === "GET") {
      const f = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
      if (!deps.controlPlaneBaseUrl) {
        // No control plane → free tier with no quota visibility.
        const body: TierStatusResponse = { tier: "free", customDomains: [], reservedNames: [] };
        return jok(body);
      }
      try {
        const r = await f(
          `${trimSlash(deps.controlPlaneBaseUrl)}/api/tier/status`,
          { method: "GET" },
        );
        if (!r.ok) {
          // Treat as free tier on upstream failure rather than 502 — the
          // tier dashboard is a soft surface; we don't want a .com
          // outage to break the webapp's settings view.
          const body: TierStatusResponse = { tier: "free", customDomains: [], reservedNames: [] };
          return jok(body);
        }
        const upstream = (await r.json()) as TierStatusResponse;
        return jok(upstream);
      } catch {
        const body: TierStatusResponse = { tier: "free", customDomains: [], reservedNames: [] };
        return jok(body);
      }
    }

    // ---- P1.5 POST /api/screens/vibe-code/start
    if (path === "/api/screens/vibe-code/start" && method === "POST") {
      if (!deps.vibeCode) return jerr(503, "vibe-code not configured");
      const body = parseJson(req.body) as VibeCodeStartRequest | null;
      if (!body || typeof body.prompt !== "string" || body.prompt.length === 0) {
        return jerr(400, "prompt required");
      }
      const session = deps.vibeCode.registry.create({
        username: deps.vibeCode.username,
        serverFqdn: deps.vibeCode.serverFqdn,
      });
      session.pushUserMessage(body.prompt);
      if (deps.vibeCode.startStreaming) {
        // Fire-and-forget. Streaming consumers attach via P1.6 WS;
        // P1.7 replays whatever's been emitted so far.
        void deps.vibeCode.startStreaming({
          sessionId: session.meta.sessionId,
          prompt: body.prompt,
          model: body.model,
        }).catch((e: Error) => {
          session.fail(e.message ?? "stream failed", true);
        });
      }
      const out: VibeCodeStartResponse = { sessionId: session.meta.sessionId };
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
      if (!body || typeof body.appId !== "string" || body.appId.length === 0) {
        return jerr(400, "appId required");
      }
      const parts = body.appId.split("--");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return jerr(400, "appId must be '<creator>--<slug>'");
      }
      try {
        const record = await deps.appBackup.createBackup({
          creator: parts[0],
          slug: parts[1],
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
      if (!body || typeof body.appId !== "string" || body.appId.length === 0) {
        return jerr(400, "appId required");
      }
      if (body.decision !== "accept" && body.decision !== "revoke") {
        return jerr(400, "decision must be 'accept' or 'revoke'");
      }
      try {
        if (body.decision === "accept") {
          const r = await deps.lineageResolver.accept(body.appId);
          if (!r.ok) return jerr(502, r.reason ?? "accept failed");
          const out: LineageResolveResponse = { ok: true, outcome: r.outcome };
          return jok(out);
        }
        const r = await deps.lineageResolver.revoke(body.appId);
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

    // ---- P1.10 GET /api/screens/browser-tabs/list/:appId
    if (path.startsWith("/api/screens/browser-tabs/list/") && method === "GET") {
      const appId = decodeURIComponent(path.slice("/api/screens/browser-tabs/list/".length));
      if (!deps.appPlatform) return jerr(503, "app-platform not configured");
      const app = deps.appPlatform.byAppId(appId);
      if (!app) return jerr(404, "app not found");
      const tabs: BrowserTab[] = (deps.tabRegistry?.tabsForApp(appId) ?? []).map(
        (tabId) => ({ tabId, appId }),
      );
      const out: BrowserTabsListResponse = { tabs };
      return jok(out);
    }

    // ---- P1.8 GET /api/screens/unlock-approvals/pending (proxied to .com)
    if (path === "/api/screens/unlock-approvals/pending" && method === "GET") {
      const f = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
      if (!deps.controlPlaneBaseUrl) {
        const out: UnlockApprovalsPendingResponse = { pending: [] };
        return jok(out);
      }
      const r = await f(
        `${trimSlash(deps.controlPlaneBaseUrl)}/api/unlock/approvals/pending?serverFqdn=${encodeURIComponent(deps.serverFqdn)}`,
        { method: "GET" },
      );
      if (!r.ok) return jerr(502, `unlock-approvals fetch failed: ${r.status}`);
      const upstream = (await r.json()) as { pending?: PendingUnlockApproval[] };
      const out: UnlockApprovalsPendingResponse = {
        pending: Array.isArray(upstream.pending) ? upstream.pending : [],
      };
      return jok(out);
    }

    // ---- P1.9 POST /api/screens/unlock-approvals/:requestId/approve
    if (
      path.startsWith("/api/screens/unlock-approvals/") &&
      path.endsWith("/approve") &&
      method === "POST"
    ) {
      if (!deps.controlPlaneBaseUrl) return jerr(503, "control plane not configured");
      const f = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
      const requestId = decodeURIComponent(
        path.slice("/api/screens/unlock-approvals/".length, -"/approve".length),
      );
      if (requestId.length === 0) return jerr(400, "requestId required");
      const body = parseJson(req.body) as UnlockApprovalApproveRequest | null;
      if (!body || typeof body.signature !== "string" || typeof body.envelope !== "string") {
        return jerr(400, "signature + envelope required");
      }
      const r = await f(
        `${trimSlash(deps.controlPlaneBaseUrl)}/api/unlock/approvals/${encodeURIComponent(requestId)}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            serverFqdn: deps.serverFqdn,
            signature: body.signature,
            envelope: body.envelope,
          }),
        },
      );
      if (!r.ok) return jerr(502, `approve failed: ${r.status}`);
      return jok({ ok: true });
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

    return jerr(404, "screen route not found");
  };
}

function parseListing(
  raw: unknown,
  installed: Set<string>,
): MarketplaceBrowseResponse["listings"][number] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const creator = typeof r.creator === "string" ? r.creator : "";
  const slug = typeof r.slug === "string" ? r.slug : "";
  return {
    creator,
    slug,
    title: typeof r.title === "string" ? r.title : slug,
    summary: typeof r.summary === "string" ? r.summary : "",
    screenshots: Array.isArray(r.screenshots)
      ? (r.screenshots as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    installCount: typeof r.installCount === "number" ? r.installCount : 0,
    requiresLlmKey: !!r.requiresLlmKey,
    alreadyInstalled: installed.has(`${creator}/${slug}`),
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
    appCount: deps.appPlatform?.list().length ?? 0,
    pairedSessionCount: deps.pairedSessions?.list().length ?? 0,
    recentInstallEvents,
  };
}

function toSummary(app: InstalledApp, serverFqdn: string): AppSummary {
  return {
    appId: app.appId,
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

function appDetail(app: InstalledApp, deps: ScreensHttpDeps): AppDetailResponse {
  const dataLayerInstances = collectDataLayerInstances(app);
  const members = collectMembers(app.membership);
  const browserTabs = (deps.tabRegistry?.tabsForApp(app.appId) ?? []).map((tabId) => ({
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

function collectDataLayerInstances(app: InstalledApp): Array<{ store: string; instanceName: string }> {
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

function jok(body: unknown): HttpResponse {
  return { status: 200, headers: J, body: JSON.stringify(body) };
}

function jerr(status: number, message: string): HttpResponse {
  return { status, headers: J, body: JSON.stringify({ error: message }) };
}
