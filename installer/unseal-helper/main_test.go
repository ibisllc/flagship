package main

import (
	"bytes"
	"strings"
	"testing"
)

// These exercise the CLI argument plumbing in run(); the cryptographic
// wire-compat itself is gated by the Go unit tests in internal/unseal and the
// authoritative TS->Go cross-check in tools/unseal-crosscheck.

func TestRunRequiresIdentity(t *testing.T) {
	var out bytes.Buffer
	err := run([]string{"--sealed-hex", "00"}, strings.NewReader(""), &out)
	if err == nil {
		t.Fatal("expected error when --identity-priv-hex is missing")
	}
}

func TestRunRejectsBadIdentityHex(t *testing.T) {
	var out bytes.Buffer
	err := run([]string{"--identity-priv-hex", "zz", "--sealed-hex", "00"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "not valid hex") {
		t.Fatalf("expected hex error, got %v", err)
	}
}

func TestRunRejectsShortIdentity(t *testing.T) {
	var out bytes.Buffer
	err := run([]string{"--identity-priv-hex", "abcd", "--sealed-hex", "00"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "32 bytes") {
		t.Fatalf("expected length error, got %v", err)
	}
}

func TestRunResponseRequiresNonceAndPurpose(t *testing.T) {
	seed := "9d61b19deff31a5f7c4f7e4c8a2b1d4e5d6c7b8a9f0e1d2c3b4a596877869506"
	var out bytes.Buffer
	err := run([]string{"--identity-priv-hex", seed, "--sealed-hex", "00", "--response"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--nonce-hex and --purpose are required") {
		t.Fatalf("expected nonce/purpose requirement error, got %v", err)
	}
}

func TestRunPinnedRawVector(t *testing.T) {
	// The same pinned vector the cross-check uses, end-to-end through run().
	seed := "9d61b19deff31a5f7c4f7e4c8a2b1d4e5d6c7b8a9f0e1d2c3b4a596877869506"
	sealed := "8dc0e0bd9fceb5ecab0632c331aee422268719476d312a04aef93cacdc9abe2070043b6bc257e7498c3b89560d2b744dd9b532ab4b8e111200d30027b45ddc45245cd9af3eea784fb9aee483cc173ed5c63c57e048ddfd855f553af2"
	want := "030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc"
	var out bytes.Buffer
	if err := run([]string{"--identity-priv-hex", seed, "--sealed-hex", sealed}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("run: %v", err)
	}
	if strings.TrimSpace(out.String()) != want {
		t.Fatalf("got %q want %q", strings.TrimSpace(out.String()), want)
	}
}

func TestRunPinnedResponseViaJSONStdin(t *testing.T) {
	seed := "9d61b19deff31a5f7c4f7e4c8a2b1d4e5d6c7b8a9f0e1d2c3b4a596877869506"
	sealed := "ca619d12010f13fca681e85356c97fb31b3441d6b0628aa71a0792ff6579054dbb46fa9b25c8b6248d9f3fabfc0ecef85cd349024ffaf1865460166c67c9982a4923733a9219b8d1acea22fc9181c1dcfaa21864875270f6d33e993ba1172b87597d30b13c8797e70da9bf38b79b769ec8acec2caa164b1534a9d9ec56cdd35c23aba2fe873f82c713e1c5f0336af86a40c9d012477d39117944a0958bd04fe2b86088c161a6b9f78337fdaf5f65b6007b154b24683aeaaa76ea1addedce827b25a586a24a479b"
	nonce := "05101b26313c47525d68737e89949faab5c0cbd6e1ecf7020d18232e39444f5a"
	want := "030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc"
	reply := `{"serverDomain":"kitchen.alice.flagship.services","requestNonceHex":"` + nonce +
		`","purpose":"unlock-key","sealedHex":"` + sealed + `","issuedAt":1700000000000}`
	var out bytes.Buffer
	if err := run([]string{"--identity-priv-hex", seed, "--response-json", "-"}, strings.NewReader(reply), &out); err != nil {
		t.Fatalf("run: %v", err)
	}
	if strings.TrimSpace(out.String()) != want {
		t.Fatalf("got %q want %q", strings.TrimSpace(out.String()), want)
	}
}
