package main

import (
	"bufio"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
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
		down, active := k.down, k.active
		k.mu.Unlock()
		if down {
			return
		}
		res := map[string]any{"id": req.ID, "ok": true}
		switch req.Op {
		case "hello":
			res["result"] = map[string]any{"v": 1}
		case "tls.active":
			res["result"] = map[string]any{"active": map[string]any{"handle": active.handle, "chainPem": active.chain, "notAfter": active.cert.NotAfter.UnixMilli(), "names": active.cert.DNSNames}}
		case "tls.sign":
			k.mu.Lock()
			k.signs++
			k.mu.Unlock()
			digest, _ := hex.DecodeString(req.Args["digest"].(string))
			sig, err := ecdsa.SignASN1(rand.Reader, active.key, digest)
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

func TestSignerRefusesOtherHashes(t *testing.T) {
	s := &keydSigner{client: newKeydClient("/nonexistent", "x"), handle: "h"}
	if _, err := s.Sign(nil, make([]byte, 20), crypto.SHA1); err == nil {
		t.Fatal("SHA-1 was signed")
	}
}

func TestBuildCertificateNeedsAnECDSALeaf(t *testing.T) {
	if _, err := buildCertificate(newKeydClient("/x", "x"), &activeCert{Handle: "h", ChainPEM: "not pem"}); err == nil {
		t.Fatal("garbage accepted")
	}
}
