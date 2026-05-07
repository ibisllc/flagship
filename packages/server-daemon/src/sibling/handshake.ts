/**
 * Sibling-WS handshake state machine.
 *
 * Runs over a duplex stream of `SiblingFrame` messages. The state
 * machine is symmetric — same code on both peers. After construction:
 *
 *   1. Both sides call `start()`. This sends a sibling-hello carrying
 *      a fresh challenge to the peer and (once the peer's hello has
 *      arrived) a signature over `siblingHelloChallenge` for the
 *      peer's challenge.
 *   2. Both sides verify the peer's signature once it arrives. The
 *      handshake completes when:
 *      - we've received a peer-hello (so we know what to sign), AND
 *      - we've received a peer-hello whose challengeResponseSignature
 *        verifies against the peer's STK pubkey.
 *   3. Either side may then send takeover-request frames; sync-frame /
 *      takeover-ack / sync-complete carry takeover state.
 *
 * The wire reality is that each peer needs the OTHER's challenge before
 * it can sign — so the first hello carries challenge but no signature,
 * and the responding hello carries both. Implementations send a second
 * hello after receiving the first if their own initial hello was
 * already on the wire without a signature. We accept either ordering.
 *
 * STK pubkey lookup is delegated — production wires it to a cached
 * `.com /api/server/by-domain` fetch. Tests inject a static map.
 */

import { ed, type Bytes, type Keypair } from "@flagship/protocol";
import {
  decodeSiblingFrame,
  encodeSiblingFrame,
  FRAME_SIBLING_HELLO,
  siblingHelloChallenge,
  type SiblingFrame,
  type SiblingHelloPayload,
} from "./frames.js";

export interface SiblingPeerLookup {
  /**
   * Return the STK pubkey for the named server, or null if unknown.
   * Production cached fetch from `.com /api/server/by-domain`.
   */
  (serverId: string): Promise<Bytes | null>;
}

export interface SiblingHandshakeOptions {
  /** This pod's serverId (will be sent in our sibling-hello). */
  myServerId: string;
  /** The peer we expect to talk to. */
  peerServerId: string;
  /** This pod's STK keypair. */
  myStk: Keypair;
  /** STK pubkey lookup. */
  lookupPeerStk: SiblingPeerLookup;
  /** Send a frame on the underlying transport. */
  send: (frame: SiblingFrame) => void;
  /**
   * Snapshot getter for the currently-live sibling set. Called at
   * hello-send time; the result is piggybacked on the hello as
   * `liveSiblings` so peers can grow their own live set via gossip.
   * Optional — when omitted, no gossip is sent (the receiver can
   * still bootstrap its own discovery elsewhere).
   *
   * The set is purely ephemeral. There is no historical record; what
   * the getter returns at send-time is what the peer learns.
   */
  liveSiblings?: () => string[];
  /** Test seam — supply random bytes for the challenge nonce. */
  randomChallenge?: () => Uint8Array;
}

export type HandshakeStatus =
  | { state: "initializing" }
  | { state: "awaiting-peer-hello" }
  | { state: "awaiting-peer-signature" }
  | { state: "ready" }
  | { state: "failed"; reason: string };

export class SiblingHandshake {
  private status: HandshakeStatus = { state: "initializing" };
  private myChallenge: Uint8Array;
  private peerChallenge: Uint8Array | null = null;
  private peerVerified = false;
  private sentSignedHello = false;
  private resolveReady!: () => void;
  private rejectReady!: (reason: string) => void;
  private readyPromise: Promise<void>;

  constructor(private readonly opts: SiblingHandshakeOptions) {
    const rng = opts.randomChallenge ?? defaultRandom;
    this.myChallenge = rng();
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = (r) => reject(new Error(r));
    });
  }

  /** Kick off the handshake by sending our initial hello. */
  start(): void {
    if (this.status.state !== "initializing") return;
    this.sendHello(undefined);
    this.status = { state: "awaiting-peer-hello" };
  }

  /** Block until the handshake completes (or fails). */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Public read of current state — useful for tests. */
  getStatus(): HandshakeStatus {
    return this.status;
  }

  /** Feed a raw inbound WS message. */
  async ingest(message: Uint8Array): Promise<void> {
    if (this.status.state === "failed" || this.status.state === "ready") return;
    const r = decodeSiblingFrame(message);
    if (r.kind === "error") {
      this.fail(`frame decode: ${r.reason}`);
      return;
    }
    await this.onFrame(r.frame);
  }

  private async onFrame(frame: SiblingFrame): Promise<void> {
    if (frame.type !== FRAME_SIBLING_HELLO) {
      // Pre-completion non-hello frames are protocol errors. Post-ready
      // they are handled by the higher-level dispatcher (not this state
      // machine).
      this.fail(`unexpected frame 0x${frame.type.toString(16)} before handshake`);
      return;
    }
    const hello = frame.payload;
    if (hello.serverId !== this.opts.peerServerId) {
      this.fail("peer serverId mismatch");
      return;
    }

    // Capture the peer's challenge on the first hello.
    if (!this.peerChallenge) {
      try {
        this.peerChallenge = hexToBytes(hello.challenge);
      } catch {
        this.fail("peer challenge not hex");
        return;
      }
      // We can now sign the peer's challenge and reply.
      if (!this.sentSignedHello) {
        this.sendHello(this.peerChallenge);
        this.sentSignedHello = true;
        this.status = { state: "awaiting-peer-signature" };
      }
    }

    // If THIS hello carries a signature, verify it.
    if (hello.challengeResponseSignature) {
      const verified = await this.verifyPeerSignature(hello);
      if (!verified) return; // fail() already called
      this.peerVerified = true;
    }

    if (this.peerVerified && this.sentSignedHello) {
      this.status = { state: "ready" };
      this.resolveReady();
    }
  }

  private async verifyPeerSignature(hello: SiblingHelloPayload): Promise<boolean> {
    if (!hello.challengeResponseSignature) {
      this.fail("hello missing challengeResponseSignature");
      return false;
    }
    let sig: Uint8Array;
    try {
      sig = hexToBytes(hello.challengeResponseSignature);
    } catch {
      this.fail("hello signature not hex");
      return false;
    }
    const peerPub = await this.opts.lookupPeerStk(hello.serverId);
    if (!peerPub) {
      this.fail("peer serverId not registered with .com");
      return false;
    }
    // The peer signs OUR challenge — the bytes they were authenticating
    // against, with their serverId in the "peer" slot.
    const challenge = siblingHelloChallenge({
      peerServerId: this.opts.peerServerId,
      myServerId: this.opts.myServerId,
      challengeHex: bytesToHex(this.myChallenge),
    });
    let ok: boolean;
    try {
      ok = ed.verify(sig, challenge, peerPub);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.fail("peer signature failed verification");
      return false;
    }
    return true;
  }

  private sendHello(peerChallenge: Uint8Array | undefined): void {
    let signature: string | undefined;
    if (peerChallenge) {
      const challenge = siblingHelloChallenge({
        peerServerId: this.opts.myServerId,
        myServerId: this.opts.peerServerId,
        challengeHex: bytesToHex(peerChallenge),
      });
      const sig = ed.sign(challenge, this.opts.myStk.privateKey);
      signature = bytesToHex(sig);
    }
    const payload: SiblingHelloPayload = {
      protocolVersion: 1,
      serverId: this.opts.myServerId,
      challenge: bytesToHex(this.myChallenge),
      challengeResponseSignature: signature,
      liveSiblings: this.opts.liveSiblings?.(),
    };
    this.opts.send({ type: FRAME_SIBLING_HELLO, payload });
  }

  private fail(reason: string): void {
    if (this.status.state === "failed") return;
    this.status = { state: "failed", reason };
    this.rejectReady(reason);
  }
}

function defaultRandom(): Uint8Array {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}

/**
 * Spin up an in-memory pair of handshakes for tests. Each side's
 * `send` is wired to feed the other's `ingest`. Returns once both
 * `ready()` promises resolve (success), or one rejects.
 */
export async function runHandshakePair(
  alice: SiblingHandshakeOptions,
  bob: SiblingHandshakeOptions,
): Promise<{ alice: SiblingHandshake; bob: SiblingHandshake }> {
  // Trampoline: send → encode → other.ingest. The Options' own send
  // closures are replaced with this trampoline.
  let aliceHs!: SiblingHandshake;
  let bobHs!: SiblingHandshake;
  const aliceOpts: SiblingHandshakeOptions = {
    ...alice,
    send: (frame) => {
      void bobHs.ingest(encodeSiblingFrame(frame));
    },
  };
  const bobOpts: SiblingHandshakeOptions = {
    ...bob,
    send: (frame) => {
      void aliceHs.ingest(encodeSiblingFrame(frame));
    },
  };
  aliceHs = new SiblingHandshake(aliceOpts);
  bobHs = new SiblingHandshake(bobOpts);
  aliceHs.start();
  bobHs.start();
  await Promise.all([aliceHs.ready(), bobHs.ready()]);
  return { alice: aliceHs, bob: bobHs };
}
