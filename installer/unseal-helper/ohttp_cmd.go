package main

// `flagship-unseal ohttp-seal` / `ohttp-open`: seal one boot-unlock call for
// the private relay and open its answer (docs/outbound-proxy.md §OHTTP). The
// initramfs carries the bytes with its own curl, which already holds the CA
// bundle, and falls back to the direct request when the relay fails.

import (
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/flagship/installer/unseal-helper/internal/ohttp"
)

type headerFlags []ohttp.Header

func (h *headerFlags) String() string { return "" }
func (h *headerFlags) Set(v string) error {
	name, value, ok := strings.Cut(v, ":")
	if !ok || strings.TrimSpace(name) == "" {
		return fmt.Errorf("header %q must be 'name: value'", v)
	}
	*h = append(*h, ohttp.Header{Name: strings.ToLower(strings.TrimSpace(name)), Value: strings.TrimSpace(value)})
	return nil
}

func runOhttpSeal(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("flagship-unseal ohttp-seal", flag.ContinueOnError)
	keyConfigHex := fs.String("key-config-hex", "", "the gateway's key configuration, hex")
	method := fs.String("method", "GET", "request method")
	target := fs.String("url", "", "the https URL the gateway should serve")
	bodyFile := fs.String("body-file", "", "request body file (optional)")
	outRequest := fs.String("out-request", "", "where to write the Encapsulated Request")
	outContext := fs.String("out-context", "", "where to write the response context (keep it secret)")
	var headers headerFlags
	fs.Var(&headers, "header", "a request header 'name: value' (repeatable)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *keyConfigHex == "" || *target == "" || *outRequest == "" || *outContext == "" {
		return fmt.Errorf("--key-config-hex, --url, --out-request and --out-context are required")
	}
	raw, err := hex.DecodeString(*keyConfigHex)
	if err != nil {
		return fmt.Errorf("--key-config-hex: %w", err)
	}
	cfg, err := ohttp.ParseKeyConfig(raw)
	if err != nil {
		return err
	}
	u, err := url.Parse(*target)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return fmt.Errorf("--url must be an https URL")
	}
	var body []byte
	if *bodyFile != "" {
		if body, err = os.ReadFile(*bodyFile); err != nil {
			return err
		}
	}
	path := u.EscapedPath()
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	req := ohttp.EncodeRequest(strings.ToUpper(*method), "https", u.Host, path, headers, body)
	enc, ctx, err := ohttp.EncapsulateRequest(cfg, req, nil)
	if err != nil {
		return err
	}
	if err := os.WriteFile(*outRequest, enc, 0o600); err != nil {
		return err
	}
	return os.WriteFile(*outContext, []byte(hex.EncodeToString(append(append([]byte{}, ctx.Enc...), ctx.Secret...))), 0o600)
}

func runOhttpOpen(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("flagship-unseal ohttp-open", flag.ContinueOnError)
	contextFile := fs.String("context", "", "the context ohttp-seal wrote")
	responseFile := fs.String("response-file", "", "the relay's Encapsulated Response")
	outBody := fs.String("out-body", "", "where to write the inner response body")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *contextFile == "" || *responseFile == "" || *outBody == "" {
		return fmt.Errorf("--context, --response-file and --out-body are required")
	}
	ctxHex, err := os.ReadFile(*contextFile)
	if err != nil {
		return err
	}
	ctxRaw, err := hex.DecodeString(strings.TrimSpace(string(ctxHex)))
	if err != nil || len(ctxRaw) != 48 {
		return fmt.Errorf("malformed context file")
	}
	enc, err := os.ReadFile(*responseFile)
	if err != nil {
		return err
	}
	res, err := ohttp.DecapsulateResponse(ohttp.Context{Enc: ctxRaw[:32], Secret: ctxRaw[32:]}, enc)
	if err != nil {
		return err
	}
	status, body, err := ohttp.DecodeResponse(res)
	if err != nil {
		return err
	}
	if err := os.WriteFile(*outBody, body, 0o600); err != nil {
		return err
	}
	// The inner status on stdout, like curl -w "%{http_code}".
	_, err = fmt.Fprintf(stdout, "%d", status)
	return err
}
