/**
 * Only an admin device of the joining account accepts a share (owner rule
 * 2026-10-16, docs/share-a-server.md §5.1 and §10). Before the first grant
 * for a share id goes live, the box checks the joining account's proof that
 * came sealed with the acceptance:
 *
 *   - #12 `flagship/server-share-accept-admin/v1`, naming the same share,
 *     server, member key and time as the member-key acceptance (#3), signed
 *     by the per-share admin key it names (keyKind `share`);
 *   - `.com`'s CA-signed AccountKeyAttestation of that key, which `.com`
 *     issues only on a request signed by the account's sensitive key (admin
 *     root or an admin-granted device; the IRK only when the account pins no
 *     admin root: `authorizeSensitiveComOp`).
 *
 * The attestation names no account, the box asks `.com` nothing, and the key
 * is derived per share from the joining account's UMK: it is no key `.com`
 * serves by name, and another server B joins sees a different one, so no
 * owner can confirm a guessed account or link B across servers (AT-LNK-10).
 * The box learns only that some account's admin vouched for this member key.
 */
import {
  ACCOUNT_KEY_ATTESTATION_TTL_MS,
  verifyCaSignedAccountKeyAttestation,
  verifyServerShareAcceptAdmin,
  type CaTrustChain,
  type ServerShareAccept,
  type ShareAcceptAdminProof,
} from "@flagship/protocol";

export type AcceptAdminRefusal = "accept-not-admin" | "accept-signature" | "accept-stale" | "accept-unverifiable";

/** What the owner's app shows when the box refuses a first grant. */
export const ACCEPT_ADMIN_SENTENCES: Record<AcceptAdminRefusal, string> = {
  "accept-not-admin":
    "Only an admin device of their account can accept a co-manage invitation. Cancel this link and send a new one for them to open on an admin device.",
  "accept-signature":
    "Their acceptance isn't signed by their account's admin key, so this server can't trust it. Cancel this link and send a new one.",
  "accept-stale": "Their acceptance is too old to check. Cancel this link and send them a new one.",
  "accept-unverifiable":
    "This server can't check the acceptance right now because its list of trusted Flagship keys is out of date. Update the server, then confirm again.",
};

export type AcceptAdminVerdict =
  | { ok: true; keyKind: ShareAcceptAdminProof["admit"]["keyKind"]; keyPubHex: string }
  | { ok: false; status: number; code: AcceptAdminRefusal; error: string };

/** A clock ahead of the box by more than this is a stale (bad) acceptance. */
const FUTURE_SKEW_MS = 5 * 60_000;

function refuse(code: AcceptAdminRefusal): AcceptAdminVerdict {
  return { ok: false, status: code === "accept-unverifiable" ? 503 : 403, code, error: ACCEPT_ADMIN_SENTENCES[code] };
}

export interface CheckAcceptAdminArgs {
  accept: ServerShareAccept;
  proof: ShareAcceptAdminProof | undefined;
  /** The box's maintainer CA chain (links 2-3); null when it can't be read. */
  chain: CaTrustChain | null;
  now: number;
  /** Tests only: the baked pin. */
  pinnedMandateHash?: string;
}

export function checkShareAcceptAdmin(args: CheckAcceptAdminArgs): AcceptAdminVerdict {
  const { accept, proof, now } = args;
  if (!proof) return refuse("accept-not-admin");
  const { admit, attestation } = proof;
  if (
    admit.serverDomain !== accept.serverDomain ||
    admit.shareId !== accept.shareId ||
    admit.memberPubHex !== accept.memberPubHex ||
    admit.acceptedAt !== accept.acceptedAt
  ) {
    return refuse("accept-signature");
  }
  // Only a per-share key is accepted: a stable account key would let this
  // server's owner match the joining account by name (AT-LNK-10).
  if (admit.keyKind !== "share" || attestation.keyKind !== "share") return refuse("accept-not-admin");
  if (admit.keyPubHex !== attestation.keyPubHex) return refuse("accept-signature");
  const sig = Buffer.from(proof.signature, "hex");
  if (sig.length !== 64 || !verifyServerShareAcceptAdmin(admit, sig, Buffer.from(admit.keyPubHex, "hex"))) {
    return refuse("accept-signature");
  }
  if (admit.acceptedAt > now + FUTURE_SKEW_MS || now - admit.acceptedAt > ACCOUNT_KEY_ATTESTATION_TTL_MS) {
    return refuse("accept-stale");
  }
  const ca = verifyCaSignedAccountKeyAttestation(attestation, args.chain, now, args.pinnedMandateHash);
  if (!ca.ok) {
    if (ca.reason === "artifact-expired") return refuse("accept-stale");
    if (ca.reason === "signature-unverified") return refuse("accept-signature");
    return refuse("accept-unverifiable");
  }
  return { ok: true, keyKind: admit.keyKind, keyPubHex: admit.keyPubHex };
}
