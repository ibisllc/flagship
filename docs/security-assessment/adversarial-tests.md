# The V01 adversarial suite

Tests that attack the built boundaries end to end (plan §14 "Mandatory adversarial matrix"). Each
test title starts with its ID, names the boundary, and says which defect it would catch. A test
that passes means the attack is refused. A test kept as **`it.fails`** documents an attack that
**succeeds today**. It stays red-on-green until the product code is fixed; then it becomes a plain
`it`. Results below are from the base commit `8007d3f8f` plus the working tree, on 2026-10-24
(macOS, Node 24; no gym run yet).

```sh
npx vitest run tools/adversarial/tests                     # every unit-level attack
bash scripts/gym-release-run.sh --groups adversarial,canary --skip-refresh   # the live ones (gym lock)
```

| File | Area | Tests | it.fails (open) |
|---|---|---|---|
| `tools/adversarial/tests/envelopeForgery*.test.ts` (+ `support/`) | ENV signed envelopes | 1,069 | 0 |
| `tools/adversarial/tests/downgrade.test.ts` | DWN strict mode, PQ companions, boot unlock v1/v2 | 26 | 3 |
| `tools/adversarial/tests/catalogRollback.test.ts` | CAT release catalog rollback/freeze | 20 | 5 |
| `tools/adversarial/tests/identityLinkage.test.ts` | LNK cross-account / cross-app linkage | 10 | 0 |
| `tools/adversarial/tests/egressEscape.test.ts` | EGR egress and browser escape | 14 | 3 |
| `tools/adversarial/tests/firstContact.test.ts` | FC first-contact MITM | 6 | 0 |
| `tools/adversarial/tests/appNameCerts.test.ts` | CRT app-name certificate and grant misuse | 6 | 1 |
| `tools/adversarial/tests/privdArgv.test.ts` | PRV broker argv escapes | 13 | 5 |
| `tools/adversarial/tests/keydPurpose.test.ts` | KEY keyd purpose abuse | 12 | 0 |
| `tools/live-e2e/groups/release03/adversarial.ts` | LIVE real box, gym | 19 checks | not run yet |
| `packages/protocol/tests/updateReceipt.test.ts`, `packages/server-daemon/tests/canary/updateReceipts.test.ts`, `apps/com/test/updateReceipts.test.ts`, `tools/release-catalog/tests/rollout.test.ts` | V02 receipts, stop rule | 13 + 10 + 7 + 4 | 0 |

## 1. ENV: forged and stripped signatures

Harness: `tools/adversarial/tests/support/envelopeDriver.ts` drives every exported `signX`/`verifyX`
pair in `packages/protocol/src` (167 families) against its **production verifier**, signing through
an opaque keyd stand-in so it sees the exact signed bytes. `support/tagInventory.ts` labels each of
the 117 other `flagship/<purpose>/vN` strings: either covered by its own negative vectors, or not a
signature (KDF, AAD, hash, MAC label). 1,069 tests, 0 `it.fails`.

| ID | What it proves (for each of the 167 families unless stated) | Result |
|---|---|---|
| AT-ENV-01 | control: the family's own signature verifies | pass |
| AT-ENV-02 | one flipped bit (first or last byte) is refused | pass |
| AT-ENV-03 | another valid key's signature, and the right signature under the wrong key, are refused | pass |
| AT-ENV-04 | changing any field the encoder reads breaks the signature | pass |
| AT-ENV-05 | empty, 63-byte, 65-byte, all-zero and missing signatures are refused | pass |
| AT-ENV-06 | all 167×166 cross-family replays are refused (tag confusion) | pass |
| AT-ENV-07 | every family signs bytes starting with its own purpose tag; no two share one (4 reviewed legacy prefixes) | pass |
| AT-ENV-08 | the all-zero key and the identity point with a zero signature are refused | pass |
| AT-ENV-09a–f | a `\|` inside one text field cannot move into the next under the same signature | **fixed 2026-10-24** (was open, low): `canonicalLlmPromoIssue` (09a, 09b), `canonicalPbManifestDeposit` (09c), `canonicalProvisionEvent` (09d), `canonicalPublisherTrust` (09e) and `canonicalPushRelayRequest` (09f) now refuse `\|` and control characters in every text field (`legacyFieldGuard`) and require safe integers in numeric ones (`integerFieldGuard`); bytes for valid input are unchanged, so the tags stay. The webapp, Swift, Kotlin and Rust ports of the two cross-port families refuse the same, pinned by `refuse` lists in `test-vectors/llm-promo-issue` and `test-vectors/publisher-trust` |
| AT-ENV-10 | every purpose tag in protocol src is driven or listed in the inventory, and nothing listed is stale | pass (fails CI for a new unclassified family) |
| AT-ENV-11 | the harness still drives at least 165 families | pass |
| AT-ENV-20 | hybrid Ed25519+ML-DSA-65: either half spliced from another message, zeroed or stripped, another purpose, a public key mixing two keys' halves | refused |
| AT-ENV-21 | `pq-key-binding/v1`: wrong role/subject/key, a replaced ML-DSA key against the pin, Ed25519-only, edited, future-dated or stale | refused (a first unpinned binding verifies by design: the pin is the control) |
| AT-ENV-22 | `verifyCriticalSignature`: strict refuses a valid Ed25519 signature with or without binding, a relabelled hybrid half, a look-alike binding object, another signer's binding, a mismatched purpose, an unknown suite, a spliced ML-DSA half; "prepared" (not enforced) still accepts classical | as specified |
| AT-ENV-23, 24 | release-endorsement/v2 and box-artifact/v2 companions: halves spliced between releases, cross-purpose with the same key, replay onto another manifest or signer, stripped half, wrong key id | refused |
| AT-ENV-25, 26 | CA-signed time (`auth-time` vs `signed-time` swapped, non-CA key, other nonce, moved time); account-key attestation and service blessing (relabel, re-key, cross-use) | refused |
| AT-ENV-27 | all 14 phone order types: flipped, other key, other server, other time, 14×13 cross-type replays, power "off" vs "restart" | refused |
| AT-ENV-28, 29 | server order (reordered or shortened list, odd hex, other key/user); `rotate-rck/v1` (missing, swapped or doubled signatures) | refused |
| AT-ENV-30 | MACs: gossip/v2, enrollment proof, server-code-seen (wrong key, truncation, moved fields) | refused |

Note: `verifyBoxArtifactPq` does not check the binding's role itself. It relies on its caller
(`verifiedBoxArtifactBindings`), so a new caller building its own map would reopen role confusion.

## 2. DWN: downgrade

| ID | Attack | Result |
|---|---|---|
| AT-DWN-01..05 | strict signature gate: classical-only signature, either hybrid half zeroed, suite relabelled, fake/foreign/missing binding, signature moved to another purpose | refused |
| AT-DWN-06..12 | policy chain: box, app, relay, cloud or old client asks for compatibility; classical or unacknowledged opt-out; revoked signer; replayed/skipped/forked generation; older state or rollout going backwards; hybrid suite stripped from the offer; return to strict without re-entry evidence | refused |
| AT-DWN-13 | `.com` serves a truncated chain, a classical opt-out, or an opt-out signed by the box | box stays strict |
| **AT-DWN-14** | damaged policy file + an empty chain from `.com` | **open**: the box drops to compatibility (`assurancePolicySync.ts:134` skips anti-rollback while fail-closed) |
| **AT-DWN-15** | the device that turned strict on is later revoked | **open**: every replay stops at generation 1; the box refuses later owner changes, even from the admin root (`assurancePolicySync.ts:145-162,186-205`) |
| **AT-DWN-16** | export authorization from an older policy generation | **open** (no caller yet): `classicalExchangeAllowed` ignores generation and scope (`assurancePolicy.ts:288-291`) |
| AT-DWN-17..20 | release endorsements, CA leases, box artifacts, security notices with a test PQ pin: classical-only, stripped, moved, wrong commit, unpinned PQ key | refused |
| AT-DWN-21..25 | boot unlock: v1 reply/lease to a strict box; stranger-sealed reply; replay under another nonce/server/boot key; extended/uncapped/re-id'd v3 lease; phone under strict with no v2 material | refused |
| AT-DWN-26 | `/boot` policy file garbage → strict; missing → compatibility | the documented §19.3 limitation, not a new finding |

## 3. CAT: release catalog

| ID | Attack | Result |
|---|---|---|
| AT-CAT-01..04 | roll back targets, timestamp, snapshot or root (03: a stolen online timestamp key re-signs an old snapshot) | refused |
| AT-CAT-05 | newer targets with a lower floor | refused |
| AT-CAT-06 | expired timestamp/snapshot served | stale: new updates blocked, rollback unaffected |
| **AT-CAT-07** | the catalog fetch is blocked after a fresh view was accepted | **open**: the view never turns stale by the clock (`releaseCatalogGate.ts:100-108` trusts the `stale` flag saved at accept time). A blocked fetch keeps a stopped rollout open on that box |
| AT-CAT-08 | snapshot/targets swapped between two catalogs | refused |
| **AT-CAT-09** | the same version re-signed with different content | **open**: accepted (`releaseMetadata.ts:236` refuses only lower versions). The `rollout` tool always bumps the version |
| AT-CAT-10, 11 | targets signed only by the online timestamp key; one key signing twice to reach a threshold | refused |
| **AT-CAT-12** | two key ids for one public key, threshold 2 | **open**: accepted (`releaseMetadata.ts:139-144,165-179`); `catalog.ts root` accepts any id=pub pairs |
| AT-CAT-13, 14 | root chain: skipped version, self-signed jump, old key only, an attacker's root v2 from the feed | refused; a proper rotation is accepted |
| AT-CAT-15 | release removed from targets while a floor is set | rollback to it refused; `--percent 0` keeps it a valid target (the stop rule uses `--percent 0`) |
| AT-CAT-16 | box outside the cohort, unlisted commit, no catalog | refused; a 10% rollout admits about 10% of boxes |
| **AT-CAT-17** | a 16 MiB catalog body | refused, but **open**: the whole body is read before the 1 MiB check (`releaseCatalogFeed.ts:66-76`) |
| AT-CAT-18 | health rollback below the floor, or the floor check throws | restricted recovery, no restore, marker kept |
| AT-CAT-19 | a refused catalog | stored state byte-identical |
| **AT-CAT-20** | the catalog state file is damaged | **open**: the floor reads as 0 until the next good fetch, and the boot health gate runs before that fetch (`releaseCatalogGate.ts:56-72,130`) |

## 4. LNK, EGR, FC, CRT

| ID | Attack | Result |
|---|---|---|
| AT-LNK-01..03 | per-app visitor key and stable id across apps, accounts and servers; malformed app refs | unlinkable, refused |
| AT-LNK-04..07 | forged `X-Flagship-*` headers (any case, `_`); sibling-app CSRF and WebSocket; another app's session cookie; one member across two apps | stripped / anonymous / unlinkable |
| AT-LNK-08, 09 | visit and knock proofs moved between apps/pages; chat frames to another app, replayed, from the owner's own account, impersonated, unregistered | refused |
| AT-LNK-10 | share acceptance anonymity | **fixed 2026-10-24** (was open): the acceptance's #12 is now signed by a per-share admin key `HKDF(UMK, "flagship/server-share-admin/v1\|<shareId>")`, and `.com` attests that key (`keyKind: share`) on a request the account's admin root signs (`POST /api/users/:u/share-key-attestation`); the box accepts no other kind. The key matches nothing `GET /api/username/:u` serves and differs per share. The public `GET /api/users/:u/account-key-attestation` is gone (docs/share-a-server.md §5.1). `irkPub`/`adminRootPub` stay public: pre-sign-in recovery and the DNS broker verify against them |
| AT-EGR-01..07, 10, 12, 13 | v4-mapped/compat/NAT64/6to4/Teredo/ULA/link-local/metadata spellings; octal/hex/dword IPv4; rebinding names; wildcard label boundaries; duplicate Host; browser judge numerics and `file:`; per-app pinning proxies; provider redirects; git clone pinning | refused |
| **AT-EGR-08** | `https://<box fqdn>./` (trailing dot) from a granted page | **open**: the judge's "this server" check does not normalise the host (`browser/policy/judge.ts` `destination()`) |
| **AT-EGR-09** | production wiring of the app-browser judge | **open**: `bootstrapBrowserBundle` in `index.ts` passes neither `protectedHosts` nor `egress.protectedAddresses`. A whole-LAN grant reaches the box itself (app browser is off today) |
| **AT-EGR-11** | approval for `host:443` used on another port | **open**: `browser/pinningProxy.ts` keys approvals by host only |
| AT-FC-01..06 | enrollment proof with the wrong key, server or serial; the secret forgotten after use; Studio "seen" MAC forgery; a six-digit code collision (found in <20k tries) still refused by the proof; any key change after pinning; the boot-key binding | refused |
| AT-CRT-01..05 | wildcard grants: IRK where an admin root is pinned, another account's admin, another server or key, another user's name, case/trailing-dot spellings, apex, replay by another box; a revoked server; keyd `TlsKeys` names | refused by `.com`, the DNS broker and keyd |
| **AT-CRT-06** | keyd `namesFor` on a policy FQDN of `alice.flagship.services` | **open** (defence in depth): keyd would mint a key for `*.flagship.services` (`packages/keyd/src/migrate.ts`); `.com` and Let's Encrypt still refuse the challenge |

## 5. PRV, KEY: compromised daemon against the broker and keyd

| ID | Attack | Result |
|---|---|---|
| AT-PRV-01, 02 | long-form host flags and host bind mounts (privileged, cap-add, devices, host namespaces, seccomp/apparmor off, env-file, network host, user root, `-v /:/host`, bind `--mount`) | refused |
| **AT-PRV-03** | `docker run … -v/:/host …` (value attached to the short flag) | **open, high**: accepted. `validateDockerArgs` compares the whole argument with `-v` (`packages/privd/src/policy.ts` `validateDockerArgs`); the Rust broker mirrors it (`rust/crates/flagship-broker/src/policy.rs:640,684`) |
| **AT-PRV-04** | `docker run -dv /:/host …` (grouped short flags) | **open, high**: accepted, same cause |
| **AT-PRV-05** | `-u0` / `-uroot` | **open, high**: accepted; root in the container over a host bind with 03/04 |
| **AT-PRV-06** | `--network container:flagship-postgres` under Docker | **open, medium**: accepted; the `:` check exists only for Podman |
| **AT-PRV-07** | `--runtime runc` or no runtime on an ordinary run | **open, medium**: accepted; an app image can run outside gVisor |
| AT-PRV-08..13 | exec outside the two data services or with other flags/env; cp/commit/plugin/swarm/context/buildx/`-H`; NUL, oversize, extra keys, `DOCKER_HOST`; Podman transports, `--rootfs`, hooks, annotations; systemctl masking/editing/other units; the state dir or the engine socket in any argument | refused |
| AT-KEY-01..11 | keyd as a raw signer, owner/admin purposes, hybrid-only purposes through classical `sign`, pq-binding shape, boot-suspension/boot-auth roles, size bounds, HKDF labels and salt, CGK MAC tags, `unseal` purposes, wire shape (`getPrivateKey`, extra `uid`), per-app derivations | refused |
| AT-KEY-12 | `swk.deriveTlsKey` for any serverId | documents the known unscoped derivation (REGISTER K01) |

## 6. LIVE: the gym group `adversarial` (not run yet)

`tools/live-e2e/groups/release03/adversarial.ts`, phase 10, needs A1 and B1, runs alone and last.

| ID | Boundary | Expected |
|---|---|---|
| AT-LIVE-01 | `/api/power` on an admin-pinned box: five forged signature shapes, IRK, B's admin root, a delegated key, an order naming B1, a signature over "off" sent as "restart" | 4xx, box still serves |
| AT-LIVE-02 | signed journal: forged shapes, B's IRK, a stranger, another server, unit `ssh`, an hour-old request | refused, no lines |
| AT-LIVE-03 | `.com` update deposit lane across accounts | 401/403 |
| AT-LIVE-04..08 | access list, uninstall, env change, rank order, server order: forged shapes, IRK on admin-pinned, B's admin root, wrong target | refused, state unchanged |
| AT-LIVE-09 | paired session of one account on the other's box | 401 |
| AT-LIVE-10, 11 | a real Remote session against keys, backups, AI, build, identity, tickets; raw `%2e%2e`, `//`, `%2f`, `%5c` paths | refused |
| AT-LIVE-12 | client-sent identity headers and cookies into an app | never reach the app; anonymous, no rank |
| AT-LIVE-13 | app egress to metadata (all spellings), loopback, the bridge gateway, the box's own name | fenced |
| AT-LIVE-14 | session token in a stream URL; ticket reuse; ticket on another route | refused |
| AT-LIVE-15, 16 | certificate names stay in their account; SNI/Host fronting across accounts | no cross-account answer |
| AT-LIVE-17 | a replayed update order | `.com` or the box refuses; the commit is unchanged |
| AT-LIVE-18 | arch-v2 effective state from the daemon journal (not root, Rust path, Podman) | as claimed |
| AT-LIVE-19 | privd audit visible to the owner | skips: the signed journal reads only the daemon and data-services units |

Things the group could not check from outside are listed for a later group:

- effective UID/caps/seccomp from `/proc` of each unit;
- socket ownership;
- runsc in a broker-started container;
- the broker's audit content.
