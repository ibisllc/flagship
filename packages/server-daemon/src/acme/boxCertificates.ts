import type { CertManager, CertMaterial } from "../certManager.js";
import type { PersistentAcmeStore } from "./persistentStore.js";
import { IssuanceDeferred, IssuanceRefused, type BoxCertClass, type IssuedCertificate, type ServiceIssuer } from "./serviceIssuer.js";

/**
 * The box's two certificates through `.com`'s issuance service (plan H9, H7): a control certificate for exactly its
 * own name and an app certificate for its app wildcards. Each is renewed only once due (its last third, plus up to
 * three days of jitter so a fleet never asks at once); `.com` refuses earlier orders anyway. A refusal backs off
 * (`.com`'s own `retryAt` when it gave one, else 15 minutes doubling to 6 hours) and the box keeps serving what it
 * has. Nothing is ordered per restart: a valid stored certificate is reused.
 */
export interface KeydCertSlots {
  install(handle: string, chainPem: string): Promise<{ notAfter: number; names: string[] }>;
  /** Without a slot: the one default certificate, served for every name by an older frontend (clears the slots). */
  activate(handle: string, slot?: BoxCertClass): Promise<void>;
  /** The certificates in service by slot; null (or absent) when keyd serves only one. */
  serving?(): Promise<Array<{ slot: string; handle: string }> | null>;
  list(): Promise<Array<{ handle: string; names: string[]; notAfter: number | null; active: boolean; legacy: boolean }>>;
  active(): Promise<{ handle: string; chainPem: string; notAfter: number; names: string[] } | null>;
}

interface Held {
  names: string[];
  chainPem: string;
  privateKeyPem: string;
  handle: string | null;
  notBefore: number;
  notAfter: number;
}

export interface BoxCertificatesOptions {
  issuer: Pick<ServiceIssuer, "issue" | "names">;
  serverFqdn: string;
  certManager: CertManager;
  /** Classic: the PEM store (key + chain in this process). */
  store?: PersistentAcmeStore | null;
  /** Arch-v2: the keys live in flagship-keyd; the frontend serves each name the certificate of its class. */
  keyd?: KeydCertSlots;
  onInstalled?(cls: BoxCertClass, cert: CertMaterial, notAfter: number, names: string[]): void;
  onAttemptFailed?(cls: BoxCertClass, attempt: number, error: string): void;
  now?: () => number;
  random?: () => number;
}

export const RENEWAL_JITTER_MS = 3 * 86_400_000;
const BACKOFF_BASE_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 6 * 3_600_000;
const NO_SERVING_RETRY_MS = 3_600_000;
const CLASSES: readonly BoxCertClass[] = ["control", "apps"];
const storeKey = (cls: BoxCertClass, fqdn: string) => `${cls}.${fqdn}`;

export class BoxCertificates {
  private held: Record<BoxCertClass, Held | null> = { control: null, apps: null };
  private retry: Record<BoxCertClass, { failures: number; at: number }> = { control: { failures: 0, at: 0 }, apps: { failures: 0, at: 0 } };
  private jitter: number;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private classes: readonly BoxCertClass[] = CLASSES;

  constructor(private readonly o: BoxCertificatesOptions) {
    this.jitter = Math.floor((o.random ?? Math.random)() * RENEWAL_JITTER_MS);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** The renewal time of a class's certificate, or 0 when there is none to keep. */
  dueAt(cls: BoxCertClass): number {
    const h = this.held[cls];
    if (!h || !sameNames(h.names, this.o.issuer.names(cls))) return 0;
    return h.notAfter - Math.floor((h.notAfter - h.notBefore) / 3) + this.jitter;
  }

  has(cls: BoxCertClass): boolean {
    const h = this.held[cls];
    return !!h && h.notAfter > this.now();
  }

  status(): Record<BoxCertClass, { notAfter: number; dueAt: number; retryAt: number } | null> {
    const one = (cls: BoxCertClass) => {
      const h = this.held[cls];
      return h ? { notAfter: h.notAfter, dueAt: this.dueAt(cls), retryAt: this.retry[cls].at } : null;
    };
    return { control: one("control"), apps: one("apps") };
  }

  /** Reuse what is stored and still valid. */
  async load(): Promise<void> {
    const now = this.now();
    if (this.o.keyd) {
      const keys = await this.o.keyd.list().catch(() => []);
      for (const cls of CLASSES) {
        const want = this.o.issuer.names(cls);
        const best = keys
          .filter((k) => !k.legacy && k.notAfter && k.notAfter > now && sameNames(k.names, want))
          .sort((a, b) => (b.notAfter ?? 0) - (a.notAfter ?? 0))[0];
        // keyd does not keep notBefore; Let's Encrypt's lifetime is 90 days.
        if (best) this.held[cls] = { names: want, chainPem: "", privateKeyPem: "", handle: best.handle, notBefore: best.notAfter! - 90 * 86_400_000, notAfter: best.notAfter! };
      }
      await this.activateKeyd();
      return;
    }
    if (!this.o.store) return;
    for (const cls of CLASSES) {
      const c = await this.o.store.loadCert(storeKey(cls, this.o.serverFqdn)).catch(() => null);
      if (!c || c.notAfter <= now) continue;
      const notBefore = c.issuedAt && c.issuedAt < c.notAfter ? c.issuedAt : c.notAfter - 90 * 86_400_000;
      this.held[cls] = { names: c.names, chainPem: c.certPem, privateKeyPem: c.privateKeyPem, handle: null, notBefore, notAfter: c.notAfter };
      this.installLocal(cls);
    }
  }

  /** Order whatever is missing or due and allowed to retry now. Never throws. */
  tick(): Promise<void> {
    this.running ??= (async () => {
      try {
        for (const cls of this.classes) await this.maybeRenew(cls);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  start(intervalMs = 10 * 60_000): void {
    void this.tick();
    if (intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  /** No app certificate (a box started without app names, e.g. tests and early bootstrap). */
  onlyControl(): void {
    this.classes = ["control"];
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async maybeRenew(cls: BoxCertClass): Promise<void> {
    const now = this.now();
    if (now < this.dueAt(cls) || now < this.retry[cls].at) return;
    const r = this.retry[cls];
    try {
      const c = await this.o.issuer.issue(cls);
      await this.take(c);
      this.retry[cls] = { failures: 0, at: 0 };
    } catch (e) {
      r.failures += 1;
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof IssuanceDeferred) r.at = e.retryAt + Math.floor((this.o.random ?? Math.random)() * 15 * 60_000);
      else if (e instanceof IssuanceRefused && e.code === "issuance-no-serving") r.at = this.now() + NO_SERVING_RETRY_MS;
      else r.at = this.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (r.failures - 1)) + Math.floor((this.o.random ?? Math.random)() * 60_000);
      console.warn(`[certs] ${cls} certificate for ${this.o.serverFqdn}: ${msg}; next try ${new Date(r.at).toISOString()}`);
      try {
        this.o.onAttemptFailed?.(cls, r.failures, msg);
      } catch {
        /* observability never breaks issuance */
      }
    }
  }

  private async take(c: IssuedCertificate): Promise<void> {
    const held: Held = { names: c.names, chainPem: c.chainPem, privateKeyPem: c.privateKeyPem, handle: c.handle, notBefore: c.notBefore, notAfter: c.notAfter };
    if (this.o.keyd && c.handle) {
      await this.o.keyd.install(c.handle, c.chainPem);
      this.held[c.cls] = held;
      await this.activateKeyd();
    } else {
      if (this.o.store) {
        await this.o.store.saveCert(storeKey(c.cls, this.o.serverFqdn), { certPem: c.chainPem, privateKeyPem: c.privateKeyPem, names: c.names, notAfter: c.notAfter });
      }
      this.held[c.cls] = held;
      this.installLocal(c.cls);
    }
    console.log(`[certs] ${c.cls} certificate for ${this.o.serverFqdn} installed; not after ${new Date(c.notAfter).toISOString()}`);
  }

  private installLocal(cls: BoxCertClass): void {
    const h = this.held[cls]!;
    const cert = { certPem: h.chainPem, privateKeyPem: h.privateKeyPem };
    if (cls === "control") this.o.certManager.installControl(this.o.serverFqdn, cert, h.notAfter);
    else this.o.certManager.install(cert, h.notAfter);
    try {
      this.o.onInstalled?.(cls, cert, h.notAfter, h.names);
    } catch {
      /* observability */
    }
  }

  /**
   * keyd's default certificate is what an older frontend serves for every name: the app certificate when it also
   * covers the control name (`*.<user>`) and is valid, otherwise the control certificate, so the box's own name always
   * answers (recovery). With both valid, each also goes in its slot, and the frontend (flagship-tlsd, flagship-ingress)
   * serves the box's own name the control certificate and every app name the apps one (gym 20: without the account
   * wildcard, app names got the control certificate). A keyd without slots keeps the one default.
   */
  private async activateKeyd(): Promise<void> {
    const keyd = this.o.keyd!;
    const now = this.now();
    const apps = this.held.apps;
    const control = this.held.control;
    const zoneWildcard = `*.${this.o.serverFqdn.toLowerCase().split(".").slice(1).join(".")}`;
    const pick = apps?.handle && apps.notAfter > now && apps.names.includes(zoneWildcard) ? apps : control?.handle && control.notAfter > now ? control : null;
    if (!pick?.handle) return;
    let active = await keyd.active().catch(() => null);
    if (active?.handle !== pick.handle) {
      await keyd.activate(pick.handle);
      active = await keyd.active().catch(() => null);
    }
    const validControl = control?.handle && control.notAfter > now ? control.handle : null;
    const validApps = apps?.handle && apps.notAfter > now ? apps.handle : null;
    if (validControl && validApps && keyd.serving) {
      try {
        const serving = await keyd.serving();
        if (serving) {
          for (const [slot, handle] of [["control", validControl], ["apps", validApps]] as const) {
            if (!serving.some((s) => s.slot === slot && s.handle === handle)) await keyd.activate(handle, slot);
          }
        }
      } catch (e) {
        console.warn(`[certs] could not serve the control and apps certificates side by side: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!active) return;
    try {
      this.o.onInstalled?.(pick === apps ? "apps" : "control", { certPem: active.chainPem, privateKeyPem: "" }, active.notAfter, active.names);
    } catch {
      /* observability */
    }
  }
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return [...a].map((n) => n.toLowerCase()).sort().join("\n") === [...b].map((n) => n.toLowerCase()).sort().join("\n");
}
