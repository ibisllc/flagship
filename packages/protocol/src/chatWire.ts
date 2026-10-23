/**
 * Box-to-box carriage of app chat (SECURITY-HARDENING-PLAN.md 17.5-17.6) and the admin's answer to a
 * held request. Two signed statements, all `|`-separated:
 *
 *   flagship/chat-wire/v1|<purpose>|<fromServer>|<toServer>|<issuedAt>|<nonce>|<bodySha256Hex>
 *       signed by the SENDING box's server identity key (STK). `purpose` is "frame". `toServer` is the
 *       receiving app's canonical host (`<label>.<user>.<apex>`), never a box: whichever of that owner's
 *       boxes holds the name gets it. The receiver looks the sender's key up in `.com`'s public server
 *       registry, so a peer is authenticated by a registered, unrevoked server, never by what the frame
 *       claims. The remote app's author and slug stay claims.
 *
 *   flagship/chat-approval/v1|<serverDomain>|<requestId>|<kind>|<decision>|<issuedAt>
 *       signed by the owner's sensitive-order key (admin root where pinned). `kind` is "incoming" or
 *       "outgoing"; `decision` is allow, always or deny (always only for incoming). A paired session
 *       carries it but cannot make it, so a stolen session cannot admit a stranger's app.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_CHAT_WIRE = "flagship/chat-wire/v1";
export const TAG_CHAT_APPROVAL = "flagship/chat-approval/v1";

/** How far a wire statement's time may differ from the receiver's clock. */
export const CHAT_WIRE_SKEW_MS = 120_000;

export type ChatWirePurpose = "frame";
export type ChatApprovalKind = "incoming" | "outgoing";
export type ChatApprovalDecision = "allow" | "always" | "deny";

export interface ChatWireStatement {
  purpose: ChatWirePurpose;
  fromServer: string;
  toServer: string;
  issuedAt: number;
  nonce: string;
  bodySha256Hex: string;
}

export interface ChatApprovalOrder {
  serverDomain: string;
  requestId: string;
  kind: ChatApprovalKind;
  decision: ChatApprovalDecision;
  issuedAt: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32,64}$/;

export function chatWireBodySha256(body: Bytes): string {
  return hex(sha256(body));
}

export function canonicalChatWire(s: ChatWireStatement): Bytes {
  if (s.purpose !== "frame") throw new Error("unknown chat wire purpose");
  legacyFieldGuard("fromServer", s.fromServer);
  legacyFieldGuard("toServer", s.toServer);
  if (!NONCE.test(s.nonce)) throw new Error("nonce must be 32 to 64 lowercase hex");
  if (!HEX64.test(s.bodySha256Hex)) throw new Error("bodySha256Hex must be 64 lowercase hex");
  if (!Number.isSafeInteger(s.issuedAt) || s.issuedAt < 0) throw new Error("bad issuedAt");
  return new TextEncoder().encode(
    [TAG_CHAT_WIRE, s.purpose, s.fromServer.toLowerCase(), s.toServer.toLowerCase(), s.issuedAt, s.nonce, s.bodySha256Hex].join("|"),
  );
}

export function signChatWire(s: ChatWireStatement, sign: (msg: Bytes) => Bytes): Bytes {
  return sign(canonicalChatWire(s));
}

export function verifyChatWire(s: ChatWireStatement, sig: Bytes, senderStkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalChatWire(s), senderStkPub);
  } catch {
    return false;
  }
}

/** True when the statement is addressed to `me`, is recent enough and names the body it travelled with. */
export function chatWireFresh(s: ChatWireStatement, me: string, body: Bytes, now: number): boolean {
  return (
    s.toServer.toLowerCase() === me.toLowerCase() &&
    Math.abs(now - s.issuedAt) <= CHAT_WIRE_SKEW_MS &&
    s.bodySha256Hex === chatWireBodySha256(body)
  );
}

export function canonicalChatApproval(o: ChatApprovalOrder): Bytes {
  legacyFieldGuard("serverDomain", o.serverDomain);
  legacyFieldGuard("requestId", o.requestId);
  if (o.kind !== "incoming" && o.kind !== "outgoing") throw new Error("bad kind");
  if (!["allow", "always", "deny"].includes(o.decision)) throw new Error("bad decision");
  if (o.decision === "always" && o.kind !== "incoming") throw new Error("always allow applies to incoming requests only");
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt < 0) throw new Error("bad issuedAt");
  return new TextEncoder().encode([TAG_CHAT_APPROVAL, o.serverDomain.toLowerCase(), o.requestId, o.kind, o.decision, o.issuedAt].join("|"));
}

export function signChatApproval(o: ChatApprovalOrder, sign: (msg: Bytes) => Bytes): Bytes {
  return sign(canonicalChatApproval(o));
}

export function verifyChatApproval(o: ChatApprovalOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalChatApproval(o), pub);
  } catch {
    return false;
  }
}
