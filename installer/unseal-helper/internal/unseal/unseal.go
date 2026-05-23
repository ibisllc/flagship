// Package unseal reproduces, byte-for-byte, the public-key seal format and the
// SealedSecretResponse wrapper from the TypeScript @flagship/protocol so a
// booting box can open a phone-sealed boot secret with nothing but a static Go
// binary on its unencrypted /boot.
//
// The authoritative spec is the TS source — this package mirrors:
//
//   packages/protocol/src/encryption.ts
//       sealForRecipient / sealForEd25519Recipient / openSealed /
//       openSealedFromEd25519Recipient
//   packages/protocol/src/phoneEndpoint.ts
//       buildSealedSecretResponse / openSealedSecretResponse
//
// The TS->Go cross-check test (tools/unseal-crosscheck) is the authoritative
// gate; a future protocol change that breaks the wire is meant to fail it.
package unseal

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"
)

// FlagshipSealTag is the HKDF `info` string used by sealForRecipient. It MUST
// match FLAGSHIP_SEAL_TAG in encryption.ts exactly — it is mixed into the AEAD
// key derivation, so any drift produces a different key and a tag mismatch.
const FlagshipSealTag = "flagship.seal.v1"

// TagSecretResponseCtx is the canonical-bytes tag prefix of the context header
// bound into a SealedSecretResponse. MUST match TAG_SECRET_RESPONSE_CTX in
// phoneEndpoint.ts.
const TagSecretResponseCtx = "flagship/secret-response/v1"

// Wire-layout constants for a sealed blob:
//
//	[eph_x25519_pub: 32][nonce: 12][AES-256-GCM ciphertext+tag: var]
const (
	ephPubLen = 32
	nonceLen  = 12
	headerLen = ephPubLen + nonceLen // 44
)

// ed25519SeedToX25519Priv reproduces noble's toMontgomerySecret /
// edwards25519.utils.toMontgomerySecret, which is libsodium's
// crypto_sign_ed25519_sk_to_curve25519:
//
//	hashed = SHA-512(seed)            // seed is the 32-byte Ed25519 seed
//	scalar = clamp(hashed[:32])       // RFC 7748 X25519 clamping
//
// This is the birational map from the Ed25519 *private* seed to the X25519
// scalar. It is NOT a coordinate map of the public key — Ed25519 derives its
// signing scalar from SHA-512 of the seed, and the same scalar (clamped) is the
// X25519 private key. Getting this exactly right is the whole point of this
// helper: plain openssl cannot do it.
func ed25519SeedToX25519Priv(seed []byte) ([]byte, error) {
	if len(seed) != 32 {
		return nil, fmt.Errorf("identity Ed25519 priv (seed) must be 32 bytes, got %d", len(seed))
	}
	h := sha512.Sum512(seed)
	scalar := make([]byte, 32)
	copy(scalar, h[:32])
	// adjustScalarBytes — identical to noble's adjustScalarBytes and to the
	// clamp curve25519.X25519 applies internally (so the explicit clamp here is
	// idempotent with the library's, never a divergence).
	scalar[0] &= 248
	scalar[31] &= 127
	scalar[31] |= 64
	return scalar, nil
}

// deriveSealKey reproduces:
//
//	key = HKDF-SHA256(ikm=shared, salt=ephPub, info="flagship.seal.v1", len=32)
//
// noble's hkdf(sha256, shared, ephPub, info, 32) maps to Go's
// hkdf.New(sha256.New, shared, salt=ephPub, info). HKDF with an empty/derived
// salt would differ — here the salt is the 32-byte ephemeral pubkey, matching
// encryption.ts.
func deriveSealKey(shared, ephPub []byte) ([]byte, error) {
	r := hkdf.New(sha256.New, shared, ephPub, []byte(FlagshipSealTag))
	key := make([]byte, 32)
	if _, err := io.ReadFull(r, key); err != nil {
		return nil, fmt.Errorf("hkdf: %w", err)
	}
	return key, nil
}

// OpenSealed mirrors encryption.ts openSealed: given a sealed blob and the
// recipient's X25519 private scalar, recover the plaintext.
//
//	ephPub  = blob[0:32]
//	nonce   = blob[32:44]
//	ct      = blob[44:]
//	shared  = X25519(recipientPriv, ephPub)
//	key     = HKDF-SHA256(shared, salt=ephPub, info=FLAGSHIP_SEAL_TAG)
//	plain   = AES-256-GCM(key, nonce).Open(ct)
func OpenSealed(blob, recipientX25519Priv []byte) ([]byte, error) {
	if len(blob) < headerLen {
		return nil, errors.New("sealed blob too short (need at least eph_pub + nonce)")
	}
	if len(recipientX25519Priv) != 32 {
		return nil, fmt.Errorf("recipient X25519 priv must be 32 bytes, got %d", len(recipientX25519Priv))
	}
	ephPub := blob[:ephPubLen]
	nonce := blob[ephPubLen:headerLen]
	ct := blob[headerLen:]

	// curve25519.X25519 returns an error on an all-zero (low-order) output,
	// matching noble's `if (pu === _0n) throw`.
	shared, err := curve25519.X25519(recipientX25519Priv, ephPub)
	if err != nil {
		return nil, fmt.Errorf("x25519: %w", err)
	}
	key, err := deriveSealKey(shared, ephPub)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("aes: %w", err)
	}
	// noble's gcm uses the standard 12-byte nonce + 16-byte tag; Go's
	// cipher.NewGCM defaults to exactly that.
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("gcm: %w", err)
	}
	plain, err := aead.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, fmt.Errorf("gcm open (tag mismatch / wrong key): %w", err)
	}
	return plain, nil
}

// OpenSealedFromEd25519Recipient mirrors encryption.ts
// openSealedFromEd25519Recipient: convert the box's 32-byte Ed25519 seed to its
// X25519 scalar (birational map), then OpenSealed.
func OpenSealedFromEd25519Recipient(blob, recipientEd25519Seed []byte) ([]byte, error) {
	x25519Priv, err := ed25519SeedToX25519Priv(recipientEd25519Seed)
	if err != nil {
		return nil, err
	}
	return OpenSealed(blob, x25519Priv)
}

// SecretResponseContext reproduces phoneEndpoint.ts secretResponseContext:
//
//	"flagship/secret-response/v1" | hex(nonce) | purpose
//
// joined with the canonical-bytes '|' separator, UTF-8 encoded.
func SecretResponseContext(nonceHex, purpose string) []byte {
	return []byte(TagSecretResponseCtx + "|" + nonceHex + "|" + purpose)
}

// OpenSealedSecretResponse mirrors phoneEndpoint.ts openSealedSecretResponse.
//
// The inner plaintext is length-prefixed:
//
//	[ctxLen: 4 bytes big-endian][ctx][secret]
//
// where ctx = SecretResponseContext(nonceHex, purpose). The caller passes the
// (nonceHex, purpose) of the request the box actually sent; this verifies the
// embedded ctx matches and rejects a response bound to a different
// (nonce, purpose) — anti-replay / anti-repurpose. Returns the recovered
// secret with the header stripped.
func OpenSealedSecretResponse(sealed, recipientEd25519Seed []byte, expectNonceHex, expectPurpose string) ([]byte, error) {
	payload, err := OpenSealedFromEd25519Recipient(sealed, recipientEd25519Seed)
	if err != nil {
		return nil, err
	}
	if len(payload) < 4 {
		return nil, errors.New("sealed secret response payload too short")
	}
	ctxLen := binary.BigEndian.Uint32(payload[:4])
	if uint64(len(payload)) < uint64(4)+uint64(ctxLen) {
		return nil, errors.New("sealed secret response payload truncated")
	}
	ctx := payload[4 : 4+ctxLen]
	expected := SecretResponseContext(expectNonceHex, expectPurpose)
	if len(ctx) != len(expected) {
		return nil, errors.New("sealed secret response bound to a different (nonce, purpose)")
	}
	for i := range ctx {
		if ctx[i] != expected[i] {
			return nil, errors.New("sealed secret response bound to a different (nonce, purpose)")
		}
	}
	return payload[4+ctxLen:], nil
}
