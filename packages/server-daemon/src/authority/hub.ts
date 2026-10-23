/**
 * Where grants, operations and live work meet (SECURITY-HARDENING-PLAN.md 18.5, N05).
 *
 * Anything that runs on borrowed authority (a build, a stream, a browser action, a download)
 * registers a cancel handler against the grants it runs under. Revoking a grant revokes its
 * children durably, cancels every operation that depended on any of them, and actively stops the
 * registered work, each handler under a deadline so one stuck job cannot hold the rest.
 */
import { GrantIndex, type Grant, type GrantKind, type RevocationResult } from "./grantIndex.js";
import { OperationLedger, type Operation } from "./operationLedger.js";

export const REVOCATION_TARGET_MS = 5_000;

export interface WorkHandle {
  id: string;
  label: string;
  /** Stop it. Must be idempotent. */
  cancel: (reason: string) => void | Promise<void>;
}

export interface RevocationReport extends RevocationResult {
  cancelledOperations: Operation[];
  stoppedWork: string[];
  /** Work whose cancel handler threw or ran past the deadline: it may still be running. */
  stuckWork: string[];
  elapsedMs: number;
}

export class AuthorityHub {
  private work = new Map<string, { handle: WorkHandle; grants: Set<string> }>();
  private seq = 0;
  private revokedHandlers = new Map<GrantKind, Array<(g: Grant) => void | Promise<void>>>();

  constructor(
    readonly grants: GrantIndex,
    readonly ops: OperationLedger,
    private readonly now: () => number = () => Date.now(),
    private readonly handlerDeadlineMs = REVOCATION_TARGET_MS,
  ) {}

  /** Register running work against the grants it runs under. Returns the deregistration. */
  registerWork(grantIds: string[], handle: Omit<WorkHandle, "id">): () => void {
    const id = `w${++this.seq}`;
    this.work.set(id, { handle: { ...handle, id }, grants: new Set(grantIds) });
    return () => {
      this.work.delete(id);
    };
  }

  /** Run `handler` for every revoked grant of `kind`: how a token store drops what the index revoked. */
  onRevoked(kind: GrantKind, handler: (g: Grant) => void | Promise<void>): void {
    this.revokedHandlers.set(kind, [...(this.revokedHandlers.get(kind) ?? []), handler]);
  }

  /** Work running under this grant or a descendant, for the per-service permissions page. */
  openWorkFor(grantId: string): string[] {
    const family = new Set([grantId, ...this.grants.descendants(grantId).map((g) => g.id)]);
    return [...this.work.values()].filter((w) => [...w.grants].some((g) => family.has(g))).map((w) => w.handle.label);
  }

  async revoke(grantId: string, reason: string): Promise<RevocationReport> {
    const started = this.now();
    const result = await this.grants.revoke(grantId, reason, started);
    const ids = result.revoked.map((g: Grant) => g.id);
    for (const g of result.revoked) {
      for (const h of this.revokedHandlers.get(g.kind) ?? []) {
        // A store that fails to drop its token must not stop the others: the index already refuses it.
        await runWithDeadline(() => h(g), this.handlerDeadlineMs);
      }
    }
    const cancelledOperations = await this.ops.cancelDependingOn(ids, `grant revoked: ${reason}`);
    const doomed = [...this.work.values()].filter((w) => [...w.grants].some((g) => ids.includes(g)));
    const stopped: string[] = [];
    const stuck: string[] = [];
    await Promise.all(
      doomed.map(async (w) => {
        const ok = await runWithDeadline(() => w.handle.cancel(`grant revoked: ${reason}`), this.handlerDeadlineMs);
        (ok ? stopped : stuck).push(w.handle.label);
        if (ok) this.work.delete(w.handle.id);
      }),
    );
    return { ...result, cancelledOperations, stoppedWork: stopped, stuckWork: stuck, elapsedMs: this.now() - started };
  }

  async revokeService(service: string, reason: string): Promise<RevocationReport[]> {
    const reports: RevocationReport[] = [];
    for (const g of this.grants.all()) {
      if (g.service === service && g.revokedAt === null) reports.push(await this.revoke(g.id, reason));
    }
    return reports;
  }
}

async function runWithDeadline(fn: () => void | Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const run = (async () => {
      await fn();
      return true as const;
    })().catch(() => false as const);
    return await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
