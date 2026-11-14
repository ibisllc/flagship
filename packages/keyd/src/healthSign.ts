import { HYBRID_SIG_LEN, TAG_BOX_HEALTH } from "@flagship/protocol";

/** What `flagship-keyd sign-health` prints for the health timer (server-daemon healthReporter.ts). */
export interface BoxHealthSignatures {
  signature: string;
  /** The hybrid (STK + its ML-DSA-65 key) signature, when this keyd holds an ML-DSA key. */
  hybrid?: string;
}

interface Caller {
  call(op: "sign" | "sign.hybrid" | "pq.status", args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const PREFIX = new TextEncoder().encode(`${TAG_BOX_HEALTH}|`);
const HEX = /^[0-9a-f]+$/;

/**
 * Signs a tagged box health report (`flagship/box-health/v1|<report>`) with the STK, and with
 * its ML-DSA half when keyd has one, so a strict installation still takes the box's health
 * (`.com` serverHealth.ts gates it like the heartbeat). The timer runs this as root, outside the
 * daemon: a crash-looping daemon does not stop it, and it falls back to the boot key when keyd
 * itself is down.
 */
export async function signBoxHealth(keyd: Caller, tagged: Uint8Array): Promise<BoxHealthSignatures> {
  if (tagged.length <= PREFIX.length || !PREFIX.every((b, i) => tagged[i] === b)) {
    throw new Error("not a tagged box health report");
  }
  const msg = Buffer.from(tagged).toString("hex");
  const sig = String((await keyd.call("sign", { msg })).sig ?? "");
  if (sig.length !== 128 || !HEX.test(sig)) throw new Error("keyd gave no signature");
  const status = await keyd.call("pq.status", {}).catch(() => ({}) as Record<string, unknown>);
  if (typeof status.mldsaPublicKey !== "string") return { signature: sig };
  const hybrid = String((await keyd.call("sign.hybrid", { msg })).sig ?? "");
  if (hybrid.length !== HYBRID_SIG_LEN * 2 || !HEX.test(hybrid)) throw new Error("keyd gave no hybrid signature");
  return { signature: sig, hybrid };
}
