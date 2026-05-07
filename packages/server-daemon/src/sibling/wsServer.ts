/**
 * Sibling-handshake WS endpoint glue. The daemon's TLS server detects
 * an inbound `Upgrade: websocket` request for `/.flagship/sibling-handshake`
 * and hands the raw socket here. We complete the WS handshake with
 * `ws`'s `noServer` mode, wrap the resulting WebSocket as a
 * SiblingTransportSocket, and start a SiblingConnection acceptor.
 *
 * The peer's serverId is unknown at upgrade time; SiblingHandshake's
 * responder mode binds it from the first inbound hello, so we can
 * just construct the connection with `peerServerId` undefined.
 */

import type { Keypair } from "@flagship/protocol";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { SiblingConnection, wrapWsAsSiblingTransport } from "./connection.js";
import type { SiblingPeerLookup } from "./handshake.js";
import type { InMemorySiblingRouter } from "./router.js";

const wss = new WebSocketServer({ noServer: true });

export interface AcceptSiblingUpgradeArgs {
  socket: Socket;
  headBuffer: Buffer;
  headers: Record<string, string>;
  myServerId: string;
  myStk: Keypair;
  lookupPeerStk: SiblingPeerLookup;
  router: InMemorySiblingRouter;
  liveSiblings?: () => string[];
  onReady?: (args: { peerServerId: string }) => void;
  onClose?: (args: { peerServerId: string | null }) => void;
}

export function acceptSiblingUpgrade(args: AcceptSiblingUpgradeArgs): boolean {
  const fakeReq = {
    headers: args.headers,
    method: "GET",
    url: "/.flagship/sibling-handshake",
  } as unknown as import("node:http").IncomingMessage;

  let accepted = false;

  wss.handleUpgrade(fakeReq, args.socket, args.headBuffer, (ws: WsSocket) => {
    accepted = true;
    const transport = wrapWsAsSiblingTransport(
      ws as unknown as Parameters<typeof wrapWsAsSiblingTransport>[0],
    );
    const conn = new SiblingConnection({
      socket: transport,
      myServerId: args.myServerId,
      // peerServerId omitted — handshake binds it on first hello.
      myStk: args.myStk,
      lookupPeerStk: args.lookupPeerStk,
      router: args.router,
      liveSiblings: args.liveSiblings,
      onReady: args.onReady,
      onClose: args.onClose,
    });
    void conn;
  });

  return accepted;
}
