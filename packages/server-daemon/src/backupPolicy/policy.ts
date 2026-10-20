/**
 * The server's backup policy (docs/server-backup-and-clone.md, "Backup
 * policy"): phone, peer or none, chosen when the server is created (it rides
 * the pairing order, like a restore order) and changed from the server page.
 * Only an order signed under the box's sensitive-order authority is taken,
 * and only one newer than the policy it holds, so an old order can't be
 * replayed over a newer choice. `<dataDir>/backup-policy.json`.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseBackupPolicy, type BackupPolicyKind, type BackupPolicyOrder } from "@flagship/protocol";

export type BackupPolicyState = "unset" | BackupPolicyKind;

export interface CurrentPolicy {
  policy: BackupPolicyState;
  /** 0 unless the policy is "phone". */
  phoneReserveBytes: number;
  /** When the owner signed it; null while unset. */
  issuedAt: number | null;
}

export interface BackupPolicyStoreOptions {
  path: string;
  serverDomain: string;
  /** Check the order's signature under this box's sensitive-order authority. */
  authorize: (o: BackupPolicyOrder, sig: Uint8Array) => boolean;
  /** False while backups on other servers are switched off: a new Peer policy is refused on every path (create time included). */
  peerAllowed?: () => boolean;
  log?: (m: string) => void;
}

export class BackupPolicyStore {
  private held: { order: BackupPolicyOrder; signatureHex: string } | null = null;
  private readonly listeners = new Set<(p: CurrentPolicy) => void>();

  constructor(private readonly opts: BackupPolicyStoreOptions) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.opts.path, "utf8")) as { order?: unknown; signatureHex?: unknown };
      const order = parseBackupPolicy(raw.order);
      if (order && typeof raw.signatureHex === "string" && this.verify(order, raw.signatureHex)) {
        this.held = { order, signatureHex: raw.signatureHex };
      }
    } catch {
      /* none yet */
    }
  }

  current(): CurrentPolicy {
    if (!this.held) return { policy: "unset", phoneReserveBytes: 0, issuedAt: null };
    const o = this.held.order;
    return { policy: o.policy, phoneReserveBytes: o.phoneReserveBytes, issuedAt: o.issuedAt };
  }

  /** Called with the new policy after every change. Returns an unsubscribe. */
  onChange(cb: (p: CurrentPolicy) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private verify(order: BackupPolicyOrder, signatureHex: string): boolean {
    if (!/^[0-9a-f]{128}$/.test(signatureHex)) return false;
    if (order.serverDomain !== this.opts.serverDomain) return false;
    return this.opts.authorize(order, Buffer.from(signatureHex, "hex"));
  }

  /** Take a signed order. A sentence on refusal; null when taken (or already held). */
  async adopt(rawOrder: unknown, signatureHex: unknown): Promise<string | null> {
    const order = parseBackupPolicy(rawOrder);
    if (!order) return "that backup policy is malformed";
    if (order.serverDomain !== this.opts.serverDomain) return "that backup policy is for a different server";
    if (typeof signatureHex !== "string" || !this.verify(order, signatureHex)) return "only an admin device of this account can set the backup policy";
    if (order.policy === "peer" && this.held?.order.policy !== "peer" && this.opts.peerAllowed && !this.opts.peerAllowed()) {
      return "Backups on other servers aren't available yet. Choose another policy.";
    }
    if (this.held && order.issuedAt <= this.held.order.issuedAt) {
      return order.issuedAt === this.held.order.issuedAt ? null : "a newer backup policy is already set on this server";
    }
    this.held = { order, signatureHex };
    await mkdir(dirname(this.opts.path), { recursive: true });
    const tmp = `${this.opts.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.held), { mode: 0o600 });
    await rename(tmp, this.opts.path);
    const now = this.current();
    for (const cb of this.listeners) {
      try {
        cb(now);
      } catch (e) {
        this.opts.log?.(`[backup-policy] listener failed: ${(e as Error).message}`);
      }
    }
    return null;
  }

  /** The create-time policy riding beside a verified pairing order: `{ backupPolicy: { order, signatureHex } }`. */
  async adoptFromPairingJson(json: string): Promise<boolean> {
    let parsed: { backupPolicy?: { order?: unknown; signatureHex?: unknown } };
    try {
      parsed = JSON.parse(json) as typeof parsed;
    } catch {
      return false;
    }
    if (!parsed.backupPolicy) return false;
    const refused = await this.adopt(parsed.backupPolicy.order, parsed.backupPolicy.signatureHex);
    if (refused) this.opts.log?.(`[backup-policy] the create-time policy wasn't taken: ${refused}`);
    return refused === null;
  }
}
