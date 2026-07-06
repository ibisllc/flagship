import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import {
  verifySetLeader,
  SET_LEADER_NONE,
  type AdminGrantView,
  type SetLeaderVote,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";

/**
 * Box-side consumer of the owner's preferred-server vote (Phase 6) — the
 * companion to the gossip loop's `readSelfVote` getter.
 *
 * The owner's phone signs an owner-IRK `set-leader` vote (`flagship/set-leader/v1`)
 * naming a `preferredStkPubHex`, ADDRESSED to a box domain, and deposits it on the
 * `.com` `purpose:"set-leader"` lane. This module polls that lane for THIS box,
 * RE-VERIFIES the vote under the config-pinned owner IRK (`.com` is not a trust
 * anchor), and stores the verified vote in a local `set-leader.json` marker.
 *
 * The gossip loop's `readSelfVote` getter then returns the stored vote ONLY when
 * `preferredStkPubHex` is THIS box's STK (so the vote rides this box's own gossip
 * announcement, lifting its clout). When the vote points at a SIBLING, this box
 * holds NO self-vote — the sibling carries the vote on ITS frame and this box
 * learns it via gossip. `preferredStkPubHex = "none"` clears the vote (the getter
 * returns null). Unlike the SWK/CGK consumers there is NO restart — the vote is a
 * standing preference read live each gossip tick, not a one-shot enablement.
 *
 * Everything is best-effort + never throws: a forged/junk/wrong-account vote is
 * rejected and the box keeps polling; a missing/corrupt marker means "no vote".
 */

const HEX = /^[0-9a-f]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX_SIG = /^[0-9a-f]{128}$/;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The verified vote we persist + read back. */
export interface StoredSetLeaderVote {
  user: string;
  /** Lowercased STK pub hex of the preferred pod, or "none" to clear. */
  preferredStkPubHex: string;
  issuedAt: number;
  nonce: string;
}

/**
 * Parse the deposited set-leader carrier hex (`{vote, signature}` UTF-8 JSON) and
 * RE-VERIFY it under the owner IRK + bind it to this account. Returns the stored
 * vote shape on success, or null on ANY defect — never throws.
 */
export function decodeAndVerifySetLeaderCarrier(args: {
  sealedHex: string;
  ownerIrkPub: Uint8Array;
  user: string;
  /** Slice D — pinned admin master root; present ⇒ authority gate, absent ⇒ legacy owner-IRK. */
  adminRootPub?: Uint8Array;
  /** Slice D — box-local active admin grants (`[]` box-side today). */
  activeGrants?: readonly AdminGrantView[];
}): StoredSetLeaderVote | null {
  try {
    const h = args.sealedHex.toLowerCase();
    if (!HEX.test(h) || h.length === 0 || h.length % 2 !== 0) return null;
    let json: string;
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(h));
    } catch {
      return null;
    }
    const p = JSON.parse(json) as {
      vote?: {
        user?: unknown;
        preferredStkPubHex?: unknown;
        issuedAt?: unknown;
        nonce?: unknown;
      };
      signature?: unknown;
    };
    const v = p.vote;
    if (
      !v ||
      typeof v.user !== "string" ||
      typeof v.preferredStkPubHex !== "string" ||
      typeof v.issuedAt !== "number" ||
      typeof v.nonce !== "string" ||
      typeof p.signature !== "string" ||
      !HEX_SIG.test(p.signature.toLowerCase())
    ) {
      return null;
    }
    const prefLower = v.preferredStkPubHex.toLowerCase();
    if (prefLower !== SET_LEADER_NONE && !HEX64.test(prefLower)) return null;
    // The vote must bind to THIS account.
    if (v.user.toLowerCase() !== args.user.toLowerCase()) return null;

    const vote: SetLeaderVote = {
      user: v.user,
      preferredStkPubHex: v.preferredStkPubHex,
      issuedAt: v.issuedAt,
      nonce: v.nonce,
    };
    if (
      !authorizeSensitiveOrder({
        order: vote,
        signature: hexToBytes(p.signature.toLowerCase()),
        verify: verifySetLeader,
        ownerIrkPub: args.ownerIrkPub,
        adminRootPub: args.adminRootPub,
        username: args.user,
        activeGrants: args.activeGrants,
      })
    ) {
      return null;
    }
    return {
      user: vote.user,
      preferredStkPubHex: prefLower,
      issuedAt: vote.issuedAt,
      nonce: vote.nonce.toLowerCase(),
    };
  } catch {
    return null;
  }
}

/** File-backed store for the verified standing vote. */
export interface SetLeaderVoteStore {
  read(): Promise<StoredSetLeaderVote | null>;
  write(vote: StoredSetLeaderVote): Promise<void>;
}

export function fileSetLeaderVoteStore(path: string): SetLeaderVoteStore {
  return {
    async read() {
      try {
        const raw = await readFile(path, "utf-8");
        const p = JSON.parse(raw) as Partial<StoredSetLeaderVote>;
        if (
          typeof p.user !== "string" ||
          typeof p.preferredStkPubHex !== "string" ||
          typeof p.issuedAt !== "number" ||
          typeof p.nonce !== "string"
        ) {
          return null;
        }
        return {
          user: p.user,
          preferredStkPubHex: p.preferredStkPubHex.toLowerCase(),
          issuedAt: p.issuedAt,
          nonce: p.nonce,
        };
      } catch {
        return null;
      }
    },
    async write(vote) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(vote) + "\n", { mode: 0o600 });
      await rename(tmp, path);
    },
  };
}

/**
 * Build the `readSelfVote` getter the gossip loop expects: it reads the latest
 * stored vote and returns `{ stkHex, date }` ONLY when the vote points at THIS
 * box's STK. A vote for a sibling (or "none") → null (this box holds no self-vote;
 * the sibling carries its vote via gossip). Pure + synchronous-snapshot over a
 * supplied vote-getter, so the loop can call it each tick with no I/O on the hot
 * path (the consumer refreshes the in-memory snapshot on each successful poll).
 */
export function buildReadSelfVote(args: {
  /** Synchronous snapshot of the latest verified vote (null when none). */
  currentVote: () => StoredSetLeaderVote | null;
  /** This box's own STK pub hex (lowercased compare). */
  selfStkHex: string;
}): () => { stkHex: string; date: number } | null {
  const selfStk = args.selfStkHex.toLowerCase();
  return () => {
    const v = args.currentVote();
    if (!v) return null;
    if (v.preferredStkPubHex === SET_LEADER_NONE) return null;
    if (v.preferredStkPubHex !== selfStk) return null;
    return { stkHex: v.preferredStkPubHex, date: v.issuedAt };
  };
}

export interface ClaimSetLeaderOptions {
  serverDomain: string;
  /** This box's account (UserId) — the vote must bind to it. */
  user: string;
  /** The config-pinned owner IRK pubkey — the legacy trust anchor. */
  ownerIrkPub: Uint8Array;
  /** Slice D — the pinned admin master root (`ServerConfig.adminRootPub`);
   *  present ⇒ the vote is gated by `requireMasterAdmin`, absent ⇒ legacy
   *  owner-IRK verification (a strict no-op on pre-wipe boxes). */
  adminRootPub?: Uint8Array;
  /** Slice D — box-local active admin grants (`[]` box-side today). */
  activeGrants?: readonly AdminGrantView[];
  /** `.com` base URL. */
  controlPlaneBaseUrl: string;
  /** Persist the verified vote locally + refresh the in-memory snapshot. */
  store: SetLeaderVoteStore;
  /** Called with the freshly-stored vote so the loop's getter sees it at once. */
  onVote?: (vote: StoredSetLeaderVote) => void;
  fetchImpl?: typeof fetch;
  onLog?: (m: string) => void;
}

export type SetLeaderClaimOutcome =
  | { stored: false; reason: "no-deposit" | "rejected" | "stale" | "error" }
  | { stored: true; vote: StoredSetLeaderVote };

/**
 * One poll: fetch + verify + store the freshest set-leader vote addressed to this
 * box. Never throws. Idempotent re-storage is harmless (the same vote overwrites
 * itself); a NEWER vote (or a "none" clear) replaces the prior one.
 */
export async function claimSetLeaderDeposit(
  opts: ClaimSetLeaderOptions,
): Promise<SetLeaderClaimOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onLog ?? (() => {});
  const base = opts.controlPlaneBaseUrl.replace(/\/+$/, "");
  const url = `${base}/api/server/${encodeURIComponent(opts.serverDomain)}/set-leader`;

  let sealedHex: string | undefined;
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (res.status === 404) return { stored: false, reason: "no-deposit" };
    if (!res.ok) {
      log(`[set-leader] GET ${res.status}; ignoring`);
      return { stored: false, reason: "error" };
    }
    const body = (await res.json()) as { sealed?: string };
    sealedHex = body?.sealed;
  } catch (e) {
    log(`[set-leader] GET failed: ${(e as Error).message}`);
    return { stored: false, reason: "error" };
  }

  if (typeof sealedHex !== "string" || sealedHex.length === 0) {
    return { stored: false, reason: "rejected" };
  }

  const vote = decodeAndVerifySetLeaderCarrier({
    sealedHex,
    ownerIrkPub: opts.ownerIrkPub,
    user: opts.user,
    ...(opts.adminRootPub ? { adminRootPub: opts.adminRootPub } : {}),
    ...(opts.activeGrants ? { activeGrants: opts.activeGrants } : {}),
  });
  if (!vote) {
    log("[set-leader] vote rejected (signature/account mismatch); ignoring");
    return { stored: false, reason: "rejected" };
  }

  // v1-sec GAP 6 — monotonic replay defense. A captured OLDER signed vote must
  // NOT overwrite a newer preferred-server choice: `.com` is not a trust anchor
  // and could re-serve a stale deposit. Only accept a vote STRICTLY newer than
  // the last applied one (a re-served equal vote is a no-op, not an overwrite).
  let prior: StoredSetLeaderVote | null = null;
  try {
    prior = await opts.store.read();
  } catch {
    /* unreadable/absent prior ⇒ treat as no prior vote */
  }
  if (prior && vote.issuedAt <= prior.issuedAt) {
    log(
      `[set-leader] ignoring stale/replayed vote (issuedAt ${vote.issuedAt} ` +
        `<= last applied ${prior.issuedAt})`,
    );
    return { stored: false, reason: "stale" };
  }

  try {
    await opts.store.write(vote);
  } catch (e) {
    log(`[set-leader] persist failed (${(e as Error).message}); ignoring`);
    return { stored: false, reason: "error" };
  }
  opts.onVote?.(vote);
  log(
    `[set-leader] stored owner vote → ${vote.preferredStkPubHex === SET_LEADER_NONE ? "(cleared)" : vote.preferredStkPubHex}`,
  );
  return { stored: true, vote };
}

export interface SetLeaderConsumer {
  pollOnce(): Promise<SetLeaderClaimOutcome>;
  /** Synchronous snapshot of the latest verified vote (drives readSelfVote). */
  currentVote(): StoredSetLeaderVote | null;
  start(): void;
  stop(): void;
}

/**
 * Poll the set-leader lane on the daemon heartbeat cadence (default 5 min) and
 * keep an in-memory snapshot of the latest verified vote. Unlike the SWK/CGK
 * pollers it NEVER stops on success — the vote is a standing preference that can
 * change (a new vote, or a "none" clear) and the box must keep up to date. The
 * stored vote is loaded once at start so a reboot keeps the last verified vote.
 */
export function buildSetLeaderConsumer(
  opts: ClaimSetLeaderOptions & { intervalMs?: number },
): SetLeaderConsumer {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let snapshot: StoredSetLeaderVote | null = null;
  let loaded = false;

  const innerOpts: ClaimSetLeaderOptions = {
    ...opts,
    onVote: (v) => {
      snapshot = v;
      opts.onVote?.(v);
    },
  };

  async function pollOnce(): Promise<SetLeaderClaimOutcome> {
    if (!loaded) {
      // First tick: hydrate from disk so a reboot keeps the last verified vote
      // until a fresh poll (consume-once may have already drained the lane).
      try {
        snapshot = await opts.store.read();
      } catch {
        /* corrupt/missing marker → no vote */
      }
      loaded = true;
    }
    return claimSetLeaderDeposit(innerOpts);
  }

  return {
    pollOnce,
    currentVote: () => snapshot,
    start() {
      if (timer) return;
      void pollOnce().catch(() => {});
      timer = setInterval(() => {
        void pollOnce().catch(() => {});
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
