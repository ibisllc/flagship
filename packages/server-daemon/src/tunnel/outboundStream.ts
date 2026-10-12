import { Duplex } from "node:stream";
import {
  closeFrame,
  dataFrame,
  OUTBOUND_INITIAL_WINDOW,
  OUTBOUND_MAX_CHUNK,
  outboundCreditFrame,
  type Frame,
  type OutboundRefusal,
} from "@flagship/tunnel-protocol";

/**
 * Why an outbound relay stream couldn't be used. `message` is owner-facing:
 * it reaches the AI-call error the apps show, so it names the destination
 * host at most and never anything from the request.
 */
export type RelayErrorCode =
  | "unavailable"
  | "refused"
  | "lost"
  | "timeout"
  | "unsupported"
  | "tls";

export const RELAY_UNAVAILABLE_MESSAGE =
  "the Flagship relay isn't reachable, so the AI call wasn't sent";

export class RelayError extends Error {
  constructor(
    public readonly code: RelayErrorCode,
    message: string,
    public readonly refusal?: OutboundRefusal,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export function relayUnavailable(): RelayError {
  return new RelayError("unavailable", RELAY_UNAVAILABLE_MESSAGE);
}

export function relayRefused(host: string, reason: OutboundRefusal): RelayError {
  const why: Record<OutboundRefusal, string> = {
    "bad-request": "it couldn't read the request",
    "forbidden-port": "it only carries port 443",
    "forbidden-host": "it only carries public host names",
    "forbidden-address": "the name points at a private address (turn the relay off for this key to reach a local server)",
    "dns-failed": "the name didn't resolve",
    "connect-failed": "the provider didn't answer",
    "too-many-streams": "this server has too many AI calls open",
    "rate-limited": "this server is opening AI calls too fast",
    "duplicate-stream": "of an internal error",
    disabled: "the relay is switched off",
  };
  return new RelayError(
    "refused",
    `the Flagship relay didn't connect to ${host} because ${why[reason]}, so the AI call wasn't sent`,
    reason,
  );
}

/**
 * The box end of one outbound stream: a Duplex whose writes become DATA
 * frames within the hub's credit, and whose reads are the hub's DATA. Credit
 * goes back to the hub only as the consumer drains what it has, so a slow
 * reader slows the provider instead of growing this process's memory.
 */
export class OutboundStream extends Duplex {
  private sendCredit = OUTBOUND_INITIAL_WINDOW;
  private recvOutstanding = 0;
  private opened = false;
  private remoteClosed = false;
  private closeSent = false;
  private pending: { buf: Buffer; cb: (err?: Error | null) => void } | null = null;

  constructor(
    readonly streamId: number,
    private readonly sendFrame: (f: Frame) => void,
    private readonly onDone: () => void,
  ) {
    super({ allowHalfOpen: false });
  }

  /** The hub accepted the open. */
  markOpen(): void {
    this.opened = true;
    this.flushPending();
  }

  /** Hub DATA. Returns false if the hub overran its window (stream destroyed). */
  receive(payload: Uint8Array): boolean {
    if (this.destroyed || this.remoteClosed) return true;
    if (this.recvOutstanding + payload.length > OUTBOUND_INITIAL_WINDOW) {
      this.destroy(new RelayError("lost", "the Flagship relay broke flow control"));
      return false;
    }
    this.recvOutstanding += payload.length;
    if (this.push(Buffer.from(payload))) this.maybeGrant(false);
    return true;
  }

  addCredit(n: number): void {
    this.sendCredit = Math.min(this.sendCredit + n, OUTBOUND_INITIAL_WINDOW * 4);
    this.flushPending();
  }

  /** Hub CLOSE_REMOTE: the upstream is gone, after all its data. */
  remoteClose(): void {
    if (this.remoteClosed) return;
    this.remoteClosed = true;
    this.closeSent = true; // the hub has already forgotten this stream
    this.push(null);
    if (this.pending) {
      const { cb } = this.pending;
      this.pending = null;
      cb();
    }
    this.onDone();
  }

  /** The hub refused the open and already forgot the stream. */
  abandon(): void {
    this.closeSent = true;
    this.destroy();
  }

  /** The tunnel dropped. */
  lost(): void {
    this.closeSent = true;
    this.destroy(new RelayError("lost", "the connection to the Flagship relay dropped during the AI call"));
  }

  override _read(): void {
    this.maybeGrant(true);
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.remoteClosed) return cb();
    this.pending = { buf: chunk, cb };
    this.flushPending();
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.sendClose();
    cb();
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.sendClose();
    this.onDone();
    cb(err);
  }

  private sendClose(): void {
    if (this.closeSent) return;
    this.closeSent = true;
    this.sendFrame(closeFrame(this.streamId, false));
  }

  private flushPending(): void {
    const p = this.pending;
    if (!p || !this.opened || this.destroyed) return;
    let buf = p.buf;
    while (buf.length > 0 && this.sendCredit > 0) {
      const n = Math.min(buf.length, this.sendCredit, OUTBOUND_MAX_CHUNK);
      const piece = buf.subarray(0, n);
      this.sendFrame(dataFrame(this.streamId, new Uint8Array(piece.buffer, piece.byteOffset, n)));
      this.sendCredit -= n;
      buf = buf.subarray(n);
    }
    if (buf.length > 0) {
      p.buf = buf;
      return;
    }
    this.pending = null;
    p.cb();
  }

  /**
   * Grant credit in batches: once a quarter window has been consumed, or
   * whenever the reader asks for more. A hub that is out of credit always has
   * a full window outstanding here, so the threshold can't deadlock.
   */
  private maybeGrant(force: boolean): void {
    if (this.recvOutstanding === 0 || this.closeSent) return;
    if (!force && this.recvOutstanding < OUTBOUND_INITIAL_WINDOW / 4) return;
    const n = this.recvOutstanding;
    this.recvOutstanding = 0;
    this.sendFrame(outboundCreditFrame(this.streamId, n));
  }
}
