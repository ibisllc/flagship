/**
 * Persistent sibling-sync SERVER glue (#86).
 *
 * Accepts inbound WS upgrades on `/.flagship/sibling-sync` and starts
 * a SyncConnection in responder mode. The path is distinct from the
 * legacy `/.flagship/sibling-handshake` (frames.ts protocol) so cert
 * sync and opaque app-message routing don't share state — peers that
 * hold AppGrants but not handshake-trust can still cert-sync, and
 * vice versa.
 *
 * The accept helper here mirrors `acceptSiblingUpgrade` in wsServer.ts:
 * the runtime's TLS server detects the upgrade, validates the path,
 * and hands the raw socket to us. We complete the WS handshake via
 * `ws` in `noServer` mode, wrap the resulting socket as a
 * SyncTransport, and start a SyncConnection.
 */

import type { Bytes, Keypair, PodIdentityBinding } from "@flagship/protocol";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import {
  startSyncConnection,
  wrapWsAsSyncTransport,
  type AppGrantStore,
  type IrkPubKeyLookup,
  type SyncConnection,
  type SyncRevocationLookup,
} from "./syncConnection.js";

const wss = new WebSocketServer({ noServer: true });

export interface AcceptSyncUpgradeArgs {
  socket: Socket;
  headBuffer: Buffer;
  headers: Record<string, string>;
  /** Our pod's canonical FQDN. */
  myServerDomain: string;
  /** Our pod identity keypair. */
  myIdentity: Keypair;
  /** Our username. */
  username: string;
  myBinding: PodIdentityBinding;
  myBindingSignature: Bytes;
  lookupIrk: IrkPubKeyLookup;
  revocations: SyncRevocationLookup;
  store: AppGrantStore;
  /** Default 5 minutes. */
  inventoryIntervalMs?: number;
  /** Fires once the mutual hello completes. */
  onReady?: (args: { peerDomain: string; peerIdentityPubKey: Bytes }) => void;
  onClose?: (args: { peerDomain: string | null; reason?: string }) => void;
  onAuthFailure?: (args: { reason: string }) => void;
}

export function acceptSyncUpgrade(args: AcceptSyncUpgradeArgs): boolean {
  const fakeReq = {
    headers: args.headers,
    method: "GET",
    url: "/.flagship/sibling-sync",
  } as unknown as import("node:http").IncomingMessage;

  let accepted = false;
  let conn: SyncConnection | null = null;
  let lastPeer: string | null = null;

  wss.handleUpgrade(fakeReq, args.socket, args.headBuffer, (ws: WsSocket) => {
    accepted = true;
    conn = startSyncConnection({
      socket: wrapWsAsSyncTransport(
        ws as unknown as Parameters<typeof wrapWsAsSyncTransport>[0],
      ),
      myServerDomain: args.myServerDomain,
      myIdentity: args.myIdentity,
      username: args.username,
      myBinding: args.myBinding,
      myBindingSignature: args.myBindingSignature,
      lookupIrk: args.lookupIrk,
      revocations: args.revocations,
      store: args.store,
      inventoryIntervalMs: args.inventoryIntervalMs,
      onReady: ({ peerDomain, peerIdentityPubKey }) => {
        lastPeer = peerDomain;
        args.onReady?.({ peerDomain, peerIdentityPubKey });
      },
      onClose: ({ reason }) => {
        args.onClose?.({ peerDomain: lastPeer, reason });
      },
      onAuthFailure: ({ reason }) => {
        args.onAuthFailure?.({ reason });
      },
    });
    void conn;
  });

  return accepted;
}
