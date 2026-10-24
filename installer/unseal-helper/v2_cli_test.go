package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/flagship/installer/unseal-helper/internal/unseal"
)

type cliVectors struct {
	ServerDomain string                       `json:"serverDomain"`
	DiskKey      string                       `json:"diskKey"`
	Keys         map[string]map[string]string `json:"keys"`
	Reply        struct {
		Ctx    map[string]string `json:"ctx"`
		Sealed string            `json:"sealed"`
	} `json:"reply"`
	Lease struct {
		Fields struct {
			LeaseID   string `json:"leaseId"`
			IssuedAt  int64  `json:"issuedAt"`
			ExpiresAt int64  `json:"expiresAt"`
		} `json:"fields"`
		SealedKey string `json:"sealedKey"`
	} `json:"lease"`
}

func cliV2(t *testing.T) (*cliVectors, string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "packages", "protocol", "test-vectors", "boot-unlock-v2", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v cliVectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	put := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	put("owner.pq", v.Keys["owner"]["publicKey"]+"\n")
	put("reply.key", v.Keys["replyKem"]["seed"]+"\n")
	put("lease.key", v.Keys["leaseKem"]["seed"]+"\n")
	put("boot.pq", v.Keys["boot"]["mldsaSeed"]+"\n")
	put("strict", "strict\n")
	put("compat", "compat\n")
	put("reply.json", `{"serverDomain":"`+v.ServerDomain+`","requestNonceHex":"`+v.Reply.Ctx["nonceHex"]+`","purpose":"unlock-key","sealedHex":"`+v.Reply.Sealed+`","issuedAt":1}`)
	put("v1reply.json", `{"serverDomain":"`+v.ServerDomain+`","requestNonceHex":"`+v.Reply.Ctx["nonceHex"]+`","purpose":"unlock-key","sealedHex":"`+strings.Repeat("09", 124)+`","issuedAt":1}`)
	lease, _ := json.Marshal(map[string]any{
		"serverDomain": v.ServerDomain, "leaseId": v.Lease.Fields.LeaseID, "stkPub": v.Keys["boot"]["pubHex"], "sealedKey": v.Lease.SealedKey,
		"issuedAt": v.Lease.Fields.IssuedAt, "expiresAt": v.Lease.Fields.ExpiresAt, "maxUses": nil, "signature": strings.Repeat("00", 64),
	})
	put("lease.json", string(lease))
	return &v, dir
}

func TestCLIV2ReplyOpensOnceUnderStrict(t *testing.T) {
	v, dir := cliV2(t)
	p := func(n string) string { return filepath.Join(dir, n) }
	var out bytes.Buffer
	args := []string{"--identity-priv-hex", v.Keys["boot"]["edSeed"], "--response-json", p("reply.json"), "--server-domain", v.ServerDomain,
		"--reply-kem-key", p("reply.key"), "--owner-pq-pub-file", p("owner.pq"), "--unlock-policy-file", p("strict")}
	if err := run(args, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out.String()) != v.DiskKey {
		t.Fatal("wrong disk key")
	}
	if _, err := os.Stat(p("reply.key")); !os.IsNotExist(err) {
		t.Fatal("the reply key must be gone after one open")
	}
	if err := run(args, strings.NewReader(""), &out); err == nil {
		t.Fatal("a second open must fail: the reply key is gone")
	}
}

func TestCLIStrictRefusesClassicalReply(t *testing.T) {
	v, dir := cliV2(t)
	p := func(n string) string { return filepath.Join(dir, n) }
	var out bytes.Buffer
	err := run([]string{"--identity-priv-hex", v.Keys["boot"]["edSeed"], "--response-json", p("v1reply.json"), "--owner-pq-pub-file", p("owner.pq"), "--unlock-policy-file", p("strict")}, strings.NewReader(""), &out)
	if unseal.V2Code(err) != "strict-refuses-v1" {
		t.Fatalf("want strict-refuses-v1, got %v", err)
	}
	err = run([]string{"--identity-priv-hex", v.Keys["boot"]["edSeed"], "--sealed-hex", strings.Repeat("09", 124), "--unlock-policy-file", p("strict")}, strings.NewReader(""), &out)
	if unseal.V2Code(err) != "strict-refuses-v1" {
		t.Fatalf("raw v1 blob under strict: %v", err)
	}
	err = run([]string{"--identity-priv-hex", v.Keys["boot"]["edSeed"], "--response-json", p("v1reply.json"), "--unlock-policy-file", p("compat")}, strings.NewReader(""), &out)
	if unseal.V2Code(err) != "" || err == nil {
		t.Fatalf("compat lets the v1 opener run (which then fails on this fake blob): %v", err)
	}
}

func TestCLIV3LeaseAndTimeFloor(t *testing.T) {
	v, dir := cliV2(t)
	p := func(n string) string { return filepath.Join(dir, n) }
	base := []string{"--identity-priv-hex", v.Keys["boot"]["edSeed"], "--lease-json", p("lease.json"), "--server-domain", v.ServerDomain,
		"--owner-pub-hex", v.Keys["owner"]["publicKey"][:64], "--owner-pq-pub-file", p("owner.pq"), "--unlock-policy-file", p("strict"), "--lease-kem-key", "-",
		"--now-ms", strconv.FormatInt(v.Lease.Fields.IssuedAt+1, 10)}
	var out bytes.Buffer
	if err := run(base, strings.NewReader(v.Keys["leaseKem"]["seed"]+"\n"), &out); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out.String()) != v.DiskKey {
		t.Fatal("wrong disk key from the v3 lease")
	}
	if err := os.WriteFile(p("floor"), []byte(strconv.FormatInt(v.Lease.Fields.ExpiresAt, 10)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := run(append(base, "--time-floor-file", p("floor")), strings.NewReader(v.Keys["leaseKem"]["seed"]+"\n"), &out)
	if unseal.V2Code(err) != "lease-expired" {
		t.Fatalf("a clock set back must not revive the lease past the floor: %v", err)
	}
}

func TestCLIV2RequestWritesReplyKey(t *testing.T) {
	v, dir := cliV2(t)
	p := func(n string) string { return filepath.Join(dir, n) }
	var out bytes.Buffer
	args := []string{"--identity-priv-hex", v.Keys["boot"]["edSeed"], "--v2-request", "--server-domain", v.ServerDomain, "--nonce-hex", v.Reply.Ctx["nonceHex"],
		"--boot-pq-key", p("boot.pq"), "--reply-kem-out", p("eph.key"), "--now-ms", "1790000000000"}
	if err := run(args, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	var body unseal.RequestV2
	if err := json.Unmarshal(out.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	seed, _ := os.ReadFile(p("eph.key"))
	pub := hex.EncodeToString(unseal.KemPublicKey(mustDecode(t, strings.TrimSpace(string(seed)))))
	if body.Pq.ReplyKemPubHex != pub || body.Request.StkPub != v.Keys["boot"]["pubHex"] || body.Request.IssuedAt != 1790000000000 {
		t.Fatal("the request must name the reply key just written and the boot key")
	}
	if fi, _ := os.Stat(p("eph.key")); fi.Mode().Perm() != 0o600 {
		t.Fatal("the reply key must be 0600")
	}
	if err := run(args, strings.NewReader(""), &out); err == nil {
		t.Fatal("an existing reply key file must not be overwritten")
	}
}

func mustDecode(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
