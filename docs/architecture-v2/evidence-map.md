# Architecture v2 evidence map (A01)

**Status: source inventory only.** This document completes the source half of A01. The other half,
a recorded synthetic traffic trace, is not done, and the A01 completion gate stays open until it is
(see §6).

| | |
|---|---|
| Plan package | `IMPLEMENTATION-PLAN.md` §13.1 A01 |
| Rebased on | `152ab3d87340c445505bb2d1ab11a35412d144aa`, branch `arch/audit`: `release/0.3` `29248cbb1` plus the empty A04 Rust skeleton |
| Plan snapshot it corrects | `feat/multilingual` `97095cff3` (§1.1 of the plan) |
| Method | Read-only source review. No live service, account, log or device was touched. Four parallel source sweeps collected the inventory: daemon privileged effects, box key uses, unlock/restore/share/update paths, and crypto primitives. I re-read a sample of their citations at the cited lines, including every citation that carries a verdict below |

**Labels used in this document.**

- **[code]** means observed in code.
- **[doc]** means stated only in comments or docs.
- **(inf)** means inferred, not traced end to end.
- `D/` = `packages/server-daemon/src/`, `K/` = `packages/keyd/src/`, `P/` = `packages/protocol/src/`, `CP/` = `packages/control-plane/src/`.

Machine-readable companions:

- `crypto-graph.json`: the §6.6 dependency graph.
- `scripts/crypto-graph-check.mjs`: finds classical-only bypasses in that graph.
- `REGISTER.md`: the §13.3 required-deliverable register.

---

## 1. Key custody and every box key use

### 1.1 Who holds the box keys

- **Default custody: TS `flagship-keyd`.** The daemon uses keyd when `FLAGSHIP_KEYD_SOCKET` exists (`D/index.ts:676`). Otherwise it installs keyd and restarts (`D/index.ts:677-686`). If keyd still does not answer, it falls back to **in-process keys** (`D/index.ts:692`, `KeyCustodian` at `D/index.ts:1011`). Only `FLAGSHIP_KEYD_REQUIRED=1` turns that fallback into a refusal (`D/index.ts:688-691`). [code]
- **keyd's own isolation.** keyd runs as `User=flagship-keyd` (`K/unit.ts:54`). Its migration step runs with full privileges through `ExecStartPre=+` (`K/unit.ts:60`). Callers are authenticated **only by socket group membership**: keyd reads no `SO_PEERCRED`, and the `component` name a caller sends is self-declared and used only for the audit log (`K/server.ts:127-134`; `docs/keyd.md` says the same). [code]
- **The daemon runs as root.** None of the `flagship-daemon.service` texts contains a `User=` line: `packages/flagship-builder/src/userdata.ts:743-775` (`ExecStart` at :761), `CP/demoCloudConfig.ts:393-420`, and the bundled `preseed-engine.js` copies. The only privilege drop-ins are `SupplementaryGroups=flagship-keyd-clients` (`K/unit.ts:104-113`) and the tlsd drop-in (`K/unit.ts:201-214`). [code]
- **Consequence.** keyd separates its key bytes from the daemon process. It does not separate them from root, and root is what the daemon is. `docs/keyd.md` already says this ("The boundary becomes real when the daemon runs unprivileged").

### 1.2 keyd's operation set: what crosses back to the daemon

Plan §4.2 requires "no `SignBytes` or `GetPrivateKey`". keyd has neither by name. Several operations still hand root-level material back to the daemon:

| Op (`K/service.ts`) | Returns | Concern |
|---|---|---|
| `sign` :96-101 | Ed25519 signature | Purpose-prefix allowlist (`K/policy.ts:10-45`). Shape rules exist only for `boot-suspension` and `boot-auth` (`K/policy.ts:73-84`). Every other allowed tag is signed with whatever fields follow. Example: `flagship/inject/v1` (`D/serviceProxy.ts:238`) signs any user and role, which forges app identity headers |
| `unseal` :102-110 | **Plaintext of any blob ≤1 MiB sealed to the STK** | A generic decryption oracle. The daemon uses it to open the SWK and CGK deposits (`D/swkDepositConsumer.ts:72`, `D/cgkDepositConsumer.ts:62`), so the root SWK and CGK transit the daemon. It also defeats the "keyd keeps it" intent of `acme.importGranted` (:210-222) |
| `swk.hkdf` :111-120 | A 32-byte subkey for any of the 6 `SWK_DERIVE_LABELS` (`P/opaqueKey.ts:69-76`) with any salt | Hands out the LLM key (which makes `swk.seal`/`swk.open` pointless as a boundary), the peer-backup key (PBK), app secrets, TLS-at-rest keys and chunk keys |
| `swk.deriveServiceSecret` :143-146, `swk.deriveTlsKey` :147-151 | A derived key for **any** serviceId or serverId | The ids are not scoped |
| `tls.sign` :192-196 | A signature over any 32- or 48-byte digest made with a certified leaf | This is required by the frontend. It is a signing oracle for that leaf, available to any client-group process (no peer credentials) |
| `acme.sign` :228-247 | ACME JWS | The host is pinned to Let's Encrypt, and names, CSR and revoke are policy-checked. `postAsGet` checks only the host (`K/acme.ts:134-136`) |
| `provision.swk` / `provision.cgk` :248-264 | — | Write-once, so **the first writer wins**. On a box that has no SWK yet, a compromised daemon chooses the SWK |

keyd operations nothing calls: `swk.decryptChunk`, `swk.deriveTlsKey`, `swk.deriveBackupManifestKey`, `cgk.seal`, `cgk.open`.

### 1.3 Box signing purposes (STK)

Under keyd, `identityKeypair.privateKey` is an opaque proxy (`D/index.ts:816`, `P/opaqueKey.ts:29-52`), and `ed.sign` on it becomes keyd's `sign`.

**Signed and allowed.** Each tag below is in `BOX_SIGN_PURPOSES` and has a production call site [code]:

| Tag | Call site |
|---|---|
| `tunnel-hello/v2` | `D/tunnel/tunnelClient.ts:346` |
| `daemon-status/v1` | `D/daemonStatusHeartbeat.ts:151`. Carries the native cert pin |
| `box-trust-status/v1` | `:172` |
| `secret-request/v1` | `D/entitlementRelay.ts:120` |
| `install-service/v1` | `D/llm/deploySession.ts:216` and others |
| `update-pull/v1` | `D/updateClient.ts:341` |
| `server-revoke-by-self/v1` | `D/index.ts:4747` |
| `server-migration-attach/ack` | `D/migrationConsumer.ts:370,498` |
| `dns01-publish` / `dns01-delete` | `D/acme/remoteDnsChallengeWriter.ts:100,129` |
| `box-read-token-request/v1` | `D/boxReadToken.ts:71` |
| `service-invite-create-fetch` / `service-invite-list` / `service-invite-co-manager` | `D/serviceAccess.ts:1918,2348`, `D/shares/shareInvites.ts:334` |
| `lan-hint/v1` | `D/lanDirect.ts:259` |
| `push-relay/v1` | `D/relaySos.ts:90` |
| `boot-auth/v1`, `boot-suspension/v1` | `D/bootSuspensionClient.ts:60,113` |
| `inject/v1` | `D/serviceProxy.ts:238` |
| `membership/v1` | `D/servicePlatform.ts:974` |
| `app-copy-fetch/v1` | `D/appCopy/target.ts:171` |
| `sibling-hello/v1` | `D/sibling/handshake.ts:241` |
| `pb-manifest/v1` | `D/peerBackup/manifest.ts:128` |
| `pb/request-peers/v1` | `D/peerBackup/shipper.ts:64` |
| `pb-put`, `pb-resp` | `D/peerBackup/transport.ts:102,374` |
| `pb-http/v1` | `D/peerBackup/httpPeerLink.ts:114` |

**Signed by the box but refused by keyd.** These break whenever keyd is present:

- `flagship/app-release/v1`: signed at `D/index.ts:2292`, sent through `D/updateServer.ts:237`. The N11 publisher signature therefore fails under keyd (inf: every update-pack reply that carries a pack throws).
- Seven peer-backup v2 tags, all signed through `D/peerNet/comClient.ts:77-145`: `pb-checkin`, `pb-directory`, `pb-tokens`, `pb-redeem`, `pb-filler-fetch`, `pb-filler-proof`, `pb-root-deposit` (`P/peerBackupNet.ts:379-456`).
- `flagship/identity-header/v1` (`D/identityInjector.ts:183`). Not wired: the injector map is empty (`D/index.ts:4406`) (inf).

**Signed outside keyd altogether.** The health timer signs untagged JSON with `openssl pkeyutl -inkey /boot/identity.pem` (`D/healthReporter.ts:30,52`).

**In the allowlist but signed by no daemon code.** `service-grant/v1`, `server-register/v1` and `put-sealed-luks-key/v1` are signed only by `scripts/install-helper.ts` at install time. Also unsigned: `pod-binding/v1`, `mint-reservation/v1` and `sibling-sync/v1` (inf: unwired).

### 1.4 Raw key material that persists alongside keyd

| Material | Where | Evidence |
|---|---|---|
| **STK seed, plaintext** | `/boot/identity.pem` on the unencrypted `/boot` partition, copied into the initramfs | written at install `userdata.ts:705-706`, copied :1661, rewritten on rotation `D/index.ts:4636`; read by `installer/boot-stage.sh:99` and `D/healthReporter.ts:30`. keyd's migration never touches it (`K/migrate.ts:16-20`) |
| STK rotation files | `/var/flagship/identity/identity.{pending.,}priv.hex`, `.previous` | `D/identityRotateHttp.ts:51-65`, `D/index.ts:4596-4640`. Rotation generates a raw STK in the daemon. keyd's migration moves only `identity.priv.hex` and throws when an existing key differs (`K/migrate.ts:29-35`) (inf: a rotated box fails keyd's `ExecStartPre`) |
| SWK | `install-blob.json` `swkHex`, read on every boot; `/var/flagship/swk.hex` | re-persisted from the blob when the file is absent (`D/index.ts:947-962`), but removed only when keyd lacks an SWK (`:997-1000`). The file therefore reappears on every boot once keyd holds the SWK |
| CGK | `install-blob.json` `cgkHex`; `FLAGSHIP_CGK_HEX`, which is not scrubbed from the env file | `D/gossip/cgk.ts:26-58`. **Gossip and access-sync read the raw CGK, never keyd**: `D/gossip/index.ts:154`, `D/accessSync.ts:55-56`. After the CGK moves into keyd, gossip goes silently disabled unless the env or blob still holds a copy |
| Legacy TLS/ACME PEMs | `/var/flagship/acme/account.pem`, `acme/cert/*.key` | deleted only when tlsd is installed (`D/index.ts:721-724`). Without tlsd, TLS stays on the in-process `certManager` path |
| Daemon-held keys never moved to keyd | PBK (`D/index.ts:1441`), peer-net PIK and mailbox seeds (`D/peerNet/holder.ts:124-129`, file `peer-net/holder.json`), lease seeds (`D/peerNet/owner.ts:378`), archive KEK pool (`D/serverArchive/saved.ts:76`), household key (`FLAGSHIP_HOUSEHOLD_KEY_HEX`, `D/index.ts:4030-4032`), Postgres admin password and `DATA_NAME_KEY` (`D/runtime.ts:1945-1963`), Forgejo token (`D/index.ts:2648`) | [code] |
| Zero-key fallback | MCP keys and the stable-id journal seal under a zero key when no SWK exists | `D/index.ts:2896,3814` |
| Raw read of an opaque SWK | `D/postRecovery/stableIdReissuer.ts:305-309` hashes the SWK bytes directly | (inf) this throws under keyd |

What keyd's migration does strip: it moves `identity.priv.hex`, `swk.hex` and `cgk.hex` (`K/migrate.ts:16-20`), and scrubs `FLAGSHIP_IDENTITY_PRIV_HEX` and `FLAGSHIP_SWK_HEX` from `daemon.env` and `SERVER_IDENTITY_PRIV_HEX` from the bootstrap env (`K/main.ts:35-36`).

### 1.5 Other private keys on the box

| Key | Custody | Evidence |
|---|---|---|
| TLS leaf | P-256 in keyd | `K/tls.ts:94-113` |
| ACME account | P-256 in keyd | `K/acme.ts:32` |
| TLS-ALPN challenge key | ephemeral P-256 in the daemon | `D/acme/alpnChallengeCert.ts:52-81` |
| Tier-2 shared service-certificate keys | exported over HTTP | `D/serviceCertHttp.ts:304,381`. Their files are deleted under tlsd (`D/index.ts:721-724`), and the opaque issuer returns an empty PEM (`D/acme/opaqueIssuer.ts:53`) (inf: so minting fails) |

Debug SSH public keys are written to `/etc/flagship/debug-ssh/authorized_keys` together with `NOPASSWD: ALL` sudo for user `debug` (`D/debugAccessGate.ts:44,123`). Accepted key types include `ssh-rsa` (`P/debugAccess.ts:53`).

---

## 2. Every privileged effect in `packages/server-daemon`

**Summary.**

- The daemon runs as root (§1.1) and calls host binaries directly. That is roughly 106 call sites, 57 of them `docker` and 21 `systemctl`.
- **Nothing in the daemon calls the `privd` broker.** No source file references `privd`, `PrivdClient` or `brokerCommandRunner`, and `packages/server-daemon/package.json` has no dependency on it. `brokerCommandRunner` is used only by `packages/privd/tests`. `SECURITY-0.3-PROGRESS.md` confirms the broker is "not yet switched on". [code]
- There is no direct Docker socket or API client. All Docker use goes through the `docker` CLI, and `docker.sock` appears only as a refused argument (`D/serviceRunner.ts:113`).

**Spawn primitives.**

- `realCommandRunner` (`D/serviceRunner.ts:263-305`, PATH lookup, full environment inherited).
- `realUpdateCommandRunner` (`D/updateConsumer.ts:79-86`, `execFile` with a 20-minute timeout; used for bash, systemctl and sh).
- Direct `child_process` use in `volumeDump.ts`, `appCopy/ops.ts`, `debugAccessGate.ts`, `deadMan.ts`, `selfDeleteConsumer.ts`, `dataDirWalker.ts`, `journalHttp.ts`, `tlsUpstream.ts`, and the git callers.

| Subsystem | Effects (binary: purpose) | Evidence |
|---|---|---|
| Runtime | docker `network create`, `build` (memory and CPU caps), `run` (`--runtime=runsc --cap-drop=ALL --read-only`, files volume), `stop`/`rm`/`logs`/`inspect`/`pull`/`ps`; writes `/etc/systemd/network/10-flagship-containers.network` then `networkctl reload` | `D/serviceRunner.ts:374-624`, `D/index.ts:3341`, `D/containerLinks.ts:16-36` |
| Staging | docker `run --user 0:0 --cap-add DAC_OVERRIDE` helpers (sh, find, head) | `D/buildmodes/staging.ts:600-723` |
| gVisor | downloads runsc into `/usr/local/lib/flagship-gvisor`; `apt-get install zstd`; `tar`; writes `/etc/docker/daemon.json`; `systemctl reload docker`; probe container | `D/appSandbox/gvisor.ts:144-260` |
| Per-app disk limits | `mkfs.ext4`, `mount -o loop`, `umount`, `chattr ±i`, `losetup`, `resize2fs`, `fallocate`, `cp -a`, `du`, `docker volume create --opt o=bind`. Root only | `D/appQuota/loopVolumes.ts:182-528`, `D/runtime.ts:1488-1490` |
| Data layer | `docker compose up`; writes `/etc/systemd/system/flagship-data-services.service`; `systemctl daemon-reload/start/is-active`; `chmod 0777` on volume mountpoints | `D/dataLayer/stack.ts:323-427`, `D/dataLayer/realAdmins.ts:156-220` |
| Egress | `iptables`/`ip6tables` and `-restore` (not nft); writes `/run/flagship-egress.v{4,6}.rules` and `/run/flagship-resolv-*.conf` | `D/egress/firewall.ts:45-176`, `D/egress/gateway.ts:166-169` |
| Update | `bash installer/install-box-artifact.sh` / `rollback-box-artifact.sh`; writes `/usr/local/sbin/flagship-{update-guard,rollback-release,health-report}.sh`, systemd units and drop-ins; git on per-app clones | `D/artifactUpdate.ts:135-158`, `D/updateGuard.ts:24-160`, `D/healthReporter.ts:14-116` |
| System repair | `dpkg --verify` / `-i` / `--configure -a`; `sqv` / `gpgv`; `systemctl daemon-reexec` | `D/systemRepair.ts:72-397` |
| Docker health | `systemctl reset-failed/start` for containerd and docker; `journalctl`; renames Docker's network kv-store file | `D/dockerHealth.ts:16-139` |
| Power | `systemctl poweroff/reboot`; writes `/boot/flagship-lock-once`; writes `/boot/identity.pem` during identity rotation | `D/deadMan.ts:69-87`, `D/index.ts:4600-4636` |
| Migration sandbox | `docker run --runtime=runsc --read-only --cap-drop=ALL … psql` (PGPASSWORD passed in env) | `D/migrationSandbox.ts:90-175` |
| App copy / backup / wipe | `docker save/load/exec pg_dump/pg_restore/pause/unpause`, files helper with `--user 0:0 --cap-add`, `pg_dumpall` with the password on argv, host `tar -xf`; wipe runs `compose down -v`, `volume prune`, `rm -rf <dataDir>/data` | `D/appCopy/ops.ts:132-236`, `D/volumeDump.ts:305-605`, `D/selfDeleteConsumer.ts:344-367` |
| keyd/tlsd install | `groupadd`/`useradd`/`install -d`; writes `flagship-keyd.service` and `flagship-tlsd.service` plus drop-ins; `systemctl enable --now`; `chgrp` on the socket | `D/keydInstall.ts:51-115`, `D/tlsUpstream.ts:74-76` |
| Debug access | `useradd`/`usermod`/`ssh-keygen -A`/`systemctl enable ssh`; writes `/etc/sudoers.d/90-flagship-debug` (`NOPASSWD: ALL`) and an sshd drop-in; `loginctl`/`pkill`/`gpasswd` on revoke | `D/debugAccessGate.ts:44-142` |

**What privd would refuse or not cover today.**

privd's closed operation set is `power`, `systemd.restart` for three named units, `docker` with an argument policy, and `nft.apply` (`packages/privd/src/policy.ts:17-142`, `wire.ts:12`). Compared with the daemon's actual calls:

- **Docker subcommands it refuses:** `exec`, `pause`/`unpause`, `rmi`, `save`/`load`, `volume prune`, the `docker-compose` fallback binary.
- **Docker arguments it refuses:** `--cap-add` and `--user 0:0` (both used by the files helper and staging), and compose `down -v`.
- **Egress mismatch:** the daemon uses iptables, but privd brokers only nft.
- **Not covered at all:** mount, losetup, mkfs, chattr, dpkg/apt, useradd, every `/etc` and `/usr/local` write, and the systemctl verbs other than restart.
- `privd/src/unit.ts:3` names `installer/verify-privd-unit.sh`, which does not exist.

---

## 3. Data-flow traces and the OQ-01 verdict

**Deployment fact.** In production, `/api/boot/*` runs inside the `.com` Worker through in-process adapters (`apps/com/src/route.ts:640`, `apps/com/src/bootInProcess.ts:1-18`). For confidentiality purposes, ".com" and "the boot Worker" are therefore one trust domain.

### 3.1 Unlock, end to end

**Install time (Debian d-i, USB, Studio; all share `userdata.ts`)**

1. d-i generates a random 48-character LUKS passphrase in installer RAM (`packages/flagship-builder/src/preseed.ts:333-340`).
2. The box generates its own STK and registers it with `.com` (`userdata.ts:702-707`, register at :1499-1511).
3. The box generates a 64-byte random disk key into tmpfs and runs `cryptsetup luksAddKey` (`userdata.ts:1527-1538`).
4. The box **seals that key to the account IRK's public key** (`authCode.userPubKey`). The construction: Ed25519→X25519, ephemeral X25519, HKDF-SHA256 (`flagship.seal.v1`), AES-256-GCM (`userdata.ts:1544-1558`, `scripts/install-helper.ts:228,260`, `P/encryption.ts:91-138`). Comments call the recipient a "BAK" (`P/unlock.ts:19-21`) [doc]; the code seals to the IRK.
5. The box sends the sealed key to `.com` with an STK-signed `put-sealed-luks-key/v1` (`userdata.ts:1559-1572`). `.com` verifies and stores it (`CP/luksKeys.ts:30-81`). **`GET /api/server/:host/sealed-luks-key` needs no authentication** (`CP/luksKeys.ts:10,112`). [code]
6. The box removes the burn key slot and fails the install unless exactly one slot remains (`userdata.ts:356-419`). It then writes the plaintext STK to `/boot/identity.pem` and copies it into the initramfs (:705, :1661). `/boot/flagship-unseal` is installed from the signed release at install time only (:1595-1605).
7. **VM appliance:** the factory runs `luksFormat` once per published image with a public constant passphrase (`appliance.ts:16`, `applianceFactory.ts:149-152`). The specializer adds the per-box key and removes the factory slot (`appliance.ts:152-176`). Adding and removing slots does not change the LUKS volume key, and the repo contains no `cryptsetup reencrypt`. **Every box made from one published image therefore shares one volume key, recoverable by anyone who holds the image** (inf from LUKS semantics; the image is hosted on R2).

**Each boot**

8. **Auto mode.** The box sends an STK-signed `boot-auth/v1` GET for its lease (`boot-stage.sh:182-225`). The Worker returns the stored sealed key (`packages/boot-core/src/routes.ts:360-400`). The box opens it locally with the STK from `/boot` (`boot-stage.sh:245-257`). A 404 or 423 (locked) falls through to the relay.
9. **Relay mode.** The box sends an STK-signed `secret-request/v1` (`boot-stage.sh:286-315`) and polls for the response (:335-353). The Worker verifies the request, stores a row with `responseSealedHex: null`, and sends a content-free push (`routes.ts:448-591`, `bootInProcess.ts:150-163`).
10. The phone side:
    - **iOS** checks the request against the STK in `.com`'s `/pods` (`SecretRequestCoordinator.swift:138-168`), fetches `sealed-luks-key`, opens it with the BAK or the IRK seed (:449-470), and **re-seals to the directory STK**, bound to the nonce and purpose (:472-475).
    - **Android** does the same (`SecretRequestCoordinator.kt:476-511`).
    - **The webapp** derives the IRK from the UMK in browser JavaScript (`apps/web/public/webapp/lib/bootApproval.js:84-90`) and does the same (:380-408).
    - Response format: `P/phoneEndpoint.ts:245-323`.
11. The Worker stores only `sealedHex` (`routes.ts:631-695`). It never decrypts.
12. `flagship-unseal` maps the STK seed to X25519 and runs HKDF and AES-GCM. It checks the `secret-response/v1|nonce|purpose` context against the request (`installer/unseal-helper/internal/unseal/unseal.go:63-197`). The key reaches cryptsetup through a pipe (`boot-stage.sh:443`) and is then shredded (:445). **Minor local exposure:** the STK seed is passed on argv (`--identity-priv-hex`, `boot-stage.sh:251`).
13. **Auto-unlock lease.** After an approval, the phone builds `auto-unlock-lease/v2`: the disk key sealed to the STK, signed by the IRK (`P/phoneEndpoint.ts:350-435`). The Worker checks that `stkPub` matches the directory and stores the ciphertext (`routes.ts:169-257`). **The key that opens a lease is the plaintext STK on `/boot`.** Anyone holding the stored lease and the disk can unlock it, as N10 states.

**Historical paths still in code**

- A plaintext lease-v1 table and class (`unlock_key_hex`) still exist (`packages/storage/src/types.ts:820-827`, `d1.ts:1169-1274`). Production code only lists or revokes rows in it (`CP/accountDeletion.ts:153-158` and others), and migration 0098 deleted every row.
- The `ConsumeUnlockKey` envelope (`P/unlock.ts:37-79`) has no callers.
- Stale comments in `userdata.ts:52,1401` still mention a plaintext fallback [doc].

### 3.2 OQ-01 verdict

**No plaintext disk-unlock material reaches `.com` or the boot Worker on any production path in this source.**

- They store or relay only ciphertext: the install deposit sealed to the IRK, leases sealed to the STK, and responses sealed to the STK and bound to a nonce.
- They hold no key that opens any of it (`routes.ts:169-257,360-400,631-695`; `CP/luksKeys.ts:30-126`).
- No request-body logging was found in `apps/boot`, `packages/boot-core` or the `.com` routes (grep).

Confidence: high for **passive** disclosure on the paths traced.

The verdict does **not** mean `.com` cannot obtain the key. These qualifications belong in the plan's OQ-01 row:

1. **Active substitution.** `.com` is the only source of the STK that phones seal to. iOS takes it from `/pods` (`SecretMailboxClient.swift:764-769`), and the webapp does the same (`bootApproval.js:264-281`). The owner path has no client-side STK pin; only the share path pins it (`ServerShareFlows.swift:861`, `serverShares.js:995-1016`). A hostile or impersonated `.com` that swaps a server's STK and gets one approval tap receives the disk key in the reply and in the auto-lease. The checker shows this as `chan.com-webpki → svc.com-directory → env.unlock-response`.
2. **Harvest-now-decrypt-later.** The install deposit is public ciphertext sealed to the public IRK with classical X25519. A future quantum attacker who downloaded it recovers every disk key.
3. **Demo accounts.** `.com` derives demo UMKs and IRKs from `DEMO_IRK_KEK` (`CP/demoIdentity.ts:36-42`, `demoAccountProvisioning.ts:102-105`) and writes the demo IRK into demo cloud-init (`CP/demoCloudConfig.ts:306-326`). `.com` can therefore open a `sealed-luks-key` for any box created under a demo account, including the store-review account.
4. **Code delivery.** The webapp holds the UMK in browser JavaScript served by the same operator. This is a trust assumption rather than a data flow.
5. **Physical access** (outside the cloud question, but it bounds what "ciphertext-only" buys): a copy of `/boot` holds the STK in plaintext and opens every lease and response. The initramfs and unseal helper are unmeasured (no Secure Boot, UKI or TPM code exists in the repo). VM-appliance boxes share a volume key per image (§3.1 step 7).

### 3.3 Restore

**Backups.** A random content key wraps both backup files. Its slots are an Argon2id passcode (m=64 MiB, t=3, p=4) and an account slot under HKDF(UMK, `flagship/server-archive/v1|id`) (`P/serverBackup.ts:23-59`, `P/keys.ts:141`). All of it is symmetric.

**How keys reach the box.**

- The content key goes **app → box directly**, inside box-terminated TLS (`D/serverArchive/service.ts:5-29` [doc]; `restore.ts:123,215`).
- The scheduled-backup KEK pool is admin-signed (`P/archiveKeys.ts:57-77`) and posted to the **box**, not `.com` (`apps/web/public/webapp/lib/savedBackups.js:53-65`). The box wraps the account slot and wipes the KEK (`service.ts:855-861`). The pool itself is kept on disk in plaintext (§1.4).
- **Peer backup:** PBK = HKDF(SWK, `flagship/peer-backup-key/v1`). `.com` stores the sealed root, which anyone can read, and the browser opens it locally. `from-peers` sends the PBK to a box (`apps/web/public/webapp/lib/peerBackup.js:18-95`). `.com` issues blind-RSA space tokens (`CP/peerBackupNetwork.ts:1-35`).
- **Cloud recovery:** `.com` stores the wrapped UMK (and optionally the admin root and ACME key). The wrap is AES-GCM under HKDF of the passkey PRF output (`apps/web/public/recovery/recoveryWrap.js:28-85`). Release is gated on a fetch-token hash derived from the passphrase. The record is IRK-signed v2 (`P/recoveryRecord.ts:33-108`). `.com` does not verify the passkey (`CP/recoveryProof.ts:20-22`).

**Verdict.** `.com` stores only ciphertext and holds no key to it. Confidence: medium-high.

**Not traced:**

- the Migrate box-to-box pull;
- the native ports of saved backups;
- the CTAP2 link to roaming authenticators, which uses a P-256 key exchange.

The UMK escrow is as strong as PRF secrecy, and synced passkeys depend on vendor key-sync fabrics.

### 3.4 Share-unlock

1. The co-manager derives a per-share Ed25519 member key from its own UMK (`P/serverShare.ts:69-80`). A 6-digit code over shareId, memberPub and a secret anchors that key (:122-126).
2. The owner's device opens the IRK-sealed deposit and **re-seals the disk key to the member key**. It signs `server-share-unlock/v1` over the copy's SHA-256 (`apps/web/public/webapp/lib/serverShares.js:417-448`). `.com` checks the hash and stores the copy (`CP/serverShares.ts:233-250`).
3. At boot, the member device lists pending requests and fetches its copy as the `share` principal (`packages/boot-core/src/gate.ts:214-222`, `routes.ts:711-751`). It opens the copy and re-seals to the STK **pinned in the owner's offer** (`serverShares.js:995-1016`).

**Verdict.** No cloud component sees plaintext. Confidence: medium-high; the iOS and Android ports were read only for the pin. This path is better anchored than the owner path because the STK is pinned.

### 3.5 Update

- **Owner order.** `server-update/v1` is signed by the admin root, or by the IRK when none is pinned. The box re-verifies it and checks `fromCommit`, the nonce and freshness (`D/updateConsumer.ts:438-462`).
- **Code authority.** The box downloads the artifact from `https://flagshipserver.com/build/iso` and verifies it with `verify-box-artifact.sh`. That script checks Ed25519 k-of-n with `openssl pkeyutl -verify`, plus the SHA-256 digest, architecture and Node floor (`D/artifactUpdate.ts:109-155`, `installer/verify-box-artifact.sh:82-120`, `P/boxArtifact.ts:151-190`).
- **Trust anchor: threshold 1, one key** (`release/box-artifact-trust.json:4-5`, `P/boxReleaseConfig.ts:8-13`). It is the same key that holds the CA-track mandate and signs git endorsements and security notices.
- **Anti-rollback:** a persisted sequence number (`installer/install-box-artifact.sh:48-61,119-121`).
- **First-boot update** needs only the release signature (`D/firstBootUpdate.ts:63-91`).
- `buildMaintainersReleaseGate` is imported (`D/index.ts:310`) but never called, while a comment still describes it as the gate (`D/index.ts:4221-4230`).

**Verdict.** No unlock or secret material moves during an update. The update never refreshes `/boot/flagship-unseal`, so boot-path code is frozen at install. That has security consequences for BO01.

---

## 4. Plan §2 migration seams against `release/0.3`

| §2 row | Still accurate? | What the plan should say now |
|---|---|---|
| Boot | Partly | `apps/boot` and `boot-core` are as described, but the **production boot routes run inside the `.com` Worker** (`apps/com/src/route.ts:640`, `bootInProcess.ts`), so "separate Worker" is a deployment option, not the current trust split. Suspension is no longer future work: `boot-suspension/v1` with owner/STK roles, epochs and lease revocation is live in `routes.ts:260-345` (migration 0107). The architecture adds freshness and the reviewed protocol versions on top of it |
| Early unlock | Yes, plus a gap the plan omits | Files unchanged. The plan should name **`/boot/identity.pem`**, the plaintext STK the initramfs uses (`userdata.ts:705,1661`). It sits outside keyd and is rewritten on rotation. BO01 and K02 must decide its fate. Also name the `/boot/flagship-unseal` freeze (it is never updated) and the argv seed exposure (`boot-stage.sh:251`) |
| Key custody | **No** | The current starting point is the **TS `flagship-keyd`** (`packages/keyd`, separate user, purpose-allowlisted `sign`, opaque stand-ins `P/opaqueKey.ts`) plus the `KeydCustodian` adapter. `keyCustodian.ts` is now the **in-process fallback** used when keyd is absent (`D/index.ts:677-692`). K01 is a Rust re-implementation of an existing contract, not its introduction. The work items become: close `unseal`, `swk.hkdf`, `deriveServiceSecret` and first-writer `provision.*` (§1.2); add peer credentials; remove the fallback; move gossip and access-sync onto keyd (§1.4); and reconcile the 8 tags keyd refuses (§1.3) |
| TLS | **No** | Keyd mode already has opaque TLS: a P-256 leaf and CSR in keyd (`K/tls.ts`), ACME JWS by request kind (`K/acme.ts`), and the **Go `flagship-tlsd`** frontend as `crypto.Signer` (`installer/tls-frontend/main.go`), handing off to the daemon over a Unix socket. The files the plan lists (`certManager`, `letsEncryptIssuer`, `persistentStore`) are the legacy path, used only when tlsd is absent. Restrictions of keyd mode: http/1.1 only (`main.go:82`), DNS-01 only (TLS-ALPN-01 is off), tier-2 shared certificates do not work, and `go 1.22`, so no hybrid key exchange by default. I01 replaces the Go frontend. It does not introduce isolation |
| Runtime | Partly | Still Docker CLI orchestration from a root daemon. A **TS `privd` broker exists, but nothing calls it** (§2). B01's starting point is privd's closed operation set and the coverage gap listed in §2, not a blank broker |
| Sandboxing | Yes | gVisor `20260921.0` as described (`D/appSandbox/gvisor.ts:23`). A migration sandbox under runsc was added (`D/migrationSandbox.ts`) |
| App packaging | Partly | Add `P/manifestCapabilities.ts` (a capability diff in update alerts), `P/appRelease.ts` + `D/publisherPins.ts` (N11 publisher signatures and a first-use pin; the box signs these with its STK, which keyd refuses: §1.3), and adapter attestation (`P/adapterAttestation.ts`, `D/buildmodes/adapterTrust.ts`) |
| Storage | Partly | Add `D/managementReserve.ts` (N13 reserve), bounded archive reads (`D/serverArchive/limits.ts`), and `D/authority/` (N05 grant index and operation ledger, N07 freshness and leader lease). That state already lives outside app data, which is the separation the row asks for |
| Transport | Yes | Wire unchanged (`packages/tunnel-protocol`). The relay is TS in `apps/web/src/tunnel`. Relay trust enforcement is still off by default (`D/relayLockdown.ts:8`) |
| Updates | **No** | The current model is a **signed offline box artifact**: k-of-n Ed25519 (k=1 today), offline verifier and installer, a symlink flip, rollback to a release already on disk, no git, npm or compiler on the box (`P/boxArtifact.ts`, `installer/{verify,install,rollback}-box-artifact.sh`, `D/artifactUpdate.ts`). `selfUpdateReleaseGate.ts` and the maintainer release gate are no longer what applies code (§3.5). U01 starts from this artifact. The plan's "release scripts" wording should name it |
| AI | Partly | Add the N02 address classifier (`P/addressPolicy.ts`), the provider redirect guard (`packages/llm-providers/src/baseUrlGuard.ts`) and the egress policy (`D/egress/policy.ts`) |

**Additions §2 should list as their own rows.**

- **Authority core:** `D/authority/*`, `D/centralAuthorization.ts`, `D/controlHttp.ts`. These are the N01, N05 and N07 implementations R02 must adopt, not duplicate (§4.3, single writer).
- **Chat:** `D/chat/*`.
- **Rust:** `rust/` now exists as an empty A04 skeleton: 11 crates, each `lib.rs` one line. §4.1's "proposed path, not present code" is out of date.
- **No PQ code anywhere.** The only ML-KEM and ML-DSA mentions are the `flagship-crypto` crate description (`rust/crates/flagship-crypto/src/lib.rs:1`).
- **No TPM, UKI or Secure Boot code anywhere.**

**Corrections to §2 "Important qualifications".**

- Qualification 1 should state the §3.2 qualifications: active STK substitution, public classical ciphertext, demo accounts, code delivery.
- Qualification 2 should name `/boot/identity.pem` as the private decryption key that makes a copied lease usable. It should also add the shared VM-appliance volume key, which slot removal does not fix.

---

## 5. Cryptographic dependency graph result

**Graph contents.** `crypto-graph.json` has 88 nodes, 101 edges and 16 strict targets.

- Every node carries algorithms, location, `pq` status, an owner placeholder and `path:line` evidence. `node scripts/crypto-graph-check.mjs --check-evidence --schema-only` verifies that every cited line exists.
- Edges read "controlling A lets you <type> B".
- `gate: "all"` nodes need every group of incoming edges. For example, an owner-ordered update needs both a maintainer group and an owner group.
- Demo-account edges are marked `profile: "compatibility"` and are excluded from strict evaluation.

**Not modelled:**

- Physical access, firmware and TPM. No code exists for these, so Q06 must add the nodes.
- Bearer and HMAC secrets. These do not fall to a quantum break, but they are single points of compromise.

**Checker result.** `node scripts/crypto-graph-check.mjs` reports that **all 16 strict targets are reachable** when every classical public-key primitive is broken, and exits 1. That is the expected, honest result at this commit, because no PQ primitive exists in the repo.

**The ten bypasses I would close first**, by impact (the checker's own "top" list sorts by path length):

1. `env.luks-deposit → data.disk-key → data.disk-plaintext`. A publicly downloadable X25519 ciphertext of every box's disk key. Harvest-now-decrypt-later (HNDL).
2. `env.device-pairing → key.umk`. The UMK crosses `.com`'s `/qr-pipe` under ephemeral X25519 plus a SAS. HNDL on the account root, which reaches every SWK, backup and app secret.
3. `chan.box-tls → data.box-session`. Box TLS is ECDHE with a P-256 certificate, and `go 1.22` means no hybrid key exchange by default (inf).
4. `chan.com-webpki → svc.com-directory → env.unlock-response → data.disk-key`. A forged `.com` TLS or directory makes phones seal unlock replies to an attacker's key.
5. `key.maintainer → art.box-artifact → exe.daemon → eff.box-code`. A single Ed25519 key, threshold 1, runs root code on every box. The first-boot update needs nothing else.
6. `key.irk` / `key.admin-root → eff.recovery`, `eff.device-enroll`. Every enrollment, recovery and veto rests on Ed25519.
7. `key.admin-root → eff.debug-root → eff.box-code`. An admin-signed debug grant yields SSH with passwordless sudo.
8. `key.ios-se-wrap → key.umk` (P-256 Secure Enclave wrap) and `store.icloud-keychain`/`store.android-blockstore`. The vendor sync fabrics carry the wrapped UMK.
9. `key.stk → env.swk-delivery → key.swk → data.app-secrets` and `key.stk → env.auto-unlock-lease`. Every SWK and CGK deposit and every lease is X25519-sealed to the STK.
10. `env.d1-backup → data.com-db` (age/X25519 backups of the whole directory) and `chan.fly-tls → eff.relay-route` (unpinned hub TLS; relay blessing is observe-only).

Run `node scripts/crypto-graph-check.mjs --json` for every path.

---

## 6. Not verified and still open

- **The A01 completion evidence ("synthetic trace proves no cloud plaintext") is not done.** It needs a disposable box and a gym `.com` with recorded traffic, which this brief excluded.
- Not read end to end:
  - the Swift and C# Studio preseed ports, beyond the shared `preseed-engine.js` bundle;
  - the iOS and Android share and backup flows, beyond the cited pins;
  - the Migrate data path;
  - `installer/data-services/init.sh` and the full `install-box-artifact.sh`;
  - who calls `buildReleaseCatalog`;
  - whether privd's `BUILD_CONTEXT_RE` covers the daemon's real build-context paths.
- **Runtime behaviour is not verified.** Every "(inf: throws/breaks under keyd)" item above needs a run on a keyd box. Those are the app-release tag, the pb-* tags, the stable-id reissuer, CGK-disabled gossip, keyd migration after rotation, and tier-2 certificates.
- **Deployment facts are not knowable from source:** Cloudflare edge TLS posture, production D1 contents (whether `auto_unlock_leases` is empty), and which demo accounts hold real encrypted boxes.
- **Callers have no named owners.** Owner columns in the graph and register are placeholders until A03 and kickoff.
