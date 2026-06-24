/**
 * `wireGossip` — assembles the daemon's per-service leadership gossip system:
 * CGK provisioning → SiblingView → inbound `/internal/gossip` handler → the
 * announce+elect loop, with the route claim/release live-wired to the daemon's
 * UrlController.
 *
 * EVERY piece is best-effort and NEVER throws/bricks the daemon. If no CGK is
 * provisioned, `wireGossip` returns `{ enabled: false }` and the daemon runs
 * exactly as before (no gossip, no leader routing). The caller mounts the
 * returned `handler` on the HTTP chain and `start()`s the loop after the runtime
 * is up.
 */
import { readFile } from "node:fs/promises";
import { birthDateFromAuthCode } from "@flagship/protocol";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { resolveCgk } from "./cgk.js";
import { buildGossipIngestHandler } from "./gossipHttp.js";
import {
  ANNOUNCE_INTERVAL_MS,
  buildGossipLoop,
  type GossipLoop,
  LIVENESS_WINDOW_MS,
  type SelfAnnounceState,
} from "./gossipLoop.js";
import {
  type RouteClaimer,
  tier2FqdnFor,
  urlControllerRouteClaimer,
} from "./routeClaimer.js";
import { buildRouteNudgeHandler, type CertPrewarm } from "./routeNudge.js";
import { SiblingView } from "./siblingView.js";

/** The FULL leadership map a `/api/leads` reader serves. */
export interface LeadsSnapshot {
  /** True iff gossip is wired (a CGK is provisioned). */
  gossipActive: boolean;
  /**
   * Per-service-slug → elected leader, over {self} ∪ {live siblings}. Only
   * live-hosted services appear. Empty when gossip is disabled. The slug is the
   * SAME identifier the gossip + route-nudge use (ServicePlatform's app slug).
   */
  leads: Record<string, { leaderFqdn: string; leaderStkHex: string; live: boolean }>;
}

export interface WireGossipResult {
  enabled: boolean;
  /** HTTP handler for `/internal/gossip` — null when disabled. */
  handler: ((req: HttpRequest) => Promise<HttpResponse | null>) | null;
  /**
   * HTTP handler for `POST /internal/route-nudge` — the hub's on-demand
   * "someone wants this unclaimed meta-URL" prod. null when disabled. Mount it
   * on the SAME chain as `handler`.
   */
  routeNudgeHandler: ((req: HttpRequest) => Promise<HttpResponse | null>) | null;
  /** The loop — null when disabled. Call start() after the runtime is up. */
  loop: GossipLoop | null;
  /** The live view (for diagnostics/tests). null when disabled. */
  view: SiblingView | null;
  /**
   * On-service-delete teardown: RELEASE the box's `<slug>.<user>` route at the
   * hub (so a stale claim doesn't outlive the uninstalled service) AND trigger a
   * gossip re-announce (so siblings recompute leads without it). Best-effort,
   * idempotent, never throws. null when gossip is disabled.
   */
  releaseRouteForRemovedService: ((slug: string) => Promise<void>) | null;
  /**
   * Compute the FULL live per-service leadership map from the SiblingView (self +
   * live siblings). ALWAYS present (even when gossip is disabled): when disabled
   * it returns `{ gossipActive:false, leads:{} }`. Mounted by `/api/leads`.
   */
  leadsSnapshot: () => LeadsSnapshot;
}

export interface WireGossipDeps {
  /** This box's account (UserId). */
  user: string;
  /** This box's podCanonical/fqdn — its gossip `name` + self-id. */
  serverFqdn: string;
  /** This box's STK pub hex (identity pubkey) — the birth-cert authority hex. */
  identityPubHex: string;
  /** Birth date (ms). Pass directly, or omit and let `readAuthCodeIssuedAt` find it. */
  birthDate: number;
  /** The daemon's UrlController (claim/release/list FQDNs → tunnel HELLO). */
  urlController: {
    claim(fqdn: string): Promise<void>;
    release(fqdn: string): Promise<void>;
    list(): string[];
  };
  /** Snapshot the slugs this box currently runs (re-read each tick). */
  listServiceSlugs: () => string[];
  /** The latest owner set-leader vote for THIS box, if any. */
  readSelfVote?: () => { stkHex: string; date: number } | null;
  /** Services-zone apex (default flagship.services). */
  servicesApex?: string;
  /** Broadcast base host (default broadcast--<user>.flagship.services). */
  broadcastUrl?: string;
  /**
   * Cert pre-warm seam — load an already-provisioned tier-2 `<slug>.<user>`
   * cert before this box claims a meta-URL it leads (gossip election round AND
   * the route-nudge handler), so the parked request isn't waiting on ACME.
   * Optional; omitted on certless paths.
   */
  certPrewarm?: CertPrewarm;
  /** Test seams. */
  cgk?: Uint8Array;
  intervalMs?: number;
  livenessWindowMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onLog?: (m: string) => void;
}

/**
 * The first-boot install blob carries `authCode.issuedAt` — the immutable,
 * owner-IRK-signed birth instant (`birthDateFromAuthCode`). Read it best-effort;
 * returns null on any absence/malformation so the caller can fall back.
 */
export async function readAuthCodeBirthDate(): Promise<number | null> {
  const blobPath = process.env.FLAGSHIP_INSTALL_BLOB ?? "/var/flagship/install-blob.json";
  try {
    const raw = await readFile(blobPath, "utf8");
    const b = JSON.parse(raw) as { authCode?: { issuedAt?: unknown; serial?: unknown } };
    const ac = b.authCode;
    if (!ac || typeof ac.issuedAt !== "number" || !Number.isFinite(ac.issuedAt)) return null;
    // birthDateFromAuthCode is a verbatim passthrough of issuedAt — go through it
    // so the seniority source is named in exactly one place.
    return birthDateFromAuthCode({
      version: 1,
      serial: typeof ac.serial === "string" ? ac.serial : "",
      username: "",
      serverName: "",
      serverDomain: "",
      delegatedPubKey: new Uint8Array(0),
      userPubKey: new Uint8Array(0),
      issuedAt: ac.issuedAt,
      expiresAt: 0,
    });
  } catch {
    return null;
  }
}

export async function wireGossip(deps: WireGossipDeps): Promise<WireGossipResult> {
  const log = deps.onLog ?? ((m: string) => console.log(m));
  const cgk = deps.cgk ?? (await resolveCgk());
  if (!cgk) {
    log(
      "[gossip] no CGK provisioned — per-service leadership gossip DISABLED. " +
        "(The phone embeds cgkHex into the recipe in a later provisioning step.)",
    );
    return {
      enabled: false,
      handler: null,
      routeNudgeHandler: null,
      loop: null,
      view: null,
      releaseRouteForRemovedService: null,
      leadsSnapshot: () => ({ gossipActive: false, leads: {} }),
    };
  }

  const view = new SiblingView(deps.livenessWindowMs ?? LIVENESS_WINDOW_MS);

  const handler = buildGossipIngestHandler({
    cgk,
    view,
    user: deps.user,
    selfId: deps.serverFqdn,
    ...(deps.now ? { now: deps.now } : {}),
    onLog: log,
  });

  const apex = deps.servicesApex ?? "flagship.services";
  const fqdnForService = tier2FqdnFor(deps.user, apex);
  const claimer: RouteClaimer = urlControllerRouteClaimer({
    urlController: deps.urlController,
    fqdnForService,
  });

  const broadcastUrl =
    deps.broadcastUrl ?? `https://broadcast--${deps.user.toLowerCase()}.${apex}`;

  const readSelf = (): SelfAnnounceState => ({
    user: deps.user,
    name: deps.serverFqdn,
    birthAuthHex: deps.identityPubHex.toLowerCase(),
    birthDate: deps.birthDate,
    vote: deps.readSelfVote?.() ?? null,
    services: deps.listServiceSlugs(),
  });

  const loop = buildGossipLoop({
    cgk,
    view,
    claimer,
    fqdnForService,
    ...(deps.certPrewarm ? { certPrewarm: deps.certPrewarm } : {}),
    readSelf,
    broadcastUrl,
    intervalMs: deps.intervalMs ?? ANNOUNCE_INTERVAL_MS,
    livenessWindowMs: deps.livenessWindowMs ?? LIVENESS_WINDOW_MS,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    onLog: log,
  });

  // The on-demand twin of the periodic election: the hub POSTs a plaintext
  // route-nudge when a real request hits an unclaimed meta-URL; the lead claims
  // (+ pre-warms the cert) instantly instead of waiting for the next gossip tick.
  const routeNudgeHandler = buildRouteNudgeHandler({
    user: deps.user,
    serverFqdn: deps.serverFqdn,
    birthDate: deps.birthDate,
    listServiceSlugs: deps.listServiceSlugs,
    liveSiblings: () => view.liveMembers((deps.now ?? (() => Date.now()))()),
    selfVoteIssuedAt: () => {
      const v = deps.readSelfVote?.();
      return v && v.date > 0 ? v.date : null;
    },
    claimer,
    fqdnForService,
    ...(deps.certPrewarm ? { certPrewarm: deps.certPrewarm } : {}),
    onLog: log,
  });

  // On-service-delete teardown: release the route + re-announce (a fresh tick
  // recomputes leads + broadcasts our now-shorter service list). Both
  // best-effort; release is idempotent (releasing a route we don't hold is a
  // no-op) and a tick failure just retries on the next interval.
  const releaseRouteForRemovedService = async (slug: string): Promise<void> => {
    try {
      await claimer.release(slug.toLowerCase());
      log(`[gossip] released route for removed service "${slug}"`);
    } catch (e) {
      log(`[gossip] release for removed "${slug}" failed: ${(e as Error).message}`);
    }
    try {
      await loop.tick();
    } catch {
      // re-announce is advisory; the periodic loop will catch up.
    }
  };

  log(
    `[gossip] enabled for ${deps.serverFqdn} (account ${deps.user}); broadcast → ${broadcastUrl}`,
  );
  return {
    enabled: true,
    handler,
    routeNudgeHandler,
    loop,
    view,
    releaseRouteForRemovedService,
    leadsSnapshot: () => ({ gossipActive: true, leads: loop.leadsSnapshot() }),
  };
}

export { SiblingView } from "./siblingView.js";
export { buildGossipIngestHandler } from "./gossipHttp.js";
export { buildGossipLoop, ANNOUNCE_INTERVAL_MS, LIVENESS_WINDOW_MS } from "./gossipLoop.js";
export {
  decideClaimActions,
  leadsSnapshot,
  runElectionRound,
  selfLeadsForRound,
  type ClaimAction,
  type SelfMember,
  type ServiceLead,
} from "./election.js";
export {
  type RouteClaimer,
  urlControllerRouteClaimer,
  tier2FqdnFor,
} from "./routeClaimer.js";
export {
  buildRouteNudgeHandler,
  buildCertPrewarm,
  apexFromBoxFqdn,
  type CertPrewarm,
  type RouteNudgeDeps,
} from "./routeNudge.js";
export { resolveCgk } from "./cgk.js";
export { buildLeadsHttpHandler, type LeadsHttpDeps } from "./leadsHttp.js";
