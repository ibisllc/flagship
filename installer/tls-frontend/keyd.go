package main

import (
	"bufio"
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

// keydClient speaks flagship-keyd's wire protocol, version 1: a 4-byte big-endian length and
// a JSON body. One connection, requests serialized; it reconnects (and says hello again) when
// the connection drops.
type keydClient struct {
	path      string
	component string
	mu        sync.Mutex
	conn      net.Conn
	r         *bufio.Reader
	next      uint64
}

const maxFrame = 4 << 20

func newKeydClient(path, component string) *keydClient {
	return &keydClient{path: path, component: component}
}

type keydResponse struct {
	ID      uint64                     `json:"id"`
	OK      bool                       `json:"ok"`
	Result  map[string]json.RawMessage `json:"result"`
	Code    string                     `json:"code"`
	Message string                     `json:"message"`
}

func (c *keydClient) dial() error {
	conn, err := net.DialTimeout("unix", c.path, 3*time.Second)
	if err != nil {
		return err
	}
	c.conn, c.r = conn, bufio.NewReader(conn)
	if _, err := c.roundTrip("hello", map[string]any{"v": 1, "component": c.component}); err != nil {
		conn.Close()
		c.conn = nil
		return err
	}
	return nil
}

func (c *keydClient) roundTrip(op string, args map[string]any) (map[string]json.RawMessage, error) {
	c.next++
	id := c.next
	body, err := json.Marshal(map[string]any{"id": id, "op": op, "args": args})
	if err != nil {
		return nil, err
	}
	frame := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(frame, uint32(len(body)))
	copy(frame[4:], body)
	c.conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := c.conn.Write(frame); err != nil {
		return nil, err
	}
	var hdr [4]byte
	if _, err := io.ReadFull(c.r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 || n > maxFrame {
		return nil, errors.New("keyd frame out of range")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(c.r, buf); err != nil {
		return nil, err
	}
	var resp keydResponse
	if err := json.Unmarshal(buf, &resp); err != nil {
		return nil, err
	}
	if resp.ID != id {
		return nil, errors.New("keyd answered a different request")
	}
	if !resp.OK {
		return nil, fmt.Errorf("keyd: %s: %s", resp.Code, resp.Message)
	}
	return resp.Result, nil
}

// call sends one request, redialing once if the connection was dropped.
func (c *keydClient) call(op string, args map[string]any) (map[string]json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		if err := c.dial(); err != nil {
			return nil, err
		}
	}
	res, err := c.roundTrip(op, args)
	if err != nil && isTransport(err) {
		c.conn.Close()
		c.conn = nil
		if derr := c.dial(); derr != nil {
			return nil, derr
		}
		return c.roundTrip(op, args)
	}
	return res, err
}

func isTransport(err error) bool {
	var ne net.Error
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.As(err, &ne) || errors.Is(err, net.ErrClosed)
}

// activeCert is what keyd says is in service: the key handle and the certificate chain.
type activeCert struct {
	Handle   string `json:"handle"`
	ChainPEM string `json:"chainPem"`
	NotAfter int64  `json:"notAfter"`
	Names    []string
}

func (c *keydClient) active() (*activeCert, error) {
	res, err := c.call("tls.active", map[string]any{})
	if err != nil {
		return nil, err
	}
	var a *activeCert
	if err := json.Unmarshal(res["active"], &a); err != nil {
		return nil, err
	}
	return a, nil
}

// keydSigner is a crypto.MessageSigner whose private key stays in keyd. crypto/tls hands it the
// whole signed input (Go 1.25+), and it sends keyd the TLS fields, not a digest: keyd rebuilds
// the input itself and signs only TLS 1.3 CertificateVerify and TLS 1.2 ServerKeyExchange
// inputs, so this process cannot use the key as a general signing oracle.
type keydSigner struct {
	client *keydClient
	handle string
	pub    crypto.PublicKey
}

var _ crypto.MessageSigner = (*keydSigner)(nil)

var tls13ServerContext = []byte("TLS 1.3, server CertificateVerify\x00")

func (s *keydSigner) Public() crypto.PublicKey { return s.pub }

// Sign is the bare-digest form, which keyd does not offer.
func (s *keydSigner) Sign(_ io.Reader, _ []byte, _ crypto.SignerOpts) ([]byte, error) {
	return nil, errors.New("keyd signs TLS handshake inputs, not digests")
}

func (s *keydSigner) SignMessage(_ io.Reader, msg []byte, opts crypto.SignerOpts) ([]byte, error) {
	if opts == nil || opts.HashFunc() != crypto.SHA256 {
		return nil, errors.New("keyd signs ECDSA P-256 with SHA-256 only")
	}
	args, err := tlsSignArgs(msg)
	if err != nil {
		return nil, err
	}
	args["handle"] = s.handle
	res, err := s.client.call("tls.sign", args)
	if err != nil {
		return nil, err
	}
	var sigHex string
	if err := json.Unmarshal(res["sig"], &sigHex); err != nil {
		return nil, err
	}
	return hex.DecodeString(sigHex)
}

// tlsSignArgs splits a server signature input into the fields keyd's tls.sign takes.
func tlsSignArgs(msg []byte) (map[string]any, error) {
	if len(msg) > 64+len(tls13ServerContext) && bytes.Equal(msg[:64], bytes.Repeat([]byte{0x20}, 64)) && bytes.Equal(msg[64:64+len(tls13ServerContext)], tls13ServerContext) {
		th := msg[64+len(tls13ServerContext):]
		if len(th) != 32 && len(th) != 48 {
			return nil, errors.New("not a TLS 1.3 transcript hash")
		}
		return map[string]any{"tls": "1.3", "transcriptHash": hex.EncodeToString(th)}, nil
	}
	if len(msg) >= 64+4 {
		return map[string]any{
			"tls":          "1.2",
			"clientRandom": hex.EncodeToString(msg[:32]),
			"serverRandom": hex.EncodeToString(msg[32:64]),
			"params":       hex.EncodeToString(msg[64:]),
		}, nil
	}
	return nil, errors.New("not a TLS server signature input")
}

// buildCertificate turns keyd's active entry into a tls.Certificate that signs through keyd.
func buildCertificate(c *keydClient, a *activeCert) (*tls.Certificate, error) {
	var der [][]byte
	rest := []byte(a.ChainPEM)
	for {
		var blk *pem.Block
		blk, rest = pem.Decode(rest)
		if blk == nil {
			break
		}
		if blk.Type == "CERTIFICATE" {
			der = append(der, blk.Bytes)
		}
	}
	if len(der) == 0 {
		return nil, errors.New("keyd gave no certificate")
	}
	leaf, err := x509.ParseCertificate(der[0])
	if err != nil {
		return nil, err
	}
	if _, ok := leaf.PublicKey.(*ecdsa.PublicKey); !ok {
		return nil, errors.New("the serving key is not ECDSA")
	}
	return &tls.Certificate{Certificate: der, PrivateKey: &keydSigner{client: c, handle: a.Handle, pub: leaf.PublicKey}, Leaf: leaf}, nil
}
