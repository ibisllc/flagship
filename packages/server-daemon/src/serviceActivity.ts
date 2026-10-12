/**
 * What is working on an app on this box right now, for the owner's status
 * pill (docs/app-placement.md §6): a new version going live ("deploying"),
 * a copy arriving ("copying", from the app-copy rows), or an AI chat or IDE
 * build open on it ("editing"). Owner-facing only: never handed to a model.
 */

export type ServiceActivityKind = "deploying" | "copying" | "editing";

/** Deploys under way, per service id (re-entrant: nested funnels count once each). */
export class ServiceActivity {
  private readonly deploys = new Map<string, number>();

  /** Run `fn` with `serviceId` marked as deploying until it settles. */
  async deploying<T>(serviceId: string, fn: () => Promise<T>): Promise<T> {
    this.deploys.set(serviceId, (this.deploys.get(serviceId) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (this.deploys.get(serviceId) ?? 1) - 1;
      if (n > 0) this.deploys.set(serviceId, n);
      else this.deploys.delete(serviceId);
    }
  }

  isDeploying(serviceId: string): boolean {
    return this.deploys.has(serviceId);
  }
}

/** The part of a deploy funnel's deps that marks a service as deploying. */
export type DeployingTracker = Pick<ServiceActivity, "deploying">;

/** Run `fn`, marked as deploying `serviceId` when both are given. */
export function whileDeploying<T>(
  tracker: DeployingTracker | null | undefined,
  serviceId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return tracker && serviceId ? tracker.deploying(serviceId, fn) : fn();
}

/** An AI chat's session, as far as editing goes. */
interface ChatSessionMeta {
  editsServiceId?: string;
  status: string;
}

/** A chat that changes an installed app is editing it until it's deployed, failed or cancelled. */
const CHAT_EDITING = new Set(["streaming", "awaiting-tool-response", "ready-to-deploy", "deploying"]);

/**
 * The activity per installed app: deploying wins over editing. (A copy still
 * arriving has no installed row yet; its own row says "copying".) `chats`
 * and `builds` are read once per call.
 */
export function buildActivityResolver(src: {
  tracker?: Pick<ServiceActivity, "isDeploying"> | null;
  chats?: (() => readonly ChatSessionMeta[]) | null;
  /** Service ids an open IDE / git build is changing. */
  builds?: (() => Iterable<string>) | null;
}): (serviceIds: readonly string[]) => Map<string, ServiceActivityKind> {
  return (serviceIds) => {
    const out = new Map<string, ServiceActivityKind>();
    if (serviceIds.length === 0) return out;
    const editing = new Set<string>();
    for (const m of src.chats?.() ?? []) {
      if (m.editsServiceId && CHAT_EDITING.has(m.status)) editing.add(m.editsServiceId);
    }
    for (const id of src.builds?.() ?? []) editing.add(id);
    for (const id of serviceIds) {
      if (src.tracker?.isDeploying(id)) out.set(id, "deploying");
      else if (editing.has(id)) out.set(id, "editing");
    }
    return out;
  };
}
