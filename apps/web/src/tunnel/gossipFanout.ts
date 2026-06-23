/**
 * Per-account gossip fan-out (Phase 4 — the hub broadcast surface).
 *
 * Flagship boxes of ONE account gossip with each other over a reserved
 * per-account fan-out name `broadcast--<user>.flagship.services`. A box POSTs
 * an OPAQUE, end-to-end-encrypted blob there; the hub mirrors that blob to
 * EVERY connected box of the same account over their tunnels, content-blind,
 * and returns NOTHING.
 *
 * The hub NEVER decrypts (the boxes share a CGK the hub doesn't hold) and
 * NEVER parses the body — it is forwarded verbatim. The reply is empty (`204`)
 * so no membership count / liveness signal leaks back through it.
 *
 *   ┌── box A ──POST opaque──▶ broadcast--acct.flagship.services (hub, :8443)
 *   │                              │ look up every connected tunnel of `acct`
 *   │                              ├── deliverGossipToBox(box B, opaque)
 *   │                              └── deliverGossipToBox(box C, opaque)
 *   └◀── 204 empty ────────────────┘   (sender A excluded)
 *
 * Hub→box delivery rides the SAME stream-origination mechanism the SNI router
 * uses (open a multiplexed stream toward the box, write request bytes, the
 * box's own HTTP server answers). Here the request is a synthetic
 * `POST /internal/gossip` carrying the opaque body; the box-side response is
 * read-and-discarded — the fan-out is fire-and-forget.
 */

import {
  closeFrame,
  dataFrame,
  openFrame,
} from "@flagship/tunnel-protocol";
import type { RegisteredTunnel, TunnelRegistry } from "./registry.js";

/**
 * Host shape the hub's TLS-terminating surface recognizes as a gossip
 * fan-out target. `broadcast--<user>.<apex>`. The `--` keeps it inside the
 * reserved-name regime (no user can own a label containing `--`, and
 * `broadcast` is reserved), and the leading `broadcast` is the cheap
 * routing discriminator the surface checks before the (more expensive)
 * apex/regex parse.
 */
export const GOSSIP_HOST_PREFIX = "broadcast--";

/**
 * The box-side inbound gossip endpoint contract the daemon must serve.
 * `POST /internal/gossip`, body = the opaque CGK-sealed bytes, response
 * IGNORED by the hub. Stated here so the daemon lane matches exactly.
 */
export const GOSSIP_BOX_PATH = "/internal/gossip";
export const GOSSIP_BOX_METHOD = "POST";

/**
 * Parse `broadcast--<user>.<apex>` → `<user>`, or null if `host` is not a
 * gossip fan-out target under this apex. Case-insensitive; strips any `:port`.
 * The `<user>` must be a single valid user-zone label (no further dots) so a
 * crafted `broadcast--a.b.flagship.services` can't address some other zone.
 */
export function parseGossipHost(host: string, apex: string): string | null {
  let h = host.trim().toLowerCase();
  if (!h) return null;
  const colon = h.lastIndexOf(":");
  // Only strip a trailing :port (digits), never an IPv6-ish colon mid-host.
  if (colon !== -1 && /^[0-9]+$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  const suffix = "." + apex.toLowerCase();
  if (!h.endsWith(suffix)) return null;
  const head = h.slice(0, -suffix.length);
  if (!head.startsWith(GOSSIP_HOST_PREFIX)) return null;
  const user = head.slice(GOSSIP_HOST_PREFIX.length);
  // Exactly one label: the user. No embedded dots (would address elsewhere),
  // no embedded `--` (reserved-name boundary), valid user grammar.
  if (user.includes(".") || user.includes("--")) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(user)) return null;
  return user;
}

/**
 * Deliver one opaque gossip blob to one connected box over its tunnel.
 *
 * THE SEAM. Originates a multiplexed stream toward the box and writes a
 * synthetic `POST /internal/gossip` carrying `opaqueBody` verbatim, then
 * detaches and closes the stream. The box-side response is read-and-discarded
 * (`onData`/`onRemoteClose` only drive teardown) — the fan-out returns
 * nothing to the originator, so the box's reply is irrelevant to the hub.
 *
 * Content-blind: `opaqueBody` is placed in the HTTP body unmodified; the hub
 * sets only transport framing (method, path, Host, Content-Length). It never
 * inspects, decodes, or re-encodes the bytes.
 *
 * Best-effort: a send failure (tunnel mid-close) is swallowed — one dead box
 * must not abort the fan-out to the others. Returns true if the request bytes
 * were handed to the tunnel, false if the tunnel was already gone.
 */
export function deliverGossipToBox(
  tunnel: RegisteredTunnel,
  opaqueBody: Uint8Array,
  opts: { host?: string } = {},
): boolean {
  const streamId = tunnel.nextStreamId();
  // Host header: the box's own canonical (it terminates TLS for its own zone),
  // so its HTTP server routes the synthetic request like any inbound one. The
  // SNI the hub "opens" with is likewise the box canonical.
  const host = opts.host ?? tunnel.podCanonical;
  const head =
    `${GOSSIP_BOX_METHOD} ${GOSSIP_BOX_PATH} HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    `Content-Type: application/octet-stream\r\n` +
    `Content-Length: ${opaqueBody.byteLength}\r\n` +
    `Connection: close\r\n` +
    `\r\n`;
  const headBytes = new TextEncoder().encode(head);
  const requestBytes = new Uint8Array(headBytes.byteLength + opaqueBody.byteLength);
  requestBytes.set(headBytes, 0);
  requestBytes.set(opaqueBody, headBytes.byteLength);

  let done = false;
  const teardown = () => {
    if (done) return;
    done = true;
    tunnel.detachStream(streamId);
    try {
      tunnel.send(closeFrame(streamId, false));
    } catch {
      /* tunnel may already be down */
    }
  };

  // We don't care about the box's reply — attach a no-op sink so the hub
  // drains/closes cleanly without buffering, and never surfaces a body upward.
  tunnel.attachStream(streamId, {
    onData() {
      /* response bytes discarded — fan-out returns nothing */
    },
    onRemoteClose() {
      teardown();
    },
  });

  try {
    tunnel.send(openFrame(streamId, host));
    tunnel.send(dataFrame(streamId, requestBytes));
    return true;
  } catch {
    teardown();
    return false;
  }
}

export interface GossipFanoutResult {
  /** How many boxes the blob was delivered to (excludes the sender). */
  delivered: number;
  /** Total account members considered (for hub-internal metrics only — NEVER returned to the caller). */
  members: number;
}

/**
 * Fan a verbatim opaque gossip blob out to every connected box of `username`'s
 * account, EXCLUDING the sender when it can be identified.
 *
 * The hub does NOT parse/decrypt `opaqueBody`. The return value is for
 * hub-internal metrics ONLY — the HTTP surface MUST respond empty (204) and
 * leak no count.
 *
 * @param senderPodCanonical optional canonical of the originating box; that
 *        tunnel is skipped (harmless to include, but we prefer to exclude so a
 *        box never re-receives its own gossip).
 */
export function fanOutGossip(
  registry: TunnelRegistry,
  username: string,
  opaqueBody: Uint8Array,
  senderPodCanonical?: string,
): GossipFanoutResult {
  const members = registry.tunnelsForUser(username);
  const sender = senderPodCanonical?.toLowerCase();
  let delivered = 0;
  for (const t of members) {
    if (sender && t.podCanonical.toLowerCase() === sender) continue;
    if (deliverGossipToBox(t, opaqueBody)) delivered++;
  }
  return { delivered, members: members.length };
}
