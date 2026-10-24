package unseal

// Boot unlock v2 (packages/protocol/src/bootUnlockV2.ts, docs/architecture-v2/pq-suites.md §19):
// the box side of the hybrid reply and the v3 lease, plus the hybrid-signed v2 request. The seal
// is flagship/hybrid-seal/v1 (X-Wing, HKDF-SHA-512, AES-256-GCM) and the signatures
// flagship/hybrid-sig/ed25519-mldsa65/v1; both are checked against the shared vectors in
// packages/protocol/test-vectors/boot-unlock-v2/vectors.json.
//
// Ed25519 here is Go's cofactorless verify. The strict profile the other ports use refuses
// torsion-carrying keys and R values; the only keys this verifies under (the owner key on /boot,
// written by the daemon from a binding it verified) are torsion-free, and with a torsion-free key
// the cofactorless equation cannot hold for a torsion-carrying R, so the verdicts agree.

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/cloudflare/circl/kem/xwing"
	"github.com/cloudflare/circl/sign/mldsa/mldsa65"
	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"
	"golang.org/x/crypto/sha3"
)

const (
	TagEnvelopeV2         = "flagship/envelope/v2"
	TagHybridSealV1       = "flagship/hybrid-seal/v1"
	TagHybridSig          = "flagship/hybrid-sig/ed25519-mldsa65/v1"
	TagPqKeyID            = "flagship/pq-key-id/v1"
	TagSecretRequestV1    = "flagship/secret-request/v1"
	TagSecretRequestV2    = "flagship/secret-request/v2"
	TagBootReplyV2        = "flagship/boot-reply/v2"
	TagAutoUnlockLeaseV3  = "flagship/auto-unlock-lease/v3"
	SuiteHybridSeal       = 0x0001
	SuiteHybridSig        = 0x0002
	HybridSigPublicKeyLen = 32 + mldsa65.PublicKeySize
	HybridSigLen          = 64 + mldsa65.SignatureSize
	KemPublicKeyLen       = xwing.PublicKeySize
	kemEncLen             = xwing.CiphertextSize
	gcmTagLen             = 16
	maxDiskKey            = 1024
)

// V2Error is a refusal; Code matches bootUnlockV2.ts and the vectors' `expect`.
type V2Error struct{ Code string }

func (e *V2Error) Error() string { return "boot-unlock-v2: " + e.Code }

func v2err(code string) error { return &V2Error{Code: code} }

// V2Code returns the vector code of err, or "" when it is not a v2 refusal.
func V2Code(err error) string {
	var e *V2Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// IsV2Sealed reports whether b is a v2 envelope; a v1 seal starts with an X25519 point.
func IsV2Sealed(b []byte) bool {
	return len(b) > 21 && b[0] == byte(len(TagEnvelopeV2)) && string(b[1:21]) == TagEnvelopeV2
}

// ParseUnlockPolicy reads /boot/flagship-unlock-policy as bootUnlockV2.ts does: no file is
// compat, exactly "compat" or "strict" (one trailing newline allowed) are themselves, anything
// else is strict once the box holds v2 material.
func ParseUnlockPolicy(text []byte, present, hasV2Material bool) string {
	if !present {
		return "compat"
	}
	t := strings.TrimSuffix(string(text), "\n")
	switch {
	case t == "compat":
		return "compat"
	case t == "strict", hasV2Material:
		return "strict"
	}
	return "compat"
}

// BoxAcceptsVersion refuses a classical reply or lease under strict.
func BoxAcceptsVersion(policy string, sealed []byte) error {
	if policy == "strict" && !IsV2Sealed(sealed) {
		return v2err("strict-refuses-v1")
	}
	return nil
}

func lp8(s string) []byte { return append([]byte{byte(len(s))}, s...) }

func u16(n int) []byte { return binary.BigEndian.AppendUint16(nil, uint16(n)) }

func u32(n int) []byte { return binary.BigEndian.AppendUint32(nil, uint32(n)) }

// PqKeyID is SHA-512(lp8(tag) || u16be(suite) || u16be(len pk) || pk)[:32].
func PqKeyID(suite int, pk []byte) []byte {
	h := sha512.New()
	h.Write(lp8(TagPqKeyID))
	h.Write(u16(suite))
	h.Write(u16(len(pk)))
	h.Write(pk)
	return h.Sum(nil)[:32]
}

func hybridMessage(pk []byte, purpose string, payload []byte) []byte {
	m := lp8(TagHybridSig)
	m = append(m, u16(SuiteHybridSig)...)
	m = append(m, pk...)
	m = append(m, lp8(purpose)...)
	m = append(m, u32(len(payload))...)
	return append(m, payload...)
}

// HybridVerify is true when BOTH halves verify over M' (pq-suites.md §5).
func HybridVerify(pk []byte, purpose string, payload, sig []byte) bool {
	if len(pk) != HybridSigPublicKeyLen || len(sig) != HybridSigLen || len(purpose) == 0 || len(purpose) > 128 {
		return false
	}
	var mpk mldsa65.PublicKey
	var raw [mldsa65.PublicKeySize]byte
	copy(raw[:], pk[32:])
	mpk.Unpack(&raw)
	m := hybridMessage(pk, purpose, payload)
	edOK := ed25519.Verify(ed25519.PublicKey(pk[:32]), m, sig[:64])
	mlOK := mldsa65.Verify(&mpk, m, []byte(TagHybridSig), sig[64:])
	return edOK && mlOK
}

// HybridPublicKey is ed25519 pub || ML-DSA-65 pub for the two seeds.
func HybridPublicKey(edSeed, mldsaSeed []byte) []byte {
	edPub := ed25519.NewKeyFromSeed(edSeed).Public().(ed25519.PublicKey)
	var s [mldsa65.SeedSize]byte
	copy(s[:], mldsaSeed)
	mpk, _ := mldsa65.NewKeyFromSeed(&s)
	b, _ := mpk.MarshalBinary()
	return append(append([]byte{}, edPub...), b...)
}

// HybridSign signs with both halves; deterministic uses ML-DSA rnd = 0 (vectors only).
func HybridSign(edSeed, mldsaSeed []byte, purpose string, payload []byte, deterministic bool) ([]byte, error) {
	if len(edSeed) != 32 || len(mldsaSeed) != 32 {
		return nil, v2err("v2-malformed")
	}
	pk := HybridPublicKey(edSeed, mldsaSeed)
	m := hybridMessage(pk, purpose, payload)
	var s [mldsa65.SeedSize]byte
	copy(s[:], mldsaSeed)
	_, msk := mldsa65.NewKeyFromSeed(&s)
	for i := range s {
		s[i] = 0
	}
	mlSig := make([]byte, mldsa65.SignatureSize)
	if err := mldsa65.SignTo(msk, m, []byte(TagHybridSig), !deterministic, mlSig); err != nil {
		return nil, err
	}
	edSig := ed25519.Sign(ed25519.NewKeyFromSeed(edSeed), m)
	return append(edSig, mlSig...), nil
}

// KemPublicKey derives the X-Wing public key of a 32-byte seed.
func KemPublicKey(seed []byte) []byte {
	_, pk := xwing.DeriveKeyPair(seed)
	b := make([]byte, xwing.PublicKeySize)
	pk.Pack(b)
	return b
}

// envelope header (pq-suites.md §3), decoded and checked the way both reference ports do.
type envHeader struct {
	purpose      string
	suite        int
	sender       []byte
	recipient    []byte
	sessionNonce []byte
	issuedAt     uint64
	expiresAt    *uint64
	bodyLen      int
}

var fixedLen = map[byte]int{2: 2, 3: 32, 4: 32, 5: 16, 6: 8, 7: 32, 8: 64, 9: 8, 10: 8, 11: 4}

func decodeEnvelope(b []byte) (*envHeader, []byte, []byte, error) {
	bad := v2err("v2-malformed")
	if !IsV2Sealed(b) || len(b) < 23 {
		return nil, nil, nil, bad
	}
	tlvLen := int(binary.BigEndian.Uint16(b[21:23]))
	end := 23 + tlvLen
	if end > 1024 || len(b) < end {
		return nil, nil, nil, bad
	}
	h := &envHeader{}
	seen := 0
	last := -1
	for p := 23; p < end; {
		if end-p < 3 {
			return nil, nil, nil, bad
		}
		t := b[p]
		n := int(binary.BigEndian.Uint16(b[p+1 : p+3]))
		p += 3
		if end-p < n || int(t) <= last || t == 0 || t > 11 {
			return nil, nil, nil, bad
		}
		last = int(t)
		v := b[p : p+n]
		p += n
		if fl, ok := fixedLen[t]; ok && n != fl {
			return nil, nil, nil, bad
		}
		switch t {
		case 1:
			if n == 0 || n > 128 {
				return nil, nil, nil, bad
			}
			h.purpose = string(v)
		case 2:
			h.suite = int(binary.BigEndian.Uint16(v))
		case 3:
			h.sender = v
		case 4:
			h.recipient = v
		case 7:
			h.sessionNonce = v
		case 9:
			h.issuedAt = binary.BigEndian.Uint64(v)
		case 10:
			e := binary.BigEndian.Uint64(v)
			h.expiresAt = &e
		case 11:
			h.bodyLen = int(binary.BigEndian.Uint32(v))
		}
		seen |= 1 << t
	}
	need := 1<<1 | 1<<2 | 1<<3 | 1<<9 | 1<<11
	if seen&need != need || h.issuedAt > 1<<53-1 || (h.expiresAt != nil && (*h.expiresAt > 1<<53-1 || *h.expiresAt <= h.issuedAt)) {
		return nil, nil, nil, bad
	}
	if len(b)-end != h.bodyLen {
		return nil, nil, nil, bad
	}
	return h, b[:end], b[end:], nil
}

// hybridOpen opens a flagship/hybrid-seal/v1 seal (pq-suites.md §4.5).
func hybridOpen(seed []byte, purpose string, context [][]byte, sealed []byte) (*envHeader, []byte, error) {
	h, hdr, body, err := decodeEnvelope(sealed)
	if err != nil {
		return nil, nil, err
	}
	if h.suite != SuiteHybridSeal || h.purpose != purpose || h.recipient == nil {
		return nil, nil, v2err("v2-malformed")
	}
	sk, pk := xwing.DeriveKeyPair(seed)
	pkb := make([]byte, xwing.PublicKeySize)
	pk.Pack(pkb)
	if !bytes.Equal(h.recipient, PqKeyID(SuiteHybridSeal, pkb)) {
		return nil, nil, v2err("recipient-mismatch")
	}
	if len(body) < kemEncLen+gcmTagLen {
		return nil, nil, v2err("v2-malformed")
	}
	enc := body[:kemEncLen]
	// X-Wing as noble implements it refuses an all-zero X25519 share; so does this port.
	var xk [96]byte
	sh := sha3.NewShake256()
	sh.Write(seed)
	sh.Read(xk[:])
	if _, err := curve25519.X25519(xk[64:96], enc[kemEncLen-32:]); err != nil {
		return nil, nil, v2err("decrypt-failed")
	}
	for i := range xk {
		xk[i] = 0
	}
	ss := make([]byte, xwing.SharedKeySize)
	sk.DecapsulateTo(ss, enc)
	info := lp8(TagHybridSealV1)
	info = append(info, u16(SuiteHybridSeal)...)
	info = append(info, lp8(h.purpose)...)
	info = append(info, h.sender...)
	info = append(info, h.recipient...)
	info = append(info, u32(len(hdr))...)
	info = append(info, hdr...)
	info = append(info, byte(len(context)))
	for _, c := range context {
		info = append(info, u16(len(c))...)
		info = append(info, c...)
	}
	info = append(info, enc...)
	okm := make([]byte, 44)
	if _, err := hkdf.New(sha512.New, ss, []byte(TagHybridSealV1), info).Read(okm); err != nil {
		return nil, nil, v2err("decrypt-failed")
	}
	for i := range ss {
		ss[i] = 0
	}
	block, _ := aes.NewCipher(okm[:32])
	gcm, _ := cipher.NewGCM(block)
	aad := append(append([]byte{}, hdr...), enc...)
	pt, err := gcm.Open(nil, okm[32:44], body[kemEncLen:], aad)
	for i := range okm {
		okm[i] = 0
	}
	if err != nil {
		return nil, nil, v2err("decrypt-failed")
	}
	return h, pt, nil
}

func unpackKeyAndSig(p []byte) ([]byte, []byte, error) {
	if len(p) < 2 {
		return nil, nil, v2err("v2-malformed")
	}
	n := int(binary.BigEndian.Uint16(p[:2]))
	if n == 0 || n > maxDiskKey || len(p) != 2+n+HybridSigLen {
		return nil, nil, v2err("v2-malformed")
	}
	return append([]byte{}, p[2:2+n]...), p[2+n:], nil
}

func wipe(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// OpenBootReplyV2 opens a v2 reply with the per-boot reply key and checks the owner's hybrid
// signature over flagship/boot-reply/v2.
func OpenBootReplyV2(sealed []byte, serverDomain, bootPubHex, nonceHex string, replyKemSeed, ownerPq []byte) ([]byte, error) {
	serverDomain = strings.ToLower(serverDomain)
	bootPub, err1 := hex.DecodeString(bootPubHex)
	nonce, err2 := hex.DecodeString(nonceHex)
	if err1 != nil || err2 != nil || len(bootPub) != 32 || len(nonce) != 32 || len(replyKemSeed) != 32 || len(ownerPq) != HybridSigPublicKeyLen {
		return nil, v2err("v2-malformed")
	}
	ctx := [][]byte{[]byte(serverDomain), bootPub, []byte("unlock-key"), nonce}
	h, pt, err := hybridOpen(replyKemSeed, TagBootReplyV2, ctx, sealed)
	if err != nil {
		return nil, err
	}
	defer wipe(pt)
	key, sig, err := unpackKeyAndSig(pt)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(h.sessionNonce, nonce) {
		wipe(key)
		return nil, v2err("decrypt-failed")
	}
	digest := sha512.Sum512(key)
	stmt := strings.Join([]string{TagBootReplyV2, serverDomain, strings.ToLower(bootPubHex), "unlock-key", strings.ToLower(nonceHex),
		hex.EncodeToString(PqKeyID(SuiteHybridSeal, KemPublicKey(replyKemSeed))), hex.EncodeToString(digest[:]), strconv.FormatUint(h.issuedAt, 10)}, "|")
	if !HybridVerify(ownerPq, TagBootReplyV2, []byte(stmt), sig) {
		wipe(key)
		return nil, v2err("owner-signature")
	}
	return key, nil
}

// LeaseV3Fields are the lease JSON fields the owner's v3 signature covers.
type LeaseV3Fields struct {
	ServerDomain string
	BootPubHex   string
	LeaseID      string
	IssuedAt     int64
	ExpiresAt    int64
	MaxUses      int64 // -1 when absent
}

// OpenLeaseV3Sealed opens a v3 lease's sealedKey with the lease key and checks the owner's hybrid
// signature over the lease fields (so the worker cannot change id, times or cap) and the expiry.
func OpenLeaseV3Sealed(l LeaseV3Fields, sealed, leaseKemSeed, ownerPq []byte, nowMs int64) ([]byte, error) {
	l.ServerDomain = strings.ToLower(l.ServerDomain)
	l.LeaseID = strings.ToLower(l.LeaseID)
	bootPub, err := hex.DecodeString(l.BootPubHex)
	if err != nil || len(bootPub) != 32 || len(leaseKemSeed) != 32 || len(ownerPq) != HybridSigPublicKeyLen {
		return nil, v2err("v2-malformed")
	}
	h, pt, err := hybridOpen(leaseKemSeed, TagAutoUnlockLeaseV3, [][]byte{[]byte(l.ServerDomain), bootPub, []byte(l.LeaseID)}, sealed)
	if err != nil {
		return nil, err
	}
	defer wipe(pt)
	key, sig, err := unpackKeyAndSig(pt)
	if err != nil {
		return nil, err
	}
	digest := sha512.Sum512(key)
	stmt := strings.Join([]string{TagAutoUnlockLeaseV3, l.ServerDomain, strings.ToLower(l.BootPubHex),
		hex.EncodeToString(PqKeyID(SuiteHybridSeal, KemPublicKey(leaseKemSeed))), l.LeaseID, hex.EncodeToString(digest[:]),
		strconv.FormatInt(l.IssuedAt, 10), strconv.FormatInt(l.ExpiresAt, 10), strconv.FormatInt(l.MaxUses, 10)}, "|")
	if !HybridVerify(ownerPq, TagAutoUnlockLeaseV3, []byte(stmt), sig) || int64(h.issuedAt) != l.IssuedAt || h.expiresAt == nil || int64(*h.expiresAt) != l.ExpiresAt {
		wipe(key)
		return nil, v2err("owner-signature")
	}
	if l.ExpiresAt <= nowMs {
		wipe(key)
		return nil, v2err("lease-expired")
	}
	return key, nil
}

// OpenAutoUnlockLeaseAny opens the lease GET /api/boot/lease returns: v1 through
// OpenAutoUnlockLease (refused under strict), v3 through OpenLeaseV3Sealed.
func OpenAutoUnlockLeaseAny(body, bootSeed []byte, serverDomain string, ownerPub, ownerPq, leaseKemSeed []byte, policy string, nowMs int64) ([]byte, error) {
	var l leaseJSON
	if err := json.Unmarshal(body, &l); err != nil || l.SealedKey == nil {
		return nil, ErrLeaseMalformed
	}
	sealed, ok := hexOf(*l.SealedKey, 0)
	if !ok {
		return nil, ErrLeaseMalformed
	}
	if err := BoxAcceptsVersion(policy, sealed); err != nil {
		return nil, err
	}
	if !IsV2Sealed(sealed) {
		return OpenAutoUnlockLease(body, bootSeed, serverDomain, ownerPub, nowMs)
	}
	if ownerPq == nil || leaseKemSeed == nil {
		return nil, v2err("v2-malformed")
	}
	if l.ServerDomain == nil || l.LeaseID == nil || l.StkPub == nil || l.IssuedAt == nil || l.ExpiresAt == nil {
		return nil, ErrLeaseMalformed
	}
	if !strings.EqualFold(*l.ServerDomain, serverDomain) {
		return nil, ErrLeaseOtherServer
	}
	own := hex.EncodeToString(ed25519.NewKeyFromSeed(bootSeed).Public().(ed25519.PublicKey))
	if strings.ToLower(*l.StkPub) != own {
		return nil, ErrLeaseRecipient
	}
	maxUses := int64(-1)
	if l.MaxUses != nil {
		maxUses = *l.MaxUses
	}
	return OpenLeaseV3Sealed(LeaseV3Fields{*l.ServerDomain, own, *l.LeaseID, *l.IssuedAt, *l.ExpiresAt, maxUses}, sealed, leaseKemSeed, ownerPq, nowMs)
}

// RequestV2 is what the premount posts to /api/boot/request in v2: the v1 request signed by the
// boot key (the worker checks it) and the hybrid-signed v2 extension the phone checks.
type RequestV2 struct {
	Request   requestV1JSON `json:"request"`
	Signature string        `json:"signature"`
	Pq        requestPqJSON `json:"pq"`
}

type requestV1JSON struct {
	ServerDomain string `json:"serverDomain"`
	StkPub       string `json:"stkPub"`
	Purpose      string `json:"purpose"`
	Nonce        string `json:"nonce"`
	IssuedAt     int64  `json:"issuedAt"`
}

type requestPqJSON struct {
	V              int    `json:"v"`
	ReplyKemPubHex string `json:"replyKemPubHex"`
	Signature      string `json:"signature"`
}

// SignRequestV2 builds the v2 request body for an unlock-key request with a fresh reply key seed.
func SignRequestV2(bootSeed, bootMldsaSeed []byte, serverDomain, nonceHex string, issuedAt int64, replyKemSeed []byte, deterministic bool) (*RequestV2, error) {
	serverDomain = strings.ToLower(serverDomain)
	nonceHex = strings.ToLower(nonceHex)
	if n, err := hex.DecodeString(nonceHex); err != nil || len(n) != 32 || len(bootSeed) != 32 || len(replyKemSeed) != 32 || !canonicalField(serverDomain) {
		return nil, v2err("v2-malformed")
	}
	bootPub := hex.EncodeToString(ed25519.NewKeyFromSeed(bootSeed).Public().(ed25519.PublicKey))
	at := strconv.FormatInt(issuedAt, 10)
	v1 := strings.Join([]string{TagSecretRequestV1, serverDomain, bootPub, "unlock-key", nonceHex, at}, "|")
	replyPub := KemPublicKey(replyKemSeed)
	v2 := strings.Join([]string{TagSecretRequestV2, serverDomain, bootPub, "unlock-key", nonceHex, hex.EncodeToString(PqKeyID(SuiteHybridSeal, replyPub)), at}, "|")
	sig, err := HybridSign(bootSeed, bootMldsaSeed, TagSecretRequestV2, []byte(v2), deterministic)
	if err != nil {
		return nil, err
	}
	return &RequestV2{
		Request:   requestV1JSON{serverDomain, bootPub, "unlock-key", nonceHex, issuedAt},
		Signature: hex.EncodeToString(ed25519.Sign(ed25519.NewKeyFromSeed(bootSeed), []byte(v1))),
		Pq:        requestPqJSON{2, hex.EncodeToString(replyPub), hex.EncodeToString(sig)},
	}, nil
}

// PublicKeyHex is the boot key's Ed25519 public key, hex.
func PublicKeyHex(seed []byte) string {
	return hex.EncodeToString(ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey))
}
