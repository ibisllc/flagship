/**
 * A co-manager moves this server to an endorsed release
 * (docs/share-a-server.md §5.6).
 *
 * The order is `flagship/server-share-update/v1`, signed by the share's
 * per-share key and chained to the owner's grant, which must be at manage
 * level and still standing. From there it takes the owner's path exactly:
 * the same replay and base gates (`admitUpdateOrder`) and the same
 * endorsement and lineage gate before anything is checked out
 * (`applyEndorsedUpdate`). Picking a release is all the co-manager decides;
 * whether it may run here is the maintainers' endorsement, as for the owner.
 *
 * The apply runs after the answer (fetch and rebuild take minutes, then the
 * daemon restarts), and its verdict lands where the owner's does: the
 * update-outcome record server-detail reports.
 */
import {
  parseServerShareGrant,
  parseServerShareUpdate,
  verifyServerShareGrant,
  verifyServerShareUpdate,
  type ServerShareGrant,
  type ServerShareUpdate,
} from "@flagship/protocol";
import {
  admitUpdateOrder,
  updateApplyInProgress,
  type AdmitUpdateOrderOptions,
  type ApplyApproval,
  type PendingVerifyStore,
  type UpdateConsumeOutcome,
} from "../updateConsumer.js";
import { refusalRecord, type UpdateOutcomeStore } from "../updateOutcome.js";
import type { ActivityLog } from "./activityLog.js";
import { hexBytes } from "./shareStore.js";

export interface ShareUpdateCaller {
  shareId: string;
  label: string;
  level: "view" | "manage";
  memberPubHex: string;
  grant: ServerShareGrant;
  grantSignature: string;
}

export interface ShareUpdateDeps {
  gate: AdmitUpdateOrderOptions;
  pendingStore: PendingVerifyStore;
  /** The owner's sensitive key signed this grant (re-checked for every order). */
  verifyOwnerGrant: (g: ServerShareGrant, sig: Uint8Array) => boolean;
  /** `applyEndorsedUpdate` bound to this box's checkout and release gate. */
  apply: (currentCommit: string, targetCommit: string, why: string, approval: ApplyApproval) => Promise<UpdateConsumeOutcome>;
  outcomeStore?: UpdateOutcomeStore;
  activity?: ActivityLog;
  now?: () => number;
  log?: (m: string) => void;
}

export interface ShareUpdateAnswer {
  status: number;
  body: Record<string, unknown>;
  /** The apply that started, for tests and logs; absent when refused up front. */
  done?: Promise<UpdateConsumeOutcome>;
}

const REFUSAL_STATUS: Record<string, number> = {
  "wrong-domain": 403,
  stale: 403,
  "replayed-nonce": 409,
  "from-commit-mismatch": 409,
  error: 503,
};

export function buildShareUpdate(deps: ShareUpdateDeps) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((m: string) => console.log(m));
  const refuse = (status: number, code: string, error: string): ShareUpdateAnswer => ({ status, body: { error, code } });

  /** The grant behind the caller, re-verified, at manage level, for this key. */
  function chainHolds(caller: ShareUpdateCaller, u: ServerShareUpdate): boolean {
    const g = parseServerShareGrant(caller.grant);
    const gs = hexBytes(caller.grantSignature);
    if (!g || !gs || gs.length !== 64 || !deps.verifyOwnerGrant(g, gs)) return false;
    return g.level === "manage" && g.shareId === u.shareId && g.memberPubHex === u.memberPubHex;
  }

  return async function order(caller: ShareUpdateCaller, body: Record<string, unknown> | null): Promise<ShareUpdateAnswer> {
    if (caller.level !== "manage") return refuse(403, "manage-only", "manage-only");
    const u = parseServerShareUpdate(body?.update);
    const sig = typeof body?.signature === "string" ? hexBytes(body.signature) : null;
    if (!u || !sig || sig.length !== 64) return refuse(400, "malformed", "malformed update order");
    if (u.shareId !== caller.shareId || u.memberPubHex !== caller.memberPubHex) {
      return refuse(403, "not-this-share", "the order is signed for another share");
    }
    if (!verifyServerShareUpdate(u, sig, hexBytes(u.memberPubHex)!)) return refuse(403, "invalid-signature", "invalid signature");
    if (!chainHolds(caller, u)) return refuse(403, "manage-only", "manage-only");
    if (updateApplyInProgress()) return refuse(409, "busy", "an update is already being applied");
    try {
      if ((await deps.pendingStore.read()) !== null) return refuse(409, "pending-verify", "an update is waiting to prove itself");
    } catch {
      /* an unreadable marker is treated as "none pending", as for the owner */
    }
    const admitted = await admitUpdateOrder(deps.gate, {
      serverDomain: u.serverDomain,
      targetCommit: u.targetCommit,
      fromCommit: u.fromCommit,
      nonce: u.nonce,
      issuedAt: u.issuedAt,
    });
    if (!admitted.admitted) {
      const reason = admitted.outcome.reason;
      return refuse(REFUSAL_STATUS[reason] ?? 409, reason, reason);
    }
    deps.activity?.record({
      actor: { kind: "share", shareId: caller.shareId, label: caller.label },
      action: "server.update",
      target: u.targetCommit,
      ok: true,
    });
    log(`[shares] ${caller.shareId.slice(0, 8)} ordered an update to ${u.targetCommit.slice(0, 8)}`);
    const done = deps
      .apply(admitted.currentCommit, u.targetCommit, "share-ordered, maintainer-endorsed", {
        requester: `co-manager:${u.shareId}`,
        by: u.memberPubHex,
        signatureHex: Buffer.from(sig).toString("hex"),
      })
      .then(async (out) => {
        const refusal = refusalRecord(out, now());
        if (refusal) await deps.outcomeStore?.write(refusal).catch(() => {});
        return out;
      })
      .catch((e: Error): UpdateConsumeOutcome => {
        log(`[shares] update apply threw: ${e.message}`);
        return { applied: false, reason: "apply-failed" };
      });
    return { status: 202, body: { ok: true, accepted: true, targetCommit: u.targetCommit }, done };
  };
}

export type ShareUpdateOrder = ReturnType<typeof buildShareUpdate>;
