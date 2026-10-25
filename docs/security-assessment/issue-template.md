# How to report an issue (template)

Report one issue per entry. An issue is accepted only when it is tied to a **tested artifact**: the
commit it was observed on (and, for box code, the artifact digest), and a test that fails because of
it. Every entry must name both. The fix lands with the same test turned green.

```markdown
### <ID>: <one-line title>

- **Severity:** critical | high | medium | low | info. Judge it by the impact on the goals in
  threat-model.md §3, and say which goal it breaks.
- **Boundary:** B<n> from architecture.md §2, and the work package (e.g. B01, Q07).
- **Artifact:** commit `<40-hex>`; box artifact `<sha256>` (amd64|arm64) if box code; client build
  (iOS x.y (n) / Android code n / webapp shell vN / Studio x.y.z) if client code.
- **Profile:** strict | compatibility | both; stack classic | arch-v2; hardware or VM.
- **Test:** `<path>` › `<test title starting with its id>`. The test fails because of this issue (an
  `it.fails` while open), or it is a gym check `AT-LIVE-nn`.
- **Where:** `path:line` of the faulty code, in every port (TS, Rust, Swift, Kotlin, Go, webapp).
- **What happens:** the precise behaviour, and the inputs that cause it.
- **Why it matters:** which attacker from threat-model.md §2 can do it, and what they gain.
- **Reproduce:** the exact command(s), e.g. `npx vitest run <file> -t "<id>"`.
- **Suggested fix:** optional.
- **Status:** open | fixed in `<commit>` (test now `it`) | accepted risk (owner decision, date).
```

## IDs

- `AT-<AREA>-<nn>`: from the team's adversarial suite (`adversarial-tests.md`). The areas are:
  - ENV: signed envelopes
  - DWN: downgrade
  - CAT: release catalog
  - LNK: identity linkage
  - EGR: egress and browser
  - FC: first contact
  - CRT: app-name certificates
  - PRV: broker argv
  - KEY: keyd purposes
  - LIVE: the gym group
- `EXT-<reviewer>-<nn>`: from an external assessor or reviewer.

## Severity guide

| Severity | Typical meaning here |
|---|---|
| critical | `.com`, the relay or an outsider gets owner plaintext, a disk key or box root; or a forged signature authorizes an effect |
| high | a compromised daemon or app gets host root, raw keys or another app's data; or someone other than an admin can downgrade strict mode; or a stopped release can be reopened |
| medium | a privacy goal breaks (identity linkage, telemetry that names an owner); or a defence-in-depth layer is missing where the next layer is weaker than claimed; or a control the owner relies on can be frozen |
| low | needs an unlikely precondition, or affects only the availability of a non-security feature |
| info | hardening, documentation, labels |
