/**
 * Wake the owner's phone when a build needs them (an AI chat paused on a
 * question or an env var, an IDE build asking for an env var). The push is
 * content-free: category `generic` and an opaque marker body, so neither
 * `.com` nor Apple/Google learn that a build is waiting, which build, or what
 * it asks. The phone opens Flagship, and the app's own long-poll of the box
 * (GET /api/phone/alerts) shows what's waiting.
 */
import type { BoxSigner } from "./keyCustodian.js";
import { sendPushRelay, type SendPushRelayOptions } from "./relaySos.js";

export interface OwnerWakeOptions {
  /** The owner account, read at call time (null before the box is paired). */
  owner: () => string | null;
  signer: BoxSigner;
  controlPlaneBaseUrl: string | undefined;
  /** At most one wake per this many ms (default 60 s): a chat asking twice in a row wakes once. */
  minIntervalMs?: number;
  now?: () => number;
  send?: (opts: SendPushRelayOptions) => Promise<boolean>;
  log?: (line: string) => void;
}

export function buildOwnerWake(opts: OwnerWakeOptions): () => Promise<boolean> {
  const now = opts.now ?? Date.now;
  const minInterval = opts.minIntervalMs ?? 60_000;
  const send = opts.send ?? sendPushRelay;
  let last = -Infinity;
  return async () => {
    const owner = opts.owner();
    if (!owner || !opts.controlPlaneBaseUrl) return false;
    const t = now();
    if (t - last < minInterval) return false;
    last = t;
    return send({
      category: "generic",
      targetUsername: owner,
      signer: opts.signer,
      controlPlaneBaseUrl: opts.controlPlaneBaseUrl,
      logTag: "[build] owner wake push",
      ...(opts.log ? { log: opts.log } : {}),
    });
  };
}
