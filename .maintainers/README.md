# Flagship maintainers

Flagship dogfoods the maintainers protocol it ships in `maintainers/`.
This folder declares **who is currently authorized to sign Flagship
release endorsements, certificate-authority operations, and
operational advisories** — and which exact commits the current
authority has endorsed for production deployment.

Three tracks:

| Track     | Cadence | Purpose                                                       |
|-----------|---------|---------------------------------------------------------------|
| `release` | 60 d    | Signs `ReleaseEndorsement` envelopes for production commits.  |
| `ca`      | 180 d   | Signs CA-style envelopes for the user-pubkey directory.       |
| `ops`     | 60 d    | Signs operational advisories (e.g. security disclosures).     |

## Current authority

- `harry@flagship.services` — primary holder on every track.
- `harrybackup@flagship.services` — a named successor on every
  track; under each track's inline `approvalRule` (1-of-N) it can
  sign the next mandate unilaterally if the primary's mandate lapses.

Each track is a single self-signed **root (from-scratch)**
`Mandate` whose succession policy is folded INLINE (no
`policy.json` — the LOCKED v2 model dissolved the unsigned-policy
hole). The pubkeys checked in here are **placeholders derived from
fixed seeds** so anyone can re-derive them locally with
`scripts/bootstrap-flagship-maintainers.mjs` and verify the chain
offline. Before the public alpha, the root mandates will be
rotated to Yubikey-held pubkeys via a normal succession flow
(the placeholder is a named successor of itself).

## Contact

All maintainer correspondence: `harry@flagship.services`.

## Spec

See [`maintainers/docs/spec/v1.md`](../maintainers/docs/spec/v1.md)
for the protocol definition. The reference verifier is
[`@ibisllc/maintainers`](../maintainers/packages/protocol/).
