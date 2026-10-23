/**
 * Space and budgets held back for the management lane (SECURITY-HARDENING-PLAN.md 18.13, N13).
 *
 * `ManagementReserve` is a small file of real disk blocks kept in the state directory. When a
 * security write (a revocation, a lock, a recovery record) finds the disk full, the reserve is
 * deleted and the write retried, so an app that fills its volume cannot stop the owner from
 * revoking it. The reserve is rebuilt once space returns.
 *
 * `ResourceBudgets` meters expensive work per service AND per host, before the work is done:
 * unauthenticated handshakes, decompression, tabs, builds, pending alerts. A per-IP limit alone
 * fails shared networks and distributed floods; a per-service share alone lets one noisy app starve
 * the host. Pausing one spammed service must leave the others running.
 */
import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export class ManagementReserve {
  readonly file: string;

  constructor(
    dir: string,
    private readonly bytes: number,
    private readonly freeBytes: (dir: string) => Promise<number>,
    private readonly dirPath = dir,
  ) {
    this.file = join(dir, ".management-reserve");
  }

  /** Make sure the reserve exists, if the disk can spare it (keeping twice its size free). */
  async ensure(): Promise<boolean> {
    if (await this.present()) return true;
    if ((await this.freeBytes(this.dirPath)) < this.bytes * 2) return false;
    const fh = await open(this.file, "w", 0o600);
    try {
      // Real blocks, not a sparse hole: a sparse file reserves nothing.
      const chunk = Buffer.alloc(1024 * 1024);
      for (let written = 0; written < this.bytes; written += chunk.length) await fh.write(chunk, 0, Math.min(chunk.length, this.bytes - written));
      await fh.sync();
    } finally {
      await fh.close();
    }
    return true;
  }

  async present(): Promise<boolean> {
    try {
      return (await stat(this.file)).size >= this.bytes;
    } catch {
      return false;
    }
  }

  /** Give the space back so a security write can land. True if there was a reserve to give. */
  async release(): Promise<boolean> {
    if (!(await this.present())) return false;
    await rm(this.file, { force: true });
    return true;
  }
}

export interface BudgetSpec {
  /** Units a single service may use per window. */
  perService: number;
  /** Units the whole host may use per window, across services. */
  perHost: number;
  windowMs: number;
}

export type BudgetResult = { ok: true } | { ok: false; scope: "service" | "host"; retryAfterMs: number };

export class ResourceBudgets {
  private service = new Map<string, { start: number; used: number }>();
  private host = new Map<string, { start: number; used: number }>();

  constructor(
    private readonly specs: Record<string, BudgetSpec>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Charge `units` of `resource` to a service. Refuses BEFORE the work, naming whose limit was hit. */
  charge(resource: string, serviceId: string, units = 1): BudgetResult {
    const spec = this.specs[resource];
    if (!spec) return { ok: true };
    const t = this.now();
    const svc = this.slot(this.service, `${resource}|${serviceId}`, spec.windowMs, t);
    const host = this.slot(this.host, resource, spec.windowMs, t);
    if (svc.used + units > spec.perService) return { ok: false, scope: "service", retryAfterMs: svc.start + spec.windowMs - t };
    // One service cannot take the host's whole share: the host limit refuses the newcomer, not the incumbent.
    if (host.used + units > spec.perHost) return { ok: false, scope: "host", retryAfterMs: host.start + spec.windowMs - t };
    svc.used += units;
    host.used += units;
    return { ok: true };
  }

  usage(resource: string, serviceId: string): { service: number; host: number } {
    return { service: this.service.get(`${resource}|${serviceId}`)?.used ?? 0, host: this.host.get(resource)?.used ?? 0 };
  }

  private slot(m: Map<string, { start: number; used: number }>, key: string, windowMs: number, t: number) {
    const s = m.get(key);
    if (!s || t - s.start >= windowMs) {
      const fresh = { start: t, used: 0 };
      m.set(key, fresh);
      return fresh;
    }
    return s;
  }
}
