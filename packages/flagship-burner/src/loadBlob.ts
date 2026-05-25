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

export interface LoadedBlob {
  blob: InstallBlob;
  blobSignatureHex: string;
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
  return { blob, blobSignatureHex: sigHex, source };
}

export function parseInstallBlob(o: Record<string, unknown>): InstallBlob | null {
  const authCode = o.authCode as Record<string, unknown> | undefined;
  if (!authCode) return null;
  const phonePub = hexToBytes(o.phoneDelegatedPubKey as string);
  const authUserSig = hexToBytes(o.authCodeUserSignature as string);
  const rckPub = hexToBytes(o.rckPubKey as string);
  const userPub = hexToBytes(authCode.userPubKey as string);
  const delegated = hexToBytes(authCode.delegatedPubKey as string);
  if (!phonePub || !authUserSig || !rckPub || !userPub || !delegated) return null;
  if (o.version !== 2) return null;
  return {
    version: 2,
    serverDomain: String(o.serverDomain),
    username: String(o.username),
    serverName: String(o.serverName),
    phoneDelegatedPubKey: phonePub,
    registrationUrl: String(o.registrationUrl),
    authCode: {
      version: 1,
      serial: String(authCode.serial),
      username: String(authCode.username ?? o.username),
      serverName: String(authCode.serverName ?? o.serverName),
      serverDomain: String(authCode.serverDomain ?? o.serverDomain),
      delegatedPubKey: delegated,
      userPubKey: userPub,
      issuedAt: Number(authCode.issuedAt),
      expiresAt: Number(authCode.expiresAt),
    },
    authCodeUserSignature: authUserSig,
    installerGitRef: String(o.installerGitRef ?? ""),
    rckPubKey: rckPub,
  };
}

function hexToBytes(hex: unknown): Uint8Array | null {
  if (typeof hex !== "string") return null;
  if (hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
