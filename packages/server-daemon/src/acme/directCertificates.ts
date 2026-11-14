import type { CertManager } from "../certManager.js";
import type { PersistentAcmeStore } from "./persistentStore.js";
import { IssuanceDeferred, IssuanceRefused, type IssuedCertificate } from "./serviceIssuer.js";

/**
 * One certificate per direct name (docs/direct-access-and-domains.md §8), through `.com`'s issuance service (class
 * `direct`). A name the box holds (directNames.ts) gets its certificate ordered once missing or due (its last third),
 * served for exactly that name, and stored so a restart reuses it. A refusal backs off per name; a name the box no
 * longer holds is not renewed, and its certificate runs out (no record points at the box any more).
 *
 * Only where this process terminates TLS (CertManager). With the TLS key in keyd the frontend serves keyd's slots,
 * which hold the control and apps certificates only, so direct names are not served there yet.
 */
export interface DirectCertificatesOptions {
  issuer: { issueDirect(name: string): Promise<IssuedCertificate<"direct">>; hasPendingDirect?(name: string): boolean };
  certManager: Pick<CertManager, "installCustom">;
  store?: PersistentAcmeStore | null;
  names: () => readonly string[];
  now?: () => number;
  log?: (m: string) => void;
}

interface Held {
  chainPem: string;
  privateKeyPem: string;
  notBefore: number;
  notAfter: number;
}

const BACKOFF_BASE_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 6 * 3_600_000;
const RESUME_RETRY_MS = 60_000;
const storeKey = (name: string) => `direct.${name}`;

export class DirectCertificates {
  private held = new Map<string, Held>();
  private retry = new Map<string, { failures: number; at: number }>();
  private loaded = new Set<string>();
  private running: Promise<void> | null = null;

  constructor(private readonly o: DirectCertificatesOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  has(name: string): boolean {
    const h = this.held.get(name.toLowerCase());
    return !!h && h.notAfter > this.now();
  }

  dueAt(name: string): number {
    const h = this.held.get(name.toLowerCase());
    return h ? h.notAfter - Math.floor((h.notAfter - h.notBefore) / 3) : 0;
  }

  /** Order what is missing or due for the names held now. Never throws. */
  tick(): Promise<void> {
    this.running ??= (async () => {
      try {
        for (const name of this.o.names()) await this.one(name.toLowerCase());
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async one(name: string): Promise<void> {
    if (!this.loaded.has(name)) {
      this.loaded.add(name);
      const c = await this.o.store?.loadCert(storeKey(name)).catch(() => null);
      if (c && c.notAfter > this.now()) {
        const notBefore = c.issuedAt && c.issuedAt < c.notAfter ? c.issuedAt : c.notAfter - 90 * 86_400_000;
        this.install(name, { chainPem: c.certPem, privateKeyPem: c.privateKeyPem, notBefore, notAfter: c.notAfter });
      }
    }
    const now = this.now();
    const r = this.retry.get(name) ?? { failures: 0, at: 0 };
    if ((this.held.has(name) && now < this.dueAt(name)) || now < r.at) return;
    try {
      const c = await this.o.issuer.issueDirect(name);
      await this.o.store?.saveCert(storeKey(name), { certPem: c.chainPem, privateKeyPem: c.privateKeyPem, names: c.names, notAfter: c.notAfter });
      this.install(name, { chainPem: c.chainPem, privateKeyPem: c.privateKeyPem, notBefore: c.notBefore, notAfter: c.notAfter });
      this.retry.delete(name);
      this.log(`${name}: certificate installed; not after ${new Date(c.notAfter).toISOString()}`);
    } catch (e) {
      r.failures += 1;
      if (this.o.issuer.hasPendingDirect?.(name)) r.at = now + RESUME_RETRY_MS;
      else if (e instanceof IssuanceDeferred) r.at = e.retryAt;
      else r.at = now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (r.failures - 1));
      this.retry.set(name, r);
      const code = e instanceof IssuanceRefused || e instanceof IssuanceDeferred ? ` (${e.code})` : "";
      this.log(`${name}: ${(e as Error).message}${code}; next try ${new Date(r.at).toISOString()}`);
    }
  }

  private install(name: string, h: Held): void {
    this.held.set(name, h);
    this.o.certManager.installCustom(name, { certPem: h.chainPem, privateKeyPem: h.privateKeyPem }, h.notAfter);
  }

  private log(m: string): void {
    (this.o.log ?? ((x: string) => console.log(`[certs] direct ${x}`)))(m);
  }
}
