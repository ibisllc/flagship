// flagship-unseal — a tiny static binary that runs in the pre-unlock
// initramfs, where /opt/flagship (node + the @flagship/protocol code) sits on
// the still-LUKS-encrypted root and is unavailable, and plain openssl can't do
// the Ed25519->X25519 private-key birational map. It unseals the phone's reply
// using the box's Ed25519 identity (STK) key.
//
// Wire-compatible, byte-for-byte, with packages/protocol/src/encryption.ts
// (sealForRecipient / sealForEd25519Recipient) and the SealedSecretResponse
// wrapper in packages/protocol/src/phoneEndpoint.ts.
module github.com/flagship/installer/unseal-helper

go 1.22

require golang.org/x/crypto v0.31.0
