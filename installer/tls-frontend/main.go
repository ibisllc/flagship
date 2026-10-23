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

// certSource hands out the certificate in service, refreshed from keyd every few seconds so a
// renewal takes effect without dropping connections.
type certSource struct {
	client  *keydClient
	refresh time.Duration
	mu      sync.Mutex
	cur     *tls.Certificate
	handle  string
	at      time.Time
}

func (s *certSource) get() (*tls.Certificate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != nil && time.Since(s.at) < s.refresh {
		return s.cur, nil
	}
	a, err := s.client.active()
	if err != nil || a == nil {
		if s.cur != nil {
			// keyd is briefly unreachable: keep serving the certificate we have.
			return s.cur, nil
		}
		if err == nil {
			err = errors.New("no certificate in service")
		}
		return nil, err
	}
	if a.Handle == s.handle && s.cur != nil {
		s.at = time.Now()
		return s.cur, nil
	}
	c, err := buildCertificate(s.client, a)
	if err != nil {
		return nil, err
	}
	s.cur, s.handle, s.at = c, a.Handle, time.Now()
	return c, nil
}

func (s *certSource) tlsConfig(minVersion uint16) *tls.Config {
	return &tls.Config{
		MinVersion: minVersion,
		NextProtos: []string{"http/1.1"},
		GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
			c, err := s.get()
			if err != nil {
				return nil, err
			}
			// Only a name the certificate covers; anything else gets no certificate.
			if h.ServerName == "" || c.Leaf.VerifyHostname(h.ServerName) != nil {
				return nil, fmt.Errorf("no certificate for %q", h.ServerName)
			}
			return c, nil
		},
	}
}

type connHeader struct {
	SNI  string `json:"sni"`
	ALPN string `json:"alpn"`
	TLS  string `json:"tls"`
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
	hdr, _ := json.Marshal(connHeader{SNI: strings.ToLower(st.ServerName), ALPN: st.NegotiatedProtocol, TLS: tlsVersion(st.Version)})
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
