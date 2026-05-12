# @maintainers/cli

Headless / CI-friendly CLI for the maintainers protocol. Produces the exact
same envelopes (byte-identical canonical bytes) as the web UI; intended for
unattended signing flows.

## Install

This package is part of the maintainers monorepo; the workspace install
brings it in automatically. Build the workspace once with `npx tsc -b`,
then invoke the shim:

```sh
node packages/cli/bin/maintainers help
```

> **Note (transient).** Today the `@maintainers/protocol` package exports
> its `.ts` source as `main`, which means running the compiled CLI under
> plain Node still hits a TypeScript import. Either invoke via a TS
> loader (`npx tsx packages/cli/src/index.ts …`) or wait for the
> protocol package to publish its `dist/index.js` as `main` — at which
> point the bin shim runs under plain Node. The CLI test suite covers
> the full command surface today via vitest's built-in TS transform.

## Commands

```
maintainers genesis     --track release --duration 60d \
                        --holder-key file:./harry.pub \
                        --signing-key file:./harry.priv \
                        --output ./.maintainers/

maintainers mandate     --track release --duration 60d \
                        --signing-key file:./harry.priv \
                        [--successors file:./alice.pub,file:./bob.pub] \
                        [--path ./.maintainers]

maintainers endorsement --commit <40-hex> --tag v0.2.0 \
                        --previous-id <uuid> --previous-commit <40-hex> \
                        --signing-key file:./harry.priv \
                        --intermediates auto

maintainers takeover    --track release \
                        --successor-key file:./bob.priv \
                        --new-holder    file:./bob.pub

maintainers verify      --path ./.maintainers/
maintainers status      --path ./.maintainers/ --as-of now
```

## Key sources

Two forms are recognized:

* **`file:<path>`** — local 32-byte hex Ed25519 key. Whitespace and a
  leading `0x` are tolerated. When the file contains a private key, the
  corresponding public key is derived; when it contains only a public key,
  it is consumed verbatim. (The CLI cannot tell which is which from the
  hex alone, so each command says explicitly which form it expects.)

* **`yubikey:slot=<piv-slot>`** — recognized but **not yet implemented**.
  The protocol library currently signs Ed25519 only; production PIV slots
  yield ES256 (P-256) signatures, which need a coordinated update on the
  protocol side before the CLI can produce them. Calling `yubikey:` today
  raises a clear staging error and points you at `file:` keys.

  The web UI uses WebAuthn (which also produces ES256 by default); the
  same protocol-side update will let the web UI and the CLI converge on a
  single ES256 acceptance path. Until then the CLI's role is the Ed25519
  side of the world — server-side / CI signing where a hex key on disk is
  the normal carrier.

## Verify vs status

* `verify` exits non-zero if any envelope fails to verify, any track is
  missing its `policy.json`, or any endorsement is rejected. This is the
  exit code CI flows pin on.

* `status` reports the same data without ever exiting non-zero — useful
  for human-driven inspections where you want a summary of "what's the
  current authority, when does it expire, who are the named successors,
  any rejections to know about."

Both accept `--as-of <RFC3339|now>` so you can ask "what was the state
on this date?". This is how a consumer would render the bar in a browser
extension at a fixed point in time.
