/**
 * Server-archive keys held by keyd (plan G6/R6; docs/server-backup-and-clone.md). The daemon makes
 * a backup and opens one without ever holding the archive's content key or the account keys an
 * admin device deposited for scheduled backups: it gets an opaque handle and asks keyd to seal and
 * open the data file's frames and the backup file's body under it.
 *
 *   archive.pool.add   {keys:[{archiveId,kekHex}]}            the admin device's deposit (verified by the daemon)
 *   archive.pool.list  {}                                       → {archiveIds}
 *   archive.create     {archiveId}                              takes that id's KEK out of the pool (on disk first),
 *                                                               makes a random content key → {handle, slot}
 *   archive.import     {archiveId, key}                         a content key the owner's app sent → {handle}
 *   archive.sealFrame  {handle, index, last, plain}             frames in order from 0, nothing after the last
 *   archive.openFrame  {handle, index, last, frame}             → {plain}
 *   archive.sealBody   {handle, body}                           → {nonce, sealed} (keyd picks the nonce)
 *   archive.openBody   {handle, nonce, sealed}                  → {body}
 *   archive.close      {handle}
 *
 * Bytes are those of @flagship/protocol serverBackup.ts (frame nonce = index, AAD
 * `flagship/server-backup-data/v2|<id>|<last>`; body AAD `flagship/server-backup-body/v2|<id>`;
 * account slot AAD `flagship/server-backup-slot/v2|account|<id>`). Sealing in order is enforced
 * here because the nonce is the frame index: a frame index is never sealed twice under one key.
 * Rust twin: rust/crates/flagship-keyd/src/archive.rs (same answers, codes and messages).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { KeydError, hexArg, noExtraArgs, strArg, toHex } from "./wire.js";

export const ARCHIVE_POOL_MAX = 800;
export const ARCHIVE_MAX_HANDLES = 8;
export const ARCHIVE_HANDLE_IDLE_MS = 2 * 60 * 60_000;
export const ARCHIVE_MAX_FRAME = 1024 * 1024 + 16;
export const ARCHIVE_MAX_BODY = 256 * 1024;

const ID = /^[0-9a-f]{32}$/;

interface Handle {
  archiveId: string;
  key: Buffer;
  nextSeal: number;
  sealedLast: boolean;
  usedAt: number;
}

function seal(key: Buffer, nonce: Buffer, aad: string, plain: Buffer): Buffer {
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function open(key: Buffer, nonce: Buffer, aad: string, ct: Buffer): Buffer {
  if (ct.length < 16) throw new KeydError("failed", "authentication failed");
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(ct.subarray(ct.length - 16));
  try {
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  } catch {
    throw new KeydError("failed", "authentication failed");
  }
}

function frameNonce(index: number): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(index), 4);
  return n;
}

function indexArg(a: Record<string, unknown>): number {
  const v = a.index;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new KeydError("bad-request", "index must be a non-negative integer");
  return v;
}

function lastArg(a: Record<string, unknown>): boolean {
  if (typeof a.last !== "boolean") throw new KeydError("bad-request", "last must be true or false");
  return a.last;
}

function idArg(a: Record<string, unknown>): string {
  const id = strArg(a, "archiveId", 32);
  if (!ID.test(id)) throw new KeydError("bad-request", "archiveId must be 16 bytes of lowercase hex");
  return id;
}

export class ArchiveKeys {
  readonly #poolPath: string | null;
  readonly #now: () => number;
  #pool: Array<{ archiveId: string; kek: Buffer }> = [];
  readonly #handles = new Map<string, Handle>();

  constructor(poolPath: string | null, now: () => number = Date.now) {
    this.#poolPath = poolPath;
    this.#now = now;
    if (poolPath) {
      try {
        const o = JSON.parse(readFileSync(poolPath, "utf8")) as { keys?: Array<{ archiveId?: unknown; kekHex?: unknown }> };
        for (const k of o.keys ?? []) {
          if (typeof k.archiveId === "string" && ID.test(k.archiveId) && typeof k.kekHex === "string" && /^[0-9a-f]{64}$/.test(k.kekHex)) {
            this.#pool.push({ archiveId: k.archiveId, kek: Buffer.from(k.kekHex, "hex") });
          }
        }
      } catch {
        /* no pool yet */
      }
    }
  }

  #save(): void {
    if (!this.#poolPath) return;
    const tmp = `${this.#poolPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, keys: this.#pool.map((k) => ({ archiveId: k.archiveId, kekHex: k.kek.toString("hex") })) }), { mode: 0o600 });
    renameSync(tmp, this.#poolPath);
  }

  #prune(): void {
    const t = this.#now();
    for (const [h, v] of this.#handles) {
      if (t - v.usedAt > ARCHIVE_HANDLE_IDLE_MS) {
        v.key.fill(0);
        this.#handles.delete(h);
      }
    }
  }

  #open(key: Buffer, archiveId: string): string {
    this.#prune();
    if (this.#handles.size >= ARCHIVE_MAX_HANDLES) {
      key.fill(0);
      throw new KeydError("rate-limited", "too many archive keys are open");
    }
    const h = randomBytes(16).toString("hex");
    this.#handles.set(h, { archiveId, key, nextSeal: 0, sealedLast: false, usedAt: this.#now() });
    return h;
  }

  #handle(a: Record<string, unknown>): Handle {
    this.#prune();
    const h = strArg(a, "handle", 32);
    const v = this.#handles.get(h);
    if (!v) throw new KeydError("not-provisioned", "no such archive key");
    v.usedAt = this.#now();
    return v;
  }

  destroy(): void {
    for (const v of this.#handles.values()) v.key.fill(0);
    this.#handles.clear();
    for (const k of this.#pool) k.kek.fill(0);
    this.#pool = [];
  }

  handle(op: string, a: Record<string, unknown>): Record<string, unknown> {
    switch (op) {
      case "archive.pool.add": {
        noExtraArgs(a, ["keys"]);
        const keys = a.keys;
        if (!Array.isArray(keys) || keys.length === 0 || keys.length > ARCHIVE_POOL_MAX) throw new KeydError("bad-request", "keys must be a list of archive keys");
        const fresh: Array<{ archiveId: string; kek: Buffer }> = [];
        for (const k of keys) {
          if (typeof k !== "object" || k === null || Array.isArray(k)) throw new KeydError("bad-request", "keys must be a list of archive keys");
          const o = k as Record<string, unknown>;
          noExtraArgs(o, ["archiveId", "kekHex"]);
          fresh.push({ archiveId: idArg(o), kek: Buffer.from(hexArg(o, "kekHex", { exact: 32 })) });
        }
        const have = new Set(this.#pool.map((k) => k.archiveId));
        for (const k of fresh) {
          if (have.has(k.archiveId) || this.#pool.length >= ARCHIVE_POOL_MAX) {
            k.kek.fill(0);
            continue;
          }
          have.add(k.archiveId);
          this.#pool.push(k);
        }
        this.#save();
        return { size: this.#pool.length };
      }
      case "archive.pool.list":
        noExtraArgs(a, []);
        return { archiveIds: this.#pool.map((k) => k.archiveId) };
      case "archive.create": {
        noExtraArgs(a, ["archiveId"]);
        const id = idArg(a);
        const at = this.#pool.findIndex((k) => k.archiveId === id);
        if (at < 0) throw new KeydError("not-provisioned", "no account key for that archive");
        const [entry] = this.#pool.splice(at, 1);
        // The key leaves the pool on disk before it is used, so it is never used twice.
        this.#save();
        const key = randomBytes(32);
        const nonce = randomBytes(12);
        const wrapped = seal(entry!.kek, nonce, `flagship/server-backup-slot/v2|account|${id}`, key);
        entry!.kek.fill(0);
        const handle = this.#open(key, id);
        return { handle, slot: { kind: "account", nonceHex: toHex(nonce), wrappedHex: toHex(wrapped) } };
      }
      case "archive.import": {
        noExtraArgs(a, ["archiveId", "key"]);
        const id = idArg(a);
        const key = Buffer.from(hexArg(a, "key", { exact: 32 }));
        return { handle: this.#open(key, id) };
      }
      case "archive.sealFrame": {
        noExtraArgs(a, ["handle", "index", "last", "plain"]);
        const h = this.#handle(a);
        const index = indexArg(a);
        const last = lastArg(a);
        const plain = Buffer.from(hexArg(a, "plain", { max: ARCHIVE_MAX_FRAME }));
        if (h.sealedLast || index !== h.nextSeal) throw new KeydError("forbidden", "frames are sealed once each, in order");
        const frame = seal(h.key, frameNonce(index), `flagship/server-backup-data/v2|${h.archiveId}|${last ? 1 : 0}`, plain);
        h.nextSeal = index + 1;
        if (last) h.sealedLast = true;
        return { frame: toHex(frame) };
      }
      case "archive.openFrame": {
        noExtraArgs(a, ["handle", "index", "last", "frame"]);
        const h = this.#handle(a);
        const index = indexArg(a);
        const last = lastArg(a);
        const frame = Buffer.from(hexArg(a, "frame", { min: 16, max: ARCHIVE_MAX_FRAME + 16 }));
        return { plain: toHex(open(h.key, frameNonce(index), `flagship/server-backup-data/v2|${h.archiveId}|${last ? 1 : 0}`, frame)) };
      }
      case "archive.sealBody": {
        noExtraArgs(a, ["handle", "body"]);
        const h = this.#handle(a);
        const body = Buffer.from(hexArg(a, "body", { max: ARCHIVE_MAX_BODY }));
        const nonce = randomBytes(12);
        return { nonce: toHex(nonce), sealed: toHex(seal(h.key, nonce, `flagship/server-backup-body/v2|${h.archiveId}`, body)) };
      }
      case "archive.openBody": {
        noExtraArgs(a, ["handle", "nonce", "sealed"]);
        const h = this.#handle(a);
        const nonce = Buffer.from(hexArg(a, "nonce", { exact: 12 }));
        const sealed = Buffer.from(hexArg(a, "sealed", { min: 16, max: ARCHIVE_MAX_BODY + 16 }));
        return { body: toHex(open(h.key, nonce, `flagship/server-backup-body/v2|${h.archiveId}`, sealed)) };
      }
      case "archive.close": {
        noExtraArgs(a, ["handle"]);
        const h = strArg(a, "handle", 32);
        const v = this.#handles.get(h);
        if (v) v.key.fill(0);
        return { closed: this.#handles.delete(h) };
      }
      default:
        throw new KeydError("unknown-op", "unknown operation");
    }
  }
}
