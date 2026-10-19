# DEPLOYED-FINAL 2026-10-19

This is the real deployed state the Windows test should run against. Nothing below is a caveat: if a line is not true when you test, stop and report it.

- main (release pin): `59dbc8cacb74589f58b35f6a9c307320e401b1bc`
- endorsed release commit (what new boxes install): `072ee32deba005e805d682f1ec0edd0b5a996f63`
- .com deployed from: `59dbc8cacb74589f58b35f6a9c307320e401b1bc`, webapp shell version live: `v153`
- .services (Fly relay): deployed from this release
- DNS design: the flagship.services zone holds a root wildcard (`*` A and AAAA, DNS only, grey cloud, pointing at the relay) and an apex CAA pair (issue and issuewild: letsencrypt.org). Accounts and boxes hold no address or CAA records; only short-lived `_acme-challenge` TXT records exist during issuance. Rollout order: the relay (.services) was deployed first, then the wildcard and CAA were added (2026-10-19T02:24:39Z), then the new .com; existing accounts kept their own records until the phase B reap.
- Workers plan: free
- Published VM appliances (Studio "Host on this PC" downloads these):
- amd64: sha256 `69366977a515fa8af3fac14f8f9b6f4ce7e640cbc668baadd27904f9ed8a41df` (run 39186204739, bakes `072ee32deba005e805d682f1ec0edd0b5a996f63`)
- arm64: sha256 `f40405d6c20a329116435fcd98def89d0bbba8e3a5fa4a53f9683a7a0da68b84` (run 39186207272, bakes `072ee32deba005e805d682f1ec0edd0b5a996f63`)
- Not live yet (phase B, after the Windows results): the public Windows and Linux Studio release, the pre-GA scrub and reap, the store builds.
- Windows Studio under test is still the previous build; the download links on the site are unchanged.
