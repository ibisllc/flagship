/**
 * Server-side ISO personalization (#12, the dumb-flash default path).
 *
 * The user's phone/QR flow produces a signed install recipe. `/ready/` POSTs
 * that recipe here; we stream a PRE-BUILT reproducible Alpine base ISO with the
 * recipe appended as a trailer (packages/iso-personalizer/streamPersonalize) —
 * no per-user heavy build. The burner is then a dumb flasher (ISO + USB), and
 * the box reads the trailer back via the ISO9660-volume-size find
 * (packages/installer-tiny materialize_recipe).
 *
 * Runtime-agnostic: the caller supplies the base-ISO byte stream + size (from
 * R2 on the Worker, a file on Fastify) and turns the returned stream into a
 * Response. The recipe parsing + signature verify + trailer glue live here so
 * they are unit-testable without a runtime.
 */
import { installBlobFromJson, buildTrailerFromSignature } from "@flagship/iso-personalizer";
import { verifyInstallBlob, type InstallBlob } from "@flagship/protocol";

type InstallBlobJson = Parameters<typeof installBlobFromJson>[0];

export interface BaseIso {
  /** Total bytes of the base ISO (needed for the personalized Content-Length). */
  size: number;
  /** Optional. The trailer path no longer consumes the base stream — the
   *  caller streams the body itself (the Worker pipes the R2 body
   *  runtime-natively via FixedLengthStream, NOT through a JS `pull` loop,
   *  which the runtime would terminate mid-download on large ISOs). Kept
   *  optional for callers that still pass it. */
  stream?: ReadableStream<Uint8Array>;
}

export interface PersonalizeOk {
  ok: true;
  /** The (~1 KB) trailer to append AFTER the base-ISO bytes. The caller owns
   *  streaming `base || trailerBytes` to its response/sink. */
  trailerBytes: Uint8Array;
  /** baseIsoSize + trailerSize — the personalized Content-Length. */
  totalBytes: number;
  /** A safe download filename derived from the recipe. */
  filename: string;
}

export interface PersonalizeErr {
  ok: false;
  /** HTTP status the caller should return. */
  status: number;
  error: string;
}

const HEX64 = /^[0-9a-fA-F]{128}$/;

function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Parse a recipe envelope into a blob + 64-byte signature. Accepts every shape
 * the burner/webapp emit: the signature as `blobSignatureHex` | `blobSignature`
 * | `signature`, either flat (alongside the InstallBlob fields) or nested under
 * `{ blob: … }`.
 */
export function parseRecipeEnvelope(
  text: string,
): { blob: InstallBlob; sig: Uint8Array } | { error: string } {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: "recipe is not valid JSON" };
  }
  if (!j || typeof j !== "object") return { error: "recipe must be a JSON object" };
  const nested = j.blob && typeof j.blob === "object" ? (j.blob as Record<string, unknown>) : undefined;
  const blobJson = (nested ?? j) as unknown as InstallBlobJson;
  const sigHex =
    (typeof j.blobSignatureHex === "string" && j.blobSignatureHex) ||
    (typeof j.blobSignature === "string" && j.blobSignature) ||
    (typeof j.signature === "string" && j.signature) ||
    (nested && typeof nested.blobSignatureHex === "string" && nested.blobSignatureHex) ||
    "";
  if (!sigHex) {
    return { error: "recipe missing blobSignatureHex / blobSignature / signature" };
  }
  if (!HEX64.test(sigHex)) return { error: "signature is not 64-byte hex" };
  let blob: InstallBlob;
  try {
    blob = installBlobFromJson(blobJson);
  } catch (e) {
    return { error: `invalid InstallBlob: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { blob, sig: hexToBytes(sigHex) };
}

function safeIsoFilename(blob: InstallBlob): string {
  const base = (blob.serverDomain || `${blob.serverName}-${blob.username}` || "flagship").replace(
    /[^a-zA-Z0-9._-]/g,
    "-",
  );
  return `flagship-${base}.iso`;
}

/**
 * Validate + personalize. Defense-in-depth: the recipe signature must verify
 * under the embedded `authCode.userPubKey` before we stream an ISO around it
 * (the box re-verifies; this just refuses to personalize a tampered/garbage
 * recipe). Returns a streamable result or a typed HTTP error.
 */
export function buildPersonalizedIso(recipeText: string, base: BaseIso): PersonalizeOk | PersonalizeErr {
  const parsed = parseRecipeEnvelope(recipeText);
  if ("error" in parsed) return { ok: false, status: 400, error: parsed.error };
  const { blob, sig } = parsed;
  if (!verifyInstallBlob(blob, sig, blob.authCode.userPubKey)) {
    return {
      ok: false,
      status: 400,
      error: "recipe signature does not verify under authCode.userPubKey",
    };
  }
  try {
    const trailerBytes = buildTrailerFromSignature(blob, sig);
    return {
      ok: true,
      trailerBytes,
      totalBytes: base.size + trailerBytes.length,
      filename: safeIsoFilename(blob),
    };
  } catch (e) {
    return { ok: false, status: 500, error: `personalize failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
