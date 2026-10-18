/**
 * A throwaway maintainer authority for the notice gym specs: a one-mandate
 * ca-track chain (whose hash is the TEST pin) and a signer for notices. The
 * page's own poller trusts only the baked pin, so a notice from this chain is
 * what a forged `.com` would serve: the specs hand the test pin to the page
 * where they need a notice to count, and leave it out where it must not.
 */

import { generateKeypair, mandatePinHash, signMandate, type Mandate } from "@ibisllc/maintainers";
import { signSecurityNotice, type SecurityNoticeBody } from "@flagship/protocol";

export const DAY = 24 * 3600_000;

export interface Authority {
  pin: string;
  mandate: Mandate;
  sign: (body: SecurityNoticeBody) => unknown;
  /** The document `GET /api/notices` answers with for a notice. */
  doc: (body: SecurityNoticeBody) => { version: 1; notice: unknown; mandates: Mandate[] };
}

export function authority(seedByte: number): Authority {
  const seed = new Uint8Array(32);
  seed[0] = seedByte;
  const kp = generateKeypair(seed);
  const unsigned: Omit<Mandate, "signatures"> = {
    kind: "Mandate",
    version: 1,
    mandateId: `ca${seedByte.toString(16).padStart(2, "0")}0000-0000-4000-8000-000000000000`,
    track: "ca",
    holder: kp.pubKey,
    issuedAt: new Date(Date.now() - 30 * DAY).toISOString(),
    expiresAt: new Date(Date.now() + 150 * DAY).toISOString(),
    successors: [kp.pubKey],
    approvalRule: { kind: "threshold", threshold: 1 },
    minSuccessors: 1,
    maxDurationSeconds: 365 * 86400,
    defaultDurationSeconds: 180 * 86400,
    signedBy: kp.pubKey,
  };
  const mandate = signMandate(unsigned, [{ privKey: kp.privKey }]);
  const sign = (body: SecurityNoticeBody) =>
    JSON.parse(
      JSON.stringify(
        signSecurityNotice(body, {
          publicKey: Uint8Array.from(Buffer.from(kp.pubKey, "hex")),
          privateKey: Uint8Array.from(Buffer.from(kp.privKey, "hex")),
        }),
      ),
    );
  return { pin: mandatePinHash(mandate), mandate, sign, doc: (b) => ({ version: 1, notice: sign(b), mandates: [mandate] }) };
}

const base = (): SecurityNoticeBody => {
  const now = Date.now();
  return {
    seq: 1,
    kind: "maintenance",
    validFrom: now - 60_000,
    validUntil: now + 3 * DAY,
    eventAt: now + 2 * DAY,
    lockFrom: 0,
    platforms: {},
    advisoryId: "",
    deprecatesProtocol: 0,
    reason: "",
    message: "We will update on {date}. flagshipserver.com may be briefly unavailable.",
  };
};

export const maintenanceBody = (over: Partial<SecurityNoticeBody> = {}): SecurityNoticeBody => ({ ...base(), ...over });

/** A lock for every webapp build there will ever be (minBuild far above any shell version). */
export const lockBody = (over: Partial<SecurityNoticeBody> = {}): SecurityNoticeBody => {
  const now = Date.now();
  return {
    ...base(),
    seq: 5,
    kind: "update-required",
    validUntil: now + 10 * DAY,
    eventAt: 0,
    lockFrom: now - 30_000,
    platforms: { web: { minBuild: 99_999, minProtocol: 0 } },
    advisoryId: "FSA-2026-001",
    reason: "A signing flaw lets an attacker act as you.",
    message: "You must update Flagship. Older versions have stopped working.",
    ...over,
  };
};
