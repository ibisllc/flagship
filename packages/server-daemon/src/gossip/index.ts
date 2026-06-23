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
import { SiblingView } from "./siblingView.js";

export interface WireGossipResult {
  enabled: boolean;
  /** HTTP handler for `/internal/gossip` — null when disabled. */
  handler: ((req: HttpRequest) => Promise<HttpResponse | null>) | null;
  /** The loop — null when disabled. Call start() after the runtime is up. */
  loop: GossipLoop | null;
  /** The live view (for diagnostics/tests). null when disabled. */
  view: SiblingView | null;
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
    return { enabled: false, handler: null, loop: null, view: null };
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
  const claimer: RouteClaimer = urlControllerRouteClaimer({
    urlController: deps.urlController,
    fqdnForService: tier2FqdnFor(deps.user, apex),
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
    readSelf,
    broadcastUrl,
    intervalMs: deps.intervalMs ?? ANNOUNCE_INTERVAL_MS,
    livenessWindowMs: deps.livenessWindowMs ?? LIVENESS_WINDOW_MS,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    onLog: log,
  });

  log(
    `[gossip] enabled for ${deps.serverFqdn} (account ${deps.user}); broadcast → ${broadcastUrl}`,
  );
  return { enabled: true, handler, loop, view };
}

export { SiblingView } from "./siblingView.js";
export { buildGossipIngestHandler } from "./gossipHttp.js";
export { buildGossipLoop, ANNOUNCE_INTERVAL_MS, LIVENESS_WINDOW_MS } from "./gossipLoop.js";
export {
  decideClaimActions,
  runElectionRound,
  selfLeadsForRound,
  type ClaimAction,
  type SelfMember,
} from "./election.js";
export {
  type RouteClaimer,
  urlControllerRouteClaimer,
  tier2FqdnFor,
} from "./routeClaimer.js";
export { resolveCgk } from "./cgk.js";
