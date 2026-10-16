/**
 * A server created to restore a backup waits for it (docs/server-backup-and-
 * clone.md, "Restore a backup"). The owner's app signs a
 * `flagship/server-restore/v1` order naming this server and one data file (id,
 * size, SHA-256) when it creates the server; the order rides beside the
 * create-time pairing order, so the box learns it the moment it is paired.
 *
 * Only a verified order naming this box puts the box in the waiting state.
 * Restoring a backup adds a server, which is admin-only (owner rule
 * 2026-10-16): on a box with an admin root pinned the order must be signed by
 * that root (the IRK, which every device holds, is refused), as for the
 * box's other sensitive orders; a box with none takes the owner IRK. The box
 * then accepts that data file and no other. The state is kept on disk until the backup is in: a failed or
 * abandoned upload leaves the box waiting (Home says so; the owner can send
 * the backup again or delete the server). Once the apps are restored it is
 * cleared for good (a done marker keeps a replayed order from re-arming it).
 */
import { readFile } from "node:fs/promises";
import { hexToBytes } from "@noble/hashes/utils";
import { openRestoreFromPairingJson, parseServerRestoreOrder, verifyServerRestoreOrder, type ServerRestoreOrder } from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../adminAuthorityLocal.js";
import { removeDurable, writeFileDurable } from "../durableFile.js";
import type { AwaitingBackup } from "../daemonStatusHeartbeat.js";

export interface RestoreWaitState {
  order: ServerRestoreOrder;
  signatureHex: string;
  adoptedAt: number;
}

export interface RestoreWait {
  load(): Promise<void>;
  /** The order this box waits for, or null. */
  current(): RestoreWaitState | null;
  /** Adopt the restore order riding in a verified pairing order's JSON. True when it took. */
  adoptFromPairingJson(json: string): Promise<boolean>;
  /** The import is running (Home says "Restoring its backup"). */
  setRestoring(on: boolean): void;
  /** The backup is in: stop waiting, for good. */
  finish(archiveId: string): Promise<void>;
  /** For the heartbeat. */
  heartbeatView(): AwaitingBackup | null;
}

export function buildRestoreWait(opts: {
  /** `<dataDir>/restore-wait.json` */
  path: string;
  /** `<dataDir>/restore-done.json` */
  donePath: string;
  serverDomain: string;
  ownerIrkPub: Uint8Array;
  /** The pinned admin root; when set, only it authorizes a restore. */
  adminRootPub?: Uint8Array;
  /** The owning account (for the sensitive-order gate). */
  username: string;
  onChange?: () => void;
  note?: (kind: string, detail: string) => void;
  now?: () => number;
  log?: (m: string) => void;
}): RestoreWait {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  let state: RestoreWaitState | null = null;
  let restoring = false;
  const done = new Set<string>();
  const authorized = (order: ServerRestoreOrder, sig: Uint8Array): boolean =>
    authorizeSensitiveOrder<ServerRestoreOrder>({
      order,
      signature: sig,
      verify: verifyServerRestoreOrder,
      ownerIrkPub: opts.ownerIrkPub,
      ...(opts.adminRootPub ? { adminRootPub: opts.adminRootPub } : {}),
      username: opts.username,
      now: now(),
    });

  const changed = () => {
    try {
      opts.onChange?.();
    } catch {
      /* a heartbeat nudge never fails the caller */
    }
  };

  async function readJson(path: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      return null;
    }
  }

  return {
    async load() {
      const d = (await readJson(opts.donePath)) as { archiveIds?: unknown } | null;
      if (Array.isArray(d?.archiveIds)) for (const id of d.archiveIds) if (typeof id === "string") done.add(id);
      const raw = (await readJson(opts.path)) as Partial<RestoreWaitState> | null;
      if (!raw) return;
      const order = parseServerRestoreOrder(raw.order);
      const sig = typeof raw.signatureHex === "string" && /^[0-9a-f]{128}$/.test(raw.signatureHex) ? raw.signatureHex : null;
      if (
        order &&
        sig &&
        order.serverDomain.toLowerCase() === opts.serverDomain.toLowerCase() &&
        !done.has(order.archiveId) &&
        authorized(order, hexToBytes(sig))
      ) {
        state = { order, signatureHex: sig, adoptedAt: typeof raw.adoptedAt === "number" ? raw.adoptedAt : now() };
      } else {
        log("[restore-wait] dropped a waiting state that no longer verifies");
        await removeDurable(opts.path).catch(() => {});
      }
    },
    current: () => state,
    async adoptFromPairingJson(json) {
      const r = openRestoreFromPairingJson(json, authorized, opts.serverDomain);
      if (!r) return false;
      if (done.has(r.order.archiveId)) return false;
      if (state && state.order.archiveId === r.order.archiveId) return true;
      if (state) {
        log("[restore-wait] already waiting for another backup; ignored");
        return false;
      }
      const next: RestoreWaitState = { order: r.order, signatureHex: r.signatureHex, adoptedAt: now() };
      await writeFileDurable(opts.path, JSON.stringify(next));
      state = next;
      log(`[restore-wait] waiting for backup ${r.order.archiveId} (${r.order.bytes} bytes)`);
      opts.note?.("server.restore.waiting", "This server was created to restore a backup and is waiting for it.");
      changed();
      return true;
    },
    setRestoring(on) {
      if (restoring === on) return;
      restoring = on;
      changed();
    },
    async finish(archiveId) {
      done.add(archiveId);
      await writeFileDurable(opts.donePath, JSON.stringify({ archiveIds: [...done] }));
      if (state?.order.archiveId === archiveId) {
        await removeDurable(opts.path);
        state = null;
      }
      restoring = false;
      changed();
    },
    heartbeatView() {
      return state ? { archiveId: state.order.archiveId, state: restoring ? "restoring" : "waiting" } : null;
    },
  };
}
