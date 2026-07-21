/**
 * PURE InstallBlob parsing (no Node, no crypto) — split out of loadBlob.ts so it
 * can be bundled into the engine (preseedEngine.ts → JavaScriptCore / Rhino),
 * which must stay free of `node:*` imports. loadBlob.ts re-exports these and adds
 * the file/stdin readers + signature verification on top.
 */
import type { InstallBlob } from "@flagship/protocol";

export function hexToBytes(hex: unknown): Uint8Array | null {
  if (typeof hex !== "string") return null;
  if (hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function parseInstallBlob(o: Record<string, unknown>): InstallBlob | null {
  const authCode = o.authCode as Record<string, unknown> | undefined;
  if (!authCode) return null;
  const phonePub = hexToBytes(o.phoneDelegatedPubKey as string);
  const authUserSig = hexToBytes(o.authCodeUserSignature as string);
  const rckPub = hexToBytes(o.rckPubKey as string);
  const userPub = hexToBytes(authCode.userPubKey as string);
  const delegated = hexToBytes(authCode.delegatedPubKey as string);
  const adminRootRaw = authCode.adminRootPubKey;
  const adminRoot = adminRootRaw === undefined ? undefined : hexToBytes(adminRootRaw);
  if (!phonePub || !authUserSig || !rckPub || !userPub || !delegated) return null;
  if (adminRootRaw !== undefined && (!adminRoot || adminRoot.length !== 32)) return null;
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
      ...(adminRoot ? { adminRootPubKey: adminRoot } : {}),
    },
    authCodeUserSignature: authUserSig,
    installerGitRef: String(o.installerGitRef ?? ""),
    rckPubKey: rckPub,
    ...(o.bootUnlockMode === "approve" || o.bootUnlockMode === "auto"
      ? { bootUnlockMode: o.bootUnlockMode as "approve" | "auto" }
      : {}),
    ...(o.diskEncryption === "luks" || o.diskEncryption === "none"
      ? { diskEncryption: o.diskEncryption as "luks" | "none" }
      : {}),
  };
}
