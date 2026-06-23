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
import { runElectionRound, type SelfMember } from "./election.js";
import type { RouteClaimer } from "./routeClaimer.js";
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
}

export function buildGossipLoop(deps: GossipLoopDeps): GossipLoop {
  const intervalMs = deps.intervalMs ?? ANNOUNCE_INTERVAL_MS;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const log = deps.onLog ?? (() => {});
  let timer: ReturnType<typeof setInterval> | null = null;

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

  async function elect(s: SelfAnnounceState): Promise<void> {
    const t = now();
    deps.view.prune(t);
    const self: SelfMember = {
      id: s.name.toLowerCase(),
      domain: s.name.toLowerCase(),
      birthDate: s.birthDate,
      voteIssuedAt: s.vote && s.vote.date > 0 ? s.vote.date : null,
      services: s.services,
    };
    await runElectionRound({
      self,
      liveSiblings: deps.view.liveMembers(t),
      claimer: deps.claimer,
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
  };
}
