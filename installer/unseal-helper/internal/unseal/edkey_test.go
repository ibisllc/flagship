package unseal

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Runs packages/protocol/test-vectors/ed25519-low-order.
func TestEd25519LowOrderVectors(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "protocol", "test-vectors", "ed25519-low-order", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		ForgedSignatureHex  string   `json:"forgedSignatureHex"`
		MessagesHex         []string `json:"messagesHex"`
		RejectPublicKeysHex []string `json:"rejectPublicKeysHex"`
		Honest              struct {
			PublicKeyHex string `json:"publicKeyHex"`
			Signatures   []struct {
				MessageHex   string `json:"messageHex"`
				SignatureHex string `json:"signatureHex"`
			} `json:"signatures"`
		} `json:"honest"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	un := func(h string) []byte {
		x, err := hex.DecodeString(h)
		if err != nil {
			t.Fatal(err)
		}
		return x
	}
	forged := un(v.ForgedSignatureHex)
	for _, k := range v.RejectPublicKeysHex {
		if AcceptableEd25519PublicKey(un(k)) {
			t.Errorf("accepted %s", k)
		}
		for _, m := range v.MessagesHex {
			if verifyEd25519(un(k), un(m), forged) {
				t.Errorf("forged signature verified under %s for %s", k, m)
			}
		}
	}
	pub := un(v.Honest.PublicKeyHex)
	if !AcceptableEd25519PublicKey(pub) {
		t.Fatal("refused the honest key")
	}
	for _, s := range v.Honest.Signatures {
		if !verifyEd25519(pub, un(s.MessageHex), un(s.SignatureHex)) || !ed25519.Verify(pub, un(s.MessageHex), un(s.SignatureHex)) {
			t.Errorf("honest signature refused for %s", s.MessageHex)
		}
	}
}
