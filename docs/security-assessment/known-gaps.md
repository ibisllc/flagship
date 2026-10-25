# Known gaps and open items

What the team already knows is open, so the assessment can spend its time elsewhere or confirm
these. Each item names where it is tracked. Reports that turn one of these into a concrete
exploit are welcome.

## 1. Classical-only bypasses (the crypto dependency graph)

`node scripts/crypto-graph-check.mjs` breaks every classical public-key primitive in
`docs/architecture-v2/crypto-graph.json` and asks which strict targets are still reachable. At the
base commit it reports **16 of 16 strict targets reachable** and exits 1. This is the honest
result: the PQ code exists but nothing is enforced until the key ceremony fills the pins, and
several roots have no PQ replacement at all. The shortest path per target:

| Target | Shortest bypass | Work package |
|---|---|---|
| `data.box-session` | `chan.box-tls` (P-256 / X25519 TLS to the box) | Q07 (the PQ session is an inner channel, not yet required) |
| `data.com-db` | `env.d1-backup` (age/X25519 backups of the directory) | Q08 |
| `data.disk-key` | `env.auto-unlock-lease` (v2 lease, X25519 to the STK; v3 hybrid exists, not enforced) | Q03 |
| `eff.app-access`, `eff.device-enroll`, `eff.recovery`, `eff.debug-root` | `key.admin-root` (Ed25519) | Q05 |
| `eff.app-install` | `key.adapter-pipeline`, `key.publisher` (Ed25519) | Q08 |
| `eff.lock-clear` | `key.irk` (Ed25519) | Q05 |
| `eff.routing` | `key.rck` (Ed25519), `chan.fly-tls` | N02 |
| `eff.dns` | `chan.com-webpki`, `key.irk`, `key.stk` | Q07 |

Grouped by work package:

- **Q05 (enrollment, recovery, passkeys).** WebAuthn negotiates classical algorithms only, and
  passkey PRF recovery rests on vendor sync fabrics. Device pairing carries the UMK under X25519 +
  SAS. Every enrollment, recovery and veto still accepts the Ed25519 admin root or IRK alone until
  strict is enforced. No PQ pairing exists.
- **Q08 (release and data at rest).**
  - The release endorsement v2, box artifact PQ and CA lease PQ companions exist, but their pins
    are empty (`releasePqPin.ts`, `release/box-artifact-trust.json` `pq`, `CA_LEASE_PQ_PIN`). The
    ceremony has not run with real YubiKeys.
  - The age file around the PQ release seed is classical.
  - Retained data is not re-encrypted: disk-key deposits sealed with classical X25519 since install
    can be harvested now. Backups are not converted, and the D1 backups use age/X25519.
- **Q09 (assurance).** The graph closes only when every reachable bypass is replaced or protected
  independently. External review and hardware evidence are also required. Neither exists.

## 2. Unverified hardware and platforms (no receipt)

No architecture-v2 code has run on:

- a real phone (iOS 26 Secure Enclave ML-DSA, Android StrongBox, watches);
- a real box, as opposed to an UpCloud VM;
- a physical TPM (only swtpm; UpCloud has no vTPM);
- UKI or Secure Boot (no code exists);
- any GPU (NVIDIA, AMD, Intel, MIG, multi-GPU);
- arm64 Rust binaries;
- a Windows or Linux Studio on real hardware.

TPM keys are classical, and no TPM with PQ algorithms is qualified (REGISTER blockers 1–5, 8).
Labels such as "hardware PQ" are therefore claims about code paths, not measurements.

## 3. Unbuilt or switched-off parts (by our own account)

- **Relay trust enforcement** is off (`FLAGSHIP_RELAY_TRUST_ENFORCE`). The relay blessing is
  observe-only.
- **The Rust core** runs in shadow mode only. The broker owns host power; the engine and other host
  ops still go through the TS privd's v1 `docker` op.
- **The daemon** runs as root on boxes where keyd never took the keys (existing boxes that have not
  updated), and stays root until privd answers.
- **The app browser** ships on only if the release gym proves it: `APP_BROWSER.enabled` reads the
  release setting `appBrowser` (`release/box-release.json`), and the release script offers to turn it
  off when the `browser-grants` gym group fails. Its protected-host wiring (AT-EGR-09) and the other
  browser findings (AT-EGR-08, 11) are fixed in `a44fc2208`. By owner decision (2026-10-24) it may
  open other people's public Flagship apps like any public site (AT-EGR-14). The owner's standing
  grants are kept across restarts (`browser/grantStore.ts`). The data-services stack starts the
  Chromium container exactly when the release turns the browser on (`init.sh`). Not yet proved on a
  box: the live `browser-grants` group decides it in the release gym.
- **The A01 synthetic traffic trace** (no cloud plaintext, recorded) is not done.
- **Clients:** the chat approval, browser grant and AI consent screens are built on all three clients
  and covered by the mock gyms; none has run on a physical device.
  (The "Share update results" switch and the refused-rollback sentence shipped 2026-10-24 on all three
  clients, and the box's own Activity line for a rollback kept in recovery has its own sentence.)
- **Keyd** still has a generic `unseal` for the pairing order, `swk.open`/`cgk.open`, and an
  unscoped `swk.deriveTlsKey` (REGISTER K01; AT-KEY-12). Root can read the boot-ceremony token.
- **Signed time** is classical (CA Ed25519).
- **Demo accounts** are derivable by `.com` (compatibility profile).
- **Update receipts** are anonymous and therefore forgeable. A dishonest `.com` could match one
  to a box by source address (`docs/runbooks/canary.md` §6).

## 4. Findings of the adversarial suite

None open. Every finding the V01 suite opened (AT-PRV-03..07, AT-CAT-07/09/12/17/20,
AT-DWN-14/15/16, AT-CRT-06, AT-EGR-08/09/11) is fixed in `a44fc2208`; the suite has 0 `it.fails`
(`adversarial-tests.md`).

## 5. Known residual risks documented elsewhere

- Copied lease plus `/boot` STK unlocks the disk (N10; software profile).
- VM appliances shared one volume key per image before the per-box reencrypt (evidence map §3.1).
- Provider fetch DNS-rebinding window (`packages/llm-providers/src/baseUrlGuard.ts`).
- Webapp holds the account key in browser JavaScript (owner decision N06).
- The six-digit server code is 20 bits. Only the enrollment proof binds the key (AT-FC-04).
