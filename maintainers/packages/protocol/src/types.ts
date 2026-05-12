/**
 * Maintainers protocol v1 — type definitions.
 *
 * All envelopes are signed by Ed25519. Pubkeys and signatures are
 * hex-encoded strings; canonical-bytes derivations validate that no
 * field contains the separator character `|` or any control byte.
 */

export type Hex = string;
export type Iso8601 = string;
export type Uuid = string;
export type Pubkey = Hex;
export type Signature = Hex;

export interface SignatureEntry {
  pubkey: Pubkey;
  sig: Signature;
}

/** Approval rule controlling who must sign for a mandate or endorsement to be valid. */
export type ApprovalRule =
  | { kind: "threshold"; threshold: number; of: "anyAuthorizedSigner" }
  | { kind: "threshold"; threshold: number; of: Pubkey[] };

export interface TrackPolicy {
  track: string;
  description?: string;
  defaultMandateDuration: string;
  approvalRule: ApprovalRule;
}

export interface RootPolicy {
  schemaVersion: 1;
  project: {
    name: string;
    homepage?: string;
    contact?: string;
  };
  tracks: string[];
}

export interface Mandate {
  kind: "Mandate";
  version: 1;
  mandateId: Uuid;
  track: string;
  holder: Pubkey;
  issuedAt: Iso8601;
  expiresAt: Iso8601;
  successors: Pubkey[];
  signedBy: Pubkey;
  signatures: SignatureEntry[];
}

export interface EmailHistoryEntry {
  email: string;
  from: Iso8601;
  to: Iso8601 | null;
}

export interface KeyMetadata {
  photo?: string | null;
  github?: string | null;
  role?: string | null;
}

export interface KeyFile {
  kind: "KeyFile";
  version: 1;
  pubkey: Pubkey;
  displayName: string;
  currentEmail: string;
  emailHistory: EmailHistoryEntry[];
  metadata: KeyMetadata;
  introductionMandate: Uuid;
  signature: Signature;
}

export interface KeyRedirect {
  kind: "KeyRedirect";
  version: 1;
  fromEmail: string;
  renamedTo: string;
  renamedAt: Iso8601;
  pubkey: Pubkey;
  signature: Signature;
}

export interface EmailRotation {
  kind: "EmailRotation";
  version: 1;
  pubkey: Pubkey;
  fromEmail: string;
  toEmail: string;
  rotatedAt: Iso8601;
  signature: Signature;
}

export interface KeyIntroductionRequest {
  kind: "KeyIntroductionRequest";
  version: 1;
  pubkey: Pubkey;
  displayName: string;
  currentEmail: string;
  metadata: KeyMetadata;
  requestedAt: Iso8601;
  signature: Signature;
}

export interface ReleaseEndorsement {
  kind: "ReleaseEndorsement";
  version: 1;
  releaseId: Uuid;
  semverTag: string;
  commitHash: Hex;
  previousReleaseId: Uuid | null;
  previousCommitHash: Hex | null;
  intermediateCommits: Hex[];
  intermediateMerkleRoot: Hex;
  endorsedNotes: string | null;
  issuedAt: Iso8601;
  signedBy: Pubkey;
  signatures: SignatureEntry[];
}

export type Envelope =
  | Mandate
  | KeyFile
  | KeyRedirect
  | EmailRotation
  | KeyIntroductionRequest
  | ReleaseEndorsement;

/** Derived from observation; not signed. */
export interface TakeoverAlarm {
  kind: "TakeoverAlarm";
  project: string;
  track: string;
  previousMandate: Uuid;
  newMandate: Uuid;
  previousHolder: { displayName: string; email: string; pubkey: Pubkey };
  newHolder: { displayName: string; email: string; pubkey: Pubkey };
  detectedAt: Iso8601;
}
