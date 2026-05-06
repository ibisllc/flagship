import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";

/**
 * Plain-PEM persistent store for ACME state. Production daemons run on
 * a LUKS-encrypted root, so disk-at-rest encryption is provided by the
 * filesystem; we don't double-wrap with SWK here. (When SWK provisioning
 * via phone is wired up, `EncryptedCertStore` is the right place to
 * upgrade to.)
 *
 * Files written:
 *   <dataDir>/acme/account.pem
 *   <dataDir>/acme/cert/<sanitized-fqdn>.pem
 *   <dataDir>/acme/cert/<sanitized-fqdn>.key
 *   <dataDir>/acme/cert/<sanitized-fqdn>.meta.json   { names, notAfter, issuedAt }
 *
 * All writes go through a write-then-rename so a crash mid-write can't
 * leave half-written PEM on disk.
 */

export interface PersistedCert {
  certPem: string;
  privateKeyPem: string;
  names: string[];
  notAfter: number;
  issuedAt: number;
}

export class PersistentAcmeStore {
  constructor(private readonly dataDir: string) {}

  private acmeDir(): string {
    return join(this.dataDir, "acme");
  }
  private accountKeyPath(): string {
    return join(this.acmeDir(), "account.pem");
  }
  private certDir(): string {
    return join(this.acmeDir(), "cert");
  }
  private certBase(fqdn: string): string {
    // sanitize: strip wildcard, replace anything outside [a-z0-9.-] with '_'.
    const safe = fqdn.replace(/^\*\./, "").replace(/[^a-z0-9.-]/g, "_");
    return join(this.certDir(), safe);
  }

  async loadAccountKey(): Promise<string | null> {
    try {
      return await readFile(this.accountKeyPath(), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async saveAccountKey(pem: string): Promise<void> {
    await ensureDir(this.acmeDir());
    await atomicWrite(this.accountKeyPath(), pem);
  }

  async loadCert(serverFqdn: string): Promise<PersistedCert | null> {
    const base = this.certBase(serverFqdn);
    try {
      const [certPem, privateKeyPem, metaRaw] = await Promise.all([
        readFile(`${base}.pem`, "utf8"),
        readFile(`${base}.key`, "utf8"),
        readFile(`${base}.meta.json`, "utf8"),
      ]);
      const meta = JSON.parse(metaRaw) as { names?: unknown; notAfter?: unknown; issuedAt?: unknown };
      if (
        !Array.isArray(meta.names) ||
        typeof meta.notAfter !== "number" ||
        typeof meta.issuedAt !== "number"
      ) {
        return null;
      }
      return {
        certPem,
        privateKeyPem,
        names: meta.names.filter((n): n is string => typeof n === "string"),
        notAfter: meta.notAfter,
        issuedAt: meta.issuedAt,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async saveCert(
    serverFqdn: string,
    cert: { certPem: string; privateKeyPem: string; names: string[]; notAfter: number },
  ): Promise<void> {
    await ensureDir(this.certDir());
    const base = this.certBase(serverFqdn);
    const meta = {
      names: cert.names,
      notAfter: cert.notAfter,
      issuedAt: Date.now(),
    };
    // Order: cert, key, meta. Meta is what we use to decide "we have a
    // good cert" on startup; writing it last guarantees the cert and key
    // exist by the time meta does.
    await atomicWrite(`${base}.pem`, cert.certPem);
    await atomicWrite(`${base}.key`, cert.privateKeyPem);
    await atomicWrite(`${base}.meta.json`, JSON.stringify(meta, null, 2) + "\n");
  }
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
}

/** True if the cert has at least `windowMs` remaining before expiry. */
export function isCertFresh(cert: PersistedCert, windowMs = 30 * 24 * 60 * 60 * 1000, now = Date.now()): boolean {
  return cert.notAfter - now > windowMs;
}

/** Set-equality on the cert's SANs. Order-insensitive. */
export function sansEqual(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Decision for whether the runtime should reuse an existing cert from
 * disk or kick off a new ACME issuance. Pure function, easy to test —
 * extracted from `startDaemonRuntime` so the renewal logic is exercised
 * without spinning up TLS server + tunnel + ACME.
 */
export function shouldReuseCert(
  existing: PersistedCert | null,
  desiredSans: ReadonlyArray<string>,
  windowMs = 30 * 24 * 60 * 60 * 1000,
  now = Date.now(),
): boolean {
  if (!existing) return false;
  if (!sansEqual(existing.names, desiredSans)) return false;
  if (!isCertFresh(existing, windowMs, now)) return false;
  return true;
}
