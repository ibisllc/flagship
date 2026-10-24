// Command flagship-unseal opens a phone-sealed boot secret using the box's
// Ed25519 boot key (the only key on /boot; see packages/protocol/src/bootKey.ts). It is a static binary intended for the
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
// The key is read from a PKCS#8 PEM file (--identity-pem, what the initramfs
// uses) or as hex on stdin (--identity-stdin). --identity-priv-hex still works
// for tests, but puts the seed in /proc/<pid>/cmdline, so nothing on a box uses
// it.
//
//  3. Auto-unlock lease, checked before it is opened (owner signature, server,
//     recipient, expiry):
//
//     flagship-unseal --identity-pem /boot/flagship-boot-key.pem \
//     --lease-json lease.json --server-domain <fqdn> --owner-pub-hex <hex>
//
//  4. Boot unlock v2 (docs/architecture-v2/pq-suites.md §19): --v2-request
//     prints the hybrid-signed request body for /api/boot/request and writes a
//     fresh per-boot reply key to --reply-kem-out; --response-json opens a v2
//     reply with --reply-kem-key, and --lease-json a v3 lease with
//     --lease-kem-key, both checking the owner's hybrid key from
//     --owner-pq-pub-file. --unlock-policy-file decides whether a classical v1
//     reply or lease is still taken (strict refuses it).
//
// Expiry is checked against the clock (or --now-ms) raised to the floor in
// --time-floor-file, the daemon's last authenticated time.
//
// On any failure (bad key, tag mismatch, ctx/nonce/purpose mismatch, malformed
// input) it writes a message to stderr and exits non-zero. On success it prints
// the secret hex to stdout (newline-terminated unless --raw is given, which
// writes the raw secret bytes instead).
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/flagship/installer/unseal-helper/internal/unseal"
)

// sealedSecretResponseJSON mirrors the SealedSecretResponse wire shape from
// phoneEndpoint.ts, with byte fields rendered as hex (the JSON the daemon would
// have fetched from the .com mailbox, hex-encoded for transport to this tool).
type sealedSecretResponseJSON struct {
	ServerDomain    string `json:"serverDomain"`
	RequestNonceHex string `json:"requestNonceHex"`
	Purpose         string `json:"purpose"`
	SealedHex       string `json:"sealedHex"`
	IssuedAt        int64  `json:"issuedAt"`
}

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "flagship-unseal: "+err.Error())
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer) error {
	fs := flag.NewFlagSet("flagship-unseal", flag.ContinueOnError)
	identityPrivHex := fs.String("identity-priv-hex", "", "box Ed25519 key seed, 32 bytes hex (tests only: it shows in the process list)")
	identityPEM := fs.String("identity-pem", "", "path to the box's Ed25519 PKCS#8 PEM key")
	identityStdin := fs.Bool("identity-stdin", false, "read the box's Ed25519 key seed (64 hex chars) from stdin")
	sealedHex := fs.String("sealed-hex", "", "the sealed blob, hex")
	response := fs.Bool("response", false, "treat --sealed-hex as a SealedSecretResponse and verify the bound (nonce, purpose)")
	nonceHex := fs.String("nonce-hex", "", "the request nonce (hex) the box sent; required with --response")
	purpose := fs.String("purpose", "", "the request purpose the box sent (e.g. unlock-key); required with --response")
	responseJSON := fs.String("response-json", "", "path to a SealedSecretResponse JSON ('-' for stdin); implies --response")
	leaseJSON := fs.String("lease-json", "", "path to an auto-unlock lease JSON ('-' for stdin); checked before it is opened")
	serverDomain := fs.String("server-domain", "", "this box's FQDN; required with --lease-json")
	ownerPubHex := fs.String("owner-pub-hex", "", "the owner key the lease must be signed by, 32 bytes hex; required with --lease-json")
	nowMs := fs.String("now-ms", "", "the time to check lease expiry against, epoch ms (default: the clock)")
	raw := fs.Bool("raw", false, "write the raw secret bytes to stdout instead of hex")
	timeFloorFile := fs.String("time-floor-file", "", "the daemon's last authenticated time (epoch ms); the clock is never read earlier than it")
	policyFile := fs.String("unlock-policy-file", "", "the box's unlock policy file (strict refuses a classical v1 reply or lease)")
	ownerPqFile := fs.String("owner-pq-pub-file", "", "the owner's hybrid key (Ed25519 || ML-DSA-65, hex) v2 replies and v3 leases must be signed by")
	replyKemKey := fs.String("reply-kem-key", "", "the per-boot reply key seed (hex) a v2 reply is sealed to")
	leaseKemKey := fs.String("lease-kem-key", "", "the lease key seed (hex) a v3 lease is sealed to ('-' for stdin)")
	bootPqKey := fs.String("boot-pq-key", "", "the boot key's ML-DSA-65 seed (hex); required with --v2-request")
	v2Request := fs.Bool("v2-request", false, "print a hybrid-signed v2 unlock request body and write a fresh reply key to --reply-kem-out")
	replyKemOut := fs.String("reply-kem-out", "", "where --v2-request writes the per-boot reply key seed (created, mode 0600)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	sources := 0
	for _, set := range []bool{*identityPrivHex != "", *identityPEM != "", *identityStdin} {
		if set {
			sources++
		}
	}
	if sources != 1 {
		return fmt.Errorf("give exactly one of --identity-pem, --identity-stdin or --identity-priv-hex")
	}
	if *identityStdin && (*responseJSON == "-" || *leaseJSON == "-" || *leaseKemKey == "-") {
		return fmt.Errorf("--identity-stdin cannot share stdin with a JSON input")
	}
	if *leaseKemKey == "-" && (*responseJSON == "-" || *leaseJSON == "-") {
		return fmt.Errorf("--lease-kem-key - cannot share stdin with a JSON input")
	}
	now := time.Now().UnixMilli()
	if *nowMs != "" {
		n, perr := strconv.ParseInt(*nowMs, 10, 64)
		if perr != nil {
			return fmt.Errorf("--now-ms is not a number")
		}
		now = n
	}
	if *timeFloorFile != "" {
		if f, ok := readTimeFloor(*timeFloorFile); ok && f > now {
			now = f
		}
	}
	var ownerPq []byte
	if *ownerPqFile != "" {
		b, rerr := os.ReadFile(*ownerPqFile)
		if rerr == nil {
			pq, derr := decodeHex("owner-pq-pub-file", string(b))
			if derr != nil || len(pq) != unseal.HybridSigPublicKeyLen {
				return fmt.Errorf("--owner-pq-pub-file must hold the owner's %d-byte hybrid key as hex", unseal.HybridSigPublicKeyLen)
			}
			ownerPq = pq
		} else if !errors.Is(rerr, os.ErrNotExist) {
			return fmt.Errorf("reading owner hybrid key: %w", rerr)
		}
	}
	policy := "compat"
	if *policyFile != "" {
		b, rerr := os.ReadFile(*policyFile)
		policy = unseal.ParseUnlockPolicy(b, rerr == nil, ownerPq != nil)
	}
	var seed []byte
	var err error
	switch {
	case *identityPEM != "":
		pem, rerr := os.ReadFile(*identityPEM)
		if rerr != nil {
			return fmt.Errorf("reading identity key %q: %w", *identityPEM, rerr)
		}
		seed, err = unseal.SeedFromPKCS8PEM(pem)
		for k := range pem {
			pem[k] = 0
		}
		if err != nil {
			return err
		}
	case *identityStdin:
		b, rerr := io.ReadAll(io.LimitReader(stdin, 256))
		if rerr != nil {
			return fmt.Errorf("reading identity seed from stdin: %w", rerr)
		}
		seed, err = decodeHex("identity-stdin", string(b))
		for k := range b {
			b[k] = 0
		}
		if err != nil {
			return err
		}
	default:
		seed, err = decodeHex("identity-priv-hex", *identityPrivHex)
		if err != nil {
			return err
		}
	}
	defer func() {
		for k := range seed {
			seed[k] = 0
		}
	}()
	if len(seed) != 32 {
		return fmt.Errorf("the identity seed must be 32 bytes (64 hex chars), got %d bytes", len(seed))
	}

	var secret []byte
	defer func() {
		for k := range secret {
			secret[k] = 0
		}
	}()

	switch {
	case *v2Request:
		if *serverDomain == "" || *nonceHex == "" || *bootPqKey == "" || *replyKemOut == "" {
			return fmt.Errorf("--server-domain, --nonce-hex, --boot-pq-key and --reply-kem-out are required with --v2-request")
		}
		ml, rerr := readSeedFile("boot-pq-key", *bootPqKey, stdin)
		if rerr != nil {
			return rerr
		}
		defer wipe(ml)
		reply := make([]byte, 32)
		defer wipe(reply)
		if _, rerr := io.ReadFull(rand.Reader, reply); rerr != nil {
			return fmt.Errorf("no randomness for the reply key: %w", rerr)
		}
		body, serr := unseal.SignRequestV2(seed, ml, *serverDomain, *nonceHex, now, reply, false)
		if serr != nil {
			return serr
		}
		f, oerr := os.OpenFile(*replyKemOut, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if oerr != nil {
			return fmt.Errorf("writing the reply key: %w", oerr)
		}
		_, werr := io.WriteString(f, hex.EncodeToString(reply)+"\n")
		if cerr := f.Close(); werr == nil {
			werr = cerr
		}
		if werr != nil {
			return fmt.Errorf("writing the reply key: %w", werr)
		}
		out, _ := json.Marshal(body)
		_, werr = stdout.Write(append(out, '\n'))
		return werr

	case *leaseJSON != "":
		if *serverDomain == "" || *ownerPubHex == "" {
			return fmt.Errorf("--server-domain and --owner-pub-hex are required with --lease-json")
		}
		owner, derr := decodeHex("owner-pub-hex", *ownerPubHex)
		if derr != nil {
			return derr
		}
		if len(owner) != 32 {
			return fmt.Errorf("--owner-pub-hex must be 32 bytes (64 hex chars), got %d bytes", len(owner))
		}
		var body []byte
		var rerr error
		if *leaseJSON == "-" {
			body, rerr = io.ReadAll(io.LimitReader(stdin, 1<<20))
		} else {
			body, rerr = os.ReadFile(*leaseJSON)
		}
		if rerr != nil {
			return fmt.Errorf("reading lease JSON: %w", rerr)
		}
		var leaseKem []byte
		if *leaseKemKey != "" {
			k, kerr := readSeedFile("lease-kem-key", *leaseKemKey, stdin)
			if kerr != nil {
				return kerr
			}
			leaseKem = k
			defer wipe(leaseKem)
		}
		secret, err = unseal.OpenAutoUnlockLeaseAny(body, seed, *serverDomain, owner, ownerPq, leaseKem, policy, now)
		if err != nil {
			return err
		}

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
		if perr := unseal.BoxAcceptsVersion(policy, sealed); perr != nil {
			return perr
		}
		if unseal.IsV2Sealed(sealed) {
			if *replyKemKey == "" || ownerPq == nil || *serverDomain == "" || r.Purpose != "unlock-key" {
				return fmt.Errorf("a v2 reply needs --reply-kem-key, --owner-pq-pub-file and --server-domain, for unlock-key only")
			}
			k, kerr := readSeedFile("reply-kem-key", *replyKemKey, stdin)
			if kerr != nil {
				return kerr
			}
			defer wipe(k)
			bootPub := unseal.PublicKeyHex(seed)
			secret, err = unseal.OpenBootReplyV2(sealed, *serverDomain, bootPub, r.RequestNonceHex, k, ownerPq)
			if err != nil {
				return err
			}
			// The reply key opens once.
			_ = os.WriteFile(*replyKemKey, make([]byte, 65), 0o600)
			_ = os.Remove(*replyKemKey)
			break
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
		if perr := unseal.BoxAcceptsVersion(policy, sealed); perr != nil {
			return perr
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
		if perr := unseal.BoxAcceptsVersion(policy, sealed); perr != nil {
			return perr
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

func wipe(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// readSeedFile reads a 32-byte seed written as hex (one trailing newline) from path, or stdin for "-".
func readSeedFile(name, path string, stdin io.Reader) ([]byte, error) {
	var b []byte
	var err error
	if path == "-" {
		b, err = io.ReadAll(io.LimitReader(stdin, 256))
	} else {
		b, err = os.ReadFile(path)
	}
	if err != nil {
		return nil, fmt.Errorf("reading --%s: %w", name, err)
	}
	defer wipe(b)
	s, derr := decodeHex(name, string(b))
	if derr != nil {
		return nil, derr
	}
	if len(s) != 32 {
		wipe(s)
		return nil, fmt.Errorf("--%s must hold a 32-byte seed as hex", name)
	}
	return s, nil
}

// readTimeFloor reads the floor as the Rust boot client does: decimal epoch ms, at most 16
// digits, one optional trailing newline; anything else is ignored.
func readTimeFloor(path string) (int64, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	t := strings.TrimSuffix(string(b), "\n")
	if t == "" || len(t) > 16 || strings.Trim(t, "0123456789") != "" {
		return 0, false
	}
	n, err := strconv.ParseInt(t, 10, 64)
	return n, err == nil
}
