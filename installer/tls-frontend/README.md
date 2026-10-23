# flagship-tlsd

The box's TLS frontend (`SECURITY-HARDENING-PLAN.md` 6.3). It terminates TLS for the box
**without holding the certificate's private key**: the key lives in `flagship-keyd`, and each
handshake signature is one `tls.sign` request over keyd's Unix socket (a `crypto.Signer`).

- Listens on `--listen` (the address the tunnel dials), serves the certificate keyd says is in
  service (`tls.active`, refreshed every few seconds so a renewal needs no restart), and only for
  names that certificate covers.
- Forwards each decrypted connection to the daemon on `--upstream` (a Unix socket) behind one
  header line: `{"sni":…,"alpn":…,"tls":…}`.
- TLS 1.2 minimum, `http/1.1` only, `acme-tls/1` is not negotiated, a handshake deadline, and a
  connection cap. It fails closed when keyd cannot sign.
- Standard library only; built statically (`make build`) as part of the release artifact.
