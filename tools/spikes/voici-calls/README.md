# voi.ci calls spike (2026-11-08)

Throwaway measurement harness behind `docs/voici-calls-spike.md`. Not product code; nothing imports it.

It compares two ways for a browser on voi.ci to call the owner's phone over the phone's bare name
(`<user>.flagship.services`, SNI passthrough on the relay, TLS ending on the phone):

- **A**: WebRTC. The browser's only ICE server is `turns:<user>.<apex>:443?transport=tcp`; the phone answers it
  with its own TURN server (coturn stands in) and its own WebRTC stack. Opus `cbr=1;usedtx=0`, the audio-level
  header extension stripped, every encoded frame sealed again with AES-256-GCM in an encoded transform.
- **B**: our own frames. WebCodecs Opus at a constant 24 kbps, 20 ms frames padded to 64 bytes, AES-256-GCM, one
  frame per WebSocket message to `wss://<user>.<apex>/api/phone/call`.

The spike's AES key is a fixed test key: the real one comes from an X-Wing exchange in the signed call setup.

## Topology

```text
root netns:   caller Chromium
              ── lib/linkem.py: TUN link with one-way delay, jitter (FIFO), random loss, periodic outages ──
netns phone:  lib/relay.mjs (SNI passthrough :443) → lib/phone-b.mjs (B, TLS ends here) | coturn TLS :5349 (A)
              option-A "phone" Chromium (reaches coturn on loopback, no loss)
```

The kernel here has no netem, so the link is emulated in userspace between two TUN devices; TCP on it sees a
real RTT and real retransmissions. Addresses are 203.0.113.0/30 (a public documentation range) because Chrome's
Local Network Access check blocks a page from reaching private addresses (the real relay is public).

## Run (Linux, root, Chromium from Playwright)

```sh
apt-get install -y coturn iproute2 libnss3-tools tcpdump tshark
# certs: see results/certs (untrusted CA + leaf for alice.calls.test, wrong-name cert); trust the CA for A:
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n spike-ca -i results/certs/ca.pem
echo "203.0.113.2 alice.calls.test" >> /etc/hosts
env -u HTTPS_PROXY -u https_proxy node local-checks.mjs      # T0/T1 capabilities, frame sizes
env -u HTTPS_PROXY -u https_proxy node turns-check.mjs       # T2 SNI/ALPN/groups and certificate checks
env -u HTTPS_PROXY -u https_proxy node call-quality.mjs 45   # T3 the scenario matrix
```

The DTLS key-exchange check (T4) captured the handshake with `tcpdump -i lo udp` inside netns `phone` during an A
call and decoded it with `tshark --enable-heuristic dtls_udp`; its output is `results/dtls-groups.json`.
