/**
 * Inbound `/internal/gossip` — the contract:
 *
 *   POST /internal/gossip
 *   body: OPAQUE CGK-sealed gossip blob (sealGossip(canonicalGossip-bearing
 *         announcement JSON, cgk)). No auth header, no envelope — the SEAL +
 *         HMAC are the authentication (only a holder of the cloud's CGK can
 *         produce a frame that opens AND verifies).
 *   reply: 204 No Content, empty. The POSTer's reply is IGNORED — a box learns
 *          siblings from the frames it RECEIVES here, never from a POST reply.
 *
 * Pipeline: openGossip(body, cgk) → JSON.parse the announcement → verifyGossipMac
 * → upsert into the SiblingView. Any undecryptable body, bad MAC, malformed JSON,
 * or wrong-account frame is REJECTED SILENTLY (still a 204 — we never leak which
 * step failed, and a peer that can't open a frame is indistinguishable from a
 * scanner). Never throws.
 */
import type { GossipAnnouncement } from "@flagship/protocol";
import { asGossipCrypto, verifyFrameMac, type GossipCrypto } from "./gossipCrypto.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { SiblingView } from "./siblingView.js";

/** The wire shape inside the sealed blob: the announcement, its MAC, and the
 *  sender's signed server order (verified by its own signature, not the MAC). */
interface SealedGossipFrame {
  announcement: GossipAnnouncement;
  mac: string;
  serverOrder?: unknown;
}

const EMPTY_204: HttpResponse = { status: 204, body: "" };

export function buildGossipIngestHandler(deps: {
  cgk: Uint8Array | GossipCrypto;
  view: SiblingView;
  /** This box's account (UserId) — reject frames for a different account. */
  user: string;
  /** This box's own id (name) — ignore our own echoed frame if the hub loops it back. */
  selfId: string;
  /** Offer a sibling's server order to the holder (which verifies it). */
  onServerOrder?: (raw: unknown, from: string) => Promise<unknown> | void;
  /**
   * Whether a sibling (by the STK its frame names) may be counted at all; null admits it. While
   * strict is in force a frame from a server the account's signed order does not list is dropped
   * (pq-suites.md §16); the CGK alone is not enough.
   */
  admitSibling?: (stkHex: string) => string | null;
  now?: () => number;
  onLog?: (m: string) => void;
}) {
  const now = deps.now ?? (() => Date.now());
  const crypto = asGossipCrypto(deps.cgk);
  const selfId = deps.selfId.toLowerCase();
  const user = deps.user.toLowerCase();

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    const path = stripQuery(req.path);
    if (path !== "/internal/gossip") return null;
    if (req.method !== "POST") {
      // Wrong method on the gossip path — still don't leak; 405 is fine since
      // the path itself isn't a secret.
      return { status: 405, body: "" };
    }

    try {
      // 1. Open the CGK seal. A blob we can't open (wrong key / not a seal /
      //    truncated) throws → silent 204.
      const plaintext = crypto.open(toUint8(req.body));

      // 2. Parse the announcement + MAC.
      const parsed = JSON.parse(Buffer.from(plaintext).toString("utf8")) as SealedGossipFrame;
      const a = parsed?.announcement;
      const mac = parsed?.mac;
      if (!a || typeof mac !== "string") return EMPTY_204;

      // 3. Verify the HMAC under the CGK — proves the FRAME's claims weren't
      //    forged by a peer without the cloud key.
      if (!verifyFrameMac(crypto, a, mac)) return EMPTY_204;

      // 4. Account-scope + self-echo guards.
      if (typeof a.user !== "string" || a.user.toLowerCase() !== user) return EMPTY_204;
      if (typeof a.name !== "string" || a.name.toLowerCase() === selfId) return EMPTY_204;

      // 5. Only a sibling the account vouches for, then upsert into the live view.
      const refused = typeof a.birthAuthHex === "string" ? deps.admitSibling?.(a.birthAuthHex) ?? null : "no-stk";
      if (refused) {
        deps.onLog?.(`[gossip] dropping a frame from ${a.name}: ${refused}`);
        return EMPTY_204;
      }
      deps.view.upsert(a, now());
      deps.onLog?.(`[gossip] ingested frame from ${a.name} (${a.services.length} services)`);

      // 6. A sibling holding an order passes it on; the holder adopts it only
      //    if it verifies and is newer than ours.
      if (parsed.serverOrder && deps.onServerOrder) {
        await deps.onServerOrder(parsed.serverOrder, `gossip from ${a.name}`);
      }
    } catch {
      // Undecryptable / malformed — swallow. Never reveal the failure.
    }
    return EMPTY_204;
  };
}

function stripQuery(p: string): string {
  const i = p.indexOf("?");
  return i >= 0 ? p.slice(0, i) : p;
}

function toUint8(b: Buffer | Uint8Array): Uint8Array {
  return b instanceof Uint8Array ? b : new Uint8Array(b);
}
