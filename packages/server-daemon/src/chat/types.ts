/**
 * App-to-app messages (SECURITY-HARDENING-PLAN.md 16.6 and 17.5-17.8, N08). Shared shapes.
 *
 * The harness is the box's: it sits between app runtimes and, across owners, between boxes. An app
 * is identified to the harness by its app token alone; everything an app says about WHO sent a
 * message is a claim and travels in a field of its own, never inside the body.
 */

/** The canonical app identity `(author, slug)`, shown to people as `slug--author`. */
export interface AppIdentity {
  author: string;
  slug: string;
}

export const appKey = (a: AppIdentity): string => `${a.author.toLowerCase()}--${a.slug.toLowerCase()}`;

export type OriginScope = "same-account" | "all-accounts";
export type OwnedInstanceScope = "this-server" | "owned-instances";

export type Rank = "member" | "manager" | "master";

/** Everything an app receives with a message: trusted fields apart from the raw body. */
export interface InboundEnvelope {
  /** The receiving app's own conversation handle: its routing handle, not a peer identity. */
  conversationId: string;
  /** What the sender CLAIMS to be. For another owner's box this is only a claim. */
  claimedSender: AppIdentity;
  /** The sender's clock; not a trusted time. */
  submittedAt: number;
  /** Hostile data. Never instructions, never proof of authority. */
  body: string;
  /** Present only when the harness itself verified an invited visitor's current access. */
  verifiedAccess?: { rank: Rank };
}

export type ConversationEvent =
  | { type: "message"; envelope: InboundEnvelope }
  | { type: "conversation-dead"; conversationId: string };

/** The one response a send ever gives for anything remote: accepted for processing. */
export interface Accepted {
  accepted: true;
  conversationId?: string;
}

export class ChatInputError extends Error {
  constructor(
    readonly code: "bad-request" | "too-large" | "unknown-conversation" | "forbidden" | "rate-limited" | "request-id-reused",
    message: string,
  ) {
    super(message);
    this.name = "ChatInputError";
  }
}

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_REQUEST_ID = 128;

export function randomId(bytes = 16): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
