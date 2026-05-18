# Flagship maintainers

Flagship dogfoods the maintainers protocol it ships in `maintainers/`.
This folder holds the project's **real, YubiKey-signed maintainer
mandates** — declaring who is currently authorized to sign Flagship
release endorsements, certificate-authority leases, and operational
advisories, plus the exact commits the current authority has endorsed
for production deployment.

Three tracks:

| Track     | Purpose                                                      |
|-----------|--------------------------------------------------------------|
| `release` | Signs `ReleaseEndorsement` envelopes for production commits.  |
| `ca`      | Signs `CaEndorsement` leases for the user-pubkey directory.   |
| `ops`     | Signs operational advisories (e.g. security disclosures).     |

Each track is a single self-signed **from-scratch ORIGIN** `Mandate`
whose succession policy is folded INLINE (there is no `policy.json`).
Trust is anchored by the ORIGIN mandate's canonical hash
(`mandatePinHash`), baked per consumer surface as
`MAINTAINER_PINNED_MANDATE_HASH`; consumers verify the chain forward
from that pinned hash.

## Pre-genesis state

Until the genesis ceremony runs (Operation 0 in
`docs/ca-operations.md` — CLI + the maintainer's YubiKey, exactly as a
fresh external adopter would do it), this directory is intentionally
empty of mandates and keys, `MAINTAINER_PINNED_MANDATE_HASH` is `""`,
and the entire maintainer→CA chain is fail-closed (`pin-unconfigured`)
in every consumer. Nothing is released and demo flows use mock
recovery, so an empty authority is the correct, honest pre-release
posture — not a gap.

## Contact

All maintainer correspondence: `harry@flagship.services`.

## Spec

See [`maintainers/docs/spec/v1.md`](../maintainers/docs/spec/v1.md)
for the protocol definition. The reference verifier is
[`@ibisllc/maintainers`](../maintainers/packages/protocol/).
