# Architecture and trust boundaries

Sources: `docs/architecture-v2/evidence-map.md` (a source inventory at an earlier commit; §1–§3 hold
the file:line evidence), `IMPLEMENTATION-PLAN.md` §4, `HANDOVER.md` §2, `SECURITY-0.3-PROGRESS.md`.
Where the evidence map predates 0.3 work, the 0.3 state is given and the change is named.

## 1. Components

```text
 owner's phone / watch / browser ──signed orders, sealed replies──┐
   (trust root: account key UMK → IRK, admin root, per-app keys)   │
        │                                                          ▼
        │ TLS to the box (pinned key)            .com  (Cloudflare Worker + D1 + R2)
        │                                          identity, directory, deposits (ciphertext),
        ▼                                          boot mailbox, recovery records, shares,
 .services relay (Fly) ── SNI passthrough ──►     catalog + receipts, rate limits
        │  raw TCP, no TLS termination             apps/dns-broker (challenge records)
        ▼
 the box (owner's hardware or a Studio VM)
   initramfs: flagship-unseal / flagship-boot ── cryptsetup (LUKS) ── TPM (optional, PolicyPCR)
   flagship-keyd   (keys: STK, SWK, CGK, TLS leaf, ACME; TS or Rust; own user)
   flagship-tlsd / ingress (TLS terminates HERE)  →  daemon over a Unix socket
   flagship-daemon (TS; user `flagship` once keyd holds the keys, else root)
   flagship-privd / flagship-broker (root; closed typed op set)
   engine: Docker (existing boxes) or Podman (new boxes), every app under gVisor (runsc)
   flagship-core (Rust, shadow mode: compares, never writes)
```

## 2. Trust boundaries

Each boundary lists what must hold across it and the main code that enforces it. The adversarial
suite IDs in brackets test the boundary (`adversarial-tests.md`).

| # | Boundary | Must hold | Enforced in |
|---|---|---|---|
| B1 | Phone ↔ `.com` | `.com` sees only ciphertext of disk keys, recovery and deposits; its directory cannot make a phone seal to an impostor in strict mode | `packages/protocol` (envelopes, `pqTrust.ts`, `bootUnlockV2.ts`), first-contact pins (`enrollment.ts`, box key pin) [AT-ENV, AT-DWN, AT-FC] |
| B2 | Phone ↔ box | Every state change is an owner or admin signature the box verifies itself; strict boxes need the hybrid signature | daemon order consumers, `centralAuthorization.ts`, `pqChannel.ts` [AT-ENV, AT-DWN, AT-LIVE-01..08] |
| B3 | Relay ↔ box | The relay forwards bytes and cannot read or change TLS; it can drop or misroute | `tunnel-protocol`, SNI parser, box-terminated TLS [AT-LIVE-15/16] |
| B4 | Internet visitor ↔ app | Identity headers are only what the box signs; anonymous visitors get no rank; a visitor's id differs per app | app proxy, `serviceAccess*.ts`, keyd `identity-header/v1` [AT-LNK, AT-LIVE-12] |
| B5 | App ↔ box / other apps | An app cannot reach the host, the box's own services, metadata, LAN or another app | gVisor, egress fence (`egress/`), engine argument policy (privd / broker) [AT-EGR, AT-PRV] |
| B6 | Daemon ↔ keyd | The daemon gets purpose-bound operations, never raw key bytes or a generic signer | keyd `policy.ts` (TS) / `flagship-keyd` (Rust) [AT-KEY] |
| B7 | Daemon ↔ privd / broker | A compromised daemon still cannot mount host paths, run as root on the host, add devices, leave the sandbox or cross apps | privd `policy.ts`, broker `policy.rs` [AT-PRV] |
| B8 | AI ↔ owner data | A model never learns who or where the owner is; it works on a staging copy with sample data | `llm/modelPrivacy.ts`, AI staging, egress [not in this round's suite] |
| B9 | Release authority ↔ box | Only maintainer-endorsed code installs; versions and the security floor only go up; a stopped rollout stays stopped | box artifact verifier, `releaseMetadata.ts`, `releaseCatalogGate.ts`, endorsement v2 [AT-CAT, AT-DWN-17..20] |
| B10 | Box ↔ box (one account) | Siblings are the account's own servers, vouched for by the owner's server order, not by `.com` | server order `pqKeyIds`, gossip, access sync [AT-ENV] |
| B11 | Owner ↔ owner (chat, shares) | Cross-owner messages are addressed to an app and admitted by the receiving admin; a share never reveals the joining account | `chat/`, share accept [AT-LNK-09/10] |
| B12 | Box ↔ `.com` telemetry | Update receipts name no owner and carry fixed fields only | `updateReceipt.ts`, `canary/updateReceipts.ts`, `apps/com/src/updateReceipts.ts` [canary tests] |
| B13 | Boot | The disk key reaches cryptsetup only from a reply sealed to this boot, or a lease the owner signed; strict boxes refuse classical replies | `boot-stage.sh`, Go `unseal`, Rust `flagship-boot`, premount, boot-core gate [AT-DWN-21..26] |

## 3. Keys: who holds what

| Key | Holder | Protects |
|---|---|---|
| UMK (account root) | phones (Secure Enclave / Keystore wrapped), webapp (browser JS, a declared exception) | derives IRK, per-app visitor keys, archive keys |
| Admin root | admin devices | sensitive orders: ranks, modes, uninstall, add server, updates |
| IRK | derived from UMK | legacy orders, recovery records, sealing of the disk-key deposit |
| PQ halves (ML-DSA-65, X-Wing) | iOS: Secure Enclave ML-DSA on iOS 26+, else software seed SE-wrapped; Android: Keystore-wrapped seed; box: keyd `identity-mldsa.key` | hybrid signatures and seals (`pq-suites.md`) |
| STK (box identity) | keyd; also `/boot/identity.pem` for the initramfs | box signatures, unlock reply and lease recipient |
| SWK, CGK | keyd | app secrets, gossip MAC, access-sync key |
| TLS leaf, ACME account | keyd (P-256) | box TLS |
| Disk key (LUKS) | box (tmpfs), sealed copies at `.com`, optional TPM-sealed lease key | disk at rest |
| Release keys | YubiKey Ed25519 (maintainer), ML-DSA-65 companion (age to two YubiKeys + paper) | endorsements, artifacts, CA leases, notices |
| Catalog keys | offline root key; online timestamp key (repo secret) | release catalog (rollout percents, floor) |
| CA lease key | `.com` (online, endorsed by the CA track) | relay blessing, account-key attestation, signed time |

## 4. Data flows to read first

`evidence-map.md` §3 traces these end to end with file:line evidence:

- unlock at install, each boot, relay approval and the auto-unlock lease (§3.1), with the
  verdict that no plaintext unlock material reaches `.com` passively (§3.2);
- restore and peer backup (§3.3);
- share-unlock (§3.4);
- update (§3.5).

Since that map was made, these changed:

- boot unlock v2 (hybrid boot key, per-boot reply key, v3 leases, TPM-sealed lease key);
- the daemon drops root once keyd holds the keys (privd typed ops);
- deposits are readable only with the server's own read token;
- keyd slots fill only from owner-signed deliveries;
- first contact pins each box's own key (`docs/first-contact.md`);
- update receipts (`docs/runbooks/canary.md`).
