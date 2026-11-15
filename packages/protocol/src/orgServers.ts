/**
 * Org servers (docs/enterprise-accounts.md §6, §18 E2/E3, "Org servers"): adding a server to an org.
 *
 *   flagship/org-server-code/v1|<orgId>|<genesisHash>|<serial>|<serverName>|<serverDomain>|<delegatedPubKeyHex>|<issuedAt>|<expiresAt>
 *   flagship/org-server-register/v1|<orgId>|<serial>|<serverDomain>|<codeSha256>|<serverIdentityPubKeyHex>|<issuedAt>|<nonceHex>
 *
 * The server code is the org's AuthCode: an org has no IRK and no admin root, so instead of the
 * IRK's signature and the admin root's approval the code carries org approvals (`flagship/org-approval/v1`)
 * under the action `add-server` (one org admin, or a seat whose grant holds `servers-add`). The code
 * names the org and its authority genesis: that pair is what the box pins in place of
 * `adminRootPub`, so the box anchors exactly the org the admins approved. The box registers with its
 * server identity key (STK, Ed25519 proof of possession, as `flagship/server-register/v1` does) over
 * the code's hash; `.com` admits only the code it stored at issue.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { hex } from "./canonicalBase.js";
import { OrgAuthorityError, authorizeOrgOrder, orgSha256Hex, verifyOrgRecordedApprovals, type OrgApproval, type OrgAuthorityState, type OrgSeatBook } from "./orgAuthority.js";
import { ed25519VerifyStrict } from "./pqHybrid.js";
import type { Bytes } from "./types.js";

export const TAG_ORG_SERVER_CODE = "flagship/org-server-code/v1";
export const TAG_ORG_SERVER_REGISTER = "flagship/org-server-register/v1";

/** A server code lives at most a day, like an AuthCode (`RECIPE_TTL_MAX_MS`). */
export const ORG_SERVER_CODE_MAX_MS = 24 * 3_600_000;

const HEX16 = /^[0-9a-f]{32}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const SERIAL = /^[A-Za-z0-9_-]{8,64}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const NONCE = /^[0-9a-f]{16,128}$/;

const enc = (s: string): Bytes => new TextEncoder().encode(s);
const fail = (detail: string): never => {
  throw new OrgAuthorityError("malformed", detail);
};
function match(name: string, re: RegExp, v: unknown): void {
  if (typeof v !== "string" || !re.test(v)) fail(name);
}
function uint(name: string, v: unknown): void {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail(name);
}
function fromHex(s: string): Bytes {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface OrgServerCode {
  orgId: string;
  genesisHash: string;
  serial: string;
  serverName: string;
  /** `<serverName>.<orgName>.<apex>`; `.com` checks it against the org's current name. */
  serverDomain: string;
  delegatedPubKeyHex: string;
  issuedAt: number;
  expiresAt: number;
}

export function canonicalOrgServerCode(c: OrgServerCode): Bytes {
  match("orgId", HEX16, c.orgId);
  match("genesisHash", HEX32, c.genesisHash);
  match("serial", SERIAL, c.serial);
  match("serverName", LABEL, c.serverName);
  match("serverDomain", DOMAIN, c.serverDomain);
  if (!c.serverDomain.startsWith(`${c.serverName}.`)) fail("serverDomain");
  match("delegatedPubKeyHex", HEX32, c.delegatedPubKeyHex);
  uint("issuedAt", c.issuedAt);
  uint("expiresAt", c.expiresAt);
  if (c.expiresAt <= c.issuedAt || c.expiresAt - c.issuedAt > ORG_SERVER_CODE_MAX_MS) fail("expiresAt");
  return enc(
    [TAG_ORG_SERVER_CODE, c.orgId, c.genesisHash, c.serial, c.serverName, c.serverDomain, c.delegatedPubKeyHex, c.issuedAt, c.expiresAt].join("|"),
  );
}

export const orgServerCodeSha256 = (c: OrgServerCode): string => orgSha256Hex(canonicalOrgServerCode(c));

/**
 * Checks a server code under the org's verified chain and seat book: it names this org and its
 * genesis, it has not run out, and the approvals authorize `add-server`. Throws `OrgAuthorityError`.
 */
export function verifyOrgServerCode(
  state: OrgAuthorityState,
  book: OrgSeatBook,
  code: OrgServerCode,
  approvals: readonly OrgApproval[],
  now: number,
): { signers: string[]; scopedSeat: string | null } {
  const order = canonicalOrgServerCode(code);
  if (code.orgId !== state.orgId || code.genesisHash !== state.genesisHash) throw new OrgAuthorityError("wrong-org");
  if (code.expiresAt <= now) throw new OrgAuthorityError("expired");
  return authorizeOrgOrder({ state, book, action: { kind: "add-server" }, order, approvals, now });
}

export interface OrgServerRegister {
  orgId: string;
  serial: string;
  serverDomain: string;
  codeSha256: string;
  serverIdentityPubKeyHex: string;
  issuedAt: number;
  nonceHex: string;
}

export function canonicalOrgServerRegister(r: OrgServerRegister): Bytes {
  match("orgId", HEX16, r.orgId);
  match("serial", SERIAL, r.serial);
  match("serverDomain", DOMAIN, r.serverDomain);
  match("codeSha256", HEX32, r.codeSha256);
  match("serverIdentityPubKeyHex", HEX32, r.serverIdentityPubKeyHex);
  uint("issuedAt", r.issuedAt);
  match("nonceHex", NONCE, r.nonceHex);
  return enc(
    [TAG_ORG_SERVER_REGISTER, r.orgId, r.serial, r.serverDomain, r.codeSha256, r.serverIdentityPubKeyHex, r.issuedAt, r.nonceHex].join("|"),
  );
}

/** The box signs its registration with its server identity key (32-byte Ed25519 seed). */
export function signOrgServerRegister(r: OrgServerRegister, stkSeed: Bytes): string {
  const pub = hex(ed25519.getPublicKey(stkSeed));
  if (pub !== r.serverIdentityPubKeyHex) fail("serverIdentityPubKeyHex is not the signing key");
  return hex(ed25519.sign(canonicalOrgServerRegister(r), stkSeed));
}

export function verifyOrgServerRegister(r: OrgServerRegister, signatureHex: string): boolean {
  if (typeof signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
  try {
    return ed25519VerifyStrict(fromHex(signatureHex), canonicalOrgServerRegister(r), fromHex(r.serverIdentityPubKeyHex));
  } catch {
    return false;
  }
}

export const TAG_ORG_INSTALL_BLOB = "flagship/org-install-blob/v1";

/**
 * The recipe of an org server (`install-blob.json` with `kind: "org"`). A personal recipe is signed
 * by the owner's IRK; an org has none, so the recipe carries org approvals over its canonical bytes
 * (the same `add-server` authority as the code), and the server code with its own approvals. The
 * box pins `orgId` + `genesisHash` from it and, once it has replayed the chain, checks both sets of
 * approvals itself (`verifyOrgInstallBlob`).
 *
 *   flagship/org-install-blob/v1|<orgId>|<genesisHash>|<orgName>|<serverName>|<serverDomain>|<registrationUrl>|<installerGitRef>|<phoneDelegatedPubKey>|<codeSha256>|<bootUnlockMode>|<diskEncryption>
 */
export interface OrgInstallBlob {
  kind: "org";
  version: 1;
  orgId: string;
  genesisHash: string;
  orgName: string;
  /** The org's name again, under the field every bootstrap reads (`jq .username`). */
  username: string;
  serverName: string;
  serverDomain: string;
  registrationUrl: string;
  installerGitRef: string;
  phoneDelegatedPubKey: string;
  bootUnlockMode: "auto" | "approve";
  diskEncryption: "luks" | "none";
  code: OrgServerCode;
  codeApprovals: OrgApproval[];
  approvals: OrgApproval[];
}

const URL_RE = /^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?\/api\/orgs\/[0-9a-f]{32}\/servers\/register$/;
const GIT_REF = /^[0-9a-f]{40}$/;

export function canonicalOrgInstallBlob(b: Omit<OrgInstallBlob, "approvals" | "codeApprovals">): Bytes {
  if (b.kind !== "org" || b.version !== 1) fail("kind");
  match("orgId", HEX16, b.orgId);
  match("genesisHash", HEX32, b.genesisHash);
  match("orgName", LABEL, b.orgName);
  if (b.username !== b.orgName) fail("username");
  match("serverName", LABEL, b.serverName);
  match("serverDomain", DOMAIN, b.serverDomain);
  match("registrationUrl", URL_RE, b.registrationUrl);
  if (!b.registrationUrl.includes(`/api/orgs/${b.orgId}/`)) fail("registrationUrl");
  match("installerGitRef", GIT_REF, b.installerGitRef);
  match("phoneDelegatedPubKey", HEX32, b.phoneDelegatedPubKey);
  if (b.bootUnlockMode !== "auto" && b.bootUnlockMode !== "approve") fail("bootUnlockMode");
  if (b.diskEncryption !== "luks" && b.diskEncryption !== "none") fail("diskEncryption");
  const c = b.code;
  canonicalOrgServerCode(c);
  if (c.orgId !== b.orgId || c.genesisHash !== b.genesisHash || c.serverName !== b.serverName || c.serverDomain !== b.serverDomain) fail("code names another server");
  if (b.serverDomain !== `${b.serverName}.${b.orgName}.${b.serverDomain.split(".").slice(2).join(".")}`) fail("serverDomain");
  return enc(
    [
      TAG_ORG_INSTALL_BLOB,
      b.orgId,
      b.genesisHash,
      b.orgName,
      b.serverName,
      b.serverDomain,
      b.registrationUrl,
      b.installerGitRef,
      b.phoneDelegatedPubKey,
      orgServerCodeSha256(c),
      b.bootUnlockMode,
      b.diskEncryption,
    ].join("|"),
  );
}

/** Checks an org recipe under the chain and seat book the box replayed from the recipe's genesis. */
export function verifyOrgInstallBlob(state: OrgAuthorityState, book: OrgSeatBook, b: OrgInstallBlob, now: number): { signers: string[] } {
  const order = canonicalOrgInstallBlob(b);
  if (b.orgId !== state.orgId || b.genesisHash !== state.genesisHash) throw new OrgAuthorityError("wrong-org");
  // As of the record the approvals name: a box may install days after the ceremony.
  const at = (a: readonly OrgApproval[]) => (Array.isArray(a) && a[0] ? a[0].oarVersion : -1);
  const code = verifyOrgRecordedApprovals(state, book, canonicalOrgServerCode(b.code), b.codeApprovals, at(b.codeApprovals), now, { kind: "add-server" });
  const blob = verifyOrgRecordedApprovals(state, book, order, b.approvals, at(b.approvals), now, { kind: "add-server" });
  return { signers: [...new Set([...code.signers, ...blob.signers])] };
}
