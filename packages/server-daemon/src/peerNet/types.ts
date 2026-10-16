/**
 * Peer backup between accounts, box side (docs/peer-backup.md).
 *
 *   holder.ts  - holds other owners' bricks and .com filler in the pool
 *   owner.ts   - cuts this server's newest archive into bricks and keeps them alive
 *   restore.ts - brings an archive back from the bricks, on any server
 *   engine.ts  - runs both while the backup policy is Peer
 *
 * The seams below are what the simulation tests replace: `.com`, the relay,
 * and the disk.
 */
import type { PbNetwork, PbSpend, RsaPublicKey, SealedPbRoot } from "@flagship/protocol";

export interface PbNetworkInfo {
  network: PbNetwork;
  tokenKey: RsaPublicKey;
  relayBase: string;
}

export interface PbCheckinReply {
  network: PbNetwork;
  fillerNext: number;
  fillerWanted: number;
  challenge: { id: string; index: number; leaf: number; nonceHex: string; leafBytes: number; deadlineAt: number } | null;
  reliability: number;
  provenSlots: number;
}

export interface PbDirectoryEntry {
  pikPubHex: string;
  xPubHex: string;
  freeSlots: number;
  reliability: number;
  accountTag: string;
  netTag: string;
}

export interface PbDirectory {
  network: PbNetwork;
  entries: PbDirectoryEntry[];
  self: { accountTag: string; netTag: string };
}

/** A `.com` call failed; `status` is the HTTP status (0 = unreachable). */
export class PbComError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** This server's calls to `.com` (each signed by its STK inside the client). */
export interface PbComClient {
  network(): Promise<PbNetworkInfo>;
  checkin(a: { pikPubHex: string; xPubHex: string; poolBytes: number; fillerHeld: number; leaving: boolean; pikBindSigHex: string }): Promise<PbCheckinReply>;
  fetchFiller(index: number): Promise<Uint8Array>;
  proof(challengeId: string, answerHex: string): Promise<{ passed: boolean }>;
  directory(): Promise<PbDirectory>;
  tokens(blindedHex: string[]): Promise<string[]>;
  redeem(pikPubHex: string, spends: PbSpend[]): Promise<Array<{ serialHex: string; ok: boolean; reason?: string }>>;
  putRoot(serverId: string, generation: number, revision: number, sealed: SealedPbRoot): Promise<void>;
  getRoot(serverId: string): Promise<SealedPbRoot | null>;
}

/** The relay: POST a sealed envelope to a mailbox, get the sealed reply. Throws when unreachable. */
export interface PbMailTransport {
  send(mailboxId: string, envelope: Uint8Array): Promise<Uint8Array>;
}

export class PbUnreachable extends Error {}

/** Named blobs (bricks, filler, owner roots). */
export interface PbBlobStore {
  put(name: string, bytes: Uint8Array): Promise<void>;
  get(name: string): Promise<Uint8Array | null>;
  range(name: string, offset: number, length: number): Promise<Uint8Array | null>;
  delete(name: string): Promise<void>;
}

/** A JSON document that survives restarts. */
export interface PbStateFile<T> {
  load(): Promise<T | null>;
  save(v: T): Promise<void>;
}
