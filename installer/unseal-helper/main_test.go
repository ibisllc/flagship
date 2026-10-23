package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// These exercise the CLI argument plumbing in run(); the cryptographic
// wire-compat itself is gated by the Go unit tests in internal/unseal and the
// authoritative TS->Go cross-check in tools/unseal-crosscheck.

func TestRunRequiresIdentity(t *testing.T) {
	var out bytes.Buffer
	err := run([]string{"--sealed-hex", "00"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "exactly one of --identity-pem") {
		t.Fatalf("expected an identity error, got %v", err)
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

const pinnedSeed = "9d61b19deff31a5f7c4f7e4c8a2b1d4e5d6c7b8a9f0e1d2c3b4a596877869506"
const pinnedSealed = "8dc0e0bd9fceb5ecab0632c331aee422268719476d312a04aef93cacdc9abe2070043b6bc257e7498c3b89560d2b744dd9b532ab4b8e111200d30027b45ddc45245cd9af3eea784fb9aee483cc173ed5c63c57e048ddfd855f553af2"
const pinnedPlain = "030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc"

func pemOf(t *testing.T, seedHex string) string {
	t.Helper()
	seed, _ := hex.DecodeString(seedHex)
	der := append([]byte{0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20}, seed...)
	p := filepath.Join(t.TempDir(), "boot.pem")
	body := "-----BEGIN PRIVATE KEY-----\n" + base64.StdEncoding.EncodeToString(der) + "\n-----END PRIVATE KEY-----\n"
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRunReadsTheKeyFromAPEMFile(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"--identity-pem", pemOf(t, pinnedSeed), "--sealed-hex", pinnedSealed}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("run: %v", err)
	}
	if strings.TrimSpace(out.String()) != pinnedPlain {
		t.Fatalf("got %q", out.String())
	}
}

func TestRunReadsTheSeedFromStdin(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"--identity-stdin", "--sealed-hex", pinnedSealed}, strings.NewReader(pinnedSeed+"\n"), &out); err != nil {
		t.Fatalf("run: %v", err)
	}
	if strings.TrimSpace(out.String()) != pinnedPlain {
		t.Fatalf("got %q", out.String())
	}
}

func TestRunRefusesTwoIdentitySourcesAndSharedStdin(t *testing.T) {
	var out bytes.Buffer
	err := run([]string{"--identity-stdin", "--identity-priv-hex", pinnedSeed, "--sealed-hex", "00"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("got %v", err)
	}
	err = run([]string{"--identity-stdin", "--response-json", "-"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "cannot share stdin") {
		t.Fatalf("got %v", err)
	}
}

func TestRunRefusesAPEMThatIsNotEd25519(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.pem")
	_ = os.WriteFile(p, []byte("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"), 0o600)
	var out bytes.Buffer
	err := run([]string{"--identity-pem", p, "--sealed-hex", "00"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "PKCS#8") {
		t.Fatalf("got %v", err)
	}
}

type bootKeyVectors struct {
	ServerDomain   string `json:"serverDomain"`
	BootKeySeedHex string `json:"bootKeySeedHex"`
	OwnerPubHex    string `json:"ownerPubHex"`
	Lease          struct {
		Now        int64  `json:"now"`
		LuksKeyHex string `json:"luksKeyHex"`
		Cases      []struct {
			Name  string          `json:"name"`
			Lease json.RawMessage `json:"lease"`
			OK    bool            `json:"ok"`
			Error string          `json:"error"`
		} `json:"cases"`
	} `json:"lease"`
}

func TestRunLeaseVectors(t *testing.T) {
	raw, err := os.ReadFile("../../packages/protocol/test-vectors/boot-key/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v bootKeyVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	pem := pemOf(t, v.BootKeySeedHex)
	for _, c := range v.Lease.Cases {
		t.Run(c.Name, func(t *testing.T) {
			var out bytes.Buffer
			err := run([]string{
				"--identity-pem", pem, "--lease-json", "-", "--server-domain", v.ServerDomain,
				"--owner-pub-hex", v.OwnerPubHex, "--now-ms", strconv.FormatInt(v.Lease.Now, 10),
			}, bytes.NewReader(c.Lease), &out)
			if c.OK {
				if err != nil || strings.TrimSpace(out.String()) != v.Lease.LuksKeyHex {
					t.Fatalf("err=%v out=%q", err, out.String())
				}
				return
			}
			if err == nil || err.Error() != c.Error {
				t.Fatalf("want %q, got %v", c.Error, err)
			}
		})
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
