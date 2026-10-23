package unseal

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

// TagAutoUnlockLeaseV2 must match TAG_AUTO_UNLOCK_LEASE_V2 in phoneEndpoint.ts.
const TagAutoUnlockLeaseV2 = "flagship/auto-unlock-lease/v2"

// The messages are shared with the TS, Rust and phone tests through
// packages/protocol/test-vectors/boot-key/vectors.json.
var (
	ErrLeaseMalformed    = errors.New("lease is malformed")
	ErrLeaseOtherServer  = errors.New("lease is for another server")
	ErrLeaseRecipient    = errors.New("lease is not sealed to this box's boot key")
	ErrLeaseSignature    = errors.New("lease signature does not verify under the owner key")
	ErrLeaseExpired      = errors.New("lease has expired")
	ErrIdentityNotPKCS8  = errors.New("identity key is not an Ed25519 PKCS#8 private key")
	ErrIdentityNotPEM    = errors.New("identity key is not a PEM PRIVATE KEY block")
	pkcs8Ed25519V1Prefix = []byte{0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20}
)

// SeedFromPKCS8PEM returns the 32-byte Ed25519 seed of the PKCS#8 v1 PEM the
// install path writes (scripts/install-helper.ts pkcs8PemFromRaw).
func SeedFromPKCS8PEM(pem []byte) ([]byte, error) {
	const begin, end = "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"
	s := string(pem)
	i := strings.Index(s, begin)
	j := strings.Index(s, end)
	if i < 0 || j < i {
		return nil, ErrIdentityNotPEM
	}
	body := strings.Map(func(r rune) rune {
		if r == ' ' || r == '\n' || r == '\r' || r == '\t' {
			return -1
		}
		return r
	}, s[i+len(begin):j])
	der, err := base64.StdEncoding.DecodeString(body)
	if err != nil || len(der) != 48 || !bytes.Equal(der[:16], pkcs8Ed25519V1Prefix) {
		return nil, ErrIdentityNotPKCS8
	}
	seed := make([]byte, 32)
	copy(seed, der[16:])
	for k := range der {
		der[k] = 0
	}
	return seed, nil
}

type leaseJSON struct {
	ServerDomain *string `json:"serverDomain"`
	LeaseID      *string `json:"leaseId"`
	StkPub       *string `json:"stkPub"`
	SealedKey    *string `json:"sealedKey"`
	IssuedAt     *int64  `json:"issuedAt"`
	ExpiresAt    *int64  `json:"expiresAt"`
	MaxUses      *int64  `json:"maxUses"`
	Signature    *string `json:"signature"`
}

func canonicalField(s string) bool {
	for _, c := range []byte(s) {
		if c == '|' || c <= 0x1f || c == 0x7f {
			return false
		}
	}
	return s != ""
}

func hexOf(s string, n int) ([]byte, bool) {
	b, err := hex.DecodeString(s)
	if err != nil || (n > 0 && len(b) != n) || len(b) == 0 {
		return nil, false
	}
	return b, true
}

// OpenAutoUnlockLease checks a lease as GET /api/boot/lease returns it before
// opening it: the server is this box, the recipient is this box's key (the
// one derived from seed), the owner signed it, and it has not expired by the
// box's clock. The boot worker also enforces expiry, maxUses and revocation;
// the box cannot count uses itself, and its clock before an authenticated
// time source exists may be wrong (a clock that is behind accepts a lease the
// worker should already have refused; one that is ahead falls back to asking
// the phone).
func OpenAutoUnlockLease(leaseBody, seed []byte, serverDomain string, ownerPub []byte, nowMs int64) ([]byte, error) {
	var l leaseJSON
	if err := json.Unmarshal(leaseBody, &l); err != nil {
		return nil, ErrLeaseMalformed
	}
	if l.ServerDomain == nil || l.LeaseID == nil || l.StkPub == nil || l.SealedKey == nil ||
		l.IssuedAt == nil || l.ExpiresAt == nil || l.Signature == nil ||
		!canonicalField(*l.ServerDomain) || !canonicalField(*l.LeaseID) || len(ownerPub) != ed25519.PublicKeySize {
		return nil, ErrLeaseMalformed
	}
	recipient, ok1 := hexOf(*l.StkPub, 32)
	sealed, ok2 := hexOf(*l.SealedKey, 0)
	sig, ok3 := hexOf(*l.Signature, 64)
	if !ok1 || !ok2 || !ok3 {
		return nil, ErrLeaseMalformed
	}
	if !strings.EqualFold(*l.ServerDomain, serverDomain) {
		return nil, ErrLeaseOtherServer
	}
	own := ed25519.NewKeyFromSeed(seed)
	if !bytes.Equal(recipient, own.Public().(ed25519.PublicKey)) {
		return nil, ErrLeaseRecipient
	}
	maxUses := int64(-1)
	if l.MaxUses != nil {
		maxUses = *l.MaxUses
	}
	canonical := strings.Join([]string{
		TagAutoUnlockLeaseV2,
		*l.ServerDomain,
		hex.EncodeToString(recipient),
		*l.LeaseID,
		hex.EncodeToString(sealed),
		strconv.FormatInt(*l.IssuedAt, 10),
		strconv.FormatInt(*l.ExpiresAt, 10),
		strconv.FormatInt(maxUses, 10),
	}, "|")
	if !ed25519.Verify(ownerPub, []byte(canonical), sig) {
		return nil, ErrLeaseSignature
	}
	if *l.ExpiresAt <= nowMs {
		return nil, ErrLeaseExpired
	}
	return OpenSealedFromEd25519Recipient(sealed, seed)
}
