/**
 * The evidence an admin device puts on a change back to strict after a compatibility period
 * (assurancePolicy.ts `StrictReentryEvidence`, IMPLEMENTATION-PLAN.md §6.5, pq-suites.md §13.7).
 *
 * Each digest commits to what the signing device checked itself, at that moment, in a fixed
 * text form every client builds the same way (test-vectors/strict-reentry):
 *
 *   verifier-checks  every key binding it verified: the account's devices, the admin root, the
 *                    server's STK binding
 *   enrollment       the device set it found enrolled, which must be every device on the account
 *   rekey            the server's post-quantum key it re-verified and the fresh nonce of this
 *                    re-entry, after which every strict session to it starts from a new PQ key
 *                    exchange. Data at rest is NOT re-encrypted by this (Q08 is not built).
 *   recovery         that the account's recovery check passed, and when
 *
 * The box and `.com` require all four digests on a return to strict; they do not recompute them
 * (they cannot see the device's checks). The digests are signed inside the hybrid policy change,
 * so a device that lies about them is a device the owner already trusts with policy.
 */
import { sha256 } from "@noble/hashes/sha256";
import { hex } from "./canonicalBase.js";
import type { PolicyScope, StrictReentryEvidence } from "./assurancePolicy.js";

export const TAG_STRICT_REENTRY = "flagship/strict-reentry/v1";

export interface VerifiedBinding {
  role: string;
  subjectId: string;
  ed25519PubHex: string;
  mldsaPubHex: string;
}

export interface StrictReentryInputs {
  account: string;
  scope: PolicyScope;
  /** issuedAt of the compatibility change being left (the scope's head). */
  leftStrictAt: number;
  devices: VerifiedBinding[];
  /** Devices the account has, bound or not. */
  deviceCount: number;
  adminRoot: VerifiedBinding | null;
  server: VerifiedBinding;
  recoveryChecked: boolean;
  recoveryCheckedAt: number | null;
  /** 32 random bytes, hex, fresh for this re-entry. */
  nonceHex: string;
  checkedAt: number;
}

export class StrictReentryError extends Error {
  constructor(
    readonly code: "devices-not-enrolled" | "recovery-not-checked" | "bad-input",
    message: string,
  ) {
    super(message);
  }
}

const HEX = /^[0-9a-f]+$/;
const TOKEN = /^[A-Za-z0-9._:@-]{1,256}$/;

function line(b: VerifiedBinding): string {
  for (const v of [b.role, b.subjectId]) if (!TOKEN.test(v)) throw new StrictReentryError("bad-input", "strict-reentry: bad binding field");
  for (const v of [b.ed25519PubHex, b.mldsaPubHex]) if (!HEX.test(v)) throw new StrictReentryError("bad-input", "strict-reentry: binding keys must be lowercase hex");
  return `${b.role}:${b.subjectId}:${b.ed25519PubHex}:${b.mldsaPubHex}`;
}

/** The four canonical texts, in order; exposed for the vectors. */
export function strictReentryTexts(i: StrictReentryInputs): [string, string, string, string] {
  if (!TOKEN.test(i.account) || !TOKEN.test(i.scope.id) || !TOKEN.test(i.scope.kind)) throw new StrictReentryError("bad-input", "strict-reentry: bad account or scope");
  if (!/^[0-9a-f]{64}$/.test(i.nonceHex)) throw new StrictReentryError("bad-input", "strict-reentry: the nonce must be 32 bytes of hex");
  for (const n of [i.leftStrictAt, i.checkedAt, i.deviceCount]) if (!Number.isSafeInteger(n) || n < 0) throw new StrictReentryError("bad-input", "strict-reentry: bad number");
  if (i.devices.length !== i.deviceCount || i.deviceCount === 0) {
    throw new StrictReentryError("devices-not-enrolled", "every device on the account needs its post-quantum key before strict comes back");
  }
  if (!i.recoveryChecked || i.recoveryCheckedAt === null || !Number.isSafeInteger(i.recoveryCheckedAt)) {
    throw new StrictReentryError("recovery-not-checked", "test your recovery before turning strict on again");
  }
  const head = `${TAG_STRICT_REENTRY}|${i.account}|${i.scope.kind}|${i.scope.id}|${i.leftStrictAt}`;
  const devices = i.devices.map(line).sort();
  const all = [...devices, ...(i.adminRoot ? [line(i.adminRoot)] : []), line(i.server)].sort();
  return [
    `${head}|verifier-checks|${all.join(",")}|${i.checkedAt}`,
    `${head}|enrollment|${i.deviceCount}|${devices.join(",")}`,
    `${head}|rekey|${line(i.server)}|${i.nonceHex}|${i.checkedAt}`,
    `${head}|recovery|checked|${i.recoveryCheckedAt}`,
  ];
}

export function strictReentryEvidence(i: StrictReentryInputs): StrictReentryEvidence {
  const d = (s: string) => hex(sha256(new TextEncoder().encode(s)));
  const [v, e, r, c] = strictReentryTexts(i);
  return { verifierChecksDigest: d(v), enrollmentDigest: d(e), rekeyReceiptDigest: d(r), recoveryTestDigest: d(c) };
}
