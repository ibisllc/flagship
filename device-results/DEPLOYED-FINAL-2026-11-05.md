# DEPLOYED-FINAL 2026-11-05

This is the real deployed state the Windows test should run against. Nothing below is a caveat: if a line is not true when you test, stop and report it.

- main (release pin): `1e1840f2c2586dee0c2b99b3c8f8064ec309b7fe`
- endorsed release commit (what new boxes install): `3080e517fe84c5972338b4c737be9ef3f3e87988`
- .com deployed from: `1e1840f2c2586dee0c2b99b3c8f8064ec309b7fe`, webapp shell version live: `v200`
- .services (Fly relay): deployed from this release
- DNS design: the flagship.services zone holds a root wildcard (`*` A and AAAA, DNS only, grey cloud, pointing at the relay) and an apex CAA pair (issue and issuewild: letsencrypt.org). Accounts and boxes hold no address or CAA records; only short-lived `_acme-challenge` TXT records exist during issuance. Rollout order: the relay (.services) was deployed first, then the wildcard and CAA were added (2026-11-05T15:30:54Z), then the new .com; existing accounts kept their own records until the phase B reap.
- Workers plan: paid
- Published VM appliances (Studio "Host on this PC" downloads these):
- amd64: sha256 `ecd620cbd4f31b0e61352291749cce984c7661e490f4cfca76a6a193bce9813b` (run 42020393647, bakes `52c67f8848eeb878cc9f63e84786b81f6933d19c`)
- arm64: sha256 `08514894dc13e71c1ddfb1c836ed3e9046dfc3e02c7cde07ba02b54680ac8c50` (run 42020397468, bakes `52c67f8848eeb878cc9f63e84786b81f6933d19c`)
- Not live yet (phase B, after the Windows results): the public Windows and Linux Studio release, the pre-GA scrub and reap, the store builds.
- Windows Studio under test is still the previous build; the download links on the site are unchanged.
