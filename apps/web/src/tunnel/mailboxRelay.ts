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

export class MailboxRegistry {
  private readonly routes = new Map<string, { owner: object; deliver: MailDeliver }>();

  /** Point these mailbox ids at a tunnel. A later announcement for the same id wins. */
  register(ids: string[], owner: object, deliver: MailDeliver): void {
    for (const [id, r] of this.routes) if (r.owner === owner && !ids.includes(id)) this.routes.delete(id);
    for (const id of ids) this.routes.set(id, { owner, deliver });
  }

  /** The tunnel closed. */
  drop(owner: object): void {
    for (const [id, r] of this.routes) if (r.owner === owner) this.routes.delete(id);
  }

  has(id: string): boolean {
    return this.routes.has(id);
  }

  size(): number {
    return this.routes.size;
  }

  async deliver(id: string, envelope: Uint8Array): Promise<{ status: number; body: Uint8Array } | null> {
    const r = this.routes.get(id);
    if (!r) return null;
    return r.deliver(id, envelope);
  }
}
