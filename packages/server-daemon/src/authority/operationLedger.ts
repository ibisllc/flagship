/**
 * Approval and execution as one durable transaction (SECURITY-HARDENING-PLAN.md 18.5, N05).
 *
 * An operation is what someone asked the box to do, bound to the exact payload, the state it was
 * asked against and the grants it depends on. States:
 *
 *   requested -> awaiting-approval -> authorized -> executing -> applied | failed | cancelled
 *                                                              \-> outcome-unknown
 *
 * Every transition is persisted before it is acknowledged. Approval consumes its challenge and
 * moves the operation in one step, so a replay finds nothing to consume. Authority, payload hash,
 * state revision and expiry are checked again when execution starts and again immediately before
 * an irreversible commit. A crash while executing leaves `outcome-unknown`, never a guess.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { keepCorruptAside, readStateFile, withFileLock } from "../durableFile.js";

export type OperationState =
  | "requested"
  | "awaiting-approval"
  | "authorized"
  | "executing"
  | "applied"
  | "failed"
  | "cancelled"
  | "outcome-unknown";

const TERMINAL: readonly OperationState[] = ["applied", "failed", "cancelled", "outcome-unknown"];

export interface Operation {
  id: string;
  requester: string;
  kind: string;
  idempotencyKey: string;
  payloadHash: string;
  /** Digests of the artifact or capability the payload refers to, when it names one. */
  capabilityDigest?: string;
  /** The revision of the target state the requester saw; a changed target refuses the operation. */
  expectedRevision: number;
  grantDeps: string[];
  /** Single-use approval nonce; cleared when consumed. */
  challenge: string | null;
  approvalDeadline: number;
  /** After authorization the operation must start by this time. */
  executeBy: number | null;
  state: OperationState;
  createdAt: number;
  updatedAt: number;
  approval?: { by: string; at: number; signatureHex: string };
  /** Set once the point of no return is crossed; revocation can no longer cancel the effect. */
  irreversibleAt?: number;
  cancelRequested?: string;
  resultDigest?: string;
  reason?: string;
  /** Idempotency id handed to the downstream effect so a retry or reconcile can ask what happened. */
  downstreamId: string;
}

export type LedgerErrorCode =
  | "idempotency-conflict"
  | "not-found"
  | "wrong-state"
  | "expired"
  | "bad-challenge"
  | "payload-changed"
  | "state-changed"
  | "authority-lost"
  | "approval-invalid"
  | "ledger-unavailable";

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

export function payloadHashOf(canonicalPayload: string): string {
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

/** What the box asks the world at the moments that matter. */
export interface LedgerChecks {
  /** Is each of these grants live now? */
  grantsLive(ids: string[], at: number): boolean;
  /** The current revision of the state this kind of operation targets. */
  currentRevision(kind: string): number | Promise<number>;
  /** Verify the approving device's signature over the operation's binding. */
  verifyApproval(op: Operation, approval: { by: string; signatureHex: string }): boolean | Promise<boolean>;
}

/** The bytes an approver signs: the exact operation and the state it targets. */
export function approvalBinding(op: Pick<Operation, "id" | "kind" | "payloadHash" | "capabilityDigest" | "expectedRevision" | "challenge" | "approvalDeadline" | "requester">): string {
  return [
    "flagship/operation-approval/v1",
    op.id,
    op.kind,
    op.requester,
    op.payloadHash,
    op.capabilityDigest ?? "-",
    op.expectedRevision,
    op.challenge ?? "",
    op.approvalDeadline,
  ].join("|");
}

interface Persisted {
  v: 1;
  ops: Operation[];
}

export interface RequestInput {
  requester: string;
  kind: string;
  idempotencyKey: string;
  canonicalPayload: string;
  capabilityDigest?: string;
  expectedRevision: number;
  grantDeps?: string[];
  approvalTtlMs: number;
}

export class OperationLedger {
  private ops = new Map<string, Operation>();
  private byKey = new Map<string, string>();
  private failedClosed = false;
  /**
   * Told of each change of state, content-free (ids, states, digests, reasons; never a body, token or key).
   * The box's activity log records these as evidence (SECURITY-HARDENING-PLAN.md 18.13, N13).
   */
  onTransition: ((op: Operation) => void) | null = null;

  constructor(
    private readonly path: string,
    private readonly checks: LedgerChecks,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async load(): Promise<void> {
    const read = await readStateFile(this.path);
    if (read.kind === "missing") return;
    try {
      if (read.kind === "unreadable") throw read.error;
      const parsed = JSON.parse(read.text) as Persisted;
      if (parsed?.v !== 1 || !Array.isArray(parsed.ops)) throw new Error("not an operation ledger");
      for (const op of parsed.ops) {
        this.ops.set(op.id, op);
        this.byKey.set(`${op.requester}|${op.idempotencyKey}`, op.id);
      }
    } catch (e) {
      await keepCorruptAside(this.path, e, "Pending approvals are gone; nothing that was waiting will run.");
      this.failedClosed = true;
    }
  }

  get(id: string): Operation | undefined {
    const o = this.ops.get(id);
    return o ? { ...o, grantDeps: [...o.grantDeps] } : undefined;
  }

  list(filter?: { states?: OperationState[]; kind?: string }): Operation[] {
    return [...this.ops.values()]
      .filter((o) => (!filter?.states || filter.states.includes(o.state)) && (!filter?.kind || o.kind === filter.kind))
      .map((o) => ({ ...o }));
  }

  /** Request an operation. The same requester and key with the same payload returns the same operation. */
  async request(input: RequestInput): Promise<Operation> {
    this.assertUsable();
    const payloadHash = payloadHashOf(input.canonicalPayload);
    const existingId = this.byKey.get(`${input.requester}|${input.idempotencyKey}`);
    if (existingId) {
      const existing = this.ops.get(existingId)!;
      if (existing.payloadHash !== payloadHash || existing.kind !== input.kind) {
        throw new LedgerError("idempotency-conflict", "that idempotency key was already used for a different request");
      }
      return { ...existing };
    }
    const t = this.now();
    const op: Operation = {
      id: randomBytes(16).toString("hex"),
      requester: input.requester,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      ...(input.capabilityDigest ? { capabilityDigest: input.capabilityDigest } : {}),
      expectedRevision: input.expectedRevision,
      grantDeps: [...(input.grantDeps ?? [])],
      challenge: null,
      approvalDeadline: t + input.approvalTtlMs,
      executeBy: null,
      state: "requested",
      createdAt: t,
      updatedAt: t,
      downstreamId: randomBytes(16).toString("hex"),
    };
    return this.commit(op, () => {
      this.byKey.set(`${op.requester}|${op.idempotencyKey}`, op.id);
    });
  }

  /** Issue the single-use challenge the phone signs, and wait for it. */
  async awaitApproval(id: string): Promise<Operation> {
    const op = this.must(id, ["requested"]);
    const next = { ...op, state: "awaiting-approval" as const, challenge: randomBytes(16).toString("hex"), updatedAt: this.now() };
    return this.commit(next);
  }

  /**
   * Consume the challenge and authorize, atomically. A replayed approval, a changed payload or
   * target, a late approval or a lost grant each leave the operation unapproved.
   */
  async approve(
    id: string,
    approval: { by: string; signatureHex: string; challenge: string; payloadHash: string; expectedRevision: number },
    executeWithinMs = 120_000,
  ): Promise<Operation> {
    const op = this.must(id, ["awaiting-approval"]);
    const t = this.now();
    if (t > op.approvalDeadline) {
      await this.commit({ ...op, state: "cancelled", challenge: null, reason: "approval-expired", updatedAt: t });
      throw new LedgerError("expired", "the approval window closed");
    }
    if (!op.challenge || !sameString(op.challenge, approval.challenge)) {
      throw new LedgerError("bad-challenge", "that approval does not answer this request");
    }
    if (op.payloadHash !== approval.payloadHash) throw new LedgerError("payload-changed", "the approval is for different contents");
    if (op.expectedRevision !== approval.expectedRevision) throw new LedgerError("state-changed", "the approval is for a different version of the target");
    if (!(await this.checks.verifyApproval(op, { by: approval.by, signatureHex: approval.signatureHex }))) {
      throw new LedgerError("approval-invalid", "the approval's signature does not match this request");
    }
    // Re-read: another approval may have won while the signature was being checked.
    const again = this.must(id, ["awaiting-approval"]);
    if (again.challenge !== op.challenge) throw new LedgerError("bad-challenge", "that approval was already used");
    return this.commit({
      ...again,
      state: "authorized",
      challenge: null,
      approval: { by: approval.by, at: t, signatureHex: approval.signatureHex },
      executeBy: t + executeWithinMs,
      updatedAt: t,
    });
  }

  /**
   * Authorize an operation whose approval is an order the caller has ALREADY verified under the
   * box's pinned authority (an admin-signed update, migration or uninstall order). The order's own
   * signature is recorded as the approval; no challenge round trip exists because the signed order
   * is the approval. Callers must verify the order first; this method does not.
   */
  async authorizeVerifiedOrder(id: string, order: { by: string; signatureHex: string }, executeWithinMs = 120_000): Promise<Operation> {
    const op = this.must(id, ["requested"]);
    const t = this.now();
    if (t > op.approvalDeadline) {
      await this.commit({ ...op, state: "cancelled", reason: "approval-expired", updatedAt: t });
      throw new LedgerError("expired", "the order's window closed");
    }
    return this.commit({
      ...op,
      state: "authorized",
      approval: { by: order.by, at: t, signatureHex: order.signatureHex },
      executeBy: t + executeWithinMs,
      updatedAt: t,
    });
  }

  /** Start executing. Authority, content, revision and time are checked again here. */
  async begin(id: string): Promise<Operation> {
    const op = this.must(id, ["authorized"]);
    const t = this.now();
    if (op.executeBy !== null && t > op.executeBy) {
      await this.commit({ ...op, state: "cancelled", reason: "not-started-in-time", updatedAt: t });
      throw new LedgerError("expired", "the approved operation was not started in time");
    }
    await this.recheck(op, t);
    return this.commit({ ...op, state: "executing", updatedAt: t });
  }

  /** Call immediately before an irreversible commit. Throws, and cancels, if anything moved. */
  async crossPointOfNoReturn(id: string): Promise<Operation> {
    const op = this.must(id, ["executing"]);
    if (op.cancelRequested) throw new LedgerError("authority-lost", `cancelled before the commit: ${op.cancelRequested}`);
    await this.recheck(op, this.now(), true);
    return this.commit({ ...op, irreversibleAt: this.now(), updatedAt: this.now() });
  }

  async complete(id: string, resultDigest: string): Promise<Operation> {
    const op = this.must(id, ["executing"]);
    return this.commit({ ...op, state: "applied", resultDigest, updatedAt: this.now() });
  }

  async fail(id: string, reason: string): Promise<Operation> {
    const op = this.must(id, ["awaiting-approval", "authorized", "executing", "requested"]);
    return this.commit({ ...op, state: "failed", challenge: null, reason, updatedAt: this.now() });
  }

  /**
   * Cancel. Before the point of no return it ends the operation; after it, it only records that
   * cancellation was asked for, so the real outcome is still reported.
   */
  async cancel(id: string, reason: string): Promise<Operation> {
    const op = this.must(id, ["requested", "awaiting-approval", "authorized", "executing"]);
    if (op.state === "executing") {
      if (op.irreversibleAt !== undefined) return this.commit({ ...op, cancelRequested: reason, updatedAt: this.now() });
      return this.commit({ ...op, state: "cancelled", challenge: null, cancelRequested: reason, reason, updatedAt: this.now() });
    }
    return this.commit({ ...op, state: "cancelled", challenge: null, reason, updatedAt: this.now() });
  }

  /** Cancel everything non-terminal that depends on any of these grants. Returns the operations touched. */
  async cancelDependingOn(grantIds: string[], reason: string): Promise<Operation[]> {
    const touched: Operation[] = [];
    for (const op of [...this.ops.values()]) {
      if (TERMINAL.includes(op.state)) continue;
      if (!op.grantDeps.some((g) => grantIds.includes(g))) continue;
      touched.push(await this.cancel(op.id, reason));
    }
    return touched;
  }

  /**
   * After a restart: an operation that was executing may or may not have taken effect, so it
   * becomes `outcome-unknown` for the downstream reconcile; a late approval window closes.
   */
  async recover(): Promise<{ unknown: Operation[]; expired: Operation[] }> {
    const unknown: Operation[] = [];
    const expired: Operation[] = [];
    const t = this.now();
    for (const op of [...this.ops.values()]) {
      if (op.state === "executing") {
        unknown.push(await this.commit({ ...op, state: "outcome-unknown", reason: "interrupted", updatedAt: t }));
      } else if ((op.state === "awaiting-approval" || op.state === "requested") && t > op.approvalDeadline) {
        expired.push(await this.commit({ ...op, state: "cancelled", challenge: null, reason: "approval-expired", updatedAt: t }));
      } else if (op.state === "authorized" && op.executeBy !== null && t > op.executeBy) {
        expired.push(await this.commit({ ...op, state: "cancelled", reason: "not-started-in-time", updatedAt: t }));
      }
    }
    return { unknown, expired };
  }

  /** A downstream reconcile resolved an uncertain outcome. */
  async resolveUnknown(id: string, outcome: "applied" | "failed", detail: string): Promise<Operation> {
    const op = this.must(id, ["outcome-unknown"]);
    return this.commit({ ...op, state: outcome, ...(outcome === "applied" ? { resultDigest: detail } : { reason: detail }), updatedAt: this.now() });
  }

  async prune(olderThanMs: number): Promise<number> {
    let n = 0;
    for (const [id, op] of [...this.ops]) {
      if (TERMINAL.includes(op.state) && op.state !== "outcome-unknown" && op.updatedAt <= this.now() - olderThanMs) {
        this.ops.delete(id);
        this.byKey.delete(`${op.requester}|${op.idempotencyKey}`);
        n += 1;
      }
    }
    if (n) await this.persist();
    return n;
  }

  private async recheck(op: Operation, at: number, irreversible = false): Promise<void> {
    const fail = async (code: LedgerErrorCode, message: string) => {
      await this.commit({ ...this.ops.get(op.id)!, state: "cancelled", reason: code, updatedAt: at });
      throw new LedgerError(code, message);
    };
    if (!this.checks.grantsLive(op.grantDeps, at)) await fail("authority-lost", "a grant this depends on was revoked or has ended");
    const rev = await this.checks.currentRevision(op.kind);
    if (rev !== op.expectedRevision) await fail("state-changed", "the target changed since this was approved");
    if (irreversible && op.approval === undefined) await fail("approval-invalid", "no approval is recorded");
  }

  private must(id: string, states: OperationState[]): Operation {
    this.assertUsable();
    const op = this.ops.get(id);
    if (!op) throw new LedgerError("not-found", `no operation ${id}`);
    if (!states.includes(op.state)) throw new LedgerError("wrong-state", `operation is ${op.state}`);
    return { ...op, grantDeps: [...op.grantDeps] };
  }

  private assertUsable(): void {
    if (this.failedClosed) throw new LedgerError("ledger-unavailable", "the operation ledger is unreadable");
  }

  /** Persist first; only then does the in-memory view change and the caller hear back. */
  private async commit(next: Operation, after?: () => void): Promise<Operation> {
    const prior = this.ops.get(next.id);
    this.ops.set(next.id, next);
    try {
      await this.persist();
    } catch (e) {
      if (prior) this.ops.set(next.id, prior);
      else this.ops.delete(next.id);
      throw e;
    }
    after?.();
    if (!prior || prior.state !== next.state) {
      try {
        this.onTransition?.({ ...next, grantDeps: [...next.grantDeps] });
      } catch {
        /* evidence must never stop the operation */
      }
    }
    return { ...next, grantDeps: [...next.grantDeps] };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const body: Persisted = { v: 1, ops: [...this.ops.values()] };
    await withFileLock(this.path, (write) => write(JSON.stringify(body)));
  }
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
