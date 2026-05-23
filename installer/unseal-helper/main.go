// Command flagship-unseal opens a phone-sealed boot secret using the box's
// Ed25519 identity (STK) seed. It is a static binary intended for the
// pre-unlock initramfs, where the node runtime + @flagship/protocol live on the
// still-encrypted root and are unavailable.
//
// Two modes:
//
//  1. Raw sealed blob (sealForRecipient / AutoUnlockLeaseV2.sealedKey):
//
//     flagship-unseal --identity-priv-hex <64hex> --sealed-hex <hex>
//     -> prints the unsealed secret as hex on stdout.
//
//  2. SealedSecretResponse (phone's reply, nonce/purpose-bound). Provide the
//     sealed blob plus the (nonce, purpose) of the request the box actually
//     sent; the ctx header is verified before the secret is returned:
//
//     flagship-unseal --identity-priv-hex <64hex> --sealed-hex <hex> \
//     --response --nonce-hex <hex> --purpose unlock-key
//
//     Or feed a SealedSecretResponse JSON (matching phoneEndpoint.ts wire
//     shape, with `sealed` as hex) on stdin or via --response-json <path>:
//
//     flagship-unseal --identity-priv-hex <64hex> --response-json reply.json
//
// On any failure (bad key, tag mismatch, ctx/nonce/purpose mismatch, malformed
// input) it writes a message to stderr and exits non-zero. On success it prints
// the secret hex to stdout (newline-terminated unless --raw is given, which
// writes the raw secret bytes instead).
package main

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/flagship/installer/unseal-helper/internal/unseal"
)

// sealedSecretResponseJSON mirrors the SealedSecretResponse wire shape from
// phoneEndpoint.ts, with byte fields rendered as hex (the JSON the daemon would
// have fetched from the .com mailbox, hex-encoded for transport to this tool).
type sealedSecretResponseJSON struct {
	ServerDomain   string `json:"serverDomain"`
	RequestNonceHex string `json:"requestNonceHex"`
	Purpose        string `json:"purpose"`
	SealedHex      string `json:"sealedHex"`
	IssuedAt       int64  `json:"issuedAt"`
}

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "flagship-unseal: "+err.Error())
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer) error {
	fs := flag.NewFlagSet("flagship-unseal", flag.ContinueOnError)
	identityPrivHex := fs.String("identity-priv-hex", "", "box Ed25519 identity (STK) seed, 32 bytes hex (64 chars)")
	sealedHex := fs.String("sealed-hex", "", "the sealed blob, hex")
	response := fs.Bool("response", false, "treat --sealed-hex as a SealedSecretResponse and verify the bound (nonce, purpose)")
	nonceHex := fs.String("nonce-hex", "", "the request nonce (hex) the box sent; required with --response")
	purpose := fs.String("purpose", "", "the request purpose the box sent (e.g. unlock-key); required with --response")
	responseJSON := fs.String("response-json", "", "path to a SealedSecretResponse JSON ('-' for stdin); implies --response")
	raw := fs.Bool("raw", false, "write the raw secret bytes to stdout instead of hex")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *identityPrivHex == "" {
		return fmt.Errorf("--identity-priv-hex is required")
	}
	seed, err := decodeHex("identity-priv-hex", *identityPrivHex)
	if err != nil {
		return err
	}
	if len(seed) != 32 {
		return fmt.Errorf("--identity-priv-hex must be 32 bytes (64 hex chars), got %d bytes", len(seed))
	}

	var secret []byte

	switch {
	case *responseJSON != "":
		blob := []byte(*responseJSON)
		if *responseJSON == "-" {
			b, rerr := io.ReadAll(stdin)
			if rerr != nil {
				return fmt.Errorf("reading response JSON from stdin: %w", rerr)
			}
			blob = b
		} else {
			b, rerr := os.ReadFile(*responseJSON)
			if rerr != nil {
				return fmt.Errorf("reading response JSON %q: %w", *responseJSON, rerr)
			}
			blob = b
		}
		var r sealedSecretResponseJSON
		if jerr := json.Unmarshal(blob, &r); jerr != nil {
			return fmt.Errorf("parsing SealedSecretResponse JSON: %w", jerr)
		}
		sealed, derr := decodeHex("sealedHex", r.SealedHex)
		if derr != nil {
			return derr
		}
		secret, err = unseal.OpenSealedSecretResponse(sealed, seed, r.RequestNonceHex, r.Purpose)
		if err != nil {
			return err
		}

	case *response:
		if *sealedHex == "" {
			return fmt.Errorf("--sealed-hex is required with --response")
		}
		if *nonceHex == "" || *purpose == "" {
			return fmt.Errorf("--nonce-hex and --purpose are required with --response")
		}
		sealed, derr := decodeHex("sealed-hex", *sealedHex)
		if derr != nil {
			return derr
		}
		secret, err = unseal.OpenSealedSecretResponse(sealed, seed, *nonceHex, *purpose)
		if err != nil {
			return err
		}

	default:
		if *sealedHex == "" {
			return fmt.Errorf("--sealed-hex is required (or use --response-json)")
		}
		sealed, derr := decodeHex("sealed-hex", *sealedHex)
		if derr != nil {
			return derr
		}
		secret, err = unseal.OpenSealedFromEd25519Recipient(sealed, seed)
		if err != nil {
			return err
		}
	}

	if *raw {
		if _, werr := stdout.Write(secret); werr != nil {
			return werr
		}
		return nil
	}
	if _, werr := io.WriteString(stdout, hex.EncodeToString(secret)+"\n"); werr != nil {
		return werr
	}
	return nil
}

func decodeHex(name, s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	b, err := hex.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("--%s is not valid hex: %w", name, err)
	}
	return b, nil
}
