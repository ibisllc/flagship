import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { base32Encode } from "./burnerPairing.js";
import { hex, resolveMsgSigner, validateNoSepCtrl, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const ACCOUNT_METADATA_SALT = "flagship/account-metadata/v1";
export const ACCOUNT_PROFILE_INFO = "account-profile";
export const DEVICE_DIRECTORY_INFO = "device-directory";
export const ACCOUNT_DEVICE_KEY_INFO = "flagship/account-device-key/v1";
export const PROFILE_KEY_BYTES = 32;
export const PROFILE_NONCE_BYTES = 12;
export const DEVICE_ID_BYTES = 16;
export const PROFILE_NAME_MAX_GRAPHEMES = 64;
export const PROFILE_NAME_MAX_UTF8_BYTES = 256;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;
const HEX_24 = /^[0-9a-f]{24}$/;
const HEX_CIPHERTEXT = /^[0-9a-f]+$/;
const FORBIDDEN_DIRECTIONAL_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const FORBIDDEN_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;

export type ProfileRecordType = "account-profile" | "device-self-profile" | "device-managed-profile";

export interface AccountProfilePlaintext {
  version: 1;
  displayName: string;
}

export interface DeviceProfilePlaintext {
  version: 1;
  displayName: string;
}

export interface EncryptedProfileFields {
  accountId: string;
  revision: number;
  keyVersion: number;
  nonceHex: string;
  ciphertextHex: string;
  issuedAt: number;
}

export interface AccountProfileEnvelope extends EncryptedProfileFields {
  signerPubHex: string;
  signatureHex: string;
}

export interface DeviceSelfProfileEnvelope extends EncryptedProfileFields {
  deviceId: string;
  signerPubHex: string;
  signatureHex: string;
}

export interface DeviceManagedProfileEnvelope extends EncryptedProfileFields {
  deviceId: string;
  locked: boolean;
  signerPubHex: string;
  signatureHex: string;
}

export interface AccountDirectoryRequest {
  accountId: string;
  deviceId: string;
  signerPubHex: string;
  method: string;
  path: string;
  requestId: string;
  issuedAt: number;
}

export interface AccountDirectoryKeyGrant {
  accountId: string;
  recipientDeviceId: string;
  keyKind: "account-profile" | "device-directory";
  sealedKeyHex: string;
  issuedAt: number;
  expiresAt: number;
  signerPubHex: string;
}

export function deriveAccountProfileKey(umk: Bytes): Bytes {
  return deriveMetadataKey(umk, ACCOUNT_PROFILE_INFO);
}

export function deriveDeviceDirectoryKey(umk: Bytes): Bytes {
  return deriveMetadataKey(umk, DEVICE_DIRECTORY_INFO);
}

export function deriveAccountDeviceKeySeed(umk: Bytes, accountId: string, deviceId: string): Bytes {
  if (umk.length !== 32) throw new Error("UMK must be 32 bytes");
  validateRecordCoordinates({ accountId, deviceId, revision: 1, keyVersion: 1 });
  return hkdf(
    sha256,
    umk,
    new Uint8Array(0),
    encoder.encode(`${ACCOUNT_DEVICE_KEY_INFO}|${accountId.toLowerCase()}|${deviceId}`),
    32,
  );
}

function deriveMetadataKey(umk: Bytes, info: string): Bytes {
  if (umk.length !== 32) throw new Error("UMK must be 32 bytes");
  return hkdf(sha256, umk, encoder.encode(ACCOUNT_METADATA_SALT), encoder.encode(info), PROFILE_KEY_BYTES);
}

export function generateDeviceId(random: (out: Uint8Array) => Uint8Array = crypto.getRandomValues.bind(crypto)): string {
  const bytes = new Uint8Array(DEVICE_ID_BYTES);
  random(bytes);
  return hex(bytes);
}

export function isDeviceId(value: string): boolean {
  return HEX_32.test(value);
}

export function deviceSupportCode(accountId: string, deviceId: string, devicePubHex: string): string {
  validateRecordCoordinates({ accountId, deviceId, revision: 1, keyVersion: 1 });
  if (!HEX_64.test(devicePubHex)) throw new Error("devicePubHex must be 32-byte lowercase hex");
  const digest = sha256(encoder.encode([
    "flagship/device-support-code/v1",
    accountId.toLowerCase(),
    deviceId,
    devicePubHex,
  ].join("|")));
  const compact = base32Encode(digest.slice(0, 5));
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function validateProfileDisplayName(input: string): string {
  if (typeof input !== "string") throw new Error("display name must be a string");
  const normalized = input.trim().normalize("NFC");
  if (normalized.length === 0) throw new Error("display name must not be empty");
  if (FORBIDDEN_CONTROLS.test(normalized)) throw new Error("display name contains a control character");
  if (FORBIDDEN_DIRECTIONAL_CONTROLS.test(normalized)) {
    throw new Error("display name contains a text-direction control character");
  }
  assertValidUnicode(normalized);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let graphemes = 0;
  for (const _ of segmenter.segment(normalized)) graphemes += 1;
  if (graphemes > PROFILE_NAME_MAX_GRAPHEMES) {
    throw new Error(`display name must be at most ${PROFILE_NAME_MAX_GRAPHEMES} grapheme clusters`);
  }
  if (encoder.encode(normalized).length > PROFILE_NAME_MAX_UTF8_BYTES) {
    throw new Error(`display name must be at most ${PROFILE_NAME_MAX_UTF8_BYTES} UTF-8 bytes`);
  }
  return normalized;
}

function assertValidUnicode(value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("display name contains invalid Unicode");
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error("display name contains invalid Unicode");
    }
  }
}

export function encryptAccountProfile(
  displayName: string,
  key: Bytes,
  fields: { accountId: string; revision: number; keyVersion: number; nonce?: Bytes },
): Pick<EncryptedProfileFields, "accountId" | "revision" | "keyVersion" | "nonceHex" | "ciphertextHex"> {
  return encryptProfile({ version: 1, displayName: validateProfileDisplayName(displayName) }, key, {
    ...fields,
    recordType: "account-profile",
  });
}

export function encryptDeviceProfile(
  displayName: string,
  key: Bytes,
  fields: {
    accountId: string;
    deviceId: string;
    revision: number;
    keyVersion: number;
    managed?: boolean;
    nonce?: Bytes;
  },
): Pick<EncryptedProfileFields, "accountId" | "revision" | "keyVersion" | "nonceHex" | "ciphertextHex"> {
  if (!isDeviceId(fields.deviceId)) throw new Error("deviceId must be 16-byte lowercase hex");
  return encryptProfile({ version: 1, displayName: validateProfileDisplayName(displayName) }, key, {
    ...fields,
    recordType: fields.managed ? "device-managed-profile" : "device-self-profile",
  });
}

function encryptProfile(
  plaintext: AccountProfilePlaintext | DeviceProfilePlaintext,
  key: Bytes,
  fields: {
    accountId: string;
    deviceId?: string;
    recordType: ProfileRecordType;
    revision: number;
    keyVersion: number;
    nonce?: Bytes;
  },
): Pick<EncryptedProfileFields, "accountId" | "revision" | "keyVersion" | "nonceHex" | "ciphertextHex"> {
  validateRecordCoordinates(fields);
  if (key.length !== PROFILE_KEY_BYTES) throw new Error("profile key must be 32 bytes");
  const nonce = fields.nonce ? new Uint8Array(fields.nonce) : crypto.getRandomValues(new Uint8Array(PROFILE_NONCE_BYTES));
  if (nonce.length !== PROFILE_NONCE_BYTES) throw new Error("profile nonce must be 12 bytes");
  const aad = profileAad(fields);
  const ciphertext = gcm(key, nonce, aad).encrypt(encoder.encode(JSON.stringify(plaintext)));
  return {
    accountId: fields.accountId.toLowerCase(),
    revision: fields.revision,
    keyVersion: fields.keyVersion,
    nonceHex: hex(nonce),
    ciphertextHex: hex(ciphertext),
  };
}

export function decryptAccountProfile(
  envelope: Pick<EncryptedProfileFields, "accountId" | "revision" | "keyVersion" | "nonceHex" | "ciphertextHex">,
  key: Bytes,
): AccountProfilePlaintext {
  return decryptProfile(envelope, key, "account-profile") as AccountProfilePlaintext;
}

export function decryptDeviceProfile(
  envelope: Pick<EncryptedProfileFields, "accountId" | "revision" | "keyVersion" | "nonceHex" | "ciphertextHex"> & { deviceId: string },
  key: Bytes,
  managed = false,
): DeviceProfilePlaintext {
  return decryptProfile(envelope, key, managed ? "device-managed-profile" : "device-self-profile") as DeviceProfilePlaintext;
}

function decryptProfile(
  envelope: Pick<EncryptedProfileFields, "accountId" | "revision" | "keyVersion" | "nonceHex" | "ciphertextHex"> & { deviceId?: string },
  key: Bytes,
  recordType: ProfileRecordType,
): AccountProfilePlaintext | DeviceProfilePlaintext {
  validateEncryptedFields(envelope);
  if (key.length !== PROFILE_KEY_BYTES) throw new Error("profile key must be 32 bytes");
  const nonce = bytesFromHex(envelope.nonceHex);
  const ciphertext = bytesFromHex(envelope.ciphertextHex);
  const plaintext = gcm(key, nonce, profileAad({ ...envelope, recordType })).decrypt(ciphertext);
  const parsed = JSON.parse(decoder.decode(plaintext)) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("invalid profile plaintext");
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).length !== 2 || obj.version !== 1 || typeof obj.displayName !== "string") {
    throw new Error("invalid profile plaintext schema");
  }
  return { version: 1, displayName: validateProfileDisplayName(obj.displayName) };
}

export function signAccountProfile(
  fields: Omit<AccountProfileEnvelope, "signatureHex">,
  signer: MsgSigner,
): string {
  return hex(resolveMsgSigner(signer)(canonicalAccountProfile(fields)));
}

export function verifyAccountProfile(envelope: AccountProfileEnvelope, signerPub: Bytes): boolean {
  try {
    return ed.verify(bytesFromHex(envelope.signatureHex), canonicalAccountProfile(envelope), signerPub);
  } catch {
    return false;
  }
}

export function signDeviceSelfProfile(
  fields: Omit<DeviceSelfProfileEnvelope, "signatureHex">,
  signer: MsgSigner,
): string {
  return hex(resolveMsgSigner(signer)(canonicalDeviceSelfProfile(fields)));
}

export function verifyDeviceSelfProfile(envelope: DeviceSelfProfileEnvelope, signerPub: Bytes): boolean {
  try {
    return ed.verify(bytesFromHex(envelope.signatureHex), canonicalDeviceSelfProfile(envelope), signerPub);
  } catch {
    return false;
  }
}

export function signDeviceManagedProfile(
  fields: Omit<DeviceManagedProfileEnvelope, "signatureHex">,
  signer: MsgSigner,
): string {
  return hex(resolveMsgSigner(signer)(canonicalDeviceManagedProfile(fields)));
}

export function verifyDeviceManagedProfile(envelope: DeviceManagedProfileEnvelope, signerPub: Bytes): boolean {
  try {
    return ed.verify(bytesFromHex(envelope.signatureHex), canonicalDeviceManagedProfile(envelope), signerPub);
  } catch {
    return false;
  }
}

export function signAccountDirectoryRequest(request: AccountDirectoryRequest, signer: MsgSigner): string {
  return hex(resolveMsgSigner(signer)(canonicalAccountDirectoryRequest(request)));
}

export function verifyAccountDirectoryRequest(
  request: AccountDirectoryRequest,
  signatureHex: string,
  signerPub: Bytes,
): boolean {
  try {
    return ed.verify(bytesFromHex(signatureHex), canonicalAccountDirectoryRequest(request), signerPub);
  } catch {
    return false;
  }
}

export function signAccountDirectoryKeyGrant(grant: AccountDirectoryKeyGrant, signer: MsgSigner): string {
  return hex(resolveMsgSigner(signer)(canonicalAccountDirectoryKeyGrant(grant)));
}

export function verifyAccountDirectoryKeyGrant(
  grant: AccountDirectoryKeyGrant,
  signatureHex: string,
  signerPub: Bytes,
): boolean {
  try {
    return ed.verify(bytesFromHex(signatureHex), canonicalAccountDirectoryKeyGrant(grant), signerPub);
  } catch {
    return false;
  }
}

export function accountDirectoryKeyGrantId(signatureHex: string): string {
  if (!HEX_128.test(signatureHex)) throw new Error("directory key grant signature must be 64-byte lowercase hex");
  return hex(sha256(bytesFromHex(signatureHex)));
}

function canonicalAccountProfile(fields: Omit<AccountProfileEnvelope, "signatureHex">): Bytes {
  validateSignedProfile(fields);
  return canonicalSigned("flagship/account-profile/v1", fields, "", "");
}

function canonicalDeviceSelfProfile(fields: Omit<DeviceSelfProfileEnvelope, "signatureHex">): Bytes {
  validateSignedProfile(fields, fields.deviceId);
  return canonicalSigned("flagship/device-profile-self/v1", fields, fields.deviceId, "");
}

function canonicalDeviceManagedProfile(fields: Omit<DeviceManagedProfileEnvelope, "signatureHex">): Bytes {
  validateSignedProfile(fields, fields.deviceId);
  return canonicalSigned(
    "flagship/device-profile-admin/v1",
    fields,
    fields.deviceId,
    fields.locked ? "1" : "0",
  );
}

function canonicalAccountDirectoryRequest(request: AccountDirectoryRequest): Bytes {
  validateRecordCoordinates({ accountId: request.accountId, deviceId: request.deviceId, revision: 1, keyVersion: 1 });
  validateNoSepCtrl("method", request.method);
  validateNoSepCtrl("path", request.path);
  if (!/^[A-Z]+$/.test(request.method)) throw new Error("method must be uppercase ASCII");
  if (!request.path.startsWith("/api/accounts/")) throw new Error("path must be an account API path");
  if (!HEX_32.test(request.requestId)) throw new Error("requestId must be 16-byte lowercase hex");
  if (!HEX_64.test(request.signerPubHex)) throw new Error("signerPubHex must be 32-byte lowercase hex");
  if (!Number.isSafeInteger(request.issuedAt) || request.issuedAt <= 0) throw new Error("issuedAt must be positive");
  return encoder.encode([
    "flagship/account-directory-request/v1",
    request.method,
    request.path,
    request.accountId.toLowerCase(),
    request.deviceId,
    request.signerPubHex,
    request.requestId,
    request.issuedAt,
  ].join("|"));
}

function canonicalAccountDirectoryKeyGrant(grant: AccountDirectoryKeyGrant): Bytes {
  validateRecordCoordinates({ accountId: grant.accountId, deviceId: grant.recipientDeviceId, revision: 1, keyVersion: 1 });
  if (grant.keyKind !== "account-profile" && grant.keyKind !== "device-directory") {
    throw new Error("invalid directory key kind");
  }
  if (!HEX_CIPHERTEXT.test(grant.sealedKeyHex) || grant.sealedKeyHex.length < 2) {
    throw new Error("sealedKeyHex must be lowercase hex");
  }
  if (!HEX_64.test(grant.signerPubHex)) throw new Error("signerPubHex must be 32-byte lowercase hex");
  if (!Number.isSafeInteger(grant.issuedAt) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= grant.issuedAt) {
    throw new Error("directory key grant expiry must follow issuance");
  }
  return encoder.encode([
    "flagship/account-directory-key-grant/v1",
    grant.accountId.toLowerCase(),
    grant.recipientDeviceId,
    grant.keyKind,
    grant.sealedKeyHex,
    grant.issuedAt,
    grant.expiresAt,
    grant.signerPubHex,
  ].join("|"));
}

function canonicalSigned(
  tag: string,
  fields: Omit<AccountProfileEnvelope, "signatureHex">,
  deviceId: string,
  locked: string,
): Bytes {
  return encoder.encode([
    tag,
    fields.accountId.toLowerCase(),
    deviceId,
    fields.revision,
    fields.keyVersion,
    fields.nonceHex,
    fields.ciphertextHex,
    locked,
    fields.issuedAt,
    fields.signerPubHex,
  ].join("|"));
}

function validateSignedProfile(
  fields: Omit<AccountProfileEnvelope, "signatureHex">,
  deviceId?: string,
): void {
  validateEncryptedFields({ ...fields, ...(deviceId ? { deviceId } : {}) });
  if (!Number.isSafeInteger(fields.issuedAt) || fields.issuedAt <= 0) throw new Error("issuedAt must be positive");
  if (!HEX_64.test(fields.signerPubHex)) throw new Error("signerPubHex must be 32-byte lowercase hex");
}

function validateEncryptedFields(
  fields: Pick<EncryptedProfileFields, "accountId" | "revision" | "keyVersion" | "nonceHex" | "ciphertextHex"> & { deviceId?: string },
): void {
  validateRecordCoordinates(fields);
  if (!HEX_24.test(fields.nonceHex)) throw new Error("nonceHex must be 12-byte lowercase hex");
  if (!HEX_CIPHERTEXT.test(fields.ciphertextHex) || fields.ciphertextHex.length < 32 || fields.ciphertextHex.length % 2 !== 0) {
    throw new Error("ciphertextHex must contain AES-GCM ciphertext and tag");
  }
}

function validateRecordCoordinates(fields: {
  accountId: string;
  deviceId?: string;
  revision: number;
  keyVersion: number;
}): void {
  validateNoSepCtrl("accountId", fields.accountId);
  if (fields.accountId.length === 0) throw new Error("accountId must not be empty");
  if (fields.deviceId !== undefined && !isDeviceId(fields.deviceId)) {
    throw new Error("deviceId must be 16-byte lowercase hex");
  }
  if (!Number.isSafeInteger(fields.revision) || fields.revision < 1) throw new Error("revision must be >= 1");
  if (!Number.isSafeInteger(fields.keyVersion) || fields.keyVersion < 1) throw new Error("keyVersion must be >= 1");
}

function profileAad(fields: {
  accountId: string;
  deviceId?: string;
  recordType: ProfileRecordType;
  revision: number;
  keyVersion: number;
}): Bytes {
  return encoder.encode([
    "flagship/account-metadata-aad/v1",
    fields.accountId.toLowerCase(),
    fields.recordType,
    fields.deviceId ?? "",
    fields.revision,
    fields.keyVersion,
  ].join("|"));
}

function bytesFromHex(value: string): Bytes {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) throw new Error("invalid lowercase hex");
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}
