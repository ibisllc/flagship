// The recipe a phone sends in a claim: the same signed InstallBlob a USB stick or a VM seed carries,
// checked the way the builder's loadBlob checks it (the builder is not part of a box's install).

import { verifyInstallBlob, type InstallBlob } from "@flagship/protocol";
import type { RecipeCheck } from "./claimService.js";

const hex = (v: unknown, len?: number): Uint8Array | null => {
  if (typeof v !== "string" || v.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(v)) return null;
  const b = Uint8Array.from(Buffer.from(v, "hex"));
  return len === undefined || b.length === len ? b : null;
};

function parse(o: Record<string, unknown>): InstallBlob | null {
  const a = o.authCode as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object" || o.version !== 2) return null;
  const phone = hex(o.phoneDelegatedPubKey, 32);
  const authSig = hex(o.authCodeUserSignature, 64);
  const rck = hex(o.rckPubKey, 32);
  const user = hex(a.userPubKey, 32);
  const delegated = hex(a.delegatedPubKey, 32);
  const adminRoot = a.adminRootPubKey === undefined ? undefined : hex(a.adminRootPubKey, 32);
  if (!phone || !authSig || !rck || !user || !delegated || adminRoot === null) return null;
  if (typeof o.serverDomain !== "string" || typeof o.username !== "string" || typeof o.serverName !== "string" || typeof o.registrationUrl !== "string") return null;
  if (typeof a.serial !== "string" || !Number.isSafeInteger(a.issuedAt) || !Number.isSafeInteger(a.expiresAt)) return null;
  return {
    version: 2,
    serverDomain: o.serverDomain,
    username: o.username,
    serverName: o.serverName,
    phoneDelegatedPubKey: phone,
    registrationUrl: o.registrationUrl,
    authCode: {
      version: 1,
      serial: a.serial,
      username: String(a.username ?? o.username),
      serverName: String(a.serverName ?? o.serverName),
      serverDomain: String(a.serverDomain ?? o.serverDomain),
      delegatedPubKey: delegated,
      userPubKey: user,
      issuedAt: a.issuedAt as number,
      expiresAt: a.expiresAt as number,
      ...(adminRoot ? { adminRootPubKey: adminRoot } : {}),
    },
    authCodeUserSignature: authSig,
    installerGitRef: String(o.installerGitRef ?? ""),
    rckPubKey: rck,
    ...(o.bootUnlockMode === "approve" || o.bootUnlockMode === "auto" ? { bootUnlockMode: o.bootUnlockMode } : {}),
    ...(o.diskEncryption === "luks" || o.diskEncryption === "none" ? { diskEncryption: o.diskEncryption } : {}),
  };
}

/** Signed under the account key it names, for this server, not expired. */
export function verifyClaimRecipe(text: string, now: number): RecipeCheck {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "recipe-invalid" };
  }
  if (!o || typeof o !== "object") return { ok: false, reason: "recipe-invalid" };
  if (o.blob && typeof o.blob === "object" && typeof o.blobSignature === "string") o = { ...(o.blob as Record<string, unknown>), blobSignatureHex: o.blobSignature };
  const sig = hex(o.blobSignatureHex, 64);
  const blob = parse(o);
  if (!sig || !blob) return { ok: false, reason: "recipe-invalid" };
  if (blob.authCode.serverDomain !== blob.serverDomain) return { ok: false, reason: "recipe-invalid" };
  if (!verifyInstallBlob(blob, sig, blob.authCode.userPubKey)) return { ok: false, reason: "recipe-invalid" };
  if (now > blob.authCode.expiresAt) return { ok: false, reason: "recipe-expired" };
  return { ok: true, serverDomain: blob.serverDomain, serial: blob.authCode.serial };
}
