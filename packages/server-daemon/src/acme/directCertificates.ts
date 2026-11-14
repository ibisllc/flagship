import type { CertManager } from "../certManager.js";
import type { PersistentAcmeStore } from "./persistentStore.js";
import { IssuanceDeferred, IssuanceRefused, type IssuedCertificate } from "./serviceIssuer.js";

/**
 * One certificate per direct name (docs/direct-access-and-domains.md §8), through `.com`'s issuance service (class
 * `direct`). A name the box holds (directNames.ts) gets its certificate ordered once missing or due (its last third),
 * served for exactly that name, and stored so a restart reuses it. A refusal backs off per name; a name the box no
 * longer holds is not renewed, and its certificate runs out (no record points at the box any more).
 *
 * Where this process terminates TLS the certificate goes to CertManager (and the store). With the TLS key in keyd
 * (arch-v2) keyd holds one key and one slot per direct name: the box hands keyd its verified names (keyd drops a gone
 * name's keys), the issuer's request comes from a key keyd made for that one name, and the chain is installed into
 * the name's `direct` slot, which flagship-tlsd / flagship-ingress serve for exactly that name.
 */
export interface DirectKeyd {
  setNames(names: string[]): Promise<void>;
  install(handle: string, chainPem: string): Promise<unknown>;
  activate(handle: string): Promise<void>;
  serving(): Promise<Array<{ name: string; handle: string; notAfter: number }>>;
}

/** keyd's bound on direct names (MAX_DIRECT_NAMES in packages/keyd/src/tls.ts). */
export const KEYD_MAX_DIRECT_NAMES = 16;

export interface DirectCertificatesOptions {
  issuer: { issueDirect(name: string): Promise<IssuedCertificate<"direct">>; hasPendingDirect?(name: string): boolean };
  /** Where this process terminates TLS. */
  certManager?: Pick<CertManager, "installCustom">;
  /** Where keyd holds the TLS keys (instead of certManager and the store). */
  keyd?: DirectKeyd;
  store?: PersistentAcmeStore | null;
  names: () => readonly string[];
  /** False until the box's names have been read once: keyd is never told "none" before then. */
  namesReady?: () => boolean;
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
  private keydNames: string | null = null;
  private keydLoaded = false;

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
        const names = this.o.keyd ? await this.syncKeyd() : this.o.names().map((n) => n.toLowerCase());
        if (names) for (const name of names) await this.one(name);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Tell keyd the names (when they changed) and read what it serves; null when keyd can't be told yet. */
  private async syncKeyd(): Promise<string[] | null> {
    const keyd = this.o.keyd!;
    if (this.o.namesReady && !this.o.namesReady()) return null;
    let names = [...new Set(this.o.names().map((n) => n.toLowerCase()))].sort();
    if (names.length > KEYD_MAX_DIRECT_NAMES) {
      this.log(`keyd serves at most ${KEYD_MAX_DIRECT_NAMES} direct names; not serving ${names.slice(KEYD_MAX_DIRECT_NAMES).join(", ")}`);
      names = names.slice(0, KEYD_MAX_DIRECT_NAMES);
    }
    const key = names.join("\n");
    try {
      if (key !== this.keydNames) {
        await keyd.setNames(names);
        this.keydNames = key;
        for (const n of [...this.held.keys()]) if (!names.includes(n)) this.held.delete(n);
      }
      if (!this.keydLoaded) {
        for (const s of await keyd.serving()) {
          if (names.includes(s.name) && s.notAfter > this.now()) this.held.set(s.name, { chainPem: "", privateKeyPem: "", notBefore: s.notAfter - 90 * 86_400_000, notAfter: s.notAfter });
        }
        this.keydLoaded = true;
      }
    } catch (e) {
      this.log(`keyd did not take the direct names: ${(e as Error).message}`);
      return null;
    }
    return names;
  }

  private async one(name: string): Promise<void> {
    if (!this.o.keyd && !this.loaded.has(name)) {
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
      if (this.o.keyd) {
        if (!c.handle) throw new Error("the certificate's key is not in keyd");
        await this.o.keyd.install(c.handle, c.chainPem);
        await this.o.keyd.activate(c.handle);
        this.held.set(name, { chainPem: c.chainPem, privateKeyPem: "", notBefore: c.notBefore, notAfter: c.notAfter });
      } else {
        await this.o.store?.saveCert(storeKey(name), { certPem: c.chainPem, privateKeyPem: c.privateKeyPem, names: c.names, notAfter: c.notAfter });
        this.install(name, { chainPem: c.chainPem, privateKeyPem: c.privateKeyPem, notBefore: c.notBefore, notAfter: c.notAfter });
      }
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
    this.o.certManager?.installCustom(name, { certPem: h.chainPem, privateKeyPem: h.privateKeyPem }, h.notAfter);
  }

  private log(m: string): void {
    (this.o.log ?? ((x: string) => console.log(`[certs] direct ${x}`)))(m);
  }
}
