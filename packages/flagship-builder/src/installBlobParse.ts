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

/**
 * An org server's recipe (`kind: "org"`, docs/enterprise-accounts.md "Org servers"): checked for
 * shape only (the box verifies the org approvals once it has replayed the org's chain). Returns the
 * JSON the box gets as install-blob.json and the fields the bootstrap generators read, as an
 * InstallBlob view: an org has no IRK and no RCK, so those keys are all-zero placeholders no one
 * holds (the generated config names the org instead of an IRK).
 */
export function parseOrgInstallBlob(o: Record<string, unknown>): { json: Record<string, unknown>; view: InstallBlob } | null {
  const hex32 = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
  const code = o.code as Record<string, unknown> | undefined;
  if (o.kind !== "org" || o.version !== 1 || !code || typeof code !== "object") return null;
  if (typeof o.orgId !== "string" || !/^[0-9a-f]{32}$/.test(o.orgId) || !hex32(o.genesisHash) || !hex32(o.phoneDelegatedPubKey)) return null;
  for (const k of ["orgName", "serverName", "serverDomain", "registrationUrl", "installerGitRef"]) if (typeof o[k] !== "string") return null;
  if (o.username !== o.orgName || code.orgId !== o.orgId || code.genesisHash !== o.genesisHash || code.serverDomain !== o.serverDomain) return null;
  if (!Array.isArray(o.approvals) || o.approvals.length === 0 || !Array.isArray(o.codeApprovals) || o.codeApprovals.length === 0) return null;
  if (o.bootUnlockMode !== "auto" && o.bootUnlockMode !== "approve") return null;
  if (o.diskEncryption !== "luks" && o.diskEncryption !== "none") return null;
  if (typeof code.serial !== "string" || typeof code.issuedAt !== "number" || typeof code.expiresAt !== "number") return null;
  const zero = new Uint8Array(32);
  const json = { ...o };
  const view: InstallBlob = {
    version: 2,
    serverDomain: String(o.serverDomain),
    username: String(o.orgName),
    serverName: String(o.serverName),
    phoneDelegatedPubKey: hexToBytes(o.phoneDelegatedPubKey)!,
    registrationUrl: String(o.registrationUrl),
    authCode: {
      version: 1,
      serial: code.serial,
      username: String(o.orgName),
      serverName: String(o.serverName),
      serverDomain: String(o.serverDomain),
      delegatedPubKey: hexToBytes(String(code.delegatedPubKeyHex)) ?? zero,
      userPubKey: zero,
      issuedAt: code.issuedAt,
      expiresAt: code.expiresAt,
    },
    authCodeUserSignature: new Uint8Array(64),
    installerGitRef: String(o.installerGitRef),
    rckPubKey: zero,
    bootUnlockMode: o.bootUnlockMode,
    diskEncryption: o.diskEncryption,
  };
  return { json, view };
}
