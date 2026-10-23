import { X509Certificate, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha256";
import { bitString, int0, octets, oid, seq, set, tlv, utf8 } from "./der.js";
import { KeydError } from "./wire.js";

/**
 * TLS leaf keys held by keyd (SECURITY-HARDENING-PLAN.md 6.1, 6.3). The key is generated
 * here, never leaves, and is used for exactly two things: signing the certificate request
 * for the names it was created for, and signing TLS handshake digests once a certificate
 * for it has been installed. The ACME code and the TLS frontend see a handle and a public
 * key, nothing else.
 */

const MAX_NAMES = 8;
const MAX_KEYS = 8;
const HANDLE = /^[0-9a-f]{32}$/;
const NAME = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

interface StoredKey {
  names: string[];
  privHex: string;
  spkiHex: string;
  createdAt: number;
  chainPem?: string;
  notBefore?: number;
  notAfter?: number;
}

export interface TlsKeyInfo {
  handle: string;
  names: string[];
  spkiHex: string;
  createdAt: number;
  notAfter: number | null;
  active: boolean;
}

export class TlsKeys {
  private readonly keys = new Map<string, StoredKey>();
  private activeHandle: string | null = null;

  constructor(
    private readonly allowedNames: ReadonlySet<string>,
    private readonly dir: string | null = null,
    private readonly now: () => number = Date.now,
  ) {
    if (dir) this.load(dir);
  }

  private load(dir: string): void {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const m = /^([0-9a-f]{32})\.json$/.exec(f);
      if (!m) continue;
      try {
        this.keys.set(m[1]!, JSON.parse(readFileSync(join(dir, f), "utf8")) as StoredKey);
      } catch {
        /* a damaged key file is ignored; the box issues a new key */
      }
    }
    const active = join(dir, "active");
    if (existsSync(active)) {
      const h = readFileSync(active, "utf8").trim();
      if (this.keys.has(h)) this.activeHandle = h;
    }
  }

  private persist(handle: string): void {
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `${handle}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(this.keys.get(handle)), { mode: 0o400 });
    renameSync(`${file}.tmp`, file);
  }

  private get(handle: string): StoredKey {
    if (!HANDLE.test(handle)) throw new KeydError("bad-request", "bad key handle");
    const k = this.keys.get(handle);
    if (!k) throw new KeydError("bad-request", "no such key");
    return k;
  }

  /** The names this box may ever have a certificate for. */
  names(): string[] {
    return [...this.allowedNames];
  }

  createKey(names: string[]): { handle: string; spkiHex: string } {
    if (names.length === 0 || names.length > MAX_NAMES) throw new KeydError("bad-request", "between 1 and 8 names");
    const unique = [...new Set(names.map((n) => n.toLowerCase()))].sort();
    for (const n of unique) {
      if (!NAME.test(n)) throw new KeydError("bad-request", "not a valid DNS name");
      if (!this.allowedNames.has(n)) throw new KeydError("forbidden", "that name is not one this box may have a certificate for");
    }
    // Old keys that never got a certificate, or were replaced, make room for new ones.
    if (this.keys.size >= MAX_KEYS) {
      for (const [h, k] of this.keys) {
        if (h !== this.activeHandle && (!k.notAfter || k.notAfter < this.now())) this.remove(h);
        if (this.keys.size < MAX_KEYS) break;
      }
      if (this.keys.size >= MAX_KEYS) throw new KeydError("forbidden", "too many TLS keys; remove one first");
    }
    const priv = p256.utils.randomSecretKey();
    const pub = p256.getPublicKey(priv, false);
    const spkiDer = seq(seq(oid("1.2.840.10045.2.1"), oid("1.2.840.10045.3.1.7")), bitString(pub));
    const handle = randomBytes(16).toString("hex");
    this.keys.set(handle, { names: unique, privHex: Buffer.from(priv).toString("hex"), spkiHex: Buffer.from(spkiDer).toString("hex"), createdAt: this.now() });
    this.persist(handle);
    return { handle, spkiHex: Buffer.from(spkiDer).toString("hex") };
  }

  /** PKCS#10 for exactly the names the key was created for. */
  csr(handle: string): Uint8Array {
    const k = this.get(handle);
    const san = seq(...k.names.map((n) => tlv(0x82, new TextEncoder().encode(n))));
    const ext = seq(seq(oid("2.5.29.17"), octets(san)));
    const attrs = tlv(0xa0, seq(oid("1.2.840.113549.1.9.14"), set(ext)));
    const subject = seq(set(seq(oid("2.5.4.3"), utf8(k.names[0]!))));
    const info = seq(int0(), subject, Uint8Array.from(Buffer.from(k.spkiHex, "hex")), attrs);
    const sig = p256.sign(sha256(info), Uint8Array.from(Buffer.from(k.privHex, "hex")), { prehash: false, format: "der" });
    return seq(info, seq(oid("1.2.840.10045.4.3.2")), bitString(sig));
  }

  /** Accept the certificate chain for a key: the leaf must be this key's, for these names, and in date. */
  install(handle: string, chainPem: string): { notBefore: number; notAfter: number; names: string[] } {
    const k = this.get(handle);
    const certs = chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!certs || certs.length === 0 || certs.length > 6) throw new KeydError("bad-request", "expected a certificate chain");
    let leaf: X509Certificate;
    try {
      leaf = new X509Certificate(certs[0]!);
    } catch {
      throw new KeydError("bad-request", "the leaf is not a certificate");
    }
    const spki = Buffer.from(leaf.publicKey.export({ type: "spki", format: "der" })).toString("hex");
    if (spki !== k.spkiHex) throw new KeydError("forbidden", "the certificate is not for this key");
    const sans = (leaf.subjectAltName ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (sans.some((s) => !s.startsWith("DNS:"))) throw new KeydError("forbidden", "only DNS names are allowed");
    const got = sans.map((s) => s.slice(4).toLowerCase()).sort();
    if (got.length === 0 || got.some((n) => !k.names.includes(n))) throw new KeydError("forbidden", "the certificate names more than this key was made for");
    const notBefore = Date.parse(leaf.validFrom);
    const notAfter = Date.parse(leaf.validTo);
    if (!(notAfter > this.now()) || notBefore > this.now() + 24 * 3600_000) throw new KeydError("forbidden", "the certificate is not valid now");
    k.chainPem = certs.join("\n") + "\n";
    k.notBefore = notBefore;
    k.notAfter = notAfter;
    this.persist(handle);
    return { notBefore, notAfter, names: got };
  }

  activate(handle: string): void {
    const k = this.get(handle);
    if (!k.chainPem) throw new KeydError("forbidden", "install a certificate before serving with this key");
    this.activeHandle = handle;
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.dir, "active.tmp"), handle, { mode: 0o400 });
      renameSync(join(this.dir, "active.tmp"), join(this.dir, "active"));
    }
  }

  active(): { handle: string; chainPem: string; notAfter: number; names: string[] } | null {
    if (!this.activeHandle) return null;
    const k = this.keys.get(this.activeHandle);
    if (!k?.chainPem) return null;
    return { handle: this.activeHandle, chainPem: k.chainPem, notAfter: k.notAfter ?? 0, names: k.names };
  }

  /** A TLS handshake signature over `digest`. Only for a key with a valid, installed certificate. */
  sign(handle: string, digest: Uint8Array): Uint8Array {
    const k = this.get(handle);
    if (!k.chainPem || !k.notAfter) throw new KeydError("forbidden", "this key has no certificate");
    if (k.notAfter < this.now() - 7 * 24 * 3600_000) throw new KeydError("forbidden", "this key's certificate has expired");
    if (digest.length !== 32 && digest.length !== 48) throw new KeydError("bad-request", "digest must be 32 or 48 bytes");
    return p256.sign(digest, Uint8Array.from(Buffer.from(k.privHex, "hex")), { prehash: false, format: "der" });
  }

  list(): TlsKeyInfo[] {
    return [...this.keys.entries()].map(([handle, k]) => ({
      handle,
      names: k.names,
      spkiHex: k.spkiHex,
      createdAt: k.createdAt,
      notAfter: k.notAfter ?? null,
      active: handle === this.activeHandle,
    }));
  }

  remove(handle: string): void {
    this.get(handle);
    if (handle === this.activeHandle) throw new KeydError("forbidden", "the key in service cannot be removed");
    this.keys.delete(handle);
    if (this.dir) rmSync(join(this.dir, `${handle}.json`), { force: true });
  }

  /** Zero the key material held in memory. */
  destroy(): void {
    for (const k of this.keys.values()) k.privHex = "0".repeat(64);
    this.keys.clear();
  }
}

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
