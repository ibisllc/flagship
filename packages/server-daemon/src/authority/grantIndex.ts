/**
 * The index of derived authority (SECURITY-HARDENING-PLAN.md 18.5, N05).
 *
 * Every token, key, session, job or handle that lets something act for the owner is a grant with a
 * parent: a companion session's parent is the device that minted it, an API key's is the app and
 * the admin who created it, a build token's is the chat that started it. Revoking a parent revokes
 * every descendant in one durable step and bumps a revocation epoch kept in the box's state
 * directory, not in app data, so restoring an app's data cannot bring a revoked grant back.
 *
 * This index only records and answers. Stopping the work a grant was funding (a build, a stream, a
 * browser action) is the hub's job, through the cancel handlers registered with it.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { keepCorruptAside, readStateFile, withFileLock } from "../durableFile.js";

export type GrantKind =
  | "owner-session"
  | "companion-session"
  | "companion-delegation"
  | "app-api-key"
  | "mcp-key"
  | "build-token"
  | "share"
  | "member-invite"
  | "browser-grant"
  | "secret-handle"
  | "stream-ticket"
  | "job";

export interface Grant {
  id: string;
  kind: GrantKind;
  /** Who vouched: the device or account key that caused this grant to exist. */
  issuer: string;
  /** Who or what may act under it. */
  subject: string;
  /** The account generation it was issued under; a recovery or rotation lifts it. */
  accountGeneration: number;
  /** The service installation it is for (slug + install id), when it is for one. */
  service?: string;
  audience: string;
  /** What it allows, in the issuing feature's words ("read", "write", "browser:example.com"). */
  capability: string;
  constraints?: Record<string, string | number | boolean>;
  /** Grants this one derives from. Empty for a root (a device's own key). */
  parents: string[];
  /** The access-list or policy revision it was issued against. */
  policyRevision: number;
  issuedAt: number;
  /** Absolute end, ms; null = until revoked. */
  expiresAt: number | null;
  revokedAt: number | null;
  revokeReason?: string;
  /** Reading secrets is a separate permission from ordinary read. Never inherited from a parent that lacks it. */
  secretAccess: boolean;
}

export type NewGrant = Omit<Grant, "revokedAt" | "revokeReason" | "parents" | "expiresAt" | "secretAccess"> &
  Partial<Pick<Grant, "parents" | "expiresAt" | "secretAccess">>;

export interface RevocationResult {
  epoch: number;
  /** The grant asked for and every descendant that was live, in the order they were revoked. */
  revoked: Grant[];
}

interface Persisted {
  v: 1;
  epoch: number;
  grants: Grant[];
}

export class GrantRefusedError extends Error {
  constructor(
    message: string,
    readonly code: "unknown-parent" | "dead-parent" | "secret-widening" | "duplicate" | "bad-grant" | "index-unavailable",
  ) {
    super(message);
    this.name = "GrantRefusedError";
  }
}

export class GrantIndex {
  private grants = new Map<string, Grant>();
  private epochValue = 0;
  /** Set when the file could not be read: nothing is live until the owner re-issues. */
  private failedClosed = false;

  constructor(
    private readonly path: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The revocation epoch: bumps on every revoke, never goes back. */
  get epoch(): number {
    return this.epochValue;
  }

  get unavailable(): boolean {
    return this.failedClosed;
  }

  async load(): Promise<void> {
    const read = await readStateFile(this.path);
    if (read.kind === "missing") return;
    try {
      if (read.kind === "unreadable") throw read.error;
      const parsed = JSON.parse(read.text) as Persisted;
      if (parsed?.v !== 1 || !Array.isArray(parsed.grants) || !Number.isSafeInteger(parsed.epoch)) throw new Error("not a grant index");
      this.epochValue = parsed.epoch;
      for (const g of parsed.grants) {
        if (typeof g?.id !== "string" || !Array.isArray(g.parents)) throw new Error("malformed grant");
        this.grants.set(g.id, g);
      }
    } catch (e) {
      await keepCorruptAside(this.path, e, "Every token, key and session that depended on it is refused until it is issued again.");
      this.grants.clear();
      this.failedClosed = true;
    }
  }

  get(id: string): Grant | undefined {
    const g = this.grants.get(id);
    return g ? { ...g } : undefined;
  }

  all(): Grant[] {
    return [...this.grants.values()].map((g) => ({ ...g }));
  }

  /** Live now: not revoked, not expired and every ancestor the same. A damaged index is never live. */
  isLive(id: string, at: number = this.now()): boolean {
    if (this.failedClosed) return false;
    const seen = new Set<string>();
    const walk = (gid: string): boolean => {
      if (seen.has(gid)) return false;
      seen.add(gid);
      const g = this.grants.get(gid);
      if (!g || g.revokedAt !== null) return false;
      if (g.expiresAt !== null && g.expiresAt <= at) return false;
      return g.parents.every(walk);
    };
    return walk(id);
  }

  descendants(id: string): Grant[] {
    const out: Grant[] = [];
    const seen = new Set<string>([id]);
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const g of this.grants.values()) {
        if (!seen.has(g.id) && g.parents.includes(cur)) {
          seen.add(g.id);
          out.push({ ...g });
          queue.push(g.id);
        }
      }
    }
    return out;
  }

  forService(service: string, at: number = this.now()): Grant[] {
    return [...this.grants.values()].filter((g) => g.service === service && this.isLive(g.id, at)).map((g) => ({ ...g }));
  }

  async issue(input: NewGrant): Promise<Grant> {
    if (this.failedClosed) throw new GrantRefusedError("the grant index is unreadable", "index-unavailable");
    if (!input.id || !input.kind || !input.issuer || !input.subject || !input.audience || !input.capability) {
      throw new GrantRefusedError("a grant needs an id, kind, issuer, subject, audience and capability", "bad-grant");
    }
    if (this.grants.has(input.id)) throw new GrantRefusedError(`grant ${input.id} already exists`, "duplicate");
    const parents = input.parents ?? [];
    let expiresAt = input.expiresAt ?? null;
    for (const pid of parents) {
      const p = this.grants.get(pid);
      if (!p) throw new GrantRefusedError(`parent ${pid} is unknown`, "unknown-parent");
      if (!this.isLive(pid, input.issuedAt)) throw new GrantRefusedError(`parent ${pid} is not live`, "dead-parent");
      if (input.secretAccess && !p.secretAccess) {
        throw new GrantRefusedError("a grant cannot read secrets unless its parent can", "secret-widening");
      }
      // A child never outlives the parent it derives from.
      if (p.expiresAt !== null) expiresAt = expiresAt === null ? p.expiresAt : Math.min(expiresAt, p.expiresAt);
    }
    const grant: Grant = {
      ...input,
      parents,
      expiresAt,
      secretAccess: input.secretAccess ?? false,
      revokedAt: null,
    };
    this.grants.set(grant.id, grant);
    try {
      await this.persist();
    } catch (e) {
      this.grants.delete(grant.id);
      throw e;
    }
    return { ...grant };
  }

  /**
   * Revoke a grant and every descendant. Durable before it returns: a crash after this call cannot
   * bring any of them back. Revoking something already revoked is a no-op that still reports it.
   */
  async revoke(id: string, reason: string, at: number = this.now()): Promise<RevocationResult> {
    const target = this.grants.get(id);
    if (!target) return { epoch: this.epochValue, revoked: [] };
    const affected = [target, ...this.descendants(id).map((d) => this.grants.get(d.id)!)];
    const revoked: Grant[] = [];
    const before = new Map<string, Grant>();
    for (const g of affected) {
      if (g.revokedAt !== null) continue;
      before.set(g.id, { ...g });
      g.revokedAt = at;
      g.revokeReason = g.id === id ? reason : `parent ${id} revoked: ${reason}`;
      revoked.push({ ...g });
    }
    if (revoked.length === 0) return { epoch: this.epochValue, revoked };
    const previousEpoch = this.epochValue;
    this.epochValue += 1;
    try {
      await this.persist();
    } catch (e) {
      for (const [gid, g] of before) this.grants.set(gid, g);
      this.epochValue = previousEpoch;
      throw e;
    }
    return { epoch: this.epochValue, revoked };
  }

  /** Revoke every live grant of the given kind for a service (uninstall, "stop this service and revoke its access"). */
  async revokeService(service: string, reason: string, at: number = this.now()): Promise<RevocationResult> {
    const roots = [...this.grants.values()].filter((g) => g.service === service && g.revokedAt === null);
    const revoked: Grant[] = [];
    let epoch = this.epochValue;
    for (const g of roots) {
      const r = await this.revoke(g.id, reason, at);
      revoked.push(...r.revoked);
      epoch = r.epoch;
    }
    return { epoch, revoked };
  }

  /** Drop long-dead grants (revoked or expired more than `olderThanMs` ago). The epoch is kept. */
  async prune(olderThanMs: number, at: number = this.now()): Promise<number> {
    let dropped = 0;
    for (const [id, g] of [...this.grants]) {
      const ended = g.revokedAt ?? g.expiresAt;
      if (ended !== null && ended <= at - olderThanMs) {
        this.grants.delete(id);
        dropped += 1;
      }
    }
    if (dropped) await this.persist();
    return dropped;
  }

  private async persist(): Promise<void> {
    const body: Persisted = { v: 1, epoch: this.epochValue, grants: [...this.grants.values()] };
    await mkdir(dirname(this.path), { recursive: true });
    await withFileLock(this.path, (write) => write(JSON.stringify(body)));
  }
}
