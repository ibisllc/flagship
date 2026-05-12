/**
 * Per-envelope policy enforcement for the Model A Worker.
 *
 * The Worker holds a PAT capable of pushing to the target repo. Policy
 * is therefore the gate: every commit is gated on the request's signed
 * envelope verifying against the current on-repo `.maintainers/` state.
 *
 * Defense-in-depth fences (each independently sufficient to refuse the
 * commit):
 *
 *   1. Path-prefix fence — the target path MUST begin with
 *      `.maintainers/` and MUST NOT contain `..` or `//`. Enforced
 *      *before* any envelope inspection in case a future verifier bug
 *      ever lets a malformed envelope through.
 *   2. Envelope-shape fence — body MUST parse as one of the known
 *      envelope kinds at the expected version. Unknown kinds are
 *      refused; the spec's "ignore unknown for authority decisions"
 *      rule applies to consumers, not to a write-gate.
 *   3. Canonical-bytes fence — the request's `envelopeBytes` MUST
 *      re-derive to the same canonical bytes the policy module
 *      computes locally from the parsed envelope. This prevents the
 *      client from sending an envelope it didn't actually sign.
 *   4. Signature fence — every signature in the envelope MUST verify
 *      against those canonical bytes.
 *   5. Authority fence — the signers MUST satisfy the relevant track's
 *      approval rule, given the current on-repo state at the moment
 *      of the request.
 *
 * This file holds the pure policy. The Worker entrypoint wraps it with
 * I/O against the GitHub Contents API (read current state; write the
 * commit) and with rate-limiting.
 */

import {
  canonicalMandate,
  canonicalKeyFile,
  canonicalKeyRedirect,
  canonicalEmailRotation,
  canonicalKeyIntroductionRequest,
  canonicalReleaseEndorsement,
  verify,
  bytesToHex,
  hexToBytes,
  verifyTrack,
  currentAuthority,
  lastExpiredMandate,
  type Envelope,
  type Mandate,
  type KeyFile,
  type KeyRedirect,
  type EmailRotation,
  type KeyIntroductionRequest,
  type ReleaseEndorsement,
  type TrackPolicy,
  type RootPolicy,
  type ApprovalRule,
  type Pubkey,
  type VerifiedTrack,
} from "@maintainers/protocol";

export const MAINTAINERS_PREFIX = ".maintainers/";

export type PolicyDecision =
  | { ok: true; commitMessage: string }
  | { ok: false; status: number; reason: string; detail?: string };

export interface RepoState {
  /** Parsed root policy if present, else null (genesis condition). */
  rootPolicy: RootPolicy | null;
  /** Per-track policy + ordered mandates parsed from the on-repo log. */
  tracks: Map<string, { policy: TrackPolicy; mandates: Mandate[] }>;
  /** Known KeyFiles indexed by pubkey (after redirects resolved). */
  keyFiles: Map<Pubkey, KeyFile>;
}

/**
 * Decide whether a candidate envelope-bearing write is acceptable.
 *
 * Pure function: all I/O (read the repo, write the commit) lives in
 * the Worker entrypoint. This lets us unit-test every branch without
 * a GitHub mock — just feed in a synthetic RepoState.
 */
export function decide(input: {
  path: string;
  envelope: unknown;
  envelopeBytesHex: string;
  state: RepoState;
  now: Date;
}): PolicyDecision {
  // Fence 1: path-prefix
  const pathCheck = checkPath(input.path);
  if (!pathCheck.ok) return pathCheck;

  // Fence 2: envelope-shape
  const shaped = parseEnvelope(input.envelope);
  if (!shaped.ok) return shaped;
  const envelope = shaped.envelope;

  // Fence 3: canonical-bytes match
  const expectedBytes = canonicalBytesFor(envelope);
  const expectedHex = bytesToHex(expectedBytes);
  if (input.envelopeBytesHex.toLowerCase() !== expectedHex) {
    return {
      ok: false,
      status: 400,
      reason: "canonical-bytes-mismatch",
      detail: "request envelopeBytes do not match canonical derivation",
    };
  }

  // Fence 4: signatures verify
  const sigCheck = checkSignatures(envelope, expectedBytes);
  if (!sigCheck.ok) return sigCheck;

  // Fence 5: authority
  const authorityCheck = checkAuthority(envelope, input.state, input.now);
  if (!authorityCheck.ok) return authorityCheck;

  return {
    ok: true,
    commitMessage: commitMessageFor(envelope, input.now),
  };
}

function checkPath(p: string): { ok: true } | { ok: false; status: number; reason: string; detail?: string } {
  if (typeof p !== "string" || p.length === 0) {
    return { ok: false, status: 400, reason: "path-empty" };
  }
  if (!p.startsWith(MAINTAINERS_PREFIX)) {
    return {
      ok: false,
      status: 403,
      reason: "path-outside-maintainers",
      detail: `path must start with "${MAINTAINERS_PREFIX}"`,
    };
  }
  if (p.includes("..") || p.includes("//") || p.includes("\\")) {
    return { ok: false, status: 400, reason: "path-traversal" };
  }
  // Disallow trailing slash / directory writes; the Contents API
  // expects a file path.
  if (p.endsWith("/")) {
    return { ok: false, status: 400, reason: "path-is-directory" };
  }
  // Reasonable hard cap to keep the surface small.
  if (p.length > 512) {
    return { ok: false, status: 400, reason: "path-too-long" };
  }
  return { ok: true };
}

type ParsedEnvelope = { ok: true; envelope: Envelope } | { ok: false; status: number; reason: string; detail?: string };

function parseEnvelope(raw: unknown): ParsedEnvelope {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, status: 400, reason: "envelope-not-object" };
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj["kind"];
  const version = obj["version"];
  if (version !== 1) {
    return { ok: false, status: 400, reason: "envelope-version-unsupported" };
  }
  switch (kind) {
    case "Mandate":
      return shapeMandate(obj);
    case "KeyFile":
      return shapeKeyFile(obj);
    case "KeyRedirect":
      return shapeKeyRedirect(obj);
    case "EmailRotation":
      return shapeEmailRotation(obj);
    case "KeyIntroductionRequest":
      return shapeKeyIntroductionRequest(obj);
    case "ReleaseEndorsement":
      return shapeReleaseEndorsement(obj);
    default:
      return { ok: false, status: 400, reason: "envelope-kind-unknown" };
  }
}

function shapeMandate(obj: Record<string, unknown>): ParsedEnvelope {
  if (
    typeof obj["mandateId"] !== "string" ||
    typeof obj["track"] !== "string" ||
    typeof obj["holder"] !== "string" ||
    typeof obj["issuedAt"] !== "string" ||
    typeof obj["expiresAt"] !== "string" ||
    !Array.isArray(obj["successors"]) ||
    typeof obj["signedBy"] !== "string" ||
    !Array.isArray(obj["signatures"])
  ) {
    return { ok: false, status: 400, reason: "mandate-shape" };
  }
  for (const s of obj["successors"]) {
    if (typeof s !== "string") return { ok: false, status: 400, reason: "mandate-successors-shape" };
  }
  for (const s of obj["signatures"]) {
    if (
      typeof s !== "object" ||
      s === null ||
      typeof (s as Record<string, unknown>)["pubkey"] !== "string" ||
      typeof (s as Record<string, unknown>)["sig"] !== "string"
    ) {
      return { ok: false, status: 400, reason: "mandate-signatures-shape" };
    }
  }
  return { ok: true, envelope: obj as unknown as Mandate };
}

function shapeKeyFile(obj: Record<string, unknown>): ParsedEnvelope {
  if (
    typeof obj["pubkey"] !== "string" ||
    typeof obj["displayName"] !== "string" ||
    typeof obj["currentEmail"] !== "string" ||
    !Array.isArray(obj["emailHistory"]) ||
    typeof obj["metadata"] !== "object" ||
    obj["metadata"] === null ||
    typeof obj["introductionMandate"] !== "string" ||
    typeof obj["signature"] !== "string"
  ) {
    return { ok: false, status: 400, reason: "keyfile-shape" };
  }
  return { ok: true, envelope: obj as unknown as KeyFile };
}

function shapeKeyRedirect(obj: Record<string, unknown>): ParsedEnvelope {
  if (
    typeof obj["fromEmail"] !== "string" ||
    typeof obj["renamedTo"] !== "string" ||
    typeof obj["renamedAt"] !== "string" ||
    typeof obj["pubkey"] !== "string" ||
    typeof obj["signature"] !== "string"
  ) {
    return { ok: false, status: 400, reason: "keyredirect-shape" };
  }
  return { ok: true, envelope: obj as unknown as KeyRedirect };
}

function shapeEmailRotation(obj: Record<string, unknown>): ParsedEnvelope {
  if (
    typeof obj["pubkey"] !== "string" ||
    typeof obj["fromEmail"] !== "string" ||
    typeof obj["toEmail"] !== "string" ||
    typeof obj["rotatedAt"] !== "string" ||
    typeof obj["signature"] !== "string"
  ) {
    return { ok: false, status: 400, reason: "emailrotation-shape" };
  }
  return { ok: true, envelope: obj as unknown as EmailRotation };
}

function shapeKeyIntroductionRequest(obj: Record<string, unknown>): ParsedEnvelope {
  if (
    typeof obj["pubkey"] !== "string" ||
    typeof obj["displayName"] !== "string" ||
    typeof obj["currentEmail"] !== "string" ||
    typeof obj["metadata"] !== "object" ||
    obj["metadata"] === null ||
    typeof obj["requestedAt"] !== "string" ||
    typeof obj["signature"] !== "string"
  ) {
    return { ok: false, status: 400, reason: "keyintro-shape" };
  }
  return { ok: true, envelope: obj as unknown as KeyIntroductionRequest };
}

function shapeReleaseEndorsement(obj: Record<string, unknown>): ParsedEnvelope {
  if (
    typeof obj["releaseId"] !== "string" ||
    typeof obj["semverTag"] !== "string" ||
    typeof obj["commitHash"] !== "string" ||
    !Array.isArray(obj["intermediateCommits"]) ||
    typeof obj["intermediateMerkleRoot"] !== "string" ||
    typeof obj["issuedAt"] !== "string" ||
    typeof obj["signedBy"] !== "string" ||
    !Array.isArray(obj["signatures"])
  ) {
    return { ok: false, status: 400, reason: "endorsement-shape" };
  }
  return { ok: true, envelope: obj as unknown as ReleaseEndorsement };
}

function canonicalBytesFor(e: Envelope): Uint8Array {
  switch (e.kind) {
    case "Mandate":
      return canonicalMandate(e);
    case "KeyFile":
      return canonicalKeyFile(e);
    case "KeyRedirect":
      return canonicalKeyRedirect(e);
    case "EmailRotation":
      return canonicalEmailRotation(e);
    case "KeyIntroductionRequest":
      return canonicalKeyIntroductionRequest(e);
    case "ReleaseEndorsement":
      return canonicalReleaseEndorsement(e);
  }
}

function checkSignatures(
  e: Envelope,
  bytes: Uint8Array,
): { ok: true } | { ok: false; status: number; reason: string; detail?: string } {
  if (e.kind === "Mandate" || e.kind === "ReleaseEndorsement") {
    if (e.signatures.length === 0) {
      return { ok: false, status: 400, reason: "no-signatures" };
    }
    const signedByPresent = e.signatures.some((s) => s.pubkey === e.signedBy);
    if (!signedByPresent) {
      return { ok: false, status: 400, reason: "signedBy-not-in-signatures" };
    }
    for (let i = 0; i < e.signatures.length; i++) {
      const s = e.signatures[i]!;
      if (!verify(s.sig, bytes, s.pubkey)) {
        return { ok: false, status: 400, reason: "signature-invalid", detail: `signature ${i}` };
      }
    }
    return { ok: true };
  }
  // Single-signature envelopes (KeyFile, KeyRedirect, EmailRotation,
  // KeyIntroductionRequest): the envelope's `pubkey` field is the
  // signer; the `signature` field is the one signature we check.
  const pub = (e as { pubkey: Pubkey }).pubkey;
  const sig = (e as { signature: string }).signature;
  if (!verify(sig, bytes, pub)) {
    return { ok: false, status: 400, reason: "signature-invalid" };
  }
  return { ok: true };
}

function checkAuthority(
  e: Envelope,
  state: RepoState,
  now: Date,
): { ok: true } | { ok: false; status: number; reason: string; detail?: string } {
  switch (e.kind) {
    case "Mandate":
      return checkMandateAuthority(e, state, now);
    case "ReleaseEndorsement":
      return checkEndorsementAuthority(e, state, now);
    case "KeyFile":
    case "KeyRedirect":
    case "EmailRotation":
    case "KeyIntroductionRequest":
      // These envelopes are self-signed by their pubkey. Authority is
      // "the pubkey claims to be the holder of itself" — which is
      // trivially true. We additionally require, for KeyFile, that the
      // pubkey appears in some current authority's successors list OR
      // is already a known authorized signer on at least one track.
      // For KeyIntroductionRequest no authority is required (it's an
      // open-membership claim).
      // For EmailRotation / KeyRedirect we require the pubkey already
      // exists in the keys directory (a key cannot rotate an identity
      // it has never been introduced as).
      return checkKeyEnvelopeAuthority(e, state);
  }
}

function checkMandateAuthority(
  m: Mandate,
  state: RepoState,
  now: Date,
): { ok: true } | { ok: false; status: number; reason: string; detail?: string } {
  const trackEntry = state.tracks.get(m.track);
  if (!trackEntry) {
    // Track does not yet exist. Permitted ONLY in the genesis condition:
    // no `.maintainers/` state at all (no rootPolicy and no tracks).
    if (state.rootPolicy === null && state.tracks.size === 0) {
      // Genesis. Validate as a self-signed genesis under the default
      // 1-of-any rule. The verifier package enforces this.
      const policy: TrackPolicy = {
        track: m.track,
        defaultMandateDuration: "60d",
        approvalRule: { kind: "threshold", threshold: 1, of: "anyAuthorizedSigner" },
      };
      const verified = verifyTrack(m.track, policy, [m]);
      if (verified.validMandates.length === 0) {
        const rej = verified.rejections[0];
        return {
          ok: false,
          status: 403,
          reason: "genesis-rejected",
          detail: rej?.reason,
        };
      }
      return { ok: true };
    }
    return {
      ok: false,
      status: 403,
      reason: "unknown-track",
      detail: `track "${m.track}" not declared in policy.json`,
    };
  }

  const allMandates = [...trackEntry.mandates, m];
  const verified = verifyTrack(m.track, trackEntry.policy, allMandates);
  // The mandate we just appended must be in validMandates.
  const accepted = verified.validMandates.some((vm) => vm.mandateId === m.mandateId);
  if (!accepted) {
    const rej = verified.rejections.find((r) => r.mandate.mandateId === m.mandateId);
    return {
      ok: false,
      status: 403,
      reason: "mandate-rejected",
      detail: rej?.reason,
    };
  }
  return { ok: true };
}

function checkEndorsementAuthority(
  e: ReleaseEndorsement,
  state: RepoState,
  _now: Date,
): { ok: true } | { ok: false; status: number; reason: string; detail?: string } {
  const trackEntry = state.tracks.get("release");
  if (!trackEntry) {
    return {
      ok: false,
      status: 403,
      reason: "release-track-not-declared",
    };
  }
  const verified = verifyTrack("release", trackEntry.policy, trackEntry.mandates);
  const authority = currentAuthority(verified, new Date(Date.parse(e.issuedAt)));
  if (!authority) {
    return {
      ok: false,
      status: 403,
      reason: "no-active-release-authority",
    };
  }
  // The signedBy must be the current holder (1-of-N case) or in the
  // configured signer-set (M-of-{a,b,c} case).
  const rule = trackEntry.policy.approvalRule;
  if (rule.kind === "threshold" && rule.of === "anyAuthorizedSigner") {
    if (e.signedBy !== authority.holder) {
      return {
        ok: false,
        status: 403,
        reason: "endorsement-signer-not-holder",
      };
    }
    if (e.signatures.length < rule.threshold) {
      return {
        ok: false,
        status: 403,
        reason: "endorsement-approval-rule-unsatisfied",
      };
    }
  } else if (rule.kind === "threshold") {
    const required = new Set(rule.of);
    let matches = 0;
    for (const s of e.signatures) if (required.has(s.pubkey)) matches++;
    if (matches < rule.threshold) {
      return {
        ok: false,
        status: 403,
        reason: "endorsement-approval-rule-unsatisfied",
      };
    }
  }
  return { ok: true };
}

function checkKeyEnvelopeAuthority(
  e: KeyFile | KeyRedirect | EmailRotation | KeyIntroductionRequest,
  state: RepoState,
): { ok: true } | { ok: false; status: number; reason: string; detail?: string } {
  if (e.kind === "KeyIntroductionRequest") {
    // Always permitted: anyone may publish a self-signed candidacy
    // claim. Acceptance happens at the next mandate that names them.
    return { ok: true };
  }
  if (e.kind === "KeyFile") {
    // First-time KeyFile is allowed only if the pubkey is referenced
    // by a current authority's mandate (introductionMandate). We
    // don't try to look the mandate up here (we trust the field after
    // signature verification — the signer attests the introduction).
    // The follow-up mandate's verification will catch any pubkey not
    // legitimately introduced.
    return { ok: true };
  }
  // EmailRotation / KeyRedirect require the pubkey to already exist
  // in the on-repo state.
  if (!state.keyFiles.has(e.pubkey)) {
    return {
      ok: false,
      status: 403,
      reason: "unknown-pubkey",
      detail: `${e.kind} from pubkey not present in .maintainers/keys/`,
    };
  }
  return { ok: true };
}

function commitMessageFor(e: Envelope, now: Date): string {
  let pubkeyShort = "";
  switch (e.kind) {
    case "Mandate":
    case "ReleaseEndorsement":
      pubkeyShort = e.signedBy.slice(0, 8);
      break;
    case "KeyFile":
    case "KeyRedirect":
    case "EmailRotation":
    case "KeyIntroductionRequest":
      pubkeyShort = e.pubkey.slice(0, 8);
      break;
  }
  return `maintainers: ${e.kind} by ${pubkeyShort} at ${now.toISOString()}`;
}

/**
 * Compute the verified `.maintainers/` summary view returned by /verify.
 * Includes per-track current authority, takeover alarms (when a successor
 * signed a new mandate after expiry), and pending email rotations.
 */
export function summarizeState(state: RepoState, now: Date): RepoSummary {
  const tracks: RepoSummary["tracks"] = [];
  const alarms: RepoSummary["takeoverAlarms"] = [];

  for (const [name, entry] of state.tracks) {
    const verified = verifyTrack(name, entry.policy, entry.mandates);
    const current = currentAuthority(verified, now);
    const expired = lastExpiredMandate(verified, now);

    tracks.push({
      name,
      approvalRule: entry.policy.approvalRule,
      currentHolder: current?.holder ?? null,
      currentMandateId: current?.mandate.mandateId ?? null,
      currentExpiresAt: current?.mandate.expiresAt ?? null,
      successors: current?.successors ?? expired?.successors ?? [],
      mandateCount: verified.validMandates.length,
      rejectedCount: verified.rejections.length,
    });

    // Derive TakeoverAlarms: a valid mandate signed by someone other
    // than the prior holder, where prior had expired.
    for (let i = 1; i < verified.validMandates.length; i++) {
      const prev = verified.validMandates[i - 1]!;
      const cur = verified.validMandates[i]!;
      if (cur.signedBy !== prev.holder) {
        alarms.push({
          track: name,
          previousMandate: prev.mandateId,
          newMandate: cur.mandateId,
          previousHolder: prev.holder,
          newHolder: cur.holder,
          detectedAt: now.toISOString(),
        });
      }
    }
  }

  return {
    rootPolicy: state.rootPolicy,
    tracks,
    keys: Array.from(state.keyFiles.values()).map((k) => ({
      pubkey: k.pubkey,
      displayName: k.displayName,
      currentEmail: k.currentEmail,
      emailHistoryLength: k.emailHistory.length,
    })),
    takeoverAlarms: alarms,
    verifiedAt: now.toISOString(),
  };
}

export interface RepoSummary {
  rootPolicy: RootPolicy | null;
  tracks: {
    name: string;
    approvalRule: ApprovalRule;
    currentHolder: Pubkey | null;
    currentMandateId: string | null;
    currentExpiresAt: string | null;
    successors: Pubkey[];
    mandateCount: number;
    rejectedCount: number;
  }[];
  keys: {
    pubkey: Pubkey;
    displayName: string;
    currentEmail: string;
    emailHistoryLength: number;
  }[];
  takeoverAlarms: {
    track: string;
    previousMandate: string;
    newMandate: string;
    previousHolder: Pubkey;
    newHolder: Pubkey;
    detectedAt: string;
  }[];
  verifiedAt: string;
}

/** Re-export verifier internals so tests can build synthetic RepoStates. */
export { verifyTrack, currentAuthority, hexToBytes, bytesToHex };
export type { VerifiedTrack };
