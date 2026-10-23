/**
 * Run an admin-signed order (update, migration, uninstall) as a ledger operation, so that it is
 * recorded, cannot run twice, is cancelled when the grants it depends on are revoked, and leaves
 * an honest `outcome-unknown` if the box dies mid-way (SECURITY-HARDENING-PLAN.md 18.5, N05).
 *
 * The caller has verified the order already; the ledger records it as the approval.
 */
import { createHash } from "node:crypto";
import type { AuthorityHub } from "./hub.js";
import { LedgerError } from "./operationLedger.js";

export interface OrderOperationInput {
  kind: string;
  requester: string;
  /** Same order, same key: a replay returns the earlier result instead of running again. */
  idempotencyKey: string;
  canonicalPayload: string;
  capabilityDigest?: string;
  grantDeps: string[];
  approvedBy: string;
  orderSignatureHex: string;
  label: string;
  /**
   * The downstream effect can be asked again safely (a take-over ack the control plane answers
   * idempotently). An attempt a restart left `outcome-unknown` is then closed as failed and the
   * order runs again, instead of waiting forever for a reconcile that cannot come.
   */
  retryInterruptedAttempt?: boolean;
}

export interface OrderOperationContext {
  /** Call immediately before the step that cannot be undone. Throws if authority was lost. */
  crossPointOfNoReturn(): Promise<void>;
  /** True once a revocation asked for this work to stop. */
  readonly cancelled: boolean;
}

export type OrderOperationResult<T> =
  | { ran: true; value: T; operationId: string }
  | { ran: false; reason: "already-applied" | "in-progress" | "refused"; operationId?: string; detail?: string };

export async function runOrderOperation<T>(
  hub: AuthorityHub,
  input: OrderOperationInput,
  exec: (ctx: OrderOperationContext) => Promise<{ value: T; resultDigest: string }>,
): Promise<OrderOperationResult<T>> {
  // The same order replayed returns the earlier result. A failed or cancelled earlier try does not
  // block a fresh attempt of the same order (a transient failure), so those get a numbered key.
  const earlier = hub.ops.list({ kind: input.kind }).filter(
    (o) => o.requester === input.requester && (o.idempotencyKey === input.idempotencyKey || o.idempotencyKey.startsWith(`${input.idempotencyKey}#`)),
  );
  if (input.retryInterruptedAttempt) {
    for (const o of earlier) {
      if (o.state === "outcome-unknown") await hub.ops.resolveUnknown(o.id, "failed", "interrupted; asked again");
    }
  }
  const retired = hub.ops.list({ kind: input.kind }).filter(
    (o) => o.requester === input.requester && (o.idempotencyKey === input.idempotencyKey || o.idempotencyKey.startsWith(`${input.idempotencyKey}#`)),
  ).filter((o) => o.state === "failed" || o.state === "cancelled").length;
  const live = hub.ops.list({ kind: input.kind }).filter(
    (o) => o.requester === input.requester && (o.idempotencyKey === input.idempotencyKey || o.idempotencyKey.startsWith(`${input.idempotencyKey}#`)),
  ).find((o) => o.state !== "failed" && o.state !== "cancelled");
  const key = live ? live.idempotencyKey : retired ? `${input.idempotencyKey}#${retired}` : input.idempotencyKey;
  let op;
  try {
    op = await hub.ops.request({
      requester: input.requester,
      kind: input.kind,
      idempotencyKey: key,
      canonicalPayload: input.canonicalPayload,
      ...(input.capabilityDigest ? { capabilityDigest: input.capabilityDigest } : {}),
      expectedRevision: 0,
      grantDeps: input.grantDeps,
      approvalTtlMs: 120_000,
    });
  } catch (e) {
    return { ran: false, reason: "refused", detail: (e as Error).message };
  }
  if (op.state === "applied") return { ran: false, reason: "already-applied", operationId: op.id };
  if (op.state === "executing" || op.state === "outcome-unknown") return { ran: false, reason: "in-progress", operationId: op.id };
  if (op.state !== "requested") return { ran: false, reason: "refused", operationId: op.id, detail: `operation is ${op.state}` };

  let cancelled = false;
  const unregister = hub.registerWork(input.grantDeps, {
    label: input.label,
    cancel: () => {
      cancelled = true;
    },
  });
  try {
    await hub.ops.authorizeVerifiedOrder(op.id, { by: input.approvedBy, signatureHex: input.orderSignatureHex });
    await hub.ops.begin(op.id);
    const out = await exec({
      crossPointOfNoReturn: async () => {
        if (cancelled) throw new LedgerError("authority-lost", "cancelled before the commit");
        await hub.ops.crossPointOfNoReturn(op.id);
      },
      get cancelled() {
        return cancelled;
      },
    });
    await hub.ops.complete(op.id, out.resultDigest);
    return { ran: true, value: out.value, operationId: op.id };
  } catch (e) {
    const cur = hub.ops.get(op.id);
    if (cur && (cur.state === "authorized" || cur.state === "executing" || cur.state === "requested")) {
      await hub.ops.fail(op.id, (e as Error).message).catch(() => {});
    }
    if (e instanceof LedgerError) return { ran: false, reason: "refused", operationId: op.id, detail: e.message };
    throw e;
  } finally {
    unregister();
  }
}

export function digestOf(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}
