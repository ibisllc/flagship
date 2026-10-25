module github.com/flagship/installer/tls-frontend

// crypto/tls hands the handshake input to a crypto.MessageSigner only from Go 1.26; with 1.25 it
// calls Sign with a digest, which keyd refuses, and every handshake fails.
go 1.26.0
