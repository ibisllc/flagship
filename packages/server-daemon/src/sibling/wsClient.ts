/**
 * Outbound sibling-WS client. Used by the boot probe and by
 * /api/url/claim when a takeover handshake is needed.
 *
 * Opens a WSS connection to `https://<peerFqdn>/.flagship/sibling-handshake`
 * and runs the SiblingHandshake as initiator. Returns the
 * SiblingConnection once the handshake completes.
 */

import type { Keypair } from "@flagship/protocol";
import { WebSocket } from "ws";
import { SiblingConnection, wrapWsAsSiblingTransport } from "./connection.js";
import type { SiblingPeerLookup } from "./handshake.js";
import type { InMemorySiblingRouter } from "./router.js";

export interface OpenSiblingArgs {
  peerFqdn: string;
  /**
   * The peer's serverId. For canonical pod URLs this equals peerFqdn.
   * For alias / custom URLs the initiator may not know the serverId
   * up-front; passing undefined lets the handshake bind it (and the
   * router records it once known).
   */
  peerServerId?: string;
  myServerId: string;
  myStk: Keypair;
  lookupPeerStk: SiblingPeerLookup;
  router: InMemorySiblingRouter;
  liveSiblings?: () => string[];
  /** Override the URL scheme — defaults to wss:// (production). Tests pass ws://. */
  scheme?: "ws" | "wss";
  /** Override the path — defaults to /.flagship/sibling-handshake. */
  path?: string;
  /** Connect timeout in ms. Default 10s. */
  connectTimeoutMs?: number;
  onReady?: (args: { peerServerId: string }) => void;
  onClose?: (args: { peerServerId: string | null }) => void;
}

export interface OpenSiblingResult {
  connection: SiblingConnection;
}

/**
 * Open a sibling-WS to the named peer FQDN. Resolves with the
 * SiblingConnection once the handshake completes; rejects if the WS
 * upgrade fails OR the handshake fails.
 */
export async function openSiblingConnection(
  args: OpenSiblingArgs,
): Promise<OpenSiblingResult> {
  const scheme = args.scheme ?? "wss";
  const path = args.path ?? "/.flagship/sibling-handshake";
  const url = `${scheme}://${args.peerFqdn}${path}`;
  const ws = new WebSocket(url);
  const timeout = args.connectTimeoutMs ?? 10_000;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* swallow */ }
      reject(new Error(`sibling-ws connect timeout ${args.peerFqdn}`));
    }, timeout);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (e) => {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });

  const transport = wrapWsAsSiblingTransport(
    ws as unknown as Parameters<typeof wrapWsAsSiblingTransport>[0],
  );
  const connection = new SiblingConnection({
    socket: transport,
    myServerId: args.myServerId,
    peerServerId: args.peerServerId,
    myStk: args.myStk,
    lookupPeerStk: args.lookupPeerStk,
    router: args.router,
    liveSiblings: args.liveSiblings,
    onReady: args.onReady,
    onClose: args.onClose,
  });
  await connection.ready();
  return { connection };
}
