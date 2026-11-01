package main

import (
	"bufio"
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeCert struct {
	handle string
	key    *ecdsa.PrivateKey
	chain  string
	cert   *x509.Certificate
}

func newFakeCert(t *testing.T, handle string, names ...string) *fakeCert {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: names[0]},
		DNSNames: names, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(48 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true, IsCA: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return &fakeCert{handle: handle, key: key, cert: c, chain: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))}
}

// fakeKeyd answers the few operations the frontend uses, like flagship-keyd does.
type fakeKeyd struct {
	path   string
	mu     sync.Mutex
	active *fakeCert
	// slots, when set, are answered in tls.active's serving list (keyd with control and apps
	// slots); without them the answer has no serving list, like a keyd from before slots.
	slots  map[string]*fakeCert
	signed map[string]int
	down   bool
	signs  int
	ln     net.Listener
}

func startFakeKeyd(t *testing.T, active *fakeCert) *fakeKeyd {
	t.Helper()
	dir, _ := os.MkdirTemp("", "kd")
	t.Cleanup(func() { os.RemoveAll(dir) })
	k := &fakeKeyd{path: filepath.Join(dir, "k.sock"), active: active}
	ln, err := net.Listen("unix", k.path)
	if err != nil {
		t.Fatal(err)
	}
	k.ln = ln
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go k.serve(c)
		}
	}()
	return k
}

func (k *fakeKeyd) serve(c net.Conn) {
	defer c.Close()
	r := bufio.NewReader(c)
	for {
		var hdr [4]byte
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return
		}
		buf := make([]byte, binary.BigEndian.Uint32(hdr[:]))
		if _, err := io.ReadFull(r, buf); err != nil {
			return
		}
		var req struct {
			ID   uint64         `json:"id"`
			Op   string         `json:"op"`
			Args map[string]any `json:"args"`
		}
		json.Unmarshal(buf, &req)
		k.mu.Lock()
		down, active, slots := k.down, k.active, k.slots
		k.mu.Unlock()
		entry := func(slot string, c *fakeCert) map[string]any {
			return map[string]any{"slot": slot, "handle": c.handle, "chainPem": c.chain, "notAfter": c.cert.NotAfter.UnixMilli(), "names": c.cert.DNSNames}
		}
		if down {
			return
		}
		res := map[string]any{"id": req.ID, "ok": true}
		switch req.Op {
		case "hello":
			res["result"] = map[string]any{"v": 1}
		case "tls.active":
			r := map[string]any{"active": nil}
			if active != nil {
				r["active"] = entry("default", active)
			}
			if slots != nil {
				list := []any{}
				for _, slot := range []string{"control", "apps"} {
					if c := slots[slot]; c != nil {
						list = append(list, entry(slot, c))
					}
				}
				if active != nil {
					list = append(list, entry("default", active))
				}
				r["serving"] = list
			}
			res["result"] = r
		case "tls.sign":
			h, _ := req.Args["handle"].(string)
			key := (*ecdsa.PrivateKey)(nil)
			for _, c := range append([]*fakeCert{active}, slots["control"], slots["apps"]) {
				if c != nil && c.handle == h {
					key = c.key
				}
			}
			k.mu.Lock()
			k.signs++
			if k.signed == nil {
				k.signed = map[string]int{}
			}
			k.signed[h]++
			k.mu.Unlock()
			msg, err := keydSignedInput(req.Args)
			var sig []byte
			if err == nil && key == nil {
				err = errors.New("no such key")
			}
			if err == nil {
				d := sha256.Sum256(msg)
				sig, err = ecdsa.SignASN1(rand.Reader, key, d[:])
			}
			if err != nil {
				res = map[string]any{"id": req.ID, "ok": false, "code": "failed", "message": err.Error()}
			} else {
				res["result"] = map[string]any{"sig": hex.EncodeToString(sig)}
			}
		default:
			res = map[string]any{"id": req.ID, "ok": false, "code": "unknown-op", "message": "no"}
		}
		body, _ := json.Marshal(res)
		out := make([]byte, 4+len(body))
		binary.BigEndian.PutUint32(out, uint32(len(body)))
		copy(out[4:], body)
		c.Write(out)
	}
}

// upstream records the header line and echoes the rest.
type upstream struct {
	path    string
	headers chan connHeader
}

func startUpstream(t *testing.T) *upstream {
	t.Helper()
	// Unix socket paths are short on macOS; keep it directly under the temp dir.
	dir, _ := os.MkdirTemp("", "tlsd")
	t.Cleanup(func() { os.RemoveAll(dir) })
	u := &upstream{path: filepath.Join(dir, "u.sock"), headers: make(chan connHeader, 16)}
	ln, err := net.Listen("unix", u.path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				r := bufio.NewReader(c)
				line, err := r.ReadBytes('\n')
				if err != nil {
					return
				}
				var h connHeader
				json.Unmarshal(line, &h)
				u.headers <- h
				io.Copy(c, r)
			}()
		}
	}()
	return u
}

func startFrontend(t *testing.T, kd *fakeKeyd, up *upstream, refresh time.Duration) (addr string, cfg *config) {
	t.Helper()
	cfg = &config{listen: "127.0.0.1:0", keydSocket: kd.path, upstream: up.path, maxConns: 64, handshake: 3 * time.Second, refresh: refresh, minTLS: tls.VersionTLS12}
	src := &certSource{client: newKeydClient(kd.path, "tlsd-test"), refresh: refresh}
	l, err := net.Listen("tcp", cfg.listen)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go serve(l, cfg, src.tlsConfig(cfg.minTLS))
	return l.Addr().String(), cfg
}

func client(t *testing.T, addr, sni string, trust *x509.Certificate, mod func(*tls.Config)) (*tls.Conn, error) {
	pool := x509.NewCertPool()
	pool.AddCert(trust)
	cc := &tls.Config{ServerName: sni, RootCAs: pool, NextProtos: []string{"http/1.1"}}
	if mod != nil {
		mod(cc)
	}
	return tls.Dial("tcp", addr, cc)
}

func TestServesTLSWithTheKeyInKeydAndForwardsPlaintext(t *testing.T) {
	fc := newFakeCert(t, "h1", "home.alice.flagship.services", "*.home.alice.flagship.services")
	kd := startFakeKeyd(t, fc)
	up := startUpstream(t)
	addr, _ := startFrontend(t, kd, up, time.Second)

	c, err := client(t, addr, "chess.home.alice.flagship.services", fc.cert, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte("hello through tls\n"))
	got := make([]byte, 64)
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _ := c.Read(got)
	if string(got[:n]) != "hello through tls\n" {
		t.Fatalf("echo = %q", got[:n])
	}
	h := <-up.headers
	if h.SNI != "chess.home.alice.flagship.services" || h.ALPN != "http/1.1" || (h.TLS != "1.3" && h.TLS != "1.2") {
		t.Fatalf("header = %+v", h)
	}
	kd.mu.Lock()
	defer kd.mu.Unlock()
	if kd.signs == 0 {
		t.Fatal("the handshake was not signed by keyd")
	}
}

func TestRefusesANameTheCertificateDoesNotCover(t *testing.T) {
	fc := newFakeCert(t, "h1", "home.alice.flagship.services", "*.home.alice.flagship.services")
	kd := startFakeKeyd(t, fc)
	up := startUpstream(t)
	addr, _ := startFrontend(t, kd, up, time.Second)
	for _, sni := range []string{"evil.example.com", "alice.flagship.services", "a.b.home.alice.flagship.services"} {
		if c, err := client(t, addr, sni, fc.cert, func(c *tls.Config) { c.InsecureSkipVerify = true }); err == nil {
			c.Close()
			t.Fatalf("handshake for %q succeeded", sni)
		}
	}
	select {
	case h := <-up.headers:
		t.Fatalf("a refused handshake reached the daemon: %+v", h)
	case <-time.After(150 * time.Millisecond):
	}
}

func TestRefusesAnOldTLSVersionAndAcmeAlpn(t *testing.T) {
	fc := newFakeCert(t, "h1", "home.alice.flagship.services", "*.home.alice.flagship.services")
	kd := startFakeKeyd(t, fc)
	up := startUpstream(t)
	addr, _ := startFrontend(t, kd, up, time.Second)
	if c, err := client(t, addr, "home.alice.flagship.services", fc.cert, func(c *tls.Config) { c.MaxVersion = tls.VersionTLS11 }); err == nil {
		c.Close()
		t.Fatal("TLS 1.1 was accepted")
	}
	if c, err := client(t, addr, "home.alice.flagship.services", fc.cert, func(c *tls.Config) { c.NextProtos = []string{"acme-tls/1"} }); err == nil {
		st := c.ConnectionState()
		c.Close()
		if st.NegotiatedProtocol == "acme-tls/1" {
			t.Fatal("acme-tls/1 was negotiated")
		}
	}
}

func TestPicksUpARenewalWithoutDroppingConnections(t *testing.T) {
	old := newFakeCert(t, "old", "home.alice.flagship.services", "*.home.alice.flagship.services")
	kd := startFakeKeyd(t, old)
	up := startUpstream(t)
	addr, _ := startFrontend(t, kd, up, 50*time.Millisecond)

	c1, err := client(t, addr, "home.alice.flagship.services", old.cert, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c1.Close()
	fresh := newFakeCert(t, "new", "home.alice.flagship.services", "*.home.alice.flagship.services")
	kd.mu.Lock()
	kd.active = fresh
	kd.mu.Unlock()
	time.Sleep(120 * time.Millisecond)
	c2, err := client(t, addr, "home.alice.flagship.services", fresh.cert, nil)
	if err != nil {
		t.Fatalf("new connection did not get the renewed certificate: %v", err)
	}
	c2.Close()
	// The connection opened before the renewal still works.
	c1.Write([]byte("still here\n"))
	buf := make([]byte, 32)
	c1.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _ := c1.Read(buf)
	if !strings.HasPrefix(string(buf[:n]), "still here") {
		t.Fatalf("old connection broke: %q", buf[:n])
	}
}

func TestKeepsServingWhenKeydIsBrieflyUnreachable(t *testing.T) {
	fc := newFakeCert(t, "h1", "home.alice.flagship.services", "*.home.alice.flagship.services")
	kd := startFakeKeyd(t, fc)
	up := startUpstream(t)
	addr, _ := startFrontend(t, kd, up, 20*time.Millisecond)
	c, err := client(t, addr, "home.alice.flagship.services", fc.cert, nil)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	kd.mu.Lock()
	kd.down = true
	kd.mu.Unlock()
	kd.ln.Close()
	os.Remove(kd.path)
	time.Sleep(60 * time.Millisecond)
	// The certificate is cached but the handshake needs a signature, which needs keyd: it fails
	// closed rather than serving without the key.
	if c2, err := client(t, addr, "home.alice.flagship.services", fc.cert, nil); err == nil {
		c2.Close()
		t.Fatal("handshake succeeded with keyd gone")
	}
}

// keydSignedInput is what keyd's tls.sign builds from its fields (packages/keyd/src/tls.ts).
func keydSignedInput(a map[string]any) ([]byte, error) {
	str := func(k string) []byte {
		v, _ := a[k].(string)
		b, _ := hex.DecodeString(v)
		return b
	}
	if _, bare := a["digest"]; bare {
		return nil, errors.New("unknown field digest")
	}
	switch a["tls"] {
	case "1.3":
		return append(append(bytes.Repeat([]byte{0x20}, 64), tls13ServerContext...), str("transcriptHash")...), nil
	case "1.2":
		return append(append(str("clientRandom"), str("serverRandom")...), str("params")...), nil
	}
	return nil, errors.New("tls must be 1.3 or 1.2")
}

func TestSignerRefusesBareDigestsAndOtherHashes(t *testing.T) {
	s := &keydSigner{client: newKeydClient("/nonexistent", "x"), handle: "h"}
	if _, err := s.Sign(nil, make([]byte, 32), crypto.SHA256); err == nil {
		t.Fatal("a bare digest was signed")
	}
	tls13 := append(append(bytes.Repeat([]byte{0x20}, 64), tls13ServerContext...), make([]byte, 32)...)
	if _, err := s.SignMessage(nil, tls13, crypto.SHA1); err == nil {
		t.Fatal("SHA-1 was signed")
	}
	if _, err := s.SignMessage(nil, []byte("flagship/x/v1|a"), crypto.SHA256); err == nil {
		t.Fatal("a non-TLS message was sent to keyd")
	}
}

func TestTLSSignArgs(t *testing.T) {
	th := bytes.Repeat([]byte{7}, 48)
	a, err := tlsSignArgs(append(append(bytes.Repeat([]byte{0x20}, 64), tls13ServerContext...), th...))
	if err != nil || a["tls"] != "1.3" || a["transcriptHash"] != hex.EncodeToString(th) {
		t.Fatalf("1.3: %v %v", a, err)
	}
	params := append([]byte{3, 0, 0x1d, 32}, bytes.Repeat([]byte{9}, 32)...)
	a, err = tlsSignArgs(append(append(bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)...), params...))
	if err != nil || a["tls"] != "1.2" || a["params"] != hex.EncodeToString(params) || a["clientRandom"] != hex.EncodeToString(bytes.Repeat([]byte{1}, 32)) {
		t.Fatalf("1.2: %v %v", a, err)
	}
	if _, err := tlsSignArgs(append(append(bytes.Repeat([]byte{0x20}, 64), tls13ServerContext...), 1, 2, 3)); err == nil {
		t.Fatal("a short transcript hash was accepted")
	}
}

func TestTLS12HandshakeSignsServerKeyExchangeThroughKeyd(t *testing.T) {
	fc := newFakeCert(t, "h1", "home.alice.flagship.services")
	addr, _ := startFrontend(t, startFakeKeyd(t, fc), startUpstream(t), time.Second)
	c, err := client(t, addr, "home.alice.flagship.services", fc.cert, func(c *tls.Config) { c.MaxVersion = tls.VersionTLS12 })
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if v := c.ConnectionState().Version; v != tls.VersionTLS12 {
		t.Fatalf("version %x", v)
	}
}

func TestBuildCertificateNeedsAnECDSALeaf(t *testing.T) {
	if _, err := buildCertificate(newKeydClient("/x", "x"), &activeCert{Handle: "h", ChainPEM: "not pem"}); err == nil {
		t.Fatal("garbage accepted")
	}
}

func TestServesTheControlCertificateForTheBoxNameAndTheAppsCertificateForAppNames(t *testing.T) {
	control := newFakeCert(t, "control", "home.alice.flagship.services")
	apps := newFakeCert(t, "apps", "*.home.alice.flagship.services")
	// The default certificate is the control one (no account wildcard): before slots, every app
	// name got it and browsers refused it (gym 20).
	kd := startFakeKeyd(t, control)
	kd.slots = map[string]*fakeCert{"control": control, "apps": apps}
	up := startUpstream(t)
	addr, _ := startFrontend(t, kd, up, time.Second)

	for _, tc := range []struct {
		sni  string
		want *fakeCert
	}{
		{"home.alice.flagship.services", control},
		{"chess.home.alice.flagship.services", apps},
		{"CHESS.home.alice.flagship.services", apps},
	} {
		c, err := client(t, addr, tc.sni, tc.want.cert, nil)
		if err != nil {
			t.Fatalf("%s: %v", tc.sni, err)
		}
		if got := c.ConnectionState().PeerCertificates[0]; !got.Equal(tc.want.cert) {
			t.Fatalf("%s got the %s certificate", tc.sni, got.DNSNames)
		}
		c.Close()
	}
	kd.mu.Lock()
	signedControl, signedApps := kd.signed["control"], kd.signed["apps"]
	kd.mu.Unlock()
	if signedControl == 0 || signedApps == 0 {
		t.Fatalf("each certificate's own key must sign: %v", kd.signed)
	}
	if c, err := client(t, addr, "evil.example.com", control.cert, func(c *tls.Config) { c.InsecureSkipVerify = true }); err == nil {
		c.Close()
		t.Fatal("a name no certificate covers got one")
	}
}

func TestOneCertificateFromAnOlderKeydServesEveryNameItCovers(t *testing.T) {
	combined := newFakeCert(t, "one", "home.alice.flagship.services", "*.home.alice.flagship.services", "*.alice.flagship.services")
	kd := startFakeKeyd(t, combined)
	up := startUpstream(t)
	addr, _ := startFrontend(t, kd, up, time.Second)
	for _, sni := range []string{"home.alice.flagship.services", "chess.home.alice.flagship.services", "blog.alice.flagship.services"} {
		c, err := client(t, addr, sni, combined.cert, nil)
		if err != nil {
			t.Fatalf("%s: %v", sni, err)
		}
		c.Close()
	}
}

func TestPickPrefersTheClassThenAnyCoveringInDateCertificate(t *testing.T) {
	cert := func(fc *fakeCert) *tls.Certificate {
		c, err := buildCertificate(nil, &activeCert{Handle: fc.handle, ChainPEM: fc.chain})
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	control := cert(newFakeCert(t, "c", "home.alice.flagship.services"))
	apps := cert(newFakeCert(t, "a", "*.home.alice.flagship.services", "*.alice.flagship.services"))
	both := cert(newFakeCert(t, "d", "home.alice.flagship.services", "*.home.alice.flagship.services"))
	now := time.Now()
	set := []slotCert{{slot: "control", cert: control}, {slot: "apps", cert: apps}, {slot: "default", cert: both}}
	for sni, want := range map[string]*tls.Certificate{
		"home.alice.flagship.services":       control,
		"home.alice.flagship.services.":      control,
		"chess.home.alice.flagship.services": apps,
		"blog.alice.flagship.services":       apps,
	} {
		if got, err := pick(set, sni, now); err != nil || got != want {
			t.Fatalf("%s: got %v, %v", sni, got, err)
		}
	}
	// An expired apps certificate gives way to the in-date default that covers the name...
	later := apps.Leaf.NotAfter.Add(time.Minute)
	set2 := []slotCert{{slot: "control", cert: control}, {slot: "apps", cert: apps}, {slot: "default", cert: cert(newFakeCert(t, "d2", "home.alice.flagship.services", "*.home.alice.flagship.services"))}}
	set2[2].cert.Leaf.NotAfter = later.Add(time.Hour)
	if got, _ := pick(set2, "chess.home.alice.flagship.services", later); got != set2[2].cert {
		t.Fatal("an expired certificate won over an in-date one")
	}
	// ...but with nothing else covering the name, the expired one is still served (as before).
	if got, _ := pick(set2[:2], "blog.alice.flagship.services", later); got != apps {
		t.Fatal("the only covering certificate was not served")
	}
	// A name only the default covers never gets the control or apps certificate.
	if _, err := pick([]slotCert{{slot: "control", cert: control}}, "chess.home.alice.flagship.services", now); err == nil {
		t.Fatal("the control certificate was served for an app name it does not cover")
	}
	if _, err := pick(set, "", now); err == nil {
		t.Fatal("no SNI got a certificate")
	}
}
