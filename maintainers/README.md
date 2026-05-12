# maintainers

A signature-based authority-management protocol you can drop into any
git-versioned project. Mandate-and-renew model: each authoritative key
holds a time-bounded mandate, renews it before expiry, and names
designated successors who can take over after expiry. Yubikey-friendly
on-ramp; visual UI; browser-extension overlay on repo pages; CLI for
headless flows.

Built for the world where GitHub's web access controls are necessary
but not sufficient: a repo can be cloned, mirrored, forked, or moved,
and you want authority to remain cryptographically verifiable across
every copy.

## Status

This subtree is being developed inside the Flagship monorepo for
convenience. It will be extracted to its own repository at
`github.com/<TBD>/maintainers` before any external announcement.
All code, specs, and packages here are designed for standalone use;
none of them depend on Flagship internals.

## Structure

```
maintainers/
├── docs/
│   ├── spec/
│   │   └── v1.md                  Protocol specification (canonical)
│   └── guides/                    Adopter how-tos
├── packages/
│   ├── protocol/                  Envelopes + verifier (pure TS, zero deps)
│   ├── web-ui/                    WebAuthn-driven page; both deployment models
│   ├── server-adapters/           Model A reference implementations
│   ├── extension/                 Browser extension for repo pages
│   └── cli/                       Yubikey-via-PIV CLI for headless signing
└── .maintainers/                  Dogfooded on itself
```

## License

BUSL-1.1, Change Date 2030-05-03 → Apache 2.0. Same terms as Flagship.
