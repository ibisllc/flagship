/**
 * Who holds a server archive's keys (plan G6/R6). Where flagship-keyd runs, the content key of every
 * backup this box makes or opens, and the account keys an admin device deposited for scheduled
 * backups, live in keyd: this process gets an opaque handle and asks keyd to seal or open each frame
 * and the backup file's body. A key the owner's app sends (Back up now, a restore) is handed to keyd
 * at once and the copy here zeroed before the request returns. Without keyd (a classic box, a
 * developer run) the keys stay in this process as before.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { backupFrameAad, backupFrameNonce, type AccountSlot } from "@flagship/protocol";
import { KeydClient } from "@flagship/keyd";
import { ArchiveError } from "./format.js";
import { archiveIsolationStats } from "./isolation.js";

/** Seals and opens one archive's frames and body, under a key it may not hold itself. */
export interface ArchiveCipher {
  readonly archiveId: string;
  readonly custody: "keyd" | "daemon";
  sealFrame(index: number, last: boolean, plain: Buffer): Promise<Buffer>;
  openFrame(index: number, last: boolean, body: Buffer): Promise<Buffer>;
  sealBody(plain: Buffer): Promise<{ nonce: Buffer; sealed: Buffer }>;
  openBody(nonce: Buffer, sealed: Buffer): Promise<Buffer>;
  /** Forget the key (zeroed here, or the keyd handle closed). */
  close(): Promise<void>;
}

const BODY_TAG = "flagship/server-backup-body/v2";

/** The key in this process (classic boxes, tests). Takes the buffer; `close` zeroes it. */
export function localCipher(key: Buffer, archiveId: string): ArchiveCipher {
  if (key.length !== 32) throw new ArchiveError("the backup key must be 32 bytes");
  const gcm = (nonce: Uint8Array, aad: Uint8Array, plain: Buffer): Buffer => {
    const c = createCipheriv("aes-256-gcm", key, nonce);
    c.setAAD(aad);
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  };
  const ungcm = (nonce: Uint8Array, aad: Uint8Array, body: Buffer, what: string): Buffer => {
    if (body.length < 16) throw new ArchiveError(what);
    const d = createDecipheriv("aes-256-gcm", key, nonce);
    d.setAAD(aad);
    d.setAuthTag(body.subarray(body.length - 16));
    try {
      return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
    } catch {
      throw new ArchiveError(what);
    }
  };
  return {
    archiveId,
    custody: "daemon",
    sealFrame: async (index, last, plain) => gcm(backupFrameNonce(index), backupFrameAad(archiveId, last), plain),
    openFrame: async (index, last, body) =>
      ungcm(backupFrameNonce(index), backupFrameAad(archiveId, last), body, "the backup's data file can't be opened: wrong key, or it was changed or cut short"),
    sealBody: async (plain) => {
      const nonce = randomBytes(12);
      return { nonce, sealed: gcm(nonce, Buffer.from(`${BODY_TAG}|${archiveId}`), plain) };
    },
    openBody: async (nonce, sealed) => ungcm(nonce, Buffer.from(`${BODY_TAG}|${archiveId}`), sealed, "the backup file's sealed part does not open with the backup's key"),
    close: async () => {
      key.fill(0);
    },
  };
}

/** What the archive code needs of a keyd connection. */
export interface KeydCaller {
  call(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}


function keydCipher(c: KeydCaller, handle: string, archiveId: string): ArchiveCipher {
  const call = async (op: string, args: Record<string, unknown>, what: string) => {
    try {
      return await c.call(op, { handle, ...args });
    } catch (e) {
      archiveIsolationStats.keydRefusals++;
      const code = (e as { code?: string }).code;
      throw new ArchiveError(code === "failed" ? what : `${what} (${(e as Error).message})`);
    }
  };
  return {
    archiveId,
    custody: "keyd",
    async sealFrame(index, last, plain) {
      archiveIsolationStats.keydFrames++;
      const r = await call("archive.sealFrame", { index, last, plain: plain.toString("hex") }, "the backup couldn't be sealed");
      return Buffer.from(String(r.frame), "hex");
    },
    async openFrame(index, last, body) {
      archiveIsolationStats.keydFrames++;
      const r = await call("archive.openFrame", { index, last, frame: body.toString("hex") }, "the backup's data file can't be opened: wrong key, or it was changed or cut short");
      return Buffer.from(String(r.plain), "hex");
    },
    async sealBody(plain) {
      const r = await call("archive.sealBody", { body: plain.toString("hex") }, "the backup file couldn't be sealed");
      return { nonce: Buffer.from(String(r.nonce), "hex"), sealed: Buffer.from(String(r.sealed), "hex") };
    },
    async openBody(nonce, sealed) {
      const r = await call("archive.openBody", { nonce: nonce.toString("hex"), sealed: sealed.toString("hex") }, "the backup file's sealed part does not open with the backup's key");
      return Buffer.from(String(r.body), "hex");
    },
    async close() {
      await c.call("archive.close", { handle }).catch(() => undefined);
    },
  };
}

/** Where this box's archive keys live: keyd, or this process. */
export interface ArchiveKeyCustody {
  readonly kind: "keyd" | "daemon";
  /** A content key the owner's app sent. The buffer is zeroed before this returns. */
  importKey(archiveId: string, key: Buffer): Promise<ArchiveCipher>;
}

/** keyd's custody also holds the admin device's deposited account keys. */
export interface KeydArchiveCustody extends ArchiveKeyCustody {
  readonly kind: "keyd";
  poolAdd(keys: Array<{ archiveId: string; kekHex: string }>): Promise<number>;
  poolIds(): Promise<string[]>;
  /** Take `archiveId`'s account key out of the pool for a new backup: a handle and its account slot. */
  create(archiveId: string): Promise<{ cipher: ArchiveCipher; slot: AccountSlot }>;
}

export const daemonCustody: ArchiveKeyCustody = {
  kind: "daemon",
  importKey: async (archiveId, key) => swap(key, archiveId),
};

/** Copy the key into a buffer the cipher owns and zero the caller's. */
function swap(key: Buffer, archiveId: string): ArchiveCipher {
  const own = Buffer.from(key);
  key.fill(0);
  return localCipher(own, archiveId);
}

export function keydCustody(c: KeydCaller): KeydArchiveCustody {
  return {
    kind: "keyd",
    async importKey(archiveId, key) {
      const hexKey = key.toString("hex");
      key.fill(0);
      const r = await c.call("archive.import", { archiveId, key: hexKey });
      archiveIsolationStats.keydArchives++;
      return keydCipher(c, String(r.handle), archiveId);
    },
    async poolAdd(keys) {
      const r = await c.call("archive.pool.add", { keys });
      return Number(r.size);
    },
    async poolIds() {
      const r = await c.call("archive.pool.list", {});
      return Array.isArray(r.archiveIds) ? (r.archiveIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    },
    async create(archiveId) {
      const r = await c.call("archive.create", { archiveId });
      archiveIsolationStats.keydArchives++;
      const s = r.slot as { nonceHex?: unknown; wrappedHex?: unknown };
      return {
        cipher: keydCipher(c, String(r.handle), archiveId),
        slot: { kind: "account", nonceHex: String(s.nonceHex), wrappedHex: String(s.wrappedHex) },
      };
    },
  };
}

/** A keyd connection that (re)connects on use, for the archive operations. */
export function keydCallerFor(socketPath: string, component = "daemon-archive"): KeydCaller {
  let client: KeydClient | null = null;
  let connecting: Promise<KeydClient> | null = null;
  const get = async (): Promise<KeydClient> => {
    if (client) return client;
    connecting ??= (async () => {
      const c = new KeydClient({ socketPath, component, timeoutMs: 60_000 });
      await c.connect();
      client = c;
      return c;
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  };
  return {
    async call(op, args) {
      const c = await get();
      try {
        return await c.call(op as never, args);
      } catch (e) {
        if (/connection closed|not connected/.test((e as Error).message)) {
          c.close();
          client = null;
        }
        throw e;
      }
    },
  };
}
