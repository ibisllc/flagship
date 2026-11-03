/**
 * Peer-backup mailboxes on the hub (docs/peer-backup.md §5.3). A holder's
 * tunnel announces `mailboxId(pik, epoch)` signed by its PIK; owners POST a
 * sealed envelope to `/pb/m/<mailboxId>` and the hub carries it over that
 * tunnel and back. The hub sees mailbox ids, sizes and timing; it keeps
 * nothing once the reply is sent, and nothing at all across restarts.
 */
import { canonicalPbMailboxAnnounce, ed, pbMailboxEpoch, pbMailboxId } from "@flagship/protocol";
import type { MailboxAnnouncement } from "@flagship/tunnel-protocol";

export type MailDeliver = (mailboxId: string, envelope: Uint8Array) => Promise<{ status: number; body: Uint8Array }>;

/** Mailbox ids this announcement list proves, or null when any entry is bad. */
export function verifyMailboxAnnouncements(list: MailboxAnnouncement[], now: number): string[] | null {
  const e = pbMailboxEpoch(now);
  const out: string[] = [];
  for (const a of list) {
    if (a.epoch < e - 1 || a.epoch > e + 1) return null;
    let good = false;
    try {
      good = ed.verify(Buffer.from(a.sigHex, "hex"), canonicalPbMailboxAnnounce(a.pikPubHex, a.epoch), Buffer.from(a.pikPubHex, "hex"));
    } catch {
      good = false;
    }
    if (!good) return null;
    out.push(pbMailboxId(a.pikPubHex, a.epoch));
  }
  return out;
}

/**
 * The relay mesh (relay-mesh.md §7.6): a mailbox held on another relay. `onAnnounce` tells the mesh which mailboxes a
 * local tunnel proved (it announces them to every peer); `has` / `deliver` fall back to the peer that announced one.
 */
export interface RemoteMailboxes {
  onAnnounce(list: MailboxAnnouncement[]): void;
  /** Local tunnels stopped holding these ids (the mesh withdraws them, so a peer's holder can take over). */
  onWithdraw?(ids: string[]): void;
  has(id: string): boolean;
  deliver(id: string, envelope: Uint8Array): Promise<{ status: number; body: Uint8Array } | null>;
}

export class MailboxRegistry {
  private readonly routes = new Map<string, { owner: object; deliver: MailDeliver }>();
  private remote: RemoteMailboxes | null = null;

  /** Mesh mode: mailboxes held on other relays. */
  setRemote(r: RemoteMailboxes | null): void {
    this.remote = r;
  }

  /** Point these mailbox ids at a tunnel. A later announcement for the same id wins. `list`: the proofs (mesh). */
  register(ids: string[], owner: object, deliver: MailDeliver, list?: MailboxAnnouncement[]): void {
    const gone: string[] = [];
    for (const [id, r] of this.routes) {
      if (r.owner === owner && !ids.includes(id)) {
        this.routes.delete(id);
        gone.push(id);
      }
    }
    for (const id of ids) this.routes.set(id, { owner, deliver });
    if (gone.length > 0) this.remote?.onWithdraw?.(gone);
    if (list && this.remote) this.remote.onAnnounce(list);
  }

  /** The tunnel closed. */
  drop(owner: object): void {
    const gone: string[] = [];
    for (const [id, r] of this.routes) {
      if (r.owner === owner) {
        this.routes.delete(id);
        gone.push(id);
      }
    }
    if (gone.length > 0) this.remote?.onWithdraw?.(gone);
  }

  has(id: string): boolean {
    return this.routes.has(id) || (this.remote?.has(id) ?? false);
  }

  /** Held by a tunnel on this relay (a bridged pb-mail stream is served only from these: one hop). */
  hasLocal(id: string): boolean {
    return this.routes.has(id);
  }

  size(): number {
    return this.routes.size;
  }

  async deliver(id: string, envelope: Uint8Array): Promise<{ status: number; body: Uint8Array } | null> {
    const r = this.routes.get(id);
    if (r) return r.deliver(id, envelope);
    return this.remote ? this.remote.deliver(id, envelope) : null;
  }

  async deliverLocal(id: string, envelope: Uint8Array): Promise<{ status: number; body: Uint8Array } | null> {
    const r = this.routes.get(id);
    return r ? r.deliver(id, envelope) : null;
  }
}
