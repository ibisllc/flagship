# No KYC — project tenet

Flagship does not collect, store, infer, or expose any real-world identity
attribute about any user. This is a load-bearing architectural constraint,
not a marketing posture. It shapes what `flagshipserver.com` is allowed to
know, how envelopes are structured, where human-readable labels live, and
what surfaces we will never build.

## What `flagshipserver.com` knows

The control plane (`flagshipserver.com` — Cloudflare Worker + D1 + R2)
stores only:

- A **username** of the user's choice. Users pick handles, pseudonyms, or
  one-time burner names. The username is a routing label, not an identity.
- An **IRK public key** — cryptographic identity. The pubkey is a 32-byte
  Ed25519 point; it does not derive from anything humans recognize.
- **Opaque encrypted recovery data** (the wrapped UMK under WebAuthn-PRF
  recovery). Encrypted client-side; `.com` sees ciphertext only.
- **Routing and registration records** keyed by pubkey hashes and
  subdomain labels. No emails, no names, no contact information.
- **ServiceGrants and revocations**, signed by the user's IRK. These name
  service canonical IDs (themselves derived from author pubkeys, not
  usernames) and server identity pubkeys.

That's the complete list. Everything else lives on the user's own devices.

## What `flagshipserver.com` does NOT know

- Legal name, real name, display name beyond the chosen username.
- Government identification of any kind.
- Contactable email address.
- Phone number.
- Photograph or biometric.
- Physical address.
- Date of birth or age verification.
- Payment methods directly (paid surfaces use one-shot tokenized flows; we
  do not retain payment correlations to identity).
- Device IP addresses past the request that hit Cloudflare's edge (we do
  not log, we do not analytics, we do not third-party tag).

We will not build APIs to collect any of the above. We will not accept
"optional" fields for any of the above. We will not ship feature requests
that require collecting any of the above as a precondition.

## Symmetry breaks where they should

There are two places where the system uses human-readable names:

**1. Project maintainers** (the `maintainers` open-source primitive used
by Flagship and any other project that adopts it). Mandate authority is
named by **email** — because maintainers are public roles in public
projects, and the community needs an out-of-band contact channel to
sanity-check "is this really the new maintainer." Project mandates live
in a project's public `.maintainers/` folder in its git repo.

**2. User-side device labels and friend labels** (collaborator names,
device names, etc.). These live in the user's **encrypted blob on .com**,
decrypted only by the user's UMK-derived key. `.com` sees opaque
ciphertext. Labels never leave the user's devices in plaintext.

The asymmetry is intentional. Projects are public; users are not.

## What this rules out by construction

- "Find friends on Flagship" — would require `.com` to answer "does user
  X exist," enabling enumeration. Friend-finding is not a feature; users
  exchange identifiers out-of-band (the invite-link primitive).
- Email magic links — would require `.com` to hold an email address. We
  don't.
- SMS-based 2FA — would require `.com` to hold a phone number. We don't.
- Account recovery via "what was your first pet's name" — would require
  `.com` to hold a profile. We don't. Recovery uses WebAuthn-PRF +
  passphrase, both held client-side.
- Marketplace listings that auto-display the publisher's "real" name —
  publishers display only their chosen username; the author canonical
  identity is a pubkey hash, stable across renames.
- Compliance with regulations that require KYC on the user-to-platform
  relationship — there is no such relationship. The user runs their own
  hardware. We provide control-plane routing only. Anything that imposes
  KYC on the user is incompatible with the product and we will not ship
  it.

## What this rules in

- **Pseudonymous use is first-class.** Users can pick `harry` or
  `not-my-real-name` or `7b3a` — all equally supported.
- **The same key can hold many usernames over time.** Renames produce a
  permanent alias map (see `username-handover`); old usernames are
  consumed forever, never reissued, so old invites resolve correctly.
- **Public-facing names exist only where users choose them.** Marketplace
  listings, blog posts, comments — any user-published content carries
  whatever name the user attaches to it, and the underlying identity is
  a pubkey.
- **Compromise of `.com` reveals routing graph but no identities.** An
  attacker who fully owns Cloudflare's D1 cannot reconstruct who runs
  what. They see opaque pubkeys, opaque usernames, encrypted blobs.

## How to apply this when adding a feature

If you propose a feature and ask "do we need to collect X from the
user?", and X is on the do-NOT-know list above, the answer is no. Find
another design. Almost every feature that seems to require identity data
can be re-expressed with a signed pubkey, a client-side label, or an
out-of-band channel the user chooses.

If you propose a feature and the easy implementation route routes data
through `.com`'s plaintext storage that doesn't have to, the feature is
wrong and should be redesigned to route through the user's own devices
or through encrypted client-side state.

This tenet survives the Change Date. If Flagship transitions to Apache
2.0 in 2030 and a future maintainer takes over via the dead-man's switch
in the `maintainers` protocol, this policy remains in effect. Removing
or weakening it requires a release manifest signed by the current
authority, alongside the deprecation visible in the public git history.

We picked this principle because it is the difference between "Flagship
is a tool for sovereignty" and "Flagship is a service that holds data
about you." Both can be products; only the first is the product we are
building.
