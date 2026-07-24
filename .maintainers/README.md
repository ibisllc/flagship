# Flagship maintainers

Flagship dogfoods the maintainers protocol it ships in `maintainers/`.
This folder holds the project's **real, YubiKey-signed maintainer
mandates** — declaring who is currently authorized to sign Flagship
release endorsements, certificate-authority leases, and operational
advisories, plus the exact commits the current authority has endorsed
for production deployment.

Three tracks are DEFINED by the protocol, but only `ca` is signed today
(see "Track status" below):

| Track     | Purpose                                                      |
|-----------|--------------------------------------------------------------|
| `release` | Signs `ReleaseEndorsement` envelopes for production commits.  |
| `ca`      | Signs `CaEndorsement` leases for the user-pubkey directory.   |
| `ops`     | Signs operational advisories (e.g. security disclosures).     |

### Track status (pre-release)

Genesis signed the **`ca` track ONLY** (`docs/ca-operations.md` §
"LOCKED SCOPE", 2026-05-19). `ops` is dropped; `release` was deferred to
its own later isolated genesis if a release role ever exists.

**Pre-release collapse (2026-07-24, `docs/update-server-rollout-plan.md`
§2):** the "Update this server" feature needs a release endorsement
authority, and exactly one holder key exists. Rather than mint a
separate release key that would point at the SAME YubiKey, the `ca`-track
holder now endorses releases too. Flagship's daemon release gate
(`packages/server-daemon/src/releaseVerifier.ts`, `resolveReleaseChain`)
prefers a real `release` track when one exists and falls back to the `ca`
chain otherwise. `ReleaseEndorsement` carries no `track` field, so a
ca-holder-signed endorsement verifies against the ca chain unchanged. A
future dedicated `release` track wins automatically with no code change.

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
