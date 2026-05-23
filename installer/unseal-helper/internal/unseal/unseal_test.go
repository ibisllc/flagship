package unseal

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"io"
	"testing"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"
)

// ── Go-side seal, mirroring encryption.ts sealForRecipient, so the unit test
//    can round-trip without the TS toolchain. The TS->Go cross-check
//    (tools/unseal-crosscheck) remains the authoritative wire gate.

func sealForRecipient(t *testing.T, plaintext, recipientX25519Pub []byte) []byte {
	t.Helper()
	ephPriv := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, ephPriv); err != nil {
		t.Fatal(err)
	}
	ephPub, err := curve25519.X25519(ephPriv, curve25519.Basepoint)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := curve25519.X25519(ephPriv, recipientX25519Pub)
	if err != nil {
		t.Fatal(err)
	}
	r := hkdf.New(sha256.New, shared, ephPub, []byte(FlagshipSealTag))
	key := make([]byte, 32)
	if _, err := io.ReadFull(r, key); err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	ct := aead.Seal(nil, nonce, plaintext, nil)
	out := make([]byte, 0, 32+12+len(ct))
	out = append(out, ephPub...)
	out = append(out, nonce...)
	out = append(out, ct...)
	return out
}

// x25519PubFromEd25519Seed derives the recipient's X25519 pubkey from the
// Ed25519 seed via the same scalar the box opens with: u = X25519(scalar, base).
func x25519PubFromEd25519Seed(t *testing.T, seed []byte) []byte {
	t.Helper()
	scalar, err := ed25519SeedToX25519Priv(seed)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := curve25519.X25519(scalar, curve25519.Basepoint)
	if err != nil {
		t.Fatal(err)
	}
	return pub
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestRawSealRoundTrip(t *testing.T) {
	seed := mustHex(t, "1f2e3d4c5b6a798897a6b5c4d3e2f1009f8e7d6c5b4a39281706f5e4d3c2b1a0")
	secret := []byte("a luks unlock key of arbitrary length 0123456789")
	pub := x25519PubFromEd25519Seed(t, seed)
	blob := sealForRecipient(t, secret, pub)

	got, err := OpenSealedFromEd25519Recipient(blob, seed)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if !bytes.Equal(got, secret) {
		t.Fatalf("round-trip mismatch: got %x want %x", got, secret)
	}
}

func TestRawSealWrongIdentityFails(t *testing.T) {
	seed := mustHex(t, "1f2e3d4c5b6a798897a6b5c4d3e2f1009f8e7d6c5b4a39281706f5e4d3c2b1a0")
	wrong := mustHex(t, "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")
	pub := x25519PubFromEd25519Seed(t, seed)
	blob := sealForRecipient(t, []byte("secret"), pub)

	if _, err := OpenSealedFromEd25519Recipient(blob, wrong); err == nil {
		t.Fatal("expected failure opening with the wrong identity key")
	}
}

func TestRawSealTamperedCiphertextFails(t *testing.T) {
	seed := mustHex(t, "1f2e3d4c5b6a798897a6b5c4d3e2f1009f8e7d6c5b4a39281706f5e4d3c2b1a0")
	pub := x25519PubFromEd25519Seed(t, seed)
	blob := sealForRecipient(t, []byte("secret value here"), pub)
	blob[50] ^= 0x01 // inside the ciphertext

	if _, err := OpenSealedFromEd25519Recipient(blob, seed); err == nil {
		t.Fatal("expected GCM tag mismatch on tampered ciphertext")
	}
}

func TestShortBlobFails(t *testing.T) {
	seed := mustHex(t, "1f2e3d4c5b6a798897a6b5c4d3e2f1009f8e7d6c5b4a39281706f5e4d3c2b1a0")
	if _, err := OpenSealedFromEd25519Recipient([]byte{1, 2, 3}, seed); err == nil {
		t.Fatal("expected failure on a too-short blob")
	}
}

func TestBadSeedLengthFails(t *testing.T) {
	if _, err := OpenSealedFromEd25519Recipient(make([]byte, 60), []byte{1, 2, 3}); err == nil {
		t.Fatal("expected failure on a bad seed length")
	}
}

// buildSealedSecretResponse mirrors phoneEndpoint.ts: prepend
// [ctxLen:4 BE][ctx] to the secret, then seal for the box's STK.
func buildSealedSecretResponse(t *testing.T, secret, seed []byte, nonceHex, purpose string) []byte {
	t.Helper()
	ctx := SecretResponseContext(nonceHex, purpose)
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(ctx)))
	payload := append(append(append([]byte{}, header...), ctx...), secret...)
	pub := x25519PubFromEd25519Seed(t, seed)
	return sealForRecipient(t, payload, pub)
}

func TestSealedSecretResponseRoundTrip(t *testing.T) {
	seed := mustHex(t, "1f2e3d4c5b6a798897a6b5c4d3e2f1009f8e7d6c5b4a39281706f5e4d3c2b1a0")
	nonceHex := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	secret := []byte("the disk key")
	sealed := buildSealedSecretResponse(t, secret, seed, nonceHex, "unlock-key")

	got, err := OpenSealedSecretResponse(sealed, seed, nonceHex, "unlock-key")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if !bytes.Equal(got, secret) {
		t.Fatalf("mismatch: got %q want %q", got, secret)
	}
}

func TestSealedSecretResponseWrongNonceFails(t *testing.T) {
	seed := mustHex(t, "1f2e3d4c5b6a798897a6b5c4d3e2f1009f8e7d6c5b4a39281706f5e4d3c2b1a0")
	nonceHex := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	sealed := buildSealedSecretResponse(t, []byte("k"), seed, nonceHex, "unlock-key")

	wrong := "0000000000000000000000000000000000000000000000000000000000000000"
	if _, err := OpenSealedSecretResponse(sealed, seed, wrong, "unlock-key"); err == nil {
		t.Fatal("expected failure on a nonce mismatch")
	}
}

func TestSealedSecretResponseWrongPurposeFails(t *testing.T) {
	seed := mustHex(t, "1f2e3d4c5b6a798897a6b5c4d3e2f1009f8e7d6c5b4a39281706f5e4d3c2b1a0")
	nonceHex := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	sealed := buildSealedSecretResponse(t, []byte("k"), seed, nonceHex, "unlock-key")

	if _, err := OpenSealedSecretResponse(sealed, seed, nonceHex, "entitlement"); err == nil {
		t.Fatal("expected failure on a purpose mismatch")
	}
}

// TestMontgomerySecretMatchesLibsodiumFormula asserts the birational map is
// exactly SHA-512(seed)[:32] with X25519 clamping (libsodium's
// crypto_sign_ed25519_sk_to_curve25519 / noble's toMontgomerySecret). A
// regression here is a silent boot-unlock break.
func TestMontgomerySecretMatchesLibsodiumFormula(t *testing.T) {
	seed := mustHex(t, "9d61b19deff31a5f7c4f7e4c8a2b1d4e5d6c7b8a9f0e1d2c3b4a596877869506")
	got, err := ed25519SeedToX25519Priv(seed)
	if err != nil {
		t.Fatal(err)
	}
	h := sha512.Sum512(seed)
	want := make([]byte, 32)
	copy(want, h[:32])
	want[0] &= 248
	want[31] &= 127
	want[31] |= 64
	if !bytes.Equal(got, want) {
		t.Fatalf("birational map mismatch: got %x want %x", got, want)
	}
}

// TestPinnedVector freezes a known protocol output INSIDE the Go test as well,
// so `go test ./...` alone (no Node) still catches a wire-format drift. These
// bytes were emitted by @flagship/protocol via tools/unseal-crosscheck and are
// kept identical to tests/pinned-vector.json.
func TestPinnedVector(t *testing.T) {
	const (
		seedHex   = "9d61b19deff31a5f7c4f7e4c8a2b1d4e5d6c7b8a9f0e1d2c3b4a596877869506"
		rawSealed = "8dc0e0bd9fceb5ecab0632c331aee422268719476d312a04aef93cacdc9abe2070043b6bc257e7498c3b89560d2b744dd9b532ab4b8e111200d30027b45ddc45245cd9af3eea784fb9aee483cc173ed5c63c57e048ddfd855f553af2"
		respSealed = "ca619d12010f13fca681e85356c97fb31b3441d6b0628aa71a0792ff6579054dbb46fa9b25c8b6248d9f3fabfc0ecef85cd349024ffaf1865460166c67c9982a4923733a9219b8d1acea22fc9181c1dcfaa21864875270f6d33e993ba1172b87597d30b13c8797e70da9bf38b79b769ec8acec2caa164b1534a9d9ec56cdd35c23aba2fe873f82c713e1c5f0336af86a40c9d012477d39117944a0958bd04fe2b86088c161a6b9f78337fdaf5f65b6007b154b24683aeaaa76ea1addedce827b25a586a24a479b"
		respNonce  = "05101b26313c47525d68737e89949faab5c0cbd6e1ecf7020d18232e39444f5a"
		respPurp   = "unlock-key"
		wantSecret = "030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc"
	)
	seed := mustHex(t, seedHex)

	rawGot, err := OpenSealedFromEd25519Recipient(mustHex(t, rawSealed), seed)
	if err != nil {
		t.Fatalf("pinned raw open: %v", err)
	}
	if hex.EncodeToString(rawGot) != wantSecret {
		t.Fatalf("pinned raw mismatch: got %x want %s", rawGot, wantSecret)
	}

	respGot, err := OpenSealedSecretResponse(mustHex(t, respSealed), seed, respNonce, respPurp)
	if err != nil {
		t.Fatalf("pinned response open: %v", err)
	}
	if hex.EncodeToString(respGot) != wantSecret {
		t.Fatalf("pinned response mismatch: got %x want %s", respGot, wantSecret)
	}
}
