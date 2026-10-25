# Threat model

Sources: `IMPLEMENTATION-PLAN.md` §6.6 (full trust-chain threat model), §14 (the mandatory
adversarial matrix), `SECURITY-HARDENING-PLAN.md`, `docs/metadata-threat-model.md`.

## 1. Assets

1. **Owner data**: app data at rest (LUKS), in transit (box-terminated TLS), in backups.
2. **Authority**: who can install code, change access, add servers or devices, recover an account,
   unlock a disk, update a box, or widen a rollout.
3. **Keys**: the account root (UMK), admin root, IRK, the PQ halves, the STK, SWK, CGK, the disk
   key, the release, catalog and CA keys.
4. **Privacy**: who owns which server and app; who visits which app (a visitor's identity is per
   app); what an AI model learns about the owner (nothing); what telemetry names (no owner).
5. **Availability of control**: lock, revoke and recover must work while apps misbehave.

## 2. Attackers

| Attacker | Capabilities assumed |
|---|---|
| Network attacker | reads, drops, delays and injects anywhere between the parties; can obtain WebPKI certificates by fraud; controls DNS answers |
| Hostile or compromised `.com` | full control of the Worker, D1 and R2: serves any directory, deposit, catalog file or time; can log anything it sees; holds the CA lease key and demo-account derivation |
| Hostile relay | sees every TLS stream to and from boxes and its metadata; can misroute or drop |
| Malicious visitor / app user | any request to any public app or box route, with or without an invite |
| Malicious app (tenant) | arbitrary code inside its container under gVisor, its own database role and files volume |
| Compromised daemon | full control of the box's Node process and its user (`flagship`, or root on boxes that never got keyd); talks to keyd and privd/broker over their sockets |
| AI model / prompt injection | controls what the model writes, including tool calls, within the build harness |
| Co-manager or invitee turned hostile | holds a valid share or member grant; tries to escalate or link identities |
| Lost or stolen device | a device of the account, possibly with its keys extractable if the platform keystore is broken |
| Future quantum attacker | breaks every classical public-key primitive (Ed25519, X25519, P-256, RSA) in recorded traffic and stored ciphertext ("harvest now, decrypt later"), and forges classical signatures |
| Release-pipeline attacker | compromises CI, a mirror or the artifact bucket, or steals one online key (the catalog timestamp key, the CA lease key) |
| Physical attacker on a powered-off box | reads and writes the disk and `/boot`; on boxes claiming the TPM profile, also tries to replay or roll back |

## 3. Security goals (what a finding breaks)

1. `.com` and the relay never see plaintext owner data or disk keys, and cannot cause a client to
   release them to an impostor (in strict mode, even after every classical primitive is broken).
2. Every effect on a box is authorized by a signature the box verifies against keys it pinned
   itself. A compromised `.com` cannot authorize anything.
3. A compromised daemon cannot get raw keys (B6) or host root (B7). It cannot cross apps or leave
   the app sandbox.
4. A malicious app cannot reach the host, the box's services, metadata, the LAN or another app,
   unless the owner granted it.
5. Visitor identity cannot be linked across apps or servers; anonymous visitors get no rank.
6. Strict mode cannot be downgraded by anyone but an active admin device's explicit, signed opt-out,
   and an opt-out never spills to other scopes or peers.
7. Only endorsed releases install; versions, floors and revocations never go backwards; a stopped
   rollout stays stopped.
8. Telemetry (update receipts) names no owner, server or account and cannot be linked across
   releases.
9. Recovery keeps its wait and veto; possession of an old credential is not a bypass.

## 4. Assumptions and exclusions

- **Excluded** (as in plan §6.6): a malicious running kernel on the box, invasive hardware
  extraction, loss of every recovery secret, malicious phone OS vendors, malicious hardware.
- **Assumed honest for availability only:** `.com`, the relay, Let's Encrypt and DNS may deny
  service. Denial of service against the control plane is in scope only where it leads to a
  security effect, such as a stale catalog that keeps a stopped release open (AT-CAT-07).
- **Declared exceptions:**
  - The webapp holds the account key in browser JavaScript (owner decision N06, 2026-10-24; users
    are told it is less secure).
  - Demo accounts are derived by `.com` (compatibility profile, excluded from strict).
  - The VM appliance shares a volume key per published image until the per-box reencrypt runs
    (`evidence-map.md` §3.1 step 7; M0 added a reencrypt on appliances).
- **Classical-only today** (see `known-gaps.md` §1): passkeys/WebAuthn, WebPKI, APNs/FCM, the
  TPM's own algorithms, Secure Boot roots, external AI providers.
