/**
 * One browser context per service, and every target owned (SECURITY-HARDENING-PLAN.md 10.4,
 * SEC-BROWSER-002). Two apps never share cookies, storage, caches, workers, permissions or
 * history, nor do they share with the owner's own browser (which is no context here).
 *
 * The manager attaches to every new target with execution paused and asks this registry who owns
 * it BEFORE resuming. A target the registry cannot place is rejected, never raced: a popup or
 * worker belongs to its opener's context, and anything else is closed.
 */
export class PolicyError extends Error {
  constructor(
    readonly code: "not-owner" | "unowned-target" | "origin-changed" | "out-of-scope" | "no-context",
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface TargetAttach {
  targetId: string;
  /** The context Chromium put it in. */
  browserContextId?: string;
  /** The target that opened it (popup, worker, child frame). */
  openerId?: string;
}

export type AttachDecision = { allow: true; serviceId: string } | { allow: false; reason: string };

export class ContextRegistry {
  private contextByService = new Map<string, string>();
  private serviceByContext = new Map<string, string>();
  private owner = new Map<string, string>(); // targetId -> serviceId
  private quarantined = new Set<string>();

  /** Make (or find) the service's one context. `create` runs once per service. */
  async contextFor(serviceId: string, create: () => Promise<string>): Promise<string> {
    const have = this.contextByService.get(serviceId);
    if (have) return have;
    const id = await create();
    // Another call may have made one while this one waited.
    const raced = this.contextByService.get(serviceId);
    if (raced) return raced;
    this.contextByService.set(serviceId, id);
    this.serviceByContext.set(id, serviceId);
    return id;
  }

  /** Decide ownership of a newly attached (still paused) target. */
  attach(t: TargetAttach): AttachDecision {
    const byContext = t.browserContextId ? this.serviceByContext.get(t.browserContextId) : undefined;
    const byOpener = t.openerId ? this.owner.get(t.openerId) : undefined;
    if (byContext && byOpener && byContext !== byOpener) return { allow: false, reason: "the target is in one app's context but was opened by another's" };
    const serviceId = byContext ?? byOpener;
    if (!serviceId) return { allow: false, reason: "the target belongs to no app" };
    // A target in the right owner's tree must also be in that owner's context, never the default one.
    if (byOpener && t.browserContextId && this.serviceByContext.get(t.browserContextId) !== byOpener) {
      return { allow: false, reason: "a popup left its app's context" };
    }
    this.owner.set(t.targetId, serviceId);
    return { allow: true, serviceId };
  }

  ownerOf(targetId: string): string | null {
    return this.owner.get(targetId) ?? null;
  }

  assertOwned(serviceId: string, targetId: string): void {
    const o = this.owner.get(targetId);
    if (!o) throw new PolicyError("unowned-target", "that tab is not one of this app's");
    if (o !== serviceId) throw new PolicyError("not-owner", "that tab belongs to another app");
    if (this.quarantined.has(targetId)) throw new PolicyError("out-of-scope", "that tab was closed for leaving what was approved");
  }

  quarantine(targetId: string): void {
    this.quarantined.add(targetId);
  }

  targetsOf(serviceId: string): string[] {
    return [...this.owner].filter(([, s]) => s === serviceId).map(([t]) => t);
  }

  forget(targetId: string): void {
    this.owner.delete(targetId);
    this.quarantined.delete(targetId);
  }

  /** Uninstall or revocation: everything the service owned, and its context to dispose. */
  destroyService(serviceId: string): { targets: string[]; contextId: string | null } {
    const targets = this.targetsOf(serviceId);
    for (const t of targets) this.forget(t);
    const contextId = this.contextByService.get(serviceId) ?? null;
    this.contextByService.delete(serviceId);
    if (contextId) this.serviceByContext.delete(contextId);
    return { targets, contextId };
  }
}
