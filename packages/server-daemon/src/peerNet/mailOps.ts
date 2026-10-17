/**
 * Mailbox operations (docs/peer-backup.md §5.3). A request's header is
 * `{ op, leaseId, issuedAt, nonceHex, argsJson, lkPubHex?, sigHex }`, signed
 * by the lease key over `canonicalPbOp` (the args string as sent, the body's
 * SHA-256). Replies are `{ ok, error?, ...fields }` plus an optional body.
 */
import { createHash } from "node:crypto";
import {
  canonicalPbOp,
  decodePbMailPlaintext,
  ed,
  encodePbMailPlaintext,
  openPbMailResponse,
  pbMailboxEpoch,
  pbMailboxId,
  sealPbMailRequest,
} from "@flagship/protocol";
import { nodeAead } from "./fastCrypto.js";
import { PbUnreachable, type PbMailTransport } from "./types.js";

export type PbOp =
  | "lease.open"
  | "lease.renew"
  | "lease.close"
  | "lease.status"
  | "brick.put"
  | "brick.get"
  | "brick.prove"
  | "brick.delete";

export const PB_OPS: ReadonlySet<string> = new Set<PbOp>([
  "lease.open",
  "lease.renew",
  "lease.close",
  "lease.status",
  "brick.put",
  "brick.get",
  "brick.prove",
  "brick.delete",
]);

export interface PbOpHeader {
  op: PbOp;
  leaseId: string;
  issuedAt: number;
  nonceHex: string;
  argsJson: string;
  lkPubHex?: string;
  sigHex: string;
}

export function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

export function hex(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("hex");
}

export function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "hex"));
}

export interface PbHolderAddress {
  pikPubHex: string;
  xPubHex: string;
}

export interface PbReply {
  header: Record<string, unknown> & { ok?: boolean; error?: string };
  body: Uint8Array;
}

/** A holder answered, but with a refusal. */
export class PbRefused extends Error {}

/**
 * Send one operation to a holder through the relay. Throws PbUnreachable when
 * nothing came back, PbRefused when the holder said no.
 */
export async function callHolder(
  transport: PbMailTransport,
  holder: PbHolderAddress,
  a: {
    op: PbOp;
    leaseId: string | null;
    leaseKeySeed: Uint8Array;
    args: Record<string, unknown>;
    body?: Uint8Array;
    includeLkPub?: boolean;
    now: number;
  },
): Promise<PbReply> {
  const mailboxId = pbMailboxId(holder.pikPubHex, pbMailboxEpoch(a.now));
  const body = a.body ?? new Uint8Array(0);
  const argsJson = JSON.stringify(a.args);
  const nonceHex = hex(crypto.getRandomValues(new Uint8Array(16)));
  const leaseId = a.leaseId ?? "-";
  const sig = ed.sign(
    canonicalPbOp({ op: a.op, mailboxId, leaseId, issuedAt: a.now, nonceHex, argsJson, bodySha256Hex: sha256Hex(body) }),
    a.leaseKeySeed,
  );
  const header: PbOpHeader = { op: a.op, leaseId, issuedAt: a.now, nonceHex, argsJson, sigHex: hex(sig) };
  if (a.includeLkPub) header.lkPubHex = hex(ed.getPublicKey(a.leaseKeySeed));
  const plain = encodePbMailPlaintext({ header: header as unknown as Record<string, unknown>, body });
  const { envelope, keys } = sealPbMailRequest(fromHex(holder.xPubHex), mailboxId, plain, { aead: nodeAead });
  let replyEnv: Uint8Array;
  try {
    replyEnv = await transport.send(mailboxId, envelope);
  } catch (e) {
    throw e instanceof PbUnreachable ? e : new PbUnreachable((e as Error).message);
  }
  let reply: PbReply;
  try {
    const d = decodePbMailPlaintext(openPbMailResponse(keys, mailboxId, replyEnv, nodeAead));
    reply = { header: d.header as PbReply["header"], body: d.body };
  } catch {
    throw new PbUnreachable("the holder's reply didn't open");
  }
  if (reply.header.ok !== true) throw new PbRefused(typeof reply.header.error === "string" ? reply.header.error : "refused");
  return reply;
}
