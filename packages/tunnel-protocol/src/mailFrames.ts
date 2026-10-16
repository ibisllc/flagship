import {
  FRAME_PB_MAILBOX_ANNOUNCE,
  FRAME_PB_MAIL_REQ,
  FRAME_PB_MAIL_RESP,
  MAX_FRAME_PAYLOAD,
  type Frame,
} from "./frames.js";

/**
 * Peer-backup mailboxes over the tunnel (docs/peer-backup.md §5.3).
 *
 *   box → hub  MAILBOX_ANNOUNCE  JSON { announcements: [{ pikPubHex, epoch, sigHex }] }
 *   hub → box  MAIL_REQ          a sealed envelope for one of the box's mailboxes
 *   box → hub  MAIL_RESP         the sealed reply, same stream id
 *
 * A request or reply is split over frames: byte 0 is flags (1 = first,
 * 2 = last); the first REQ frame then carries u8 length + the mailbox id
 * (ASCII), the first RESP frame a u16 BE status (200 = sealed reply). The
 * rest is the envelope's bytes. The hub numbers mail streams in its own
 * space (it never sends FRAME_OPEN on them).
 */

export const MAIL_FIRST = 1;
export const MAIL_LAST = 2;
/** Largest envelope either side accepts: a 16 MiB brick plus its header. */
export const MAIL_MAX_ENVELOPE = 16 * 1024 * 1024 + 256 * 1024;
const CHUNK = MAX_FRAME_PAYLOAD - 64;

export interface MailboxAnnouncement {
  pikPubHex: string;
  epoch: number;
  sigHex: string;
}

export function mailboxAnnounceFrame(announcements: MailboxAnnouncement[]): Frame {
  return {
    streamId: 0,
    type: FRAME_PB_MAILBOX_ANNOUNCE,
    payload: new TextEncoder().encode(JSON.stringify({ announcements })),
  };
}

export function decodeMailboxAnnounce(payload: Uint8Array): MailboxAnnouncement[] | null {
  try {
    const j = JSON.parse(new TextDecoder().decode(payload)) as { announcements?: unknown };
    if (!Array.isArray(j.announcements) || j.announcements.length > 8) return null;
    const out: MailboxAnnouncement[] = [];
    for (const a of j.announcements as Array<Record<string, unknown>>) {
      if (
        typeof a?.pikPubHex !== "string" || !/^[0-9a-f]{64}$/.test(a.pikPubHex) ||
        typeof a.epoch !== "number" || !Number.isInteger(a.epoch) || a.epoch < 0 ||
        typeof a.sigHex !== "string" || !/^[0-9a-f]{128}$/.test(a.sigHex)
      ) {
        return null;
      }
      out.push({ pikPubHex: a.pikPubHex, epoch: a.epoch, sigHex: a.sigHex });
    }
    return out;
  } catch {
    return null;
  }
}

function split(type: number, streamId: number, head: Uint8Array, body: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  let off = 0;
  let first = true;
  do {
    const room = CHUNK - (first ? head.length : 0);
    const part = body.subarray(off, Math.min(body.length, off + room));
    off += part.length;
    const last = off >= body.length;
    const payload = new Uint8Array(1 + (first ? head.length : 0) + part.length);
    payload[0] = (first ? MAIL_FIRST : 0) | (last ? MAIL_LAST : 0);
    if (first) payload.set(head, 1);
    payload.set(part, 1 + (first ? head.length : 0));
    frames.push({ streamId, type: type as Frame["type"], payload });
    first = false;
  } while (off < body.length);
  return frames;
}

export function mailRequestFrames(streamId: number, mailboxId: string, envelope: Uint8Array): Frame[] {
  const id = new TextEncoder().encode(mailboxId);
  if (id.length > 64) throw new Error("mailbox id too long");
  const head = new Uint8Array(1 + id.length);
  head[0] = id.length;
  head.set(id, 1);
  return split(FRAME_PB_MAIL_REQ, streamId, head, envelope);
}

export function mailResponseFrames(streamId: number, status: number, envelope: Uint8Array): Frame[] {
  const head = new Uint8Array([(status >>> 8) & 0xff, status & 0xff]);
  return split(FRAME_PB_MAIL_RESP, streamId, head, envelope);
}

/** Collects one direction of a mail stream. `push` returns the whole message on its last frame. */
export class MailAssembler {
  private parts: Uint8Array[] = [];
  private size = 0;
  private headDone = false;
  mailboxId = "";
  status = 0;

  constructor(private readonly kind: "req" | "resp") {}

  push(payload: Uint8Array): { done: true; body: Uint8Array } | { done: false } {
    if (payload.length < 1) throw new Error("empty mail frame");
    const flags = payload[0]!;
    let rest = payload.subarray(1);
    if (flags & MAIL_FIRST) {
      if (this.headDone) throw new Error("mail stream restarted");
      if (this.kind === "req") {
        const n = rest[0] ?? 0;
        this.mailboxId = new TextDecoder().decode(rest.subarray(1, 1 + n));
        rest = rest.subarray(1 + n);
      } else {
        this.status = ((rest[0] ?? 0) << 8) | (rest[1] ?? 0);
        rest = rest.subarray(2);
      }
      this.headDone = true;
    } else if (!this.headDone) {
      throw new Error("mail stream without its first frame");
    }
    this.size += rest.length;
    if (this.size > MAIL_MAX_ENVELOPE) throw new Error("mail too large");
    this.parts.push(rest.slice());
    if (!(flags & MAIL_LAST)) return { done: false };
    const body = new Uint8Array(this.size);
    let o = 0;
    for (const p of this.parts) {
      body.set(p, o);
      o += p.length;
    }
    return { done: true, body };
  }
}
