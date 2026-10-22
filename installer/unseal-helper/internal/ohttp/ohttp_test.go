package ohttp

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func h(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// RFC 9458 Appendix A, verbatim (the same vector the TS port reproduces).
const (
	keyConfig            = "01002031e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e79815500080001000100010003"
	request              = "00034745540568747470730b6578616d706c652e636f6d012f"
	ephemeral            = "bc51d5e930bda26589890ac7032f70ad12e4ecb37abb1b65b1256c9c48999c73"
	encapsulatedRequest  = "010020000100014b28f881333e7c164ffc499ad9796f877f4e1051ee6d31bad19dec96c208b4726374e469135906992e1268c594d2a10c695d858c40a026e7965e7d86b83dd440b2c0185204b4d63525"
	exportedSecret       = "62d87a6ba569ee81014c2641f52bea36"
	encapsulatedResponse = "c789e7151fcba46158ca84b04464910d86f9013e404feea014e7be4a441f234f857fbd"
)

func TestRFC9458AppendixA(t *testing.T) {
	cfg, err := ParseKeyConfig(h(t, keyConfig))
	if err != nil {
		t.Fatal(err)
	}
	enc, ctx, err := EncapsulateRequest(cfg, h(t, request), h(t, ephemeral))
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(enc) != encapsulatedRequest {
		t.Fatalf("encapsulated request\n got %x\nwant %s", enc, encapsulatedRequest)
	}
	if hex.EncodeToString(ctx.Secret) != exportedSecret {
		t.Fatalf("exported secret %x", ctx.Secret)
	}
	res, err := DecapsulateResponse(ctx, h(t, encapsulatedResponse))
	if err != nil {
		t.Fatal(err)
	}
	status, body, err := DecodeResponse(res)
	if err != nil || status != 200 || len(body) != 0 {
		t.Fatalf("status %d body %x err %v", status, body, err)
	}
	if !bytes.Equal(EncodeRequest("GET", "https", "example.com", "/", nil, nil)[:len(h(t, request))], h(t, request)) {
		t.Fatal("binary HTTP request prefix differs from the RFC's")
	}
}

func TestRefusals(t *testing.T) {
	if _, err := ParseKeyConfig(h(t, "0100")); err == nil {
		t.Fatal("short config accepted")
	}
	cfg, _ := ParseKeyConfig(h(t, keyConfig))
	_, ctx, _ := EncapsulateRequest(cfg, h(t, request), nil)
	tampered := h(t, encapsulatedResponse)
	if _, err := DecapsulateResponse(ctx, tampered); err == nil {
		t.Fatal("a response for another request opened")
	}
}
