// flagship-tlsd — the box's TLS frontend (SECURITY-HARDENING-PLAN.md 6.3).
//
// It terminates TLS for the box without ever holding the certificate's private key: the key
// lives in flagship-keyd, and every handshake signature is one request to it over a Unix
// socket (a crypto.Signer). Decrypted connections go to the daemon on another Unix socket
// behind a one-line header naming the SNI and the negotiated protocol. It has no other
// authority: no key material, no files but its socket paths, no outbound network.
package main

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type config struct {
	listen     string
	keydSocket string
	upstream   string
	maxConns   int
	handshake  time.Duration
	refresh    time.Duration
	minTLS     uint16
}

// certSource hands out the certificates in service, refreshed from keyd every few seconds so a
// renewal takes effect without dropping connections. A box holds up to two: a control
// certificate for exactly its own name and an apps certificate for its app names; each
// handshake gets the one for its SNI (see pick).
type certSource struct {
	client  *keydClient
	refresh time.Duration
	mu      sync.Mutex
	cur     []slotCert
	at      time.Time
}

type slotCert struct {
	slot   string
	handle string
	chain  string
	cert   *tls.Certificate
}

func (s *certSource) get() ([]slotCert, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != nil && time.Since(s.at) < s.refresh {
		return s.cur, nil
	}
	list, err := s.client.serving()
	if err != nil || len(list) == 0 {
		if s.cur != nil {
			// keyd is briefly unreachable: keep serving the certificates we have.
			return s.cur, nil
		}
		if err == nil {
			err = errors.New("no certificate in service")
		}
		return nil, err
	}
	built := make(map[string]*tls.Certificate, len(s.cur))
	for _, c := range s.cur {
		built[c.handle+"\x00"+c.chain] = c.cert
	}
	next := make([]slotCert, 0, len(list))
	for _, a := range list {
		c := built[a.Handle+"\x00"+a.ChainPEM]
		if c == nil {
			if c, err = buildCertificate(s.client, &a.activeCert); err != nil {
				log.Printf("tlsd: skipping the %s certificate: %v", a.Slot, err)
				continue
			}
			built[a.Handle+"\x00"+a.ChainPEM] = c
		}
		next = append(next, slotCert{slot: a.Slot, handle: a.Handle, chain: a.ChainPEM, cert: c})
	}
	if len(next) == 0 {
		if s.cur != nil {
			return s.cur, nil
		}
		return nil, errors.New("no usable certificate in service")
	}
	s.cur, s.at = next, time.Now()
	return next, nil
}

// pick chooses the certificate for a name: the control certificate for exactly the name it
// was issued for, the apps certificate for any other, then whatever else covers the name. An
// in-date certificate always wins over an expired one; a certificate that does not cover the
// name is never served.
func pick(certs []slotCert, sni string, now time.Time) (*tls.Certificate, error) {
	if sni == "" {
		return nil, errors.New("no server name")
	}
	name := strings.ToLower(strings.TrimSuffix(sni, "."))
	controlName := false
	for _, c := range certs {
		if c.slot != "control" {
			continue
		}
		for _, n := range c.cert.Leaf.DNSNames {
			if !strings.HasPrefix(n, "*.") && strings.EqualFold(n, name) {
				controlName = true
			}
		}
	}
	order := []string{"apps", "control", "default"}
	if controlName {
		order = []string{"control", "apps", "default"}
	}
	for _, inDate := range []bool{true, false} {
		for _, slot := range order {
			for _, c := range certs {
				if c.slot != slot || (inDate && !now.Before(c.cert.Leaf.NotAfter)) {
					continue
				}
				if c.cert.Leaf.VerifyHostname(name) == nil {
					return c.cert, nil
				}
			}
		}
	}
	return nil, fmt.Errorf("no certificate for %q", sni)
}

func (s *certSource) tlsConfig(minVersion uint16) *tls.Config {
	return &tls.Config{
		MinVersion: minVersion,
		NextProtos: []string{"http/1.1"},
		GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
			certs, err := s.get()
			if err != nil {
				return nil, err
			}
			// Only a name a certificate covers; anything else gets no certificate.
			return pick(certs, h.ServerName, time.Now())
		},
	}
}

type connHeader struct {
	SNI  string `json:"sni"`
	ALPN string `json:"alpn"`
	TLS  string `json:"tls"`
	// The loopback port the connection came from (the relay tunnel and the LAN listener both dial
	// over loopback); the daemon recognises the LAN listener's ports (server-daemon lanIngress.ts).
	Peer int `json:"peer,omitempty"`
}

// loopbackPeerPort is the peer's port when it connected over loopback, else 0 (left out of the header).
func loopbackPeerPort(a net.Addr) int {
	t, ok := a.(*net.TCPAddr)
	if !ok || t == nil || !t.IP.IsLoopback() {
		return 0
	}
	return t.Port
}

func tlsVersion(v uint16) string {
	switch v {
	case tls.VersionTLS13:
		return "1.3"
	case tls.VersionTLS12:
		return "1.2"
	}
	return "?"
}

func handle(c net.Conn, cfg *config, tc *tls.Config) {
	defer c.Close()
	t := tls.Server(c, tc)
	c.SetDeadline(time.Now().Add(cfg.handshake))
	if err := t.Handshake(); err != nil {
		return
	}
	c.SetDeadline(time.Time{})
	st := t.ConnectionState()
	up, err := net.DialTimeout("unix", cfg.upstream, 3*time.Second)
	if err != nil {
		return
	}
	defer up.Close()
	hdr, _ := json.Marshal(connHeader{SNI: strings.ToLower(st.ServerName), ALPN: st.NegotiatedProtocol, TLS: tlsVersion(st.Version), Peer: loopbackPeerPort(c.RemoteAddr())})
	if _, err := up.Write(append(hdr, '\n')); err != nil {
		return
	}
	done := make(chan struct{}, 2)
	go func() { io.Copy(up, t); closeWrite(up); done <- struct{}{} }()
	go func() { io.Copy(t, up); t.CloseWrite(); done <- struct{}{} }()
	<-done
	<-done
}

func closeWrite(c net.Conn) {
	if u, ok := c.(interface{ CloseWrite() error }); ok {
		u.CloseWrite()
	}
}

func serve(l net.Listener, cfg *config, tc *tls.Config) {
	var active int64
	for {
		c, err := l.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		if int(atomic.AddInt64(&active, 1)) > cfg.maxConns {
			atomic.AddInt64(&active, -1)
			c.Close()
			continue
		}
		go func() {
			defer atomic.AddInt64(&active, -1)
			handle(c, cfg, tc)
		}()
	}
}

func main() {
	cfg := &config{}
	flag.StringVar(&cfg.listen, "listen", "127.0.0.1:18443", "address the tunnel dials for TLS")
	flag.StringVar(&cfg.keydSocket, "keyd", "/run/flagship-keyd/keyd.sock", "flagship-keyd socket")
	flag.StringVar(&cfg.upstream, "upstream", "/run/flagship-tls/upstream.sock", "daemon's plain-text socket")
	flag.IntVar(&cfg.maxConns, "max-conns", 4096, "concurrent connections")
	flag.DurationVar(&cfg.handshake, "handshake-timeout", 10*time.Second, "TLS handshake deadline")
	flag.DurationVar(&cfg.refresh, "refresh", 5*time.Second, "how often to ask keyd which certificate is in service")
	flag.Parse()
	cfg.minTLS = tls.VersionTLS12

	src := &certSource{client: newKeydClient(cfg.keydSocket, "tlsd"), refresh: cfg.refresh}
	l, err := net.Listen("tcp", cfg.listen)
	if err != nil {
		log.Fatalf("flagship-tlsd: %v", err)
	}
	// Tell the daemon where we actually are (useful with port 0).
	fmt.Fprintf(os.Stdout, "listening %s\n", l.Addr())
	_ = bufio.NewWriter(os.Stdout)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	go func() { <-sig; l.Close() }()
	serve(l, cfg, src.tlsConfig(cfg.minTLS))
}
