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

This project is developed in the Flagship monorepo and mirrored to
its standalone home at `github.com/ibisllc/maintainers`. All code,
specs, and packages are designed for standalone use; none depend on
Flagship internals.

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

BUSL-1.1, Change Date 2030-05-03 → Apache 2.0. See [LICENSE](./LICENSE).
Copyright (c) 2026 Ibis LLC.
