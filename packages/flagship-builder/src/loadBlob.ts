/**
 * Load + verify a signed InstallBlob from local input.
 *
 * The Builder NEVER fetches from .com. The blob comes from the user's
 * web flow (the QR-scan path) — by the time it reaches the Builder the
 * phone has already signed it with the user's IRK, and that signature
 * is the trust root.
 *
 * Inputs accepted:
 *   - file path to a `.flagship-recipe.json` saved from the website
 *   - copy-pasted JSON via stdin
 *
 * Outputs the parsed + signature-verified InstallBlob plus the hex
 * signature. Throws BuilderLoadError on any malformed input or bad
 * signature — never returns a partially-trusted blob.
 *
 * Why no fallback to fetching from .com: fetching would require
 * trusting .com both for availability AND for honesty. The phone's
 * signature on the blob is what gives the Builder everything it needs
 * to authorize an install. .com's involvement in the burn step is
 * a non-feature.
 */
import { verifyInstallBlob, type InstallBlob } from "@flagship/protocol";
import { readFile } from "node:fs/promises";
import { readProxySiblings } from "./proxySiblings.js";
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
   * Owner debug access — the JSON string `{grant,signatureHex}` an admin
   * device signs behind Face ID when the owner turns on "Debug-friendly
   * server" (the `flagship/debug-access/v2` envelope: an SSH key and an end
   * time). NOT part of the signed InstallBlob — a top-level recipe sibling
   * (like {@link pairingOrder} / {@link swkHex}). Threaded into
   * install-blob.json via {@link UserDataOptions.debugGrant}; the box verifies
   * it under its pinned admin root before letting the key in. Undefined for
   * production recipes.
   */
  debugGrant?: string;
  /**
   * The owner-signed outbound proxy order (`{proxy, signature}` JSON,
   * docs/outbound-proxy.md) and, only when the owner typed them into the
   * recipe, its credentials (`{username, password}` JSON). Unsigned siblings
   * like {@link debugGrant}: the order carries its own signature, which the
   * box verifies. Passed through to install-blob.json untouched.
   */
  outboundProxy?: string;
  outboundProxyCredentials?: string;
  /** Where the blob came from — useful for the auto-shred step. */
  source: { kind: "file"; path: string } | { kind: "stdin" };
}

export class BuilderLoadError extends Error {
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
    this.name = "BuilderLoadError";
  }
}

/** Load from a JSON file (the website's download-recipe button). */
export async function loadBlobFromFile(path: string): Promise<LoadedBlob> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (e) {
    throw new BuilderLoadError(`cannot read ${path}: ${(e as Error).message}`, "io");
  }
  return loadBlobFromString(raw, { kind: "file", path });
}

/**
 * Load from stdin (copy-paste flow: `pbpaste | flagship-build verify -`).
 * The webapp offers a recipe download; this is the CLI
 * counterpart to the Mac app's "Paste certificate".
 */
export async function loadBlobFromStdin(): Promise<LoadedBlob> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) {
    throw new BuilderLoadError("no recipe on stdin", "io");
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
    throw new BuilderLoadError(`JSON parse: ${(e as Error).message}`, "malformed-json");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new BuilderLoadError("top-level value is not an object", "malformed-json");
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
  // (`{grant,signatureHex}`), added by the builder's --debug consent flow. UNSIGNED
  // — recipe metadata, never part of the verified InstallBlob. Tolerate a JSON
  // STRING or an inlined object; normalize to the canonical string.
  const rawDebugGrant = (parsed as Record<string, unknown>).debugGrant;
  const debugGrant =
    typeof rawDebugGrant === "string" && rawDebugGrant.length > 0
      ? rawDebugGrant
      : rawDebugGrant && typeof rawDebugGrant === "object"
        ? JSON.stringify(rawDebugGrant)
        : undefined;
  const { outboundProxy, outboundProxyCredentials } = readProxySiblings(parsed as Record<string, unknown>);
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
    throw new BuilderLoadError("missing blobSignatureHex", "missing-field");
  }
  const sigBytes = hexToBytes(sigHex);
  if (!sigBytes || sigBytes.length !== 64) {
    throw new BuilderLoadError("blobSignatureHex not a 64-byte hex", "missing-field");
  }
  const blob = parseInstallBlob(obj);
  if (!blob) {
    throw new BuilderLoadError("InstallBlob fields incomplete/malformed", "missing-field");
  }
  // v2: the auth-code expiry IS the recipe expiry. The Builder refuses
  // an expired recipe before doing any work so the user gets a clean
  // error instead of "daemon registered fine but then .com rejected
  // the auth-code 4 hours later".
  if (Date.now() > blob.authCode.expiresAt) {
    throw new BuilderLoadError(
      `recipe expired at ${new Date(blob.authCode.expiresAt).toISOString()}`,
      "expired",
    );
  }
  // The phone signed canonical-bytes of the blob with the user's IRK.
  // We verify against the userPubKey embedded in the blob (which is
  // itself bound to the username at .com — so a forged userPubKey
  // would fail upstream when the daemon tries to register).
  if (!verifyInstallBlob(blob, sigBytes, blob.authCode.userPubKey)) {
    throw new BuilderLoadError(
      "signature does not verify under embedded user pubkey",
      "bad-signature",
    );
  }
  return {
    blob,
    blobSignatureHex: sigHex,
    pairingOrder,
    swkHex,
    debugGrant,
    ...(outboundProxy ? { outboundProxy } : {}),
    ...(outboundProxyCredentials ? { outboundProxyCredentials } : {}),
    source,
  };
}
