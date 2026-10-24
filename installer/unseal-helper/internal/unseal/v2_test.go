package unseal

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type v2Vectors struct {
	Now          int64  `json:"now"`
	ServerDomain string `json:"serverDomain"`
	DiskKey      string `json:"diskKey"`
	Keys         map[string]struct {
		EdSeed    string `json:"edSeed"`
		MldsaSeed string `json:"mldsaSeed"`
		Seed      string `json:"seed"`
		PublicKey string `json:"publicKey"`
		PubHex    string `json:"pubHex"`
	} `json:"keys"`
	Request struct {
		Canonical string `json:"canonical"`
		Fields    struct {
			NonceHex string `json:"nonceHex"`
			IssuedAt int64  `json:"issuedAt"`
		} `json:"fields"`
		Pq struct {
			ReplyKemPubHex string `json:"replyKemPubHex"`
			Signature      string `json:"signature"`
		} `json:"pq"`
	} `json:"request"`
	Reply struct {
		Cases []struct {
			Name     string `json:"name"`
			Policy   string `json:"policy"`
			Sealed   string `json:"sealed"`
			NonceHex string `json:"nonceHex"`
			Expect   string `json:"expect"`
		} `json:"cases"`
	} `json:"reply"`
	Lease struct {
		Cases []struct {
			Name   string `json:"name"`
			Policy string `json:"policy"`
			Lease  struct {
				ServerDomain string `json:"serverDomain"`
				BootPubHex   string `json:"bootPubHex"`
				LeaseID      string `json:"leaseId"`
				IssuedAt     int64  `json:"issuedAt"`
				ExpiresAt    int64  `json:"expiresAt"`
				MaxUses      *int64 `json:"maxUses"`
			} `json:"lease"`
			Sealed string `json:"sealed"`
			NowMs  int64  `json:"nowMs"`
			Expect string `json:"expect"`
		} `json:"cases"`
	} `json:"lease"`
	Policy []struct {
		Text          *string `json:"text"`
		HasV2Material bool    `json:"hasV2Material"`
		Expect        string  `json:"expect"`
	} `json:"policy"`
}

func loadV2(t *testing.T) *v2Vectors {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "protocol", "test-vectors", "boot-unlock-v2", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v v2Vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return &v
}

func v2Hex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func outcome(err error) string {
	if err == nil {
		return "ok"
	}
	if c := V2Code(err); c != "" {
		return c
	}
	return "error: " + err.Error()
}

func TestV2KeysAndRequestMatchVectors(t *testing.T) {
	v := loadV2(t)
	boot := v.Keys["boot"]
	if got := hex.EncodeToString(HybridPublicKey(v2Hex(t, boot.EdSeed), v2Hex(t, boot.MldsaSeed))); got != boot.PublicKey {
		t.Fatal("boot hybrid public key differs")
	}
	if got := hex.EncodeToString(KemPublicKey(v2Hex(t, v.Keys["replyKem"].Seed))); got != v.Keys["replyKem"].PublicKey {
		t.Fatal("X-Wing public key differs")
	}
	req, err := SignRequestV2(v2Hex(t, boot.EdSeed), v2Hex(t, boot.MldsaSeed), v.ServerDomain, v.Request.Fields.NonceHex, v.Request.Fields.IssuedAt, v2Hex(t, v.Keys["replyKem"].Seed), true)
	if err != nil {
		t.Fatal(err)
	}
	if req.Pq.Signature != v.Request.Pq.Signature || req.Pq.ReplyKemPubHex != v.Request.Pq.ReplyKemPubHex {
		t.Fatal("v2 request signature differs from the vectors")
	}
	random, err := SignRequestV2(v2Hex(t, boot.EdSeed), v2Hex(t, boot.MldsaSeed), v.ServerDomain, v.Request.Fields.NonceHex, v.Request.Fields.IssuedAt, v2Hex(t, v.Keys["replyKem"].Seed), false)
	if err != nil || random.Pq.Signature == req.Pq.Signature {
		t.Fatal("a hedged signature must differ from the deterministic one")
	}
	if !HybridVerify(v2Hex(t, boot.PublicKey), TagSecretRequestV2, []byte(v.Request.Canonical), v2Hex(t, random.Pq.Signature)) {
		t.Fatal("hedged request signature does not verify")
	}
}

func TestV2ReplyCases(t *testing.T) {
	v := loadV2(t)
	owner := v2Hex(t, v.Keys["owner"].PublicKey)
	for _, c := range v.Reply.Cases {
		sealed := v2Hex(t, c.Sealed)
		got := outcome(BoxAcceptsVersion(c.Policy, sealed))
		if got == "ok" && !IsV2Sealed(sealed) {
			got = "accept-v1"
		} else if got == "ok" {
			key, err := OpenBootReplyV2(sealed, v.ServerDomain, v.Keys["boot"].PubHex, c.NonceHex, v2Hex(t, v.Keys["replyKem"].Seed), owner)
			got = outcome(err)
			if err == nil && hex.EncodeToString(key) != v.DiskKey {
				t.Fatalf("%s: wrong key", c.Name)
			}
		}
		if got != c.Expect {
			t.Errorf("reply %s: got %s want %s", c.Name, got, c.Expect)
		}
	}
}

func TestV2LeaseCases(t *testing.T) {
	v := loadV2(t)
	owner := v2Hex(t, v.Keys["owner"].PublicKey)
	for _, c := range v.Lease.Cases {
		sealed := v2Hex(t, c.Sealed)
		got := outcome(BoxAcceptsVersion(c.Policy, sealed))
		if got == "ok" && !IsV2Sealed(sealed) {
			got = "accept-v1"
		} else if got == "ok" {
			mu := int64(-1)
			if c.Lease.MaxUses != nil {
				mu = *c.Lease.MaxUses
			}
			f := LeaseV3Fields{c.Lease.ServerDomain, c.Lease.BootPubHex, c.Lease.LeaseID, c.Lease.IssuedAt, c.Lease.ExpiresAt, mu}
			key, err := OpenLeaseV3Sealed(f, sealed, v2Hex(t, v.Keys["leaseKem"].Seed), owner, c.NowMs)
			got = outcome(err)
			if err == nil && hex.EncodeToString(key) != v.DiskKey {
				t.Fatalf("%s: wrong key", c.Name)
			}
		}
		if got != c.Expect {
			t.Errorf("lease %s: got %s want %s", c.Name, got, c.Expect)
		}
	}
}

func TestV2Policy(t *testing.T) {
	v := loadV2(t)
	for _, c := range v.Policy {
		text := []byte{}
		if c.Text != nil {
			text = []byte(*c.Text)
		}
		if got := ParseUnlockPolicy(text, c.Text != nil, c.HasV2Material); got != c.Expect {
			t.Errorf("policy %v: got %s want %s", c.Text, got, c.Expect)
		}
	}
}

func TestV2LeaseThroughJSON(t *testing.T) {
	v := loadV2(t)
	boot := v.Keys["boot"]
	c := v.Lease.Cases[0]
	body, _ := json.Marshal(map[string]any{
		"serverDomain": c.Lease.ServerDomain, "leaseId": c.Lease.LeaseID, "stkPub": boot.PubHex, "sealedKey": c.Sealed,
		"issuedAt": c.Lease.IssuedAt, "expiresAt": c.Lease.ExpiresAt, "maxUses": nil, "signature": "00",
	})
	key, err := OpenAutoUnlockLeaseAny(body, v2Hex(t, boot.EdSeed), v.ServerDomain, nil, v2Hex(t, v.Keys["owner"].PublicKey), v2Hex(t, v.Keys["leaseKem"].Seed), "strict", c.NowMs)
	if err != nil || hex.EncodeToString(key) != v.DiskKey {
		t.Fatalf("v3 lease through JSON: %v", err)
	}
	if _, err := OpenAutoUnlockLeaseAny(body, v2Hex(t, v.Keys["stranger"].EdSeed), v.ServerDomain, nil, v2Hex(t, v.Keys["owner"].PublicKey), v2Hex(t, v.Keys["leaseKem"].Seed), "strict", c.NowMs); err != ErrLeaseRecipient {
		t.Fatalf("another box's boot key: %v", err)
	}
}
