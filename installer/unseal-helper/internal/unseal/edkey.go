package unseal

import (
	"crypto/ed25519"
	"math/big"
)

// Ed25519 public keys are refused before any signature is verified under them when they are not
// canonical or are of small order (test-vectors/ed25519-low-order; edSync.isAcceptableEd25519PublicKey
// in packages/protocol). Go's verify accepts a non-canonical y and, under a small-order key, an
// identity R with a zero S for some messages. The keys here are pinned, so this is consistency.
//
// The rule is on y alone: below p, and not the y of a small-order point (0, 1, p-1 and the two
// order-8 values), which also covers x = 0 with the sign bit set. A key off the curve is refused by
// ed25519.Verify itself.
var (
	edP        = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(19))
	edOrder8Y  = mustHexInt("7a03ac9277fdc74ec6cc392cfa53202a0f67100d760b3cba4fd84d3d706a17c7")
	smallOrder = []*big.Int{big.NewInt(0), big.NewInt(1), new(big.Int).Sub(edP, big.NewInt(1)), edOrder8Y, new(big.Int).Sub(edP, edOrder8Y)}
)

func mustHexInt(h string) *big.Int {
	v, ok := new(big.Int).SetString(h, 16)
	if !ok {
		panic("bad constant")
	}
	return v
}

// AcceptableEd25519PublicKey is true for a 32-byte, canonically encoded key not of small order.
func AcceptableEd25519PublicKey(pub []byte) bool {
	if len(pub) != ed25519.PublicKeySize {
		return false
	}
	le := make([]byte, 32)
	for i := range pub {
		le[31-i] = pub[i]
	}
	le[0] &= 0x7f
	y := new(big.Int).SetBytes(le)
	if y.Cmp(edP) >= 0 {
		return false
	}
	for _, s := range smallOrder {
		if y.Cmp(s) == 0 {
			return false
		}
	}
	return true
}

// verifyEd25519 is ed25519.Verify behind AcceptableEd25519PublicKey.
func verifyEd25519(pub, msg, sig []byte) bool {
	return AcceptableEd25519PublicKey(pub) && ed25519.Verify(ed25519.PublicKey(pub), msg, sig)
}
