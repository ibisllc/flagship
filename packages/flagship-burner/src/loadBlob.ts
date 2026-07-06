/**
 * Load + verify a signed InstallBlob from local input.
 *
 * The Burner NEVER fetches from .com. The blob comes from the user's
 * web flow (the QR-scan path) — by the time it reaches the Burner the
 * phone has already signed it with the user's IRK, and that signature
 * is the trust root.
 *
 * Inputs accepted:
 *   - file path to a `.flagship-recipe.json` saved from the website
 *   - copy-pasted JSON via stdin
 *
 * Outputs the parsed + signature-verified InstallBlob plus the hex
 * signature. Throws BurnerLoadError on any malformed input or bad
 * signature — never returns a partially-trusted blob.
 *
 * Why no fallback to fetching from .com: fetching would require
 * trusting .com both for availability AND for honesty. The phone's
 * signature on the blob is what gives the Burner everything it needs
 * to authorize an install. .com's involvement in the burn step is
 * a non-feature.
 */
import { verifyInstallBlob, type InstallBlob } from "@flagship/protocol";
import { readFile } from "node:fs/promises";
import { hexToBytes, parseInstallBlob } from "./installBlobParse.js";

// Re-exported for back-compat: parseInstallBlob now lives in the pure
// (Node-free) installBlobParse module so the engine bundle can import it.
export { parseInstallBlob } from "./installBlobParse.js";

export interface LoadedBlob {
  blob: InstallBlob;
  blobSignatureHex: string;
  /**
   * OFFLINE secret-free pairing (advanced/embed): the recipe's UNSIGNED embedded
   * `add-paired-session` order (the plaintext `{request, signature}` JSON), if
   * present. NOT part of the signed InstallBlob — a top-level recipe sibling the
   * phone adds so the box can verify + add the paired session LOCALLY on first
   * boot (no `.com`). Threaded into the on-disk install-blob.json via
   * {@link UserDataOptions.pairingOrder}; undefined for the default online recipe
   * (no secret) and older recipes.
   */
  pairingOrder?: string;
  /**
   * SWK provisioning: the recipe's UNSIGNED Service Workload Key (a 32-byte hex,
   * = `deriveSWK(umk, serverId)`), if present. NOT part of the signed InstallBlob
   * — a top-level recipe sibling the phone adds (exactly like
   * {@link pairingOrder}) so the daemon can turn on the service/build
   * platform at first boot. Threaded into the on-disk install-blob.json via
   * {@link UserDataOptions.swkHex}; undefined for recipes that don't carry it.
   */
  swkHex?: string;
  /**
   * Owner-authorized debug-access grant — the JSON string `{grant,signatureHex}`
   * the phone signs behind Face ID when the user approves the burner's "Debug
   * mode" toggle (the `flagship/debug-access/v1` envelope). NOT part of the
   * signed InstallBlob — a top-level recipe sibling (like {@link pairingOrder} /
   * {@link swkHex}). Threaded into install-blob.json via
   * {@link UserDataOptions.debugGrant}; the box-side gate verifies it under the
   * owner IRK before enabling the debug user/SSH. Undefined for production recipes.
   */
  debugGrant?: string;
  /** Where the blob came from — useful for the auto-shred step. */
  source: { kind: "file"; path: string } | { kind: "stdin" };
}

export class BurnerLoadError extends Error {
  constructor(
    message: string,
    readonly code:
      | "malformed-json"
      | "missing-field"
      | "expired"
      | "bad-signature"
      | "io",
  ) {
    super(message);
    this.name = "BurnerLoadError";
  }
}

/**
 * Extract the OpenSSH authorized key to bake at install time from a recipe's
 * debug-access grant (the `{grant,signatureHex}` JSON string on {@link
 * LoadedBlob.debugGrant}). A grant with a NON-EMPTY `grant.sshAuthorizedKey` is
 * the owner's Face-ID-signed consent to bake that key (verified box-side against
 * the pinned owner IRK); we thread it into {@link UserDataOptions.debugSshAuthorizedKey}
 * so a debug-friendly VM/USB can be SSH-diagnosed pre-daemon. An empty key (the
 * common debug-console-only grant) ⇒ undefined ⇒ no debug SSH stub, and a
 * production recipe (no grant) ⇒ undefined ⇒ the normal provisioning bootstrap.
 */
export function debugSshKeyFromGrant(debugGrant?: string): string | undefined {
  if (!debugGrant) return undefined;
  try {
    const parsed = JSON.parse(debugGrant) as { grant?: { sshAuthorizedKey?: unknown } };
    const key = parsed?.grant?.sshAuthorizedKey;
    return typeof key === "string" && key.trim().length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Load from a JSON file (the website's download-recipe button). */
export async function loadBlobFromFile(path: string): Promise<LoadedBlob> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (e) {
    throw new BurnerLoadError(`cannot read ${path}: ${(e as Error).message}`, "io");
  }
  return loadBlobFromString(raw, { kind: "file", path });
}

/**
 * Load from stdin (copy-paste flow: `pbpaste | flagship-burn verify -`).
 * The website's /ready/ page offers a "Copy recipe" button; this is the CLI
 * counterpart to the Mac app's "Paste certificate".
 */
export async function loadBlobFromStdin(): Promise<LoadedBlob> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) {
    throw new BurnerLoadError("no recipe on stdin", "io");
  }
  return loadBlobFromString(raw, { kind: "stdin" });
}

/** Load from a JSON string (copy-paste flow). */
export function loadBlobFromString(
  raw: string,
  source: LoadedBlob["source"] = { kind: "stdin" },
): LoadedBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new BurnerLoadError(`JSON parse: ${(e as Error).message}`, "malformed-json");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new BurnerLoadError("top-level value is not an object", "malformed-json");
  }
  // OFFLINE secret-free pairing (advanced/embed): the optional embedded
  // `add-paired-session` order (plaintext `{request, signature}` JSON) is a
  // TOP-LEVEL recipe sibling (alongside `blob`/`blobSignature` in the envelope
  // form, or a sibling of the flattened fields). Read it off the ORIGINAL parsed
  // object before the envelope-flatten below drops top-level siblings. UNSIGNED —
  // recipe metadata, never part of the verified InstallBlob. Tolerate either a
  // JSON STRING or an inlined object; serialize an object to the canonical string.
  const rawPairingOrder = (parsed as Record<string, unknown>).pairingOrder;
  const pairingOrder =
    typeof rawPairingOrder === "string" && rawPairingOrder.length > 0
      ? rawPairingOrder
      : rawPairingOrder && typeof rawPairingOrder === "object"
        ? JSON.stringify(rawPairingOrder)
        : undefined;
  // SWK provisioning: the optional Service Workload Key is likewise a TOP-LEVEL
  // recipe sibling (read off the ORIGINAL parsed object, before the envelope
  // flatten drops top-level siblings). UNSIGNED — recipe metadata, never part of
  // the verified InstallBlob.
  const rawSwk = (parsed as Record<string, unknown>).swkHex;
  const swkHex =
    typeof rawSwk === "string" && /^[0-9a-f]{64}$/i.test(rawSwk)
      ? rawSwk.toLowerCase()
      : undefined;
  // Owner-authorized debug-access grant: an OPTIONAL top-level recipe sibling
  // (`{grant,signatureHex}`), added by the burner's --debug consent flow. UNSIGNED
  // — recipe metadata, never part of the verified InstallBlob. Tolerate a JSON
  // STRING or an inlined object; normalize to the canonical string.
  const rawDebugGrant = (parsed as Record<string, unknown>).debugGrant;
  const debugGrant =
    typeof rawDebugGrant === "string" && rawDebugGrant.length > 0
      ? rawDebugGrant
      : rawDebugGrant && typeof rawDebugGrant === "object"
        ? JSON.stringify(rawDebugGrant)
        : undefined;
  // Accept both the flattened recipe and the issued envelope that .com / the
  // website hand out: { blob: {...}, blobSignature: "..." }.
  let obj = parsed as Record<string, unknown>;
  if (
    obj.blob && typeof obj.blob === "object" &&
    typeof obj.blobSignature === "string"
  ) {
    obj = { ...(obj.blob as Record<string, unknown>), blobSignatureHex: obj.blobSignature };
  }
  const sigHex = obj.blobSignatureHex as string | undefined;
  if (typeof sigHex !== "string") {
    throw new BurnerLoadError("missing blobSignatureHex", "missing-field");
  }
  const sigBytes = hexToBytes(sigHex);
  if (!sigBytes || sigBytes.length !== 64) {
    throw new BurnerLoadError("blobSignatureHex not a 64-byte hex", "missing-field");
  }
  const blob = parseInstallBlob(obj);
  if (!blob) {
    throw new BurnerLoadError("InstallBlob fields incomplete/malformed", "missing-field");
  }
  // v2: the auth-code expiry IS the recipe expiry. The Burner refuses
  // an expired recipe before doing any work so the user gets a clean
  // error instead of "daemon registered fine but then .com rejected
  // the auth-code 4 hours later".
  if (Date.now() > blob.authCode.expiresAt) {
    throw new BurnerLoadError(
      `recipe expired at ${new Date(blob.authCode.expiresAt).toISOString()}`,
      "expired",
    );
  }
  // The phone signed canonical-bytes of the blob with the user's IRK.
  // We verify against the userPubKey embedded in the blob (which is
  // itself bound to the username at .com — so a forged userPubKey
  // would fail upstream when the daemon tries to register).
  if (!verifyInstallBlob(blob, sigBytes, blob.authCode.userPubKey)) {
    throw new BurnerLoadError(
      "signature does not verify under embedded user pubkey",
      "bad-signature",
    );
  }
  return { blob, blobSignatureHex: sigHex, pairingOrder, swkHex, debugGrant, source };
}
