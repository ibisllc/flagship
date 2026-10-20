# DEPLOYED-FINAL 2026-10-20

This is the real deployed state the Windows test should run against. Nothing below is a caveat: if a line is not true when you test, stop and report it.

- main (release pin): `1b5504f4f689c5039fa44a61496e6092c1e9c7c9`
- endorsed release commit (what new boxes install): `dbdf2e08875ae55d9b575f390a29810670f9a54d`
- .com deployed from: `1b5504f4f689c5039fa44a61496e6092c1e9c7c9`, webapp shell version live: `v156`
- .services (Fly relay): deployed from this release
- DNS design: the flagship.services zone holds a root wildcard (`*` A and AAAA, DNS only, grey cloud, pointing at the relay) and an apex CAA pair (issue and issuewild: letsencrypt.org). Accounts and boxes hold no address or CAA records; only short-lived `_acme-challenge` TXT records exist during issuance. Rollout order: the relay (.services) was deployed first, then the wildcard and CAA were added (2026-10-20T16:44:41Z), then the new .com; existing accounts kept their own records until the phase B reap.
- Workers plan: free
- Published VM appliances (Studio "Host on this PC" downloads these):
- amd64: sha256 `67e45517cb57b616324b7d28c441aa8957b727ab8e0fe46b42f6d32bdf89cf5b` (run 39440267951, bakes `dbdf2e08875ae55d9b575f390a29810670f9a54d`)
- arm64: NOT published yet (the older image is still what Studio downloads for arm64)
- Not live yet (phase B, after the Windows results): the public Windows and Linux Studio release, the pre-GA scrub and reap, the store builds.
- Windows Studio under test is still the previous build; the download links on the site are unchanged.
