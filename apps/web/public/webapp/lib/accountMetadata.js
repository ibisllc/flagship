const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const ACCOUNT_METADATA_SALT = "flagship/account-metadata/v1";
export const ACCOUNT_PROFILE_INFO = "account-profile";
export const DEVICE_DIRECTORY_INFO = "device-directory";

export async function deriveAccountProfileKey(umk) {
  return deriveMetadataKey(umk, ACCOUNT_PROFILE_INFO);
}

export async function deriveDeviceDirectoryKey(umk) {
  return deriveMetadataKey(umk, DEVICE_DIRECTORY_INFO);
}

export function generateDeviceId() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function deviceSupportCode(accountId, deviceId, devicePublicKey) {
  const pubHex = devicePublicKey instanceof Uint8Array ? toHex(devicePublicKey) : devicePublicKey;
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`flagship/device-support-code/v1|${accountId}|${deviceId}|${pubHex}`),
  ));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let accumulator = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of digest) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < 8) {
      bits -= 5;
      encoded += alphabet[(accumulator >>> bits) & 31];
    }
    if (encoded.length === 8) break;
  }
  return `${encoded.slice(0, 4)}-${encoded.slice(4, 8)}`;
}

async function deriveMetadataKey(umk, info) {
  if (!(umk instanceof Uint8Array) || umk.length !== 32) throw new Error("UMK must be 32 bytes");
  const source = await crypto.subtle.importKey("raw", umk, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: encoder.encode(ACCOUNT_METADATA_SALT),
    info: encoder.encode(info),
  }, source, 256);
  return new Uint8Array(bits);
}

export function validateProfileDisplayName(input) {
  if (typeof input !== "string") throw new Error("display name must be a string");
  const value = input.trim().normalize("NFC");
  if (!value) throw new Error("display name must not be empty");
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error("display name contains a control character");
  if (/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error("display name contains a text-direction control character");
  }
  let graphemes = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) graphemes += 1;
  if (graphemes > 64) throw new Error("display name must be at most 64 grapheme clusters");
  if (encoder.encode(value).length > 256) throw new Error("display name must be at most 256 UTF-8 bytes");
  return value;
}

export async function encryptProfile(displayName, keyBytes, fields) {
  const name = validateProfileDisplayName(displayName);
  validateFields(fields);
  const nonce = fields.nonce ?? crypto.getRandomValues(new Uint8Array(12));
  if (!(nonce instanceof Uint8Array) || nonce.length !== 12) throw new Error("profile nonce must be 12 bytes");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const plaintext = encoder.encode(`{"version":1,"displayName":${JSON.stringify(name)}}`);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: profileAad(fields), tagLength: 128 },
    key,
    plaintext,
  );
  return { nonceHex: toHex(nonce), ciphertextHex: toHex(new Uint8Array(ciphertext)) };
}

export async function decryptProfile(envelope, keyBytes) {
  validateFields(envelope);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromHex(envelope.nonceHex),
      additionalData: profileAad(envelope),
      tagLength: 128,
    },
    key,
    fromHex(envelope.ciphertextHex),
  );
  const parsed = JSON.parse(decoder.decode(plaintext));
  if (!parsed || parsed.version !== 1 || typeof parsed.displayName !== "string" || Object.keys(parsed).length !== 2) {
    throw new Error("invalid profile plaintext schema");
  }
  return validateProfileDisplayName(parsed.displayName);
}

function validateFields(fields) {
  if (!fields || typeof fields.accountId !== "string" || !fields.accountId || fields.accountId.includes("|")) {
    throw new Error("invalid accountId");
  }
  if (!["account-profile", "device-self-profile", "device-managed-profile"].includes(fields.recordType)) {
    throw new Error("invalid record type");
  }
  if (fields.recordType === "account-profile") {
    if (fields.deviceId !== undefined && fields.deviceId !== "") throw new Error("account profile must not carry deviceId");
  } else if (!/^[0-9a-f]{32}$/.test(fields.deviceId ?? "")) {
    throw new Error("invalid deviceId");
  }
  if (!Number.isSafeInteger(fields.revision) || fields.revision < 1) throw new Error("invalid revision");
  if (!Number.isSafeInteger(fields.keyVersion) || fields.keyVersion < 1) throw new Error("invalid key version");
}

function profileAad(fields) {
  return encoder.encode([
    "flagship/account-metadata-aad/v1",
    fields.accountId.toLowerCase(),
    fields.recordType,
    fields.deviceId ?? "",
    fields.revision,
    fields.keyVersion,
  ].join("|"));
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value) {
  if (typeof value !== "string" || value.length % 2 || !/^[0-9a-f]+$/.test(value)) throw new Error("invalid hex");
  return Uint8Array.from(value.match(/../g).map((part) => Number.parseInt(part, 16)));
}
