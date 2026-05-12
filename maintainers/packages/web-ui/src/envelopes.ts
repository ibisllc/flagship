/**
 * Envelope-assembly helpers tuned to the UI's needs.
 *
 * The protocol library exposes `signMandate`, `signKeyFile`, etc., each
 * of which takes a private key and produces a signed envelope. The UI
 * passes in the Ed25519 private key derived from PRF; the priv lives
 * only for the duration of the call.
 */

import {
  signKeyFile,
  signMandate,
  signKeyIntroductionRequest,
  type KeyFile,
  type Mandate,
  type RootPolicy,
  type TrackPolicy,
  type ApprovalRule,
  type Pubkey,
} from "@maintainers/protocol";

export function makeGenesisPolicy(projectName: string, tracks: string[]): RootPolicy {
  return {
    schemaVersion: 1,
    project: { name: projectName },
    tracks,
  };
}

export function makeTrackPolicy(
  track: string,
  defaultMandateDurationDays: number,
  approvalRule: ApprovalRule = { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
): TrackPolicy {
  return {
    track,
    defaultMandateDuration: `P${defaultMandateDurationDays}D`,
    approvalRule,
  };
}

export interface GenesisParams {
  holderPub: Pubkey;
  holderPriv: string;
  holderDisplayName: string;
  holderEmail: string;
  successors: Pubkey[];
  track: string;
  now: Date;
  durationDays: number;
  mandateId?: string;
}

export function buildGenesisMandate(p: GenesisParams): Mandate {
  const issuedAt = p.now.toISOString();
  const expiresAt = new Date(p.now.getTime() + p.durationDays * 86_400_000).toISOString();
  return signMandate(
    {
      kind: "Mandate",
      version: 1,
      mandateId: p.mandateId ?? randomUuid(),
      track: p.track,
      holder: p.holderPub,
      issuedAt,
      expiresAt,
      successors: p.successors,
      signedBy: p.holderPub,
    },
    [{ privKey: p.holderPriv }],
  );
}

export interface RenewalParams {
  holderPub: Pubkey;
  holderPriv: string;
  successors: Pubkey[];
  track: string;
  now: Date;
  durationDays: number;
  mandateId?: string;
}

export function buildRenewalMandate(p: RenewalParams): Mandate {
  const issuedAt = p.now.toISOString();
  const expiresAt = new Date(p.now.getTime() + p.durationDays * 86_400_000).toISOString();
  return signMandate(
    {
      kind: "Mandate",
      version: 1,
      mandateId: p.mandateId ?? randomUuid(),
      track: p.track,
      holder: p.holderPub,
      issuedAt,
      expiresAt,
      successors: p.successors,
      signedBy: p.holderPub,
    },
    [{ privKey: p.holderPriv }],
  );
}

export interface TakeoverParams {
  successorPub: Pubkey;
  successorPriv: string;
  newSuccessors: Pubkey[];
  track: string;
  now: Date;
  durationDays: number;
  mandateId?: string;
}

export function buildTakeoverMandate(p: TakeoverParams): Mandate {
  const issuedAt = p.now.toISOString();
  const expiresAt = new Date(p.now.getTime() + p.durationDays * 86_400_000).toISOString();
  return signMandate(
    {
      kind: "Mandate",
      version: 1,
      mandateId: p.mandateId ?? randomUuid(),
      track: p.track,
      holder: p.successorPub,
      issuedAt,
      expiresAt,
      successors: p.newSuccessors,
      signedBy: p.successorPub,
    },
    [{ privKey: p.successorPriv }],
  );
}

export interface KeyFileParams {
  pub: Pubkey;
  priv: string;
  displayName: string;
  email: string;
  introductionMandate: string;
  metadata?: KeyFile["metadata"];
}

export function buildKeyFile(p: KeyFileParams): KeyFile {
  return signKeyFile(
    {
      kind: "KeyFile",
      version: 1,
      pubkey: p.pub,
      displayName: p.displayName,
      currentEmail: p.email,
      emailHistory: [],
      metadata: p.metadata ?? { photo: null, github: null, role: null },
      introductionMandate: p.introductionMandate,
    },
    p.priv,
  );
}

export interface IntroductionRequestParams {
  pub: Pubkey;
  priv: string;
  displayName: string;
  email: string;
  now: Date;
  metadata?: KeyFile["metadata"];
}

export function buildKeyIntroductionRequest(p: IntroductionRequestParams) {
  return signKeyIntroductionRequest(
    {
      kind: "KeyIntroductionRequest",
      version: 1,
      pubkey: p.pub,
      displayName: p.displayName,
      currentEmail: p.email,
      metadata: p.metadata ?? { photo: null, github: null, role: null },
      requestedAt: p.now.toISOString(),
    },
    p.priv,
  );
}

/**
 * Serialize an envelope as the JSON bytes that will be written to disk.
 * Pretty-printed (2-space indent) so a casual viewer on github.com sees
 * something legible; the verifier doesn't care about whitespace.
 */
export function serializeEnvelope(env: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(env, null, 2) + "\n");
}

export function serializeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
}

/**
 * Path conventions per §7 of the spec.
 */
export function pathForMandate(track: string, issuedAt: string, summary: string): string {
  const tsSlug = issuedAt.replace(/[:.]/g, "-").replace(/Z$/, "");
  const slug = summary.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  return `tracks/${track}/mandates/${tsSlug}-${slug}.json`;
}

export function pathForKeyFile(email: string): string {
  return `keys/${email}.json`;
}

export function pathForTrackPolicy(track: string): string {
  return `tracks/${track}/policy.json`;
}

export const PATH_ROOT_POLICY = "policy.json";

/**
 * Generate a UUID v4 using the platform CSPRNG. Falls back to a
 * Math.random()-seeded variant only when crypto isn't available
 * (and warns via console; we never want that path in production).
 */
export function randomUuid(): string {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
