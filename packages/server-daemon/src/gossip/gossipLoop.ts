/**
 * The gossip loop: every tick this box (1) builds + macs + seals its OWN
 * announcement and POSTs it to the cloud broadcast endpoint (the hub fans it to
 * every sibling's `/internal/gossip`), then (2) runs a per-service election over
 * {self + live siblings} and applies claim/yield through the RouteClaimer.
 *
 * Transport (built in parallel — Phase 4): a box POSTs a CGK-SEALED gossip blob
 * to `https://broadcast--<user>.flagship.services`; the hub returns nothing
 * useful — the box LEARNS siblings only from inbound `/internal/gossip`. So this
 * loop never reads the POST reply. Every POST is best-effort: a failed broadcast
 * just retries next tick.
 *
 * Cadence: ANNOUNCE_INTERVAL_MS (~30-60s). The SiblingView's liveness window is
 * ~2.5× that so one dropped tick doesn't evict a peer but a dead one falls out
 * within a couple of rounds. Election runs on the SAME tick as the announce (and
 * once immediately on start) so a freshly-learned dead/alive sibling is reflected
 * promptly.
 */
import {
  type GossipAnnouncement,
  macGossip,
  sealGossip,
} from "@flagship/protocol";
import {
  leadsSnapshot as computeLeadsSnapshot,
  runElectionRound,
  selfLeadsForRound,
  type SelfMember,
  type ServiceLead,
} from "./election.js";
import type { RouteClaimer } from "./routeClaimer.js";
import type { CertPrewarm } from "./routeNudge.js";
import type { SiblingView } from "./siblingView.js";

/** Default announce cadence — within the 30-60s window the spec calls for. */
export const ANNOUNCE_INTERVAL_MS = 45_000;
/** Liveness window ≈ 2.5× the announce interval (a dead sibling drops in ~2 ticks). */
export const LIVENESS_WINDOW_MS = Math.round(ANNOUNCE_INTERVAL_MS * 2.5);

/** What the loop needs to know about THIS box, re-read each tick. */
export interface SelfAnnounceState {
  user: string;
  /** This box's identity — podCanonical/fqdn, used as `name`. */
  name: string;
  /** This box's birth-certificate authority hex (its STK pub), lowercased. */
  birthAuthHex: string;
  /** Birth date (ms) from birthDateFromAuthCode. */
  birthDate: number;
  /**
   * The owner's latest set-leader vote this box has seen for ITSELF, if any:
   * `{ stkHex, date }`. The vote points at a preferred pod's STK; we only carry
   * it on our own frame when it points at us (else "none"/0).
   */
  vote: { stkHex: string; date: number } | null;
  /** Service slugs this box currently runs. */
  services: string[];
}

export interface GossipLoopDeps {
  cgk: Uint8Array;
  view: SiblingView;
  claimer: RouteClaimer;
  /**
   * Cert pre-warm seam — ensure the `<slug>.<user>` cert is loaded the moment
   * this box becomes the elected lead for a service (so the route is instantly
   * serveable). Optional; omitted on certless/demo paths.
   */
  certPrewarm?: CertPrewarm;
  /** Maps a service slug → its tier-2 `<slug>.<user>.<apex>` FQDN (for pre-warm). */
  fqdnForService?: (service: string) => string;
  /** Re-read THIS box's announce state each tick (services change over time). */
  readSelf: () => SelfAnnounceState;
  /** Broadcast endpoint, e.g. https://broadcast--harry.flagship.services . */
  broadcastUrl: string;
  intervalMs?: number;
  livenessWindowMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onLog?: (m: string) => void;
}

export interface GossipLoop {
  start(): void;
  stop(): void;
  /** Run a single announce+elect tick (also the unit-test entry point). */
  tick(): Promise<void>;
  /**
   * The service slugs THIS box currently leads — the subset of the services it
   * runs where it was the elected lead on the most recent election round. Sorted.
   * Empty until the first tick. Reported on the daemon-status heartbeat so `.com`
   * can relay per-pod "lead" badges (Phase 6 Part 3).
   */
  currentLeads(): string[];
  /**
   * The FULL per-service leadership map computed LIVE from the current
   * SiblingView (self + live siblings), pruned to the current clock. Unlike
   * `currentLeads()` (a snapshot of the last election round, only THIS box's
   * leads), this elects over the UNION of every live member's service slugs —
   * so a box answers for services it doesn't host. Computed on demand so the
   * `/api/leads` reader always reflects the freshest gossip. Keyed by slug;
   * a slug with no live runner is absent.
   */
  leadsSnapshot(): Record<string, ServiceLead>;
}

export function buildGossipLoop(deps: GossipLoopDeps): GossipLoop {
  const intervalMs = deps.intervalMs ?? ANNOUNCE_INTERVAL_MS;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const log = deps.onLog ?? (() => {});
  let timer: ReturnType<typeof setInterval> | null = null;
  // The services this box led on the most recent election round (Phase 6 Part 3).
  let leads: string[] = [];

  function buildAnnouncement(s: SelfAnnounceState): GossipAnnouncement {
    return {
      user: s.user,
      name: s.name,
      birthAuthHex: s.birthAuthHex,
      birthDate: s.birthDate,
      voteStkHex: s.vote ? s.vote.stkHex : "none",
      voteDate: s.vote ? s.vote.date : 0,
      services: [...s.services],
      liveness: "live",
      issuedAt: now(),
    };
  }

  async function announce(s: SelfAnnounceState): Promise<void> {
    const a = buildAnnouncement(s);
    const mac = macGossip(a, deps.cgk);
    const plaintext = new TextEncoder().encode(JSON.stringify({ announcement: a, mac }));
    const sealed = sealGossip(plaintext, deps.cgk);
    try {
      await fetchImpl(deps.broadcastUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        // The hub fans the OPAQUE body to siblings; the reply is ignored.
        body: sealed,
      });
    } catch (e) {
      log(`[gossip] broadcast POST failed: ${(e as Error).message}; retry next tick`);
    }
  }

  /** Build the SelfMember for this box from its current announce state. */
  function selfMember(s: SelfAnnounceState): SelfMember {
    return {
      id: s.name.toLowerCase(),
      domain: s.name.toLowerCase(),
      stkHex: s.birthAuthHex.toLowerCase(),
      birthDate: s.birthDate,
      voteIssuedAt: s.vote && s.vote.date > 0 ? s.vote.date : null,
      services: s.services,
    };
  }

  async function elect(s: SelfAnnounceState): Promise<void> {
    const t = now();
    deps.view.prune(t);
    const self: SelfMember = selfMember(s);
    const liveSiblings = deps.view.liveMembers(t);
    // Record the leads BEFORE applying claim/release so the heartbeat reports the
    // election outcome even if a claim apply throws (the route is soft, the
    // election is the source of truth for "lead").
    leads = selfLeadsForRound({ self, liveSiblings });
    await runElectionRound({
      self,
      liveSiblings,
      claimer: deps.claimer,
      ...(deps.certPrewarm && deps.fqdnForService
        ? {
            prewarmLead: async (service: string) => {
              await deps.certPrewarm!.ensure(deps.fqdnForService!(service));
            },
          }
        : {}),
      onLog: deps.onLog,
    });
  }

  async function tick(): Promise<void> {
    const s = deps.readSelf();
    // Announce first (so siblings learn us this round), then elect on what we
    // currently know. Both best-effort; an announce failure still elects.
    await announce(s);
    await elect(s);
  }

  return {
    start() {
      if (timer) return;
      // Fire one immediately so leadership converges without waiting a full tick.
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      if (typeof timer === "object" && timer && "unref" in timer) {
        (timer as { unref?: () => void }).unref?.();
      }
      log(`[gossip] loop started (announce every ${intervalMs}ms → ${deps.broadcastUrl})`);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
    currentLeads: () => [...leads],
    leadsSnapshot: () => {
      const t = now();
      deps.view.prune(t);
      const self = selfMember(deps.readSelf());
      const liveSiblings = deps.view.liveMembers(t);
      return computeLeadsSnapshot({ self, liveSiblings });
    },
  };
}
