# Marketplace security-scan grade policy (public)

This is the **public, deterministic** policy that turns a scan into an
A–F letter grade on a marketplace listing. The thresholds below are
encoded verbatim as constants in `src/grade.ts` — that file is the
single source of truth; this document mirrors it. Same inputs always
produce the same grade.

A listing ships `scan_grade = NULL` (unscanned, hidden from the
"verified only" search filter) until a scanner-signed result lands on
`flagshipserver.com`. The scanner is Flagship-operated; `.com` accepts
a result **only** if its Ed25519 signature verifies against the
configured scanner pubkey (`verifyMarketplaceScanResult`). There is no
unsigned or bypass path.

## What is scanned

The scanner clones the listing's canonical repo at the **pinned
`manifest_hash`**, verifies the checked-out tree hash matches that
pin, then runs three tools inside a sandbox against the source tree:

| Tool | Command | Looks for |
|---|---|---|
| Trivy (fs) | `trivy fs --format json …` | known CVEs in deps + OS packages |
| npm audit | `npm audit --json` | advisories in the dependency tree |
| semgrep | `semgrep --config=p/owasp-top-ten --json` | OWASP-Top-Ten code patterns |

plus custom manifest checks against `flagship.app.json` (wildcard
network allowlist, privileged-container request, suspicious
`envInject` keys, missing canonical identity).

## Severity folding (worst-finding-dominates)

All three tools roll up into one set of severity tallies + a custom-check
list, then a single policy is applied. The grade is the **floor** across
every dimension — nothing can lift it back up:

- npm audit `critical/high` → counted as Trivy `CRITICAL/HIGH`;
  `moderate` → `MEDIUM`; `low` → `LOW`.
- semgrep `ERROR` → a **no-ship** custom check (caps at F).
- semgrep `WARNING` → a **warn** custom check (one-notch degrade).

## Grade rubric

Evaluated top-to-bottom; the first matching rule wins.

| Grade | Condition |
|---|---|
| **F** | ANY `CRITICAL` finding (Trivy or npm), OR ANY no-ship custom check (wildcard host, privileged, semgrep ERROR, missing/invalid manifest, **or a scan that did not complete** — see fail-closed). |
| **A** | 0 CRITICAL, 0 HIGH, 0 warnings, all custom checks pass. |
| **B** | 0 CRITICAL, 1–2 HIGH, 0 warnings. |
| **C** | 0 CRITICAL and (3–5 HIGH **OR** ≤1 warning) — i.e. `HIGH ≤ 5 OR warnings ≤ 1`. |
| **D** | 0 CRITICAL, **>5 HIGH AND >1 warning** (both C arms fail but no hard stop). |

`MEDIUM`/`LOW` findings are reported but do not by themselves change
the letter grade. The rubric is intentionally cautious: a listing that
ships **A** means "this maintainer keeps CVEs at zero." **F** listings
are hidden from the default search.

The passing-grade floor is **C** (`isPassingGrade`): A, B, C pass; D
and F do not.

## FAIL-CLOSED (non-negotiable)

A scan that did **not** actually complete — clone failure, a tool
error or timeout, the cloned tree's hash not matching the pinned
`manifest_hash`, a sandbox failure — yields the explicit failure grade
**F** (`SCAN_ERROR_GRADE`), never a passing grade and never a silent
skip. The scanner still uploads an error report and still posts a
**signed** F result so `.com` records the outcome. There is no input
to `gradeScanError()` that can return better than F.

## Envelope (wire contract — do not fork)

The signed result is the protocol package's `MarketplaceScanResult`,
canonical-tagged `flagship/marketplace-scan-result/v1`:

```
{ creator, slug, grade, reportKey, imageDigestHex, scannedAt }
```

`imageDigestHex` is the sha256 (hex) of the **scanned source tree at
the pinned manifest hash** — it pins exactly which artifact got the
grade. The scanner signs with `@flagship/protocol`'s
`signMarketplaceScanResult`; `.com` verifies with the matching
`verifyMarketplaceScanResult`. The bytes are produced by the protocol
package on both sides — the scanner never hand-rolls canonical bytes.

## Report URL

The full JSON report is uploaded to R2 at
`<creator>/<slug>/<treeDigestHex>.json` and surfaced publicly at
`flagshipserver.com/marketplace/<creator>/<slug>/scan/<hash>.pdf`
(§L.7).

---

BUSL-1.1 → Apache 2.0 in 2030, same as the rest of the project.
