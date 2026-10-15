// Package ohttp is the client half of Oblivious HTTP (RFC 9458) with Binary
// HTTP (RFC 9292), for the boot unlock of a box with an outbound proxy
// (docs/outbound-proxy.md): the initramfs has no Node, so the unlock calls are
// sealed here and carried to the relay by curl.
//
// One suite only, matching packages/protocol/src/ohttp.ts:
// DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM.
package ohttp

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"
)

const (
	kemX25519 = 0x0020
	kdfSHA256 = 0x0001
	aeadAES128 = 0x0001
	nk         = 16
	nn         = 12
	nh         = 32
	nenc       = 32
	secretLen  = 16 // max(Nn, Nk)
)

// KeyConfig is one gateway key configuration (RFC 9458 §3).
type KeyConfig struct {
	KeyID     byte
	PublicKey []byte
}

// ParseKeyConfig accepts a configuration only if it offers our KEM and suite.
func ParseKeyConfig(b []byte) (KeyConfig, error) {
	if len(b) < 1+2+nenc+2 {
		return KeyConfig{}, errors.New("key config too short")
	}
	if binary.BigEndian.Uint16(b[1:3]) != kemX25519 {
		return KeyConfig{}, errors.New("unsupported KEM")
	}
	pub := append([]byte(nil), b[3:3+nenc]...)
	o := 3 + nenc
	n := int(binary.BigEndian.Uint16(b[o : o+2]))
	o += 2
	if n%4 != 0 || o+n != len(b) {
		return KeyConfig{}, errors.New("malformed suites")
	}
	for i := o; i < o+n; i += 4 {
		if binary.BigEndian.Uint16(b[i:i+2]) == kdfSHA256 && binary.BigEndian.Uint16(b[i+2:i+4]) == aeadAES128 {
			return KeyConfig{KeyID: b[0], PublicKey: pub}, nil
		}
	}
	return KeyConfig{}, errors.New("no supported suite")
}

// Context is what the client keeps to open the response.
type Context struct {
	Enc    []byte
	Secret []byte
}

func u16(v int) []byte { return []byte{byte(v >> 8), byte(v)} }

func cat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

var (
	kemSuite  = cat([]byte("KEM"), u16(kemX25519))
	hpkeSuite = cat([]byte("HPKE"), u16(kemX25519), u16(kdfSHA256), u16(aeadAES128))
	hpkeV1    = []byte("HPKE-v1")
)

func labeledExtract(suite, salt []byte, label string, ikm []byte) []byte {
	return hkdf.Extract(sha256.New, cat(hpkeV1, suite, []byte(label), ikm), salt)
}

func labeledExpand(suite, prk []byte, label string, info []byte, l int) []byte {
	out := make([]byte, l)
	r := hkdf.Expand(sha256.New, prk, cat(u16(l), hpkeV1, suite, []byte(label), info))
	if _, err := io.ReadFull(r, out); err != nil {
		panic(err)
	}
	return out
}

func expand(prk []byte, info string, l int) []byte {
	out := make([]byte, l)
	if _, err := io.ReadFull(hkdf.Expand(sha256.New, prk, []byte(info)), out); err != nil {
		panic(err)
	}
	return out
}

func gcm(key []byte) cipher.AEAD {
	b, err := aes.NewCipher(key)
	if err != nil {
		panic(err)
	}
	a, err := cipher.NewGCM(b)
	if err != nil {
		panic(err)
	}
	return a
}

// EncapsulateRequest seals a Binary HTTP request for the gateway. A nil
// ephemeral key draws a fresh one (the argument is a test seam).
func EncapsulateRequest(cfg KeyConfig, request, ephemeral []byte) ([]byte, Context, error) {
	skE := ephemeral
	if skE == nil {
		skE = make([]byte, 32)
		if _, err := rand.Read(skE); err != nil {
			return nil, Context{}, err
		}
	}
	enc, err := curve25519.X25519(skE, curve25519.Basepoint)
	if err != nil {
		return nil, Context{}, err
	}
	dh, err := curve25519.X25519(skE, cfg.PublicKey)
	if err != nil {
		return nil, Context{}, err
	}
	eae := labeledExtract(kemSuite, nil, "eae_prk", dh)
	shared := labeledExpand(kemSuite, eae, "shared_secret", cat(enc, cfg.PublicKey), 32)

	hdr := cat([]byte{cfg.KeyID}, u16(kemX25519), u16(kdfSHA256), u16(aeadAES128))
	info := cat([]byte("message/bhttp request"), []byte{0}, hdr)
	pskIDHash := labeledExtract(hpkeSuite, nil, "psk_id_hash", nil)
	infoHash := labeledExtract(hpkeSuite, nil, "info_hash", info)
	ksc := cat([]byte{0}, pskIDHash, infoHash)
	secret := labeledExtract(hpkeSuite, shared, "secret", nil)
	key := labeledExpand(hpkeSuite, secret, "key", ksc, nk)
	nonce := labeledExpand(hpkeSuite, secret, "base_nonce", ksc, nn)
	exporter := labeledExpand(hpkeSuite, secret, "exp", ksc, nh)

	ct := gcm(key).Seal(nil, nonce, request, nil)
	respSecret := labeledExpand(hpkeSuite, exporter, "sec", []byte("message/bhttp response"), secretLen)
	return cat(hdr, enc, ct), Context{Enc: enc, Secret: respSecret}, nil
}

// DecapsulateResponse opens an Encapsulated Response.
func DecapsulateResponse(ctx Context, enc []byte) ([]byte, error) {
	if len(enc) < secretLen+16 {
		return nil, errors.New("encapsulated response too short")
	}
	prk := hkdf.Extract(sha256.New, ctx.Secret, cat(ctx.Enc, enc[:secretLen]))
	out, err := gcm(expand(prk, "key", nk)).Open(nil, expand(prk, "nonce", nn), enc[secretLen:], nil)
	if err != nil {
		return nil, errors.New("could not decrypt the response")
	}
	return out, nil
}

// ---- Binary HTTP, known-length (RFC 9292) ----

func varint(v int) []byte {
	switch {
	case v < 0x40:
		return []byte{byte(v)}
	case v < 0x4000:
		return []byte{0x40 | byte(v>>8), byte(v)}
	default:
		return []byte{0x80 | byte(v>>24), byte(v >> 16), byte(v >> 8), byte(v)}
	}
}

func lp(b []byte) []byte { return cat(varint(len(b)), b) }

// Header is one field line.
type Header struct{ Name, Value string }

// EncodeRequest builds a known-length Binary HTTP request.
func EncodeRequest(method, scheme, authority, path string, headers []Header, body []byte) []byte {
	var fields []byte
	for _, h := range headers {
		fields = append(fields, cat(lp([]byte(h.Name)), lp([]byte(h.Value)))...)
	}
	return cat(varint(0), lp([]byte(method)), lp([]byte(scheme)), lp([]byte(authority)), lp([]byte(path)), lp(fields), lp(body), varint(0))
}

type reader struct {
	b []byte
	o int
}

func (r *reader) done() bool { return r.o >= len(r.b) }

func (r *reader) varint() (int, error) {
	if r.o >= len(r.b) {
		return 0, errors.New("truncated message")
	}
	l := 1 << (r.b[r.o] >> 6)
	if l == 8 || r.o+l > len(r.b) {
		return 0, errors.New("bad varint")
	}
	v := int(r.b[r.o] & 0x3f)
	for i := 1; i < l; i++ {
		v = v<<8 | int(r.b[r.o+i])
	}
	r.o += l
	return v, nil
}

func (r *reader) bytes() ([]byte, error) {
	n, err := r.varint()
	if err != nil {
		return nil, err
	}
	if r.o+n > len(r.b) {
		return nil, errors.New("truncated message")
	}
	out := r.b[r.o : r.o+n]
	r.o += n
	return out, nil
}

// DecodeResponse returns the final status and body of a known-length Binary
// HTTP response (informational responses and fields are skipped).
func DecodeResponse(b []byte) (int, []byte, error) {
	r := &reader{b: b}
	f, err := r.varint()
	if err != nil || f != 1 {
		return 0, nil, errors.New("not a known-length response")
	}
	status, err := r.varint()
	if err != nil {
		return 0, nil, err
	}
	for status >= 100 && status < 200 {
		if _, err := r.bytes(); err != nil {
			return 0, nil, err
		}
		if status, err = r.varint(); err != nil {
			return 0, nil, err
		}
	}
	if r.done() {
		return status, nil, nil
	}
	if _, err := r.bytes(); err != nil {
		return 0, nil, err
	}
	if r.done() {
		return status, nil, nil
	}
	body, err := r.bytes()
	if err != nil {
		return 0, nil, err
	}
	return status, body, nil
}
