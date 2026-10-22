# Flagship security-hardening plan

**Date:** 2026-10-22

**Audience:** Flagship engineering, security, release, mobile, and operations

**Status:** Engineering directive for review; verified stop-ship findings are
listed below, but no implementation is implied by this document

**Primary objective:** Prevent a creator, companion session, anonymous adapter,
dependency, network attacker, physical attacker, or compromised daemon
component from crossing its intended authority boundary. In particular, none
may obtain host root, silently deploy code, bypass a phone/admin decision,
extract or replace a long-lived key, or defeat a phone-triggered lock. TLS must
continue to terminate on the user's hardware, and the phone must remain the
authority for ownership and sensitive changes.

This plan turns the product intent into enforceable engineering boundaries. It
does not attempt to eliminate every dependency or implement cryptography from
scratch. “Trust Flagship” means that Flagship defines and enforces the security
policy and that third-party code receives only the minimum capability it needs.
The unavoidable trusted base—hardware, firmware, kernel, and selected crypto/TLS
implementations—must be small, explicit, pinned, updateable, and auditable.

## 1. Executive instruction

The first work is emergency containment, not `flagship-keyd`. Freeze the paths
that currently turn lower-trust input into host-root execution or owner-level
mutation:

1. disable cross-creator automatic updates and every cross-creator migration;
   reject all creator-supplied JavaScript/TypeScript host migrations until a
   dedicated unprivileged migration sandbox exists;
2. deny companion sessions at `/api/build/*` and `/api/llm/sessions*`, revoke
   active companion sessions, and centralize session capabilities;
3. stop automatically consuming community adapters until every adapter is
   subject to a mandatory non-LLM trust gate and owner-visible quarantine;
4. stop producing Node 20 boxes, replace `curl | bash` with a pinned offline
   Node 24.22.1-or-later LTS artifact, and publish an endorsed fleet update;
5. make manual lock and dead-man lock create durable boot-worker denial state
   that a person holding only the box/STK cannot clear;
6. require an exact signed artifact digest and commit, never a mutable branch
   or tag, on every install path; and
7. disable the app-facing browser feature or clear its profile between uses
   until per-app contexts and continuous navigation enforcement are live.

These mitigations deliberately remove or narrow functionality. Re-enable a
path only after its negative tests and ship gate in this plan pass. Do not use
an LLM judgment, a regex, an unencrypted marker, TLS alone, or a UI label such
as “read-only” as a security boundary.

Build a host-owned key-custody boundary and move all durable secret-key
operations behind it. Generate keys on the user's device. Do not pass raw
private keys to ACME libraries, app containers, the general server daemon, the
control plane, or sibling boxes. Dependencies may receive public keys,
certificates, CSRs, and tightly scoped signing/decryption results only.

At the same time, stop constructing production box software from mutable
internet inputs. A box must install and update from a signed, hash-pinned,
reproducible artifact that already contains its runtime dependencies. It must
not run `curl | bash`, `npm install`, lifecycle scripts, or a compiler as part of
a production install or update.

These are two halves of one defense:

1. capability isolation limits what a malicious dependency can steal or do;
2. artifact verification reduces the chance that malicious code reaches the
   box at all.

Version pinning alone is not the solution. Pin security-critical inputs exactly
and verify their hashes, but keep a deliberate, reviewed update process so
known vulnerabilities do not remain frozen forever.

### 1.1 Priority and release decision

| Priority | Meaning | Current items |
|---|---|---|
| **P0 / stop-ship** | Disable or fix before another public box image, third-party app install, or Remote session | Root migration execution; companion build/deploy; Node 20 and `curl \| bash`; mutable install ref; ineffective lock/dead-man denial; browser cross-origin/profile escape; macOS root-helper caller/path/device validation |
| **P1 / pre-GA** | Must pass before claiming the affected feature is secure | Anonymous/community adapter trust; re-pair step-up decision; signed artifact/provenance; Secure Boot/measured boot for physical-theft claims; daemon privilege separation |
| **P2 / defense in depth** | Important, scheduled work after the immediate boundary is closed | Out-of-process key custody, TPM non-exportability, CT monitoring, reproducible builds, threshold release signing, advanced recovery drills |

“Feature not launched” reduces exposure; it does not reduce the severity of a
reachable code path. Operations must establish whether cross-creator apps,
community adapters, companion sessions, or Node 20 boxes exist in production.
If they do, treat containment as incident response: preserve privacy-safe
evidence, revoke affected sessions/keys, notify owners when action is required,
and do not wait for the architectural redesign.

## 2. Non-negotiable security invariants

The following statements become release gates, not aspirations.

1. **Phone authority:** Account ownership, server enrollment, key replacement,
   destructive operations, and release installation continue to require the
   appropriate phone/admin signature. `.com`, `.services`, a CA, and a package
   dependency are not ownership authorities.
2. **Local generation:** The box identity key and every box-local TLS key are
   generated on the destination box. Private bytes are never generated by or
   uploaded to Flagship infrastructure.
3. **No raw-key APIs:** Production interfaces expose opaque handles and
   purpose-specific operations. There is no `getPrivateKey`, `privateKeyPem`,
   generic “sign these arbitrary bytes,” or export endpoint across a process or
   network boundary.
4. **Separation of keys:** Box identity, boot/unlock, workload/data, gossip,
   ACME-account, TLS leaf, custom-domain, and ephemeral challenge keys are
   distinct. Compromise of one does not grant the powers of another.
5. **Key use is policy-bound:** Every signing/decryption request has a versioned
   purpose tag, typed fields, caller identity, replay protection where
   applicable, and an allowlisted operation. The custodian must construct or
   validate canonical bytes itself; callers cannot turn it into an arbitrary
   signing oracle.
6. **Services cannot reach host keys:** App containers, AI/build processes, and
   service code have neither filesystem nor IPC access to the custodian.
7. **CA is not identity:** Let's Encrypt/WebPKI proves hostname control to a
   browser. Native Flagship clients authenticate the box by its phone-known STK
   and hard-fail a mismatched STK-signed certificate pin.
8. **Signed immutable updates:** Production boxes execute only an endorsed
   release artifact whose source commit, dependency lock, artifact digest, and
   provenance are bound by the endorsement. Installation performs no dependency
   resolution.
9. **No silent downgrade:** Missing TPM/hardware isolation, a missing native
   certificate pin, expired security metadata, or a failed update verification
   cannot silently fall back to a weaker mode. The product may support an
   explicitly labelled software-isolated profile, but the mode and limitations
   must be visible.
10. **Friendly URLs are locators, not identities:** `voi.ci/<slug>` and custom
    names never become authentication or authorization roots. Reassignment of a
    human slug cannot transfer sessions, grants, invites, or service identity.
11. **Untrusted code never runs as host root:** Creator code, migrations,
   adapters, app build hooks, AI output, and app SQL execute only inside the
   app's least-privileged sandbox with its own data authority. The host daemon
   does not spawn them as its own user.
12. **Session type is enforced server-side:** Every authenticated daemon route
   declares the capabilities it accepts. A companion token can read explicitly
   allowlisted views and submit an owner-approval request; it cannot build,
   mint keys, deploy, change state, or reach a route merely because that route
   checks only for “some paired session.”
13. **Untrusted contributions are inert:** Anonymous/community adapters are
   suggestions, never automatically trusted programs. Hashing, regex checks,
   popularity, complaint counts, and model review do not authorize execution.
14. **A lock survives possession of the box:** A lock/dead-man event creates a
   durable server-side suspension that the boot service enforces before
   releasing any lease. A party holding the box or STK may set/refresh a
   suspension but only an owner/admin authority may clear it.
15. **Boot measurements authorize unlock:** “Approve” mode does not release a
   disk key solely because a box asked. On hardware-isolated systems, the phone
   verifies a fresh quote for an approved boot state; Secure Boot and measured
   boot cover the kernel, initramfs, command line, and early-unlock code.
16. **One app, one browser principal:** Apps do not share cookies, storage,
   cache, service workers, client certificates, or tabs. Every top-level,
   redirect, popup, subframe, download, and protocol transition is constrained
   continuously to the approved policy.
17. **Privileged helpers choose their own safe objects:** A root helper accepts
   a pinned designated client and opaque operation identifiers, not arbitrary
   filesystem/device paths. It opens validated objects once, without following
   symlinks, and re-validates the physical target immediately before mutation.

## 3. Current state and confirmed gaps

The repository already contains useful security work. Preserve and extend it:

- `packages/server-daemon/src/keyCustodian.ts` centralizes STK, SWK, and CGK
  operations and intentionally exposes narrow interfaces. Its own documentation
  correctly states that it is only an **in-process** boundary.
- iOS and Android have STK-signed leaf-certificate pin registries and hard-fail
  logic. The default behavior when no pin is known still needs to be classified
  and constrained for privileged operations.
- Box updates require a phone/admin order plus a maintainer endorsement, and
  have a health-gated rollback path.
- TLS terminates on the user's box and `.services` remains an SNI/byte relay.
- Disk encryption, signed protocol messages, routing-control keys, release
  endorsements, and native-client certificate-pin checks provide valuable
  layers that should remain.

The following gaps are confirmed in the current tree and must be treated as
real, not theoretical:

### 3.1 TLS and ACME key exposure

- `packages/server-daemon/src/acme/letsEncryptIssuer.ts` calls
  `acme.crypto.createCsr(...)`; `acme-client` therefore creates and directly
  handles the TLS leaf private key, returning it as PEM.
- The same ACME client receives the raw ACME account PEM.
- `packages/server-daemon/src/certManager.ts` passes private-key PEM to Node's
  `createSecureContext`, so the general daemon and its TLS implementation hold
  exportable key material.
- `packages/server-daemon/src/acme/persistentStore.ts` stores the ACME account
  key and certificate keys as plaintext PEM files, relying on LUKS for disk-at-
  rest protection.
- `packages/server-daemon/src/acme/customDomainCert.ts` serializes and sends a
  custom-domain certificate **and its private key** to sibling boxes. This is
  incompatible with a strict non-exportable-key promise.

### 3.2 Box identity exposure

- The STK exists as raw hex, PKCS#8 PEM, process environment, and in-process
  bytes. Current paths include `/var/flagship/identity/identity.priv.hex`,
  `/boot/identity.pem`, `/etc/flagship/daemon.env`, and bootstrap environment
  files.
- Early boot uses OpenSSL with `/boot/identity.pem`. On machines without a TPM
  or other hardware keystore, unattended pre-LUKS authentication necessarily
  leaves a secret available before the encrypted volume is open. This is a
  physical-theft limitation and must be explicit.
- Several older code paths still accept full `Keypair` values even though the
  `KeyCustodian` seam exists. The migration to narrow capabilities is not
  complete.

### 3.3 Installation and update supply chain

- The non-appliance install path runs a live NodeSource setup script, installs
  packages from current apt repositories, clones source, and runs `npm install`
  on the destination box before generating/using durable keys.
- The self-update path runs `npm ci` and falls back to `npm install`. This can
  resolve/build code on the user's trusted host after endorsement rather than
  installing the exact reviewed artifact.
- Security-critical direct dependencies still use semver ranges, including
  `acme-client` and X.509 packages. The lockfile narrows ordinary `npm ci`, but
  the manifests and `npm install` fallback leave avoidable ambiguity.
- A source-commit endorsement alone does not prove which dependency tarballs,
  compiler, base image, or generated output the box executed.

### 3.4 Web and naming limitations

- Native pinning can make WebPKI secondary, but a normal browser cannot use the
  Flagship STK pin. Browser access therefore has a different assurance level.
- A recycled `voi.ci/<slug>` can send an old bookmark to a new owner. That is
  acceptable only if the slug is explicitly a mutable marketing locator and
  never carries identity or authorization semantics.
- Custom domains and shared service certificates must not ship with private-key
  replication if Flagship claims host-local/non-exportable custody.

### 3.5 Creator-controlled updates execute outside the app sandbox — P0

- A cross-creator install defaults its pull state to `updatePolicy: "auto"` in
  `packages/server-daemon/src/servicePlatform.ts`.
- `packages/server-daemon/src/updateClient.ts` passes new migration files to
  `runMigration`; `packages/server-daemon/src/runMigration.ts` invokes `.ts`
  with `tsx`, `.js` with `node`, and `.sql` with host `psql`.
- The production daemon systemd unit does not set `User=`, so those child
  processes inherit host root. JavaScript migrations also inherit most of the
  root daemon's environment and can read or change the host outside the app
  container. SQL is limited primarily by the app database role, but `psql`
  still runs in the root host process context and exposes another parser/client
  to untrusted input.

If any third-party subscription can reach this path, a creator can gain root on
every subscriber box by publishing a migration. This is not made safe by the
creator's app being containerized after migration. Disable the path now; §10.1
defines the replacement.

### 3.6 Companion “read-only” authorization is route-local and incomplete — P0

- Companion sessions are four-hour bearer sessions recorded in the same
  `FilePairedSessionStore` used for owner sessions, with a companion flag.
- `/api/screens/*` and several newer handlers explicitly call
  `denyCompanionWrite`, but `buildBuildModesHttpHandlers` and
  `buildVibeCodeHttpHandlers` only call the generic paired-session gate.
- A companion can therefore create git/MCP/AI sessions, receive or replace
  build credentials, mint MCP keys, adapt code, and deploy/replace apps through
  `/api/build/*` and `/api/llm/sessions*` despite the product's read-only claim.

This is an authorization bypass with code-deployment impact. Patch the direct
handlers and then replace scattered checks with the default-deny capability
model in §10.2. Revoke all live companion sessions when the fix deploys.

### 3.7 Anonymous community adapters cross a trust boundary automatically — P0/P1

- `/api/adapters/submit` intentionally accepts anonymous submissions.
- Deterministic rules verify shape, source fit, license, paths, obvious secrets,
  and server addresses, but they cannot establish benign behavior.
- `ADAPTER_REVIEW_ANTHROPIC_KEY` is optional. When absent, rule-passing adapters
  are stored as `review = "rules"` and the publisher may publish them. A model
  review, even when configured, is probabilistic and prompt-injectable and is
  not an authorization authority.
- Boxes fetch a mutable public Git branch, verify that each body hashes to its
  filename, then automatically apply a candidate that fits. Content addressing
  detects accidental substitution of that file, but control of the index can
  point a box at a different malicious, correctly hashed file.

An adapter can change build inputs and app behavior on another owner's box. The
app container limits host impact only if every build, migration, browser, data,
and egress boundary also holds. Stop automatic community consumption until the
signed, quarantined design in §10.3 exists. Repo-authored adapters pinned to the
repo's reviewed commit are a distinct, narrower trust case.

### 3.8 Re-pair treats possession of the current IRK as step-up — P1 decision

`packages/control-plane/src/rePair.ts` accepts `oldIrkSignature` as a complete
recovery credential and skips TOTP/recovery proof. The comment calls the
registered key something an attacker “provably cannot hold”; theft of a key
file, unlocked device, browser storage, or compromised endpoint disproves that
assumption. The current code does **not** skip every protection: it still waits
the account-type grace period and stamps the 14-day quarantine at completion.
The verified gap is the missing independent factor/admin-root requirement for
an account-root rotation.

Adopt the §10.6 step-up policy explicitly. Do not silently remove the
registered-key recovery route without proving that a legitimate single-device
owner still has a safe recovery ceremony.

### 3.9 The macOS root helper accepts unsafe authority and objects — P0

- `FlagshipBuilderHelper` pins `identifier "com.flagshipserver.Builder" and
  anchor apple generic`, but not Flagship's Team ID/designated requirement. A
  different Apple-signed developer can claim the bundle identifier in a
  separately distributed app.
- `imagePath` need only exist, `devicePath` need only start with `/dev/disk`,
  and `logPath` is created/truncated as root. There is no symlink defense,
  ownership/type check, approved staging root, whole/removable/external-disk
  verification, root/boot-disk exclusion, stable-device check, or TOCTOU-safe
  open-file workflow.

A caller that reaches the helper can read an arbitrary image as root, truncate
an arbitrary log target, or overwrite an internal disk. Apply §10.5 before the
next macOS Studio release.

### 3.10 Lock/dead-man state is removable while the lease survives — P0

`BootUnlockModeSuppressor` writes `/boot/flagship-lock-once`; early boot trusts
that marker and deletes it after one approved unlock. `/boot` is unencrypted and
not authenticated. Neither iOS nor Android's manual lock flow revokes the
owner-signed boot lease, and a dead-man event cannot do so because the box lacks
the owner key. A thief can remove the marker and reuse the still-active sealed
auto-unlock lease. That defeats the stated border-control/physical-seizure use
case.

The durable suspension and dead-man/lease coupling in §5.5 are required. A
local marker may remain as a convenience/defense-in-depth signal, but it is not
the lock.

### 3.11 Runtime/bootstrap and mutable install inputs — P0

- Production bootstrap paths install Node through
  `curl https://deb.nodesource.com/setup_20.x | bash` as root and then install
  from the repository the script adds.
- Node 20 reached end of life on 2026-03-24. The official 2026-10-21 Node
  22.23.4 and 24.22.1 security releases update the built-in root set and reject
  chains containing blocked public keys; Node 20 will not receive those fixes.
  Treat outbound TLS from Node 20 boxes as unsafe until the runtime is replaced,
  especially calls carrying LLM API keys or install/update material.
- The phone-signed recipe permits `installerGitRef = "main"` and other mutable
  branches/tags. Signing a name prevents the network from changing the string;
  it does not prevent the repository holder or a compromised fetch path from
  changing what the name resolves to.
- The generalized appliance builder can accept an exact `gitCommit`, which is a
  useful partial control, and Studio verifies a downloaded appliance's SHA-256
  against its adjacent manifest. The recipe itself still binds only the ref,
  not the commit, appliance digest, or provenance.

Move directly to the artifact design in §8. Do not “fix” `curl | bash` by only
switching NodeSource to Node 24 or by only choosing the Debian system CA store.

### 3.12 App browser grants can escape their allowlist and share identity — P0

- `DomainGate.check` runs for `openTab` and explicit `navigate`, not for
  redirects, link clicks, popups, form submissions, script navigation,
  subframes, downloads, or the current URL before `fill`, `click`, `dom`,
  screenshot, and input operations.
- `TabRegistry` explicitly describes one Chromium cookie jar shared across all
  apps. Tab ownership is not an origin, cookie, storage, service-worker, cache,
  or credential boundary.
- Screenshot references are not bound to the requesting app in
  `getScreenshot`; any browser-entitled app that obtains a reference can fetch
  it. `request-input` accepts a caller-supplied `host`, so an app can mislabel
  the origin shown to the phone unless the phone/daemon independently derives
  it from the live frame.

An app permitted on one site can follow an off-list navigation and read or
capture another signed-in site. Disable app browser grants until §10.4 passes;
clearing the current shared profile is part of containment because cookies may
already cross app boundaries.

### 3.13 A raw SWK can ride outside the signed install blob — P1

The default online path can deliver the SWK after registration in an
owner-signed envelope sealed to the box STK, which is the preferred design.
However, Builder still accepts a top-level `swkHex` recipe sibling and
`swkHexFromInstallBlob` persists any well-formed 32-byte value without an inner
owner signature or binding to the signed server/recipe. Unlike `pairingOrder`
and `debugGrant`, whose payloads carry their own signatures and are verified by
their consumers, the embedded SWK has only shape validation.

Remove raw `swkHex` from all ordinary production recipes. If an explicit
offline/advanced self-build mode must carry it, wrap it in an owner/admin-signed
typed carrier bound to server domain, recipe digest, SWK hash, purpose,
generation, and expiry; verify before persistence and label that mode as
secret-bearing. Prefer local phone-to-box delivery after the new STK is known.
Do the same inventory for every top-level recipe sibling: an unsigned outer
carrier is acceptable only when its inner object is independently signed,
purpose-bound, fresh, and checked against the signed recipe.

## 4. Threat model and honest guarantees

Engineer and test against these attackers:

| Attacker | Required result |
|---|---|
| Malicious/compromised app creator | May update only that app inside its sandbox; cannot execute host code, expand capabilities, read sibling/host data, or migrate outside its app-scoped data authority |
| Stolen companion/Remote token | Can see only the explicitly approved read model until expiry; cannot mint credentials, build/deploy code, mutate state, or turn a read into a write without a fresh owner approval |
| Anonymous adapter submitter or compromised adapter index | Cannot cause code to execute automatically; unsigned/unreviewed input remains an inert suggestion and index compromise is detected by signed metadata/rollback protection |
| Malicious service/app container | Cannot read host keys, call key IPC, escape to the host, or impersonate another service |
| Compromised ACME/X.509 dependency | Cannot obtain STK or TLS private bytes; cannot sign outside a single validated issuance/revocation job |
| Compromised general daemon component | Cannot export keys; can request only its allowlisted, rate-limited operations |
| Compromised npm/apt/GitHub upstream | Cannot change an already endorsed artifact undetected; is absent from install-time resolution |
| Compromised `.com` or `.services` | Cannot decrypt user traffic or replace the native-client box identity; can deny service and can affect DNS/routing, which must be detectable and recoverable |
| Rogue or compromised public CA | Native clients reject the wrong leaf after a verified pin exists; browsers remain subject to WebPKI and CT/CAA mitigations |
| Stolen powered-off box | LUKS protects data; hardware-isolated mode does not expose an extractable pre-boot identity/unlock key |
| Evil-maid attacker with temporary physical access | Cannot replace early-boot code and later capture an owner-released disk key; an unapproved measurement blocks unlock and alerts the phone |
| Thief holding a locked box and its STK | Cannot clear a boot suspension or reuse a pre-lock auto-unlock lease; deleting or replacing `/boot` does not restore automatic unlock |
| Stolen running/root-compromised box | Immediate phone-triggered routing and STK revocation limits ongoing use; assume current plaintext and authorized key operations may be compromised |
| Malicious Apple-signed local app | Cannot connect to the Studio root helper; even the genuine client cannot name an internal disk or arbitrary path for the helper to mutate |
| CA/root-store or install-network compromise | Cannot alter the Node runtime, box artifact, source commit, or repository configuration that executes; sensitive application protocols retain signature/pin checks above TLS |
| Malicious Flagship release | Prevent with independent release review/signing, transparency, reproducibility, canaries, phone approval, and rollback—not with a key custodian alone |

Do not promise that a TPM makes a compromised running box harmless. A TPM can
prevent extraction and cloning, but malware may still ask an authorized key to
sign while the machine is in an allowed state. Measured boot and restrictive
key policy reduce that risk; release integrity remains essential.

Also do not claim that all third-party trust disappears. Use well-reviewed
cryptographic implementations rather than inventing crypto. The deliverable is
an enumerated trusted computing base and a system where replaceable protocol
libraries do not receive durable secrets.

## 5. Target key architecture

### 5.1 Introduce `flagship-keyd`

Move the current `KeyCustodian` contract behind a separate, minimal host
service. The existing TypeScript class becomes a compatibility adapter during
migration, then ceases to hold production keys.

`flagship-keyd` requirements:

- separate Unix user and process from the Node daemon;
- no network access (`AF_UNIX` only);
- a root-owned Unix socket inaccessible to app/container users;
- peer-credential checking on every connection;
- no shell, package manager, plugin loader, dynamic code, HTTP server, or
  general file-reading API;
- small versioned request protocol with strict size limits and canonical
  parsing;
- purpose-specific operations only, for example `SignBoxHello`,
  `OpenSealedToBox`, `DeriveServiceSecret`, `CreateTlsCsr`, and
  `TlsHandshakeSign`; never `Sign(bytes)` for untrusted callers;
- caller and operation allowlists, rate limits, replay rules, and a
  non-secret audit record containing operation, caller, key handle, result,
  and time—but never plaintext, private bytes, tokens, or full user data;
- secrets kept in mutable locked memory where supported, excluded from core
  dumps, zeroed on release, and never converted to immutable language strings;
- no swap of plaintext key pages; disable core dumps for all key-using units;
- explicit version negotiation that fails closed on an unsupported protocol.

Harden its systemd unit with the maximum compatible set of
`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=yes`,
`PrivateDevices` or an explicit TPM device allowlist, `PrivateTmp`,
`ProtectKernel*`, `ProtectControlGroups`, `RestrictNamespaces`,
`LockPersonality`, `MemoryDenyWriteExecute`, a minimal syscall filter, and a
minimal capability set. Add a test that verifies the effective unit properties
on the production appliance.

### 5.2 Define key classes and allowed movement

| Key | Generation and custody | Export policy | Rotation/recovery |
|---|---|---|---|
| Account/admin IRK | Phone secure storage | Never to box or cloud | Existing account recovery and admin-root rotation |
| Box identity STK | On box, through key custodian | Public half only | Phone-authorized replacement; old STK revoked before/at cutover |
| Boot/unlock key | Hardware-backed early-boot helper where available | Never export in hardware mode | Phone recovery path; short leases remain secondary controls |
| SWK | Provisioned sealed to the box; held by custodian | Derived, purpose-scoped operations only | Restore/replacement workflow, not general export |
| CGK | Provisioned sealed to the box; held by custodian | Gossip seal/open only | Existing account/fleet rotation |
| ACME account key | Prefer per-box generation in custodian; document any shared-account exception | ACME-JWS operations only | Rotate independently of TLS/STK; losing it must not lose service identity |
| TLS leaf key | Generated per box/domain generation in custodian | Never raw; CSR and opaque signer only | Routine renewal creates a new key; revoke old cert after safe cutover |
| TLS-ALPN challenge key | Ephemeral inside isolated issuance/TLS component | Destroy immediately after validation | Per challenge |
| Custom-domain key | Generated on the serving box | Never replicate as raw key | See §9.4 failover design |

If a high-volume Let's Encrypt agreement requires a shared ACME account, treat
that as a documented exception: distribute no PEM; provision an opaque
credential into each custodian or use a narrowly scoped signing service whose
compromise cannot expose TLS/STK keys. Do not conflate ACME-account ownership
with service identity.

### 5.3 Hardware and software profiles

Ship two explicit profiles if commodity hardware requires it:

- **Hardware-isolated:** TPM 2.0 or supported secure element. TLS P-256 keys
  should be non-exportable. Evaluate whether the current Ed25519 STK can be
  generated non-exportably on supported TPMs. If not, keep the wire protocol
  stable initially and TPM-seal the Ed25519 seed to measured/approved boot;
  record that the seed still enters `keyd` memory when used.
- **Software-isolated:** separate `keyd`, LUKS, filesystem permissions, process
  isolation, and no raw key outside `keyd`, but no claim of hardware
  non-exportability. Unattended pre-LUKS unlock without hardware protection is
  weaker and must be disclosed. Prefer phone approval on each boot or a
  user-held recovery device over silently storing an auto-unlock secret on
  unencrypted `/boot`.

For TPM mode, prototype `PolicyAuthorize` or an equivalent approach so approved
Flagship updates can advance measured-boot values without bricking machines.
Every PCR-policy change needs a phone recovery route and a tested power-loss
rollback. Do not make vendor remote attestation a mandatory identity service;
it adds a manufacturer trust/privacy dependency that is not needed for local
non-exportability.

### 5.4 Authenticated and measured boot

The hardware-isolated profile must boot a signed Unified Kernel Image or an
equivalent chain that covers the bootloader policy, kernel, initramfs, command
line, early network client, unseal helper, and the policy used to select them.
Enable Secure Boot with a controlled signing/rotation process and seal the
automatic-unlock capability to expected PCR policy. Firmware setup changes,
Secure Boot disablement, alternate media, rollback, and an unexpected UKI must
change measurements and block automatic release.

For phone-approved boot, bind the unlock response to a fresh phone nonce, the
box identity, the requested purpose, and an approved TPM quote/measurement
generation. The phone pins the box's local attestation identity during a
physical pairing; no vendor attestation lookup or stable hardware identifier
is sent to Flagship infrastructure. Show a distinct recovery ceremony when the
measurement changes—never a generic “approve” button that releases a key to
unknown early-boot code.

A post-boot hash of `/boot` is useful detection only if the expected manifest
is signed and stored outside the mutable partition. It does not prevent an evil
maid: compromised initramfs can capture the unlock key before the later daemon
runs, lie about the check, or restore files. Until measured boot ships, label
the software-isolated profile as vulnerable to temporary physical tampering and
do not market phone approval as evil-maid protection.

### 5.5 Durable lock and dead-man suspension

Introduce a versioned `BootSuspension` record with at least
`serverDomain`, `generation`, `reason`, `issuedAt`, and signer role. The boot
worker enforces it before lease lookup/release:

- an owner/admin may set or clear suspension;
- the registered STK may set or advance suspension, so the dead-man controller
  can fail closed, but STK authority can never clear or lower it;
- suspension is a non-expiring tombstone until a later owner/admin-signed
  resume generation is accepted;
- lease deposit cannot implicitly clear suspension, and stale/replayed resume
  or lease messages cannot cross a newer generation;
- storage, cache, replication, and restore failures resolve to suspended, not
  unlocked.

Manual “Lock and turn off/restart” is a two-plane transaction. The phone first
sets owner-signed suspension and revokes all active auto-unlock leases for the
server, waits for the boot worker's durable acknowledgement, then sends the
box-direct power order. The UI must report partial state precisely and retry a
pending cloud suspension; it must never say “locked” when only the local marker
was written.

Dead-man protection must not depend only on the expiring box being online at
the moment it fires. When dead-man is enabled, an auto-unlock lease's expiry may
not exceed the owner-signed dead-man affirmation expiry. Each affirmation
renews both under one phone-approved operation. On lapse the box additionally
posts an STK-signed suspension and waits for acknowledgement before powering
off when the boot service is reachable. The lease-expiry coupling makes the
denial effective even if that final post cannot arrive.

Rearming requires a biometric owner/admin resume, a new bounded lease, and—on
hardware-isolated boxes—an approved current boot measurement. Keep the
`/boot/flagship-lock-once` marker only as a local redundant signal.

## 6. TLS and Let's Encrypt redesign

### 6.1 Leaf issuance

Change the ACME interface from:

```text
issue(names) -> { certPem, privateKeyPem, notAfter }
```

to a handle-based flow:

```text
keyd.createTlsKey(policy, names) -> keyHandle + publicKey
keyd.createTlsCsr(keyHandle, exactNames) -> csrDer
acme.finalize(csrDer) -> certChain
tls.install(certChain, keyHandle)
```

The ACME state machine may select challenges, publish DNS tokens, submit the
CSR, and retrieve the certificate. It must never receive the leaf private key.
`keyd` must independently validate the requested SAN set against the box's
phone-authorized canonical names before creating the CSR. The ACME helper is
not allowed to mint arbitrary names merely because it can ask `.com` to publish
DNS challenges.

### 6.2 ACME account signing

Do not merely move the raw ACME account PEM into another Node module. Either:

1. extend/fork the ACME client so JWS signing uses an opaque signer and have
   `keyd` validate the structured ACME operation, directory origin, nonce,
   account id, identifiers, and request type; or
2. implement the small ACME JWS/request layer as Flagship-owned, audited code
   outside `keyd`, with `keyd` constructing/signing only validated JWS forms.

The networking process may be compromised and ask for allowed operations, so
the custodian policy must bind an issuance job to an exact phone/box-authorized
SAN set and short expiry. It must reject arbitrary URLs, identifiers, account
changes, and unbounded revocations.

### 6.3 TLS termination

Node's `createSecureContext({ key: privateKeyPem })` cannot meet the target
boundary. Run a short architecture spike comparing:

- a small dedicated TLS frontend using an opaque `crypto.Signer`/keyless signer;
- OpenSSL 3 provider or PKCS#11 support backed by TPM/`keyd`; and
- a minimal local TLS proxy whose only upstream is the existing service proxy
  over a Unix socket.

Select on these gates: no raw key in the Node daemon, SNI and ALPN support,
TLS 1.3, WebSockets/streaming, PROXY metadata handling, renewal without dropped
connections, TPM and software backends, bounded IPC latency, and maintainable
dependency size. The chosen TLS frontend is part of the trusted computing base;
keep it small and pin it as part of the release artifact.

### 6.4 Migration of existing PEM keys

On upgrade:

1. install and verify `keyd` before changing serving state;
2. import existing STK/SWK/CGK only once into the software or TPM-backed store;
3. issue a fresh TLS certificate with a newly generated, non-exportable key;
4. atomically switch TLS serving, verify the native pin update through the STK,
   then revoke the old leaf where appropriate;
5. replace the STK under the existing phone-authorized rotation flow if moving
   to a genuinely non-exportable identity;
6. remove PEM/hex/environment copies and their readers;
7. overwrite best-effort and trim obsolete files, while documenting that secure
   deletion on flash cannot be proven. LUKS and key rotation—not overwrite—is
   the durable protection for old encrypted-volume blocks.

Power loss at every step must leave either the old working state or the new
working state. Never destroy the old path until the phone and box have verified
the cutover.

## 7. Native clients, browsers, CAA, and CT

### 7.1 Native-client pinning

- Preserve normal platform WebPKI validation, then narrow it with the verified
  STK-signed leaf fingerprint.
- A privileged request to a known box must **not** proceed with “no pin; use
  default WebPKI.” Missing pin becomes a distinct blocked state that triggers a
  signed status refresh or explicit re-pair/recovery.
- Define the small onboarding window in which a pin is not yet available.
  During that window, allow only the minimum enrollment exchange whose response
  is authenticated by the locally/physically paired STK. Do not allow admin,
  data, update, backup, or key operations.
- Certificate renewal changes the leaf pin only when the new fingerprint is
  signed by the already trusted STK and the SAN set matches the box/service.
- STK rotation requires a signature by the old STK plus phone/admin approval,
  or the explicit physical recovery procedure. `.com` cannot unilaterally
  replace it.

Test every box-bound URLSession/OkHttp/WebSocket path against a central registry;
add a build-time inventory test so a newly introduced client cannot bypass the
pinning factory.

### 7.2 Browser assurance

Document normal browsers as the convenience/WebPKI tier. They cannot enforce a
Flagship-specific leaf pin. For browser administration and other sensitive
actions, require application-layer signatures and phone approval; never rely on
the browser TLS connection alone as proof of box identity. The browser
extension may improve this later, but it is not a prerequisite for the host key
boundary.

### 7.3 CA containment

- Keep apex CAA restricted to Let's Encrypt and verify it in `zone-health`.
- Monitor Certificate Transparency for unexpected `flagship.services` and
  registered custom-domain certificates. Alert the owner and create a signed
  security/audit event; never auto-trust a CT result.
- Native identity remains the STK pin. CAA and CT are detection/containment
  layers, especially for browsers, not replacements for it.
- Treat CA outage as availability loss only. Existing keys and service identity
  remain valid; retry renewal with sufficient margin and never accept a
  replacement identity because renewal failed.

## 8. Install and update supply-chain work

### 8.1 Immediate changes

1. Stop building or endorsing Node 20 images. Standardize production on Node
   24 LTS, initially **24.22.1 or later**, and assert the exact version plus
   built-in root-bundle generation in the release manifest and at daemon start.
   CI and `npm run ready` fail on an EOL or below-security-floor runtime.
2. Do not run a remote repository setup script. Fetch official Node archives
   only in isolated release CI; verify the pinned SHA-256 from the PGP-signed
   `SHASUMS256.txt` against a reviewed set of Node release keys, scan them, and
   embed the verified runtime in Flagship's signed box artifact. The box never
   downloads Node or adds NodeSource at install time.
3. Publish an emergency, maintainer-endorsed Node runtime update through a path
   whose digest/signature verification is independent of TLS. Rebuild both
   architectures and all appliance/installer variants. Inventory existing box
   runtime versions and require an explicit incident decision for Node 20 boxes;
   do not assume changing `NODE_OPTIONS=--use-openssl-ca` repairs a compromised
   trust path.
4. Change the install recipe schema to bind an exact 40-hex source commit,
   artifact SHA-256, architecture, artifact format/version, provenance digest,
   and minimum installer/verifier version. Reject empty refs, branches, tags,
   abbreviated hashes, detached metadata, and commit/digest mismatch. Do not
   default to `main`.
5. Treat an exact Git commit as temporary containment, not the final delivery
   format. If a source bootstrap is retained for development, fetch without
   executing, verify `git rev-parse HEAD` equals the signed commit, verify the
   maintainer endorsement/provenance, and only then enter a sandboxed build.
   Production installs use the artifact in §8.2.
6. Remove raw unsigned `swkHex` from production recipe siblings and reject it
   in ordinary mode. Inventory every sibling and require either inclusion in
   signed canonical bytes or a separately verified, purpose-bound inner
   envelope. Keep secret-bearing offline mode explicit and separately tested.
7. Remove the production self-update fallback from `npm ci` to `npm install`.
   Fail closed and roll back if the exact lock cannot install. Then remove npm
   from the on-box production update path entirely.
8. Replace semver ranges with exact versions for security-boundary dependencies
   (`acme-client`, X.509/ASN.1, crypto, TLS/proxy, update verification, archive
   extraction). Keep the lockfile committed and require `npm ci` in developer/CI
   builds.
9. Disable dependency lifecycle scripts by default. Maintain a short audited
   allowlist for packages that genuinely require a build step; execute those
   steps only in an isolated builder without release keys or production access.
10. Pin GitHub Actions by commit SHA, container/base images by digest, downloaded
   tools by signature and digest, and Debian inputs to a reproducible snapshot
   or signed immutable appliance manifest.
11. Add automated secret scanning, dependency/license inventory, vulnerability
    scanning, and an SBOM for every release. Findings need owners and deadlines;
    scanners are not an acceptance oracle by themselves.

Official evidence checked on 2026-10-22: [Node's EOL
table](https://nodejs.org/en/about/eol) lists v20 as EOL (last update
2026-03-24), and the [2026-10-21 Node 24.22.1 security
release](https://nodejs.org/en/blog/release/v24.22.1/) both updates root
certificates and rejects chains containing blocked public keys. Re-check those
official pages at implementation time; a version written in this plan is a
floor, not a forever pin.

### 8.2 Production artifact

Build one versioned box artifact in clean CI and again on an independent builder.
It must contain the daemon, TLS frontend, `keyd`, production dependencies, unit
files, migrations, and static assets. Record:

- source commit and first-parent lineage;
- exact lockfile and toolchain versions;
- base image/repository snapshot digests;
- complete SBOM;
- artifact hashes for each architecture;
- reproducibility result or an explained diff;
- test and security-gate results.

The release endorsement must bind the artifact digest and provenance digest,
not only a Git commit. The box downloads to a staging slot, verifies locally
against its baked maintainer root, installs without reaching npm/apt/GitHub,
boots into the staged slot, runs the existing health gate, and rolls back on
failure. Preserve source availability separately; do not require compiling it
on the production box.

Remove live NodeSource scripts, repository cloning, apt drift, `npm install`,
and compilation from the production installer. If retained for developer
hardware, label that path experimental and prevent it from making the same
security claims as a released appliance.

### 8.3 Release authority

The current CA-authority fallback for release endorsements was an explicit
pre-release compromise. Replace it before general availability with a distinct
release track and distinct hardware-held keys. Require:

- independent source/security review for key-boundary changes;
- threshold approval by at least two release authorities for changes to
  `keyd`, boot/unlock, update verification, TLS, ACME, or trust roots;
- a public append-only release/provenance record and anti-rollback sequence;
- staged rollout: CI emulator/VM, internal hardware, canary cohort, then broad;
- phone/admin approval remains required for the user's box to install;
- emergency security notices and rollback remain separately authorized.

Dependency updates must be small, explicit PRs showing transitive lockfile and
SBOM changes. Review upstream source/release provenance for boundary-critical
packages. Prefer a maintained Flagship fork or vendored minimal implementation
when a general-purpose dependency is large, executes code at install time, or
cannot support opaque signing. Do not freeze known-vulnerable versions merely
because they are familiar.

## 9. Names, `voi.ci`, and custom domains

This section carries forward `TODO-VOICI-SERVICE-SLUGS.md` while adding the
security requirements that must accompany reusable names.

The agreed product constraints are part of the design input:

- each publicly exposed service may receive one free user-chosen
  `voi.ci/<slug>`;
- the working account-wide active-name caps are Free 5, Pro 50, and Pro Max
  250, subject to validation before launch;
- during the launch dibs window, a registered `<slug>.com` reserves the matching
  slug for an account that proves control of that exact domain; an unregistered
  `.com` leaves the slug first-come-first-served, and remaining names become
  first-come-first-served after the window;
- working lease timing is warning after 21 days without a successful Flagship
  liveness check, expiry at 30 days, and a further 30-day `410 Gone`
  quarantine;
- deleting the service or changing its slug relinquishes the old claim into
  quarantine; after a 15-minute typo-correction window, a service may finalize
  one change per seven days;
- the working successful-claim budgets per rolling 30 days are Free 10, Pro
  100, and Pro Max 500; availability checks and failed claims do not consume
  that budget but are independently rate-limited;
- prior owners receive no permanent reclaim priority after quarantine; and
- a verified custom domain such as `harrysbar.com` is the durable branded
  address. It requires an active Pro subscription rather than a lifetime
  one-time routing purchase or a setup fee plus subscription. Pro includes one
  domain; Pro Max supplies the higher domain allowance. A lapse receives the
  planned 30-day working grace period, then fails closed while canonical and
  eligible `voi.ci` addresses remain available.

The exact numeric limits may change after abuse and availability tests, but the
security distinction may not: free human names are renewable/reassignable
locators, while a custom domain remains controlled by the domain registrant and
is only routed while control and subscription are valid.

### 9.1 `voi.ci/<slug>` architecture

- Keep it a path redirector only. Do not make `<slug>.voi.ci` a user-controlled
  origin and do not issue per-service `voi.ci` certificates.
- Resolve a slug only to a server-derived, allowlisted HTTPS URL under the
  canonical `flagship.services` namespace. Do not store or honor arbitrary
  destination URLs; this prevents an open redirect and phishing primitive.
- Accept only `GET`/`HEAD`; never forward request bodies, authorization headers,
  or cookies. Set `Referrer-Policy: no-referrer`, an appropriate CSP on error or
  interstitial pages, and host-only secure cookies only if the redirector ever
  needs cookies (prefer none).
- A slug binds to a stable service ID, not a server name. Placement/leadership
  changes update resolution without changing the human name.
- Claim, rename, deletion, expiry, quarantine, and reassignment are atomic and
  audited. Limits, cooldowns, and rolling claim budgets are enforced in the
  same transaction as allocation.

### 9.2 Reassignment safety

A recycled marketing name creates a stale-link phishing risk. Therefore:

- bare `voi.ci/<slug>` is never used as the subject of a grant, invite,
  authentication token, WebAuthn RP identity, OAuth redirect registration, API
  credential, or signed security decision;
- durable share/invite links carry an opaque stable service/claim identifier or
  signed generation in addition to any human-readable slug, and fail rather
  than resolve to a later claimant;
- deletion/change/expiry returns `410 Gone` during quarantine;
- after reassignment, consider a time-bounded “this name has a new owner”
  interstitial for requests that lack a current-generation marker;
- UI and terms state that the free slug is a revocable locator, not property or
  proof of identity. A verified custom domain is the durable branded option.

Keep the proposed 30-day liveness expiry and 30-day quarantine as starting
values, but test the phishing/reassignment UX before finalizing them. Security
links must remain safe even after the quarantine ends.

### 9.3 Dibs and domain proof

- During the dibs window, proof of the exact matching `.com` may unlock the
  free service slug as already planned; it does not create service identity.
- Challenges are random, account/IRK-bound, single-use, short-lived, and stored
  hashed. Allocation and challenge consumption are one transaction.
- DNS proof uses authoritative answers with bounded retries. HTTP proof allows
  HTTPS only, rejects private/link-local/loopback/reserved destinations after
  every resolution, limits response size/time, and either forbids redirects or
  restricts them to the same registrable domain. Re-resolve and re-check to
  resist DNS rebinding.
- Normalize with one shared validator and public-suffix data. Reserve
  infrastructure, impersonation, test, and punycode-confusable cases according
  to the canonical naming policy.
- Availability lookup, proof initiation, proof verification, claims, changes,
  and liveness probes each receive independent network/account/name rate limits
  and abuse telemetry that contains no unnecessary identity data.

### 9.4 Custom domains

Custom domains remain a recurring Pro capability: domain verification and one
domain are included; no separate setup fee is needed. Security requirements:

- verify ongoing control at attachment and periodically thereafter;
- bind the domain-to-service mapping to the stable service ID and an
  admin/IRK-signed order;
- generate the TLS key on the selected serving box through `keyd`;
- do **not** replicate `privateKeyPem` to sibling boxes;
- choose and document one failover design before merging
  `feat/custom-domains`: (A) leader-only key with controlled successor
  reissuance, or (B) independently generated per-box keys/certificates within
  CA rate limits. A remote keyless signer is acceptable only if its availability
  and compromise properties are better than controlled reissuance;
- on Pro lapse, keep the planned grace period, then remove SNI routing and fail
  closed while preserving the canonical address;
- domain replacement and detach invalidate old mappings immediately, audit the
  change, and trigger safe certificate retirement.

The existing raw sibling certificate-key bundle is a **stop-ship issue for that
unlaunched feature**, not a reason to weaken the custody invariant.

## 10. Isolation of services and host components

- Stop running the general Node daemon as root. Give it a dedicated user and
  only the files/sockets it needs. Move power, reboot, selected network setup,
  raw-disk work, and container lifecycle into separate purpose-built brokers
  whose protocols name typed operations rather than commands or paths. No
  broker accepts shell text, environment fragments, arbitrary bind mounts, or
  caller-selected executable paths.
- Run each app as an unprivileged container with a read-only root, explicit
  data volumes, no host PID/user/network namespace access, no Docker socket,
  no host devices, no added capabilities, `no-new-privileges`, bounded memory/
  CPU/PIDs/files, and the strongest practical seccomp/AppArmor profile.
- Only the dedicated ingress proxy may reach app listeners. Services cannot
  bind the host's public ports or key IPC socket.
- Separate ACME networking, TLS termination, general daemon/control logic,
  AI/build tooling, backup, and key custody into principals with explicit IPC
  edges. Do not give the monolithic daemon every privilege during transition.
- Protect `/proc`, journals, crash reports, diagnostics, and support bundles
  from leaking environment variables, PEM, tokens, request bodies, or user
  content. Add structured secret types whose string conversion is forbidden.
- Treat the Docker/container runtime as privileged infrastructure and pin it in
  the appliance. App code must never be able to invoke it.
- Keep the existing rule that models operate only on privacy-redacted staging
  data. Model/build tooling must be in the least-trusted tier and have no key
  custody capability.

### 10.1 Creator update and migration boundary

Immediate containment:

- force every cross-creator `AppPullState` to `manual` or `frozen` and stop the
  scheduler before fetching a new tip;
- reject `.js` and `.ts` migrations in production;
- require a fresh owner/admin approval for every third-party update until the
  replacement is complete; and
- inventory installed cross-creator services, their current tips, applied
  migrations, and update attempts without collecting owner content.

Target design:

1. A creator signs a content-addressed app release manifest. It names the
   source/release digest, container image/build recipe, requested capabilities,
   migrations, minimum platform, and rollback compatibility. A creator key is
   bound to the app identity; rotation is explicit and visible.
2. The box verifies the release and stages it with no host writes. Any new or
   expanded domain, egress, device, data-store, browser, secret, public-route,
   or resource capability requires a fresh admin approval. Code-only updates
   within unchanged authority may follow the owner's chosen policy. Default
   third-party apps to manual/staged updates; automatic creator updates are an
   explicit opt-in that clearly states the creator retains ongoing code
   authority over that app's existing data and already approved egress.
3. Executable migrations run in a one-shot sandbox as the app's UID, with the
   same or stricter seccomp/AppArmor/capability/device/namespace policy as the
   app, a read-only release image, a dedicated writable migration scratch
   volume, no host mounts or daemon/key/runtime sockets, no metadata service,
   and no network except the exact app-scoped database endpoint when needed.
4. SQL migrations run from a pinned `psql` image in that sandbox with only the
   app's database role. The role cannot create extensions/roles/databases,
   access sibling schemas, invoke unsafe server-side programs, or bypass row/
   quota limits. Apply statement, lock, wall-clock, memory, output, and disk
   limits. Do not parse SQL as a substitute for database authorization.
5. Snapshot/backup app data before migration. A code rollback is automatic;
   data rollback occurs only when the release declares and tests a compatible
   down path or restores the isolated snapshot. Never report success while code
   and schema generations disagree.
6. Migration stdout/stderr is bounded and redacted before logs/phone/model use.
   The sandbox receives only app-scoped credentials over a sealed descriptor,
   not the daemon environment.
7. Roll out creator releases through isolated build/test, canary boxes that use
   synthetic data, a delay/transparency window, health/error budgets, and rapid
   digest revocation. Never canary on an owner's live data or attach a model to
   a live service.

Long term, prefer declarative schema migrations over creator-supplied general
scripts. If a general migration is unavoidable, treat it exactly like the app
itself: arbitrary code with only app authority, never host maintenance code.

### 10.2 Session capabilities and Remote

Replace “token exists” gates with a single authorization layer that resolves a
session to a typed principal and capabilities before routing. At minimum:

| Principal | Allowed authority |
|---|---|
| Owner/admin paired session | Explicit owner UI/API capabilities; sensitive operations still require signed/biometric orders where specified |
| Companion Remote session | Explicit read projections and `request-write`; no raw owner secrets, build credentials, key minting, deploy, app/data/access mutation, backup/restore, power, or policy change |
| Co-manager/share session | Only the share's signed per-action scope; never inherits owner merely by entering the paired-session store |
| App token | That app's narrow daemon API only; never `/api/build`, `/api/llm`, `/api/screens`, key custody, or another app |
| MCP/build token | One build and its exact tool set; cannot become a paired session or deploy without a separate owner authorization |

Use distinct token audiences and stores (or cryptographically bound `aud` and
capability claims) so a token minted for one principal cannot be replayed at
another gate. Every route registers method, path, read/write classification,
accepted principals, required capability, and whether an application-layer
signature/biometric is required. Unregistered routes reject by default. A CI
inventory fails when a paired-session route lacks metadata.

Patch `/api/build/*` and `/api/llm/sessions*` immediately with an owner-only
check. Rotate/revoke all existing companion tokens, MCP keys created by a
companion, and builds/deployments attributable to those sessions; inspect the
privacy-safe activity journal before deciding whether owner notification or app
removal is required. Add a test that runs every companion token against every
daemon route/method and permits only the declared read/request-write matrix.

### 10.3 Community adapter trust

Immediate containment is to stop publishing and consuming anonymous adapters;
leave submissions quarantined and display no automatic candidate. Do not make
setting `ADAPTER_REVIEW_ANTHROPIC_KEY` the re-enable condition.

The safer product model has three provenance classes:

1. **Repo-authored:** the adapter is in the exact source commit the owner chose.
   It is still untrusted app code but shares that repo's provenance.
2. **Flagship-reviewed:** deterministic validation, isolated build/test, egress
   observation, human security review, and a Flagship reviewer signature bind
   the adapter hash, repo commit, toolchain, test evidence, and declared
   capabilities. Two reviewers are required for adapters that add executable
   code, install hooks, migrations, browser access, secrets, or egress.
3. **Community suggestion:** anonymous or pseudonymous content remains an inert
   diff. It can seed the owner's private sandbox/AI review but is never selected
   or installed automatically and carries no “safe” badge.

Publish signed, append-only, rollback-protected index metadata with expiry and
key rotation, not just a mutable Git branch and hash-named bodies. Verify the
same deterministic rules again on the box; build/test with no owner data and no
secrets; show the exact code/capability diff to the owner; and run the installed
app under default-deny egress. Complaint counts and canaries can withdraw an
adapter but never establish trust. A model may triage or explain findings, not
sign an acceptance decision.

### 10.4 App browser isolation and navigation enforcement

Disable the app browser API and destroy the existing shared Chromium profile as
containment. Re-enable only with all of the following:

- one incognito/persistent browser context and storage partition per service;
  no app shares cookies, local/session storage, IndexedDB, cache, service
  workers, HTTP auth, client certificates, downloads, permissions, or history
  with another app or with the owner's manual browser;
- `Target.createBrowserContext` ownership bound to `serviceId`, with every tab,
  popup, worker, and child target required to remain in that context;
- auto-attach to new targets with execution paused, install interception and
  context ownership before resuming, and reject an unowned target rather than
  racing `Target.createTarget` against later registry assignment;
- CDP `Fetch.enable`/network interception (or an equivalent browser-level
  policy) before first navigation, checking initial URL, redirects, link/form/
  script navigation, popup, subframe, worker fetch, WebSocket, download, and
  non-HTTP scheme. Resolve DNS and block loopback, link-local, RFC1918/ULA,
  metadata, host services, and rebinding unless a separately approved local
  capability requires an exact destination;
- a current main-frame URL/origin check immediately before and after every
  `fill`, `click`, DOM read, screenshot, input request, and raw input action;
  mismatch closes/quarantines the tab and returns a policy error;
- app identity attached inside `BrowserManager`, not supplied by a later HTTP
  handler after `Target.createTarget`; creation races fail closed;
- no password/OTP/cookie autofill into app-controlled contexts unless the phone
  shows the exact verified origin and the owner approves that single fill; and
- derive every phone prompt's scheme/host/port from the live main frame, never
  from app input. Bind screenshot/input references to service, tab, origin,
  requesting phone/session, purpose, single use, and a short expiry; never fall
  through from a failed phone-session check to a broader app-token path; and
- bounded downloads/screenshots/DOM output, safe file handling, and profile
  deletion on uninstall/revocation.

Tests must cover every navigation mechanism, nested/popup chains, DNS rebinding,
service workers, WebSockets, `data:`/`blob:`/`file:`/custom schemes, current-URL
TOCTOU races, and proof that cookies from app A, app B, and the owner browser are
mutually invisible.

### 10.5 macOS privileged helper

Pin the XPC client to Flagship's full designated requirement: Apple anchor,
exact bundle identifier, exact Team ID/certificate OU, and release signing
class. Validate through the connection's audit token/code-signing requirement
before exporting an interface. Development uses a different helper label and
explicit development requirement; release helper policy never weakens when a
debug build is present.

Redesign `writeImage` so the client supplies an opaque prepared-image ID and a
Disk Arbitration media identifier, not three paths. The helper:

- creates and owns a fixed root-only staging/log directory; opens image and log
  with `openat`, `O_NOFOLLOW`, expected owner/mode/type/link count, and
  `O_CREAT|O_EXCL` where applicable; then operates on held file descriptors;
- verifies the image's expected size and SHA-256 from the unprivileged
  preparation result and enforces reasonable maximums;
- resolves the target through Disk Arbitration/I/O Registry, requires a whole,
  external, removable/ejectable media object, rejects the startup/root/recovery
  disk and all internal/virtual/network devices, unmounts through the OS API,
  and re-checks BSD name, registry entry ID, size, transport, and non-system
  status immediately before opening the raw device exclusively;
- never follows symlinks or lets a caller choose a log path, executable,
  arguments, environment, or arbitrary `/dev/disk*` string; and
- emits a structured, non-secret audit result and requires the app's final UI
  confirmation to display the immutable model/size/serial suffix it will write.

Fuzz the XPC decoder and test a malicious Apple-signed non-Team-ID app,
lookalike bundle ID, symlink/hardlink/FIFO/device paths, path swaps, partition
paths, internal/startup disks, disk-number reuse, disconnect/reconnect during
confirmation, oversized/sparse images, and helper/app version skew.

### 10.6 Re-pair and account-root rotation

Treat rotation of the account IRK/admin root as more sensitive than an ordinary
IRK-signed operation. Recommended policy:

- on an admin-pinned account, require an admin-root-signed replacement order
  plus either approval from another existing admin device or an independent
  enrolled recovery factor (passkey recovery proof, TOTP, or one-time recovery
  code); a bare current-IRK signature is insufficient;
- on a multi-device legacy account, require the existing IRK **and** TOTP/
  recovery code or an explicit approval from another non-quarantined device;
- on a single-device account, preserve a documented last-device recovery path,
  but require the current key plus an independent passkey/recovery factor when
  one exists. If none exists, use the longest grace, prominent multi-channel
  alerts, no silent completion, strict grant wipe, and quarantine; decide
  explicitly whether that residual risk is acceptable before GA;
- never let a quarantined device approve, veto on behalf of another admin,
  lower the grace, change wipe policy, or lift its own quarantine; and
- bind every factor/approval to username, old and new roots, device, wipe
  policy, nonce, initiation generation, and expiry. Consume one-time factors
  atomically.

Keep the existing grace, audit, old-key proof served to boxes, box-side chain
verification, and 14-day quarantine. Correct comments and UI that equate key
possession with proof that an attacker cannot hold it. Build a recovery matrix
for stolen key file, stolen unlocked phone, SIM/email compromise, one remaining
device, multiple devices, no TOTP, lost passkey, control-plane rollback, and
concurrent re-pair attempts before changing availability behavior.

## 11. Required tests and evidence

No phase is done because unit tests pass. Produce the following evidence.

### Key-boundary tests

- Substitute a deliberately hostile ACME client that inspects every argument,
  environment variable, open file, and response. It must never observe a TLS,
  STK, SWK, CGK, or ACME private key.
- Run the Node daemon under its production user and prove it cannot read key
  storage, connect to disallowed `keyd` operations, ptrace `keyd`, read its
  `/proc` environment/memory, or obtain a core dump.
- Static guard: fail CI if production protocol/network types add raw private-key
  fields or if forbidden modules import raw-key primitives. Allow test fixtures
  through an explicit narrow exception.
- Exercise every key operation with wrong caller, wrong purpose, malformed
  canonical bytes, replay, oversized request, rate limit, stale generation, and
  name mismatch.
- In TPM mode, prove key objects have non-exportable/fixed attributes and that
  export commands fail. Then prove legitimate signing, power loss, firmware
  update, Flagship update, recovery, and board replacement behavior.

### TLS/pinning tests

- Real issuance with the CSR produced by `keyd`; inspect ACME/TLS process
  memory and filesystem artifacts for absence of private PEM.
- Renewal with zero service-identity change and an STK-signed native-pin update.
- Rogue valid public certificate: native clients hard-fail on every HTTP and
  WebSocket path; browser behavior is documented and sensitive operations still
  require application-layer approval.
- Wrong SAN, unexpected CSR request, stolen/rotated STK, expired cert, CA outage,
  CT alert, and ordered routing-revoke/eject/reissue/CA-revoke drills.

### Supply-chain tests

- Rebuild each architecture on two independent clean builders; compare hashes
  or produce and review a deterministic diff.
- Install/update with npm, apt, GitHub, and general internet egress blocked.
  Only the designated artifact fetch is permitted.
- Tamper independently with source commit, lockfile, dependency tarball,
  provenance, artifact, endorsement, and rollback sequence; each must fail
  before execution.
- Canary an intentionally unhealthy artifact and prove automatic rollback
  without loss of data or keys.
- Boot every published appliance and installer variant and assert the exact
  Node security floor/root-bundle generation. Scan generated scripts and images
  for NodeSource setup URLs, `curl | bash`, mutable production refs, npm install
  at boot/update, compilers, and package-manager repository additions.
- Serve a valid-TLS malicious Git/Node/package endpoint and prove it cannot
  change executed bytes. Serve a mutable tag/branch that moves between recipe
  issuance and install and prove the installer rejects it before execution.
- Mutate, add, remove, replay, and cross-server-copy every recipe sibling. The
  verifier accepts only fields covered by the install signature or a valid
  inner purpose-bound signature; a raw/replaced `swkHex` never persists.

### App/update, session, and adapter tests

- Publish a hostile cross-creator `.js`, `.ts`, and `.sql` migration that tries
  to read host keys, `/boot`, daemon environment, sibling volumes, Docker/
  `keyd` sockets, metadata endpoints, and the network; every attempt fails while
  the migration can modify only its own staged data.
- Exercise migration timeout, fork bomb, disk/output exhaustion, Postgres
  privilege escape, unsafe extension/function, crash, power loss, code rollback,
  and data restore. Verify the daemon itself is not root.
- Generate owner, companion, co-manager, app, and build tokens and replay each
  against every route/method. Compare to the checked-in capability matrix;
  unclassified routes and companion mutations fail CI.
- Specifically prove a companion cannot create/adapt/deploy/discard a build,
  mint/replace/retrieve an MCP or LLM credential, call legacy vibe-code, mutate
  app/data/access state, or smuggle a write through a read endpoint.
- Submit an adapter that is syntactically valid and fits the public base but
  exfiltrates secrets, weakens access at runtime, adds a delayed payload, or
  prompt-injects the reviewer. It stays inert without the required reviewer
  signatures and owner approval. Tamper, roll back, expire, or equivocate the
  signed index and prove boxes reject it.

### Boot, lock, helper, browser, and recovery tests

- Lock an auto-mode box, remove/replace all mutable `/boot` marker files, and
  prove the worker still refuses the pre-lock lease. Prove an STK can suspend
  but cannot resume, an owner can resume only at a higher generation, stale
  replicas fail closed, and a dead-man lease cannot outlive its affirmation.
- On real hardware, replace the UKI/initramfs/helper/kernel command line, disable
  Secure Boot, boot external media, replay an old approved image, and change PCR
  policy. Automatic and phone-approved unlock both refuse an unapproved quote;
  recovery and authorized update remain possible.
- Drive the macOS helper from a different Apple Team, a lookalike bundle, and a
  genuine client with malicious image/log/device inputs. No internal or startup
  disk can be opened and path/device swaps cannot win.
- Exercise every browser escape in §10.4 and inspect Chromium storage on disk;
  an app never sees another principal's cookies/storage or reads after an
  off-policy navigation.
- Verify every re-pair matrix case in §10.6, including that a registered IRK
  alone cannot bypass the selected step-up policy and that grace/quarantine are
  never shortened accidentally.

### Names and domains tests

- Concurrent slug claims, deletion/rename races, tier downgrade, liveness loss,
  quarantine, reassignment, and reclaim-after-quarantine.
- Old generation-bearing links fail after reassignment; a bare marketing link
  cannot transfer a grant/session.
- Domain-proof SSRF, redirects, DNS rebinding, stale/replayed challenges,
  Unicode/public-suffix edge cases, enumeration, and reserved-name bypass.
- Custom-domain failover without any raw key crossing a network boundary.

### Operational drills

- Stolen powered-off and stolen-running procedures.
- Maintainer/release-key compromise and rotation.
- ACME account compromise without STK/TLS extraction.
- Lost phone/account recovery without exporting a hardware box key.
- Expired certificate during a multi-day `.com`, `.services`, or CA outage.
- Restore from backup to replacement hardware, producing a new STK and
  explicitly reauthorizing it rather than cloning the old identity.
- Revoke all companion/build tokens after an authorization bug and determine
  which apps/builds changed without collecting app content.
- Emergency runtime/root-store release to a Node 20 box while ordinary DNS,
  WebPKI, GitHub, npm, apt, and NodeSource are hostile or unavailable.
- Boot-worker partial outage during manual lock, dead-man lapse, suspension
  replication, and owner resume; no ambiguous UI or fail-open lease release.

Store release evidence with the manifest. Tests that require hardware must name
the hardware/firmware and date; “works in a VM” is not TPM or physical-theft
evidence.

## 12. Execution order, ownership, and ship gates

### Phase E — Emergency containment (security owner + release owner)

**Timebox:** immediate; complete before another public installer/appliance,
third-party app enablement, or Remote-session release.

**Deliverables:**

- freeze cross-creator auto-update and every cross-creator migration; reject
  creator-supplied JavaScript/TypeScript host migrations on every path;
- owner-only guards on `/api/build/*` and `/api/llm/sessions*`, plus revocation
  of active companion sessions and any derived build/MCP credentials;
- stop community-adapter publish/automatic consumption;
- disable app browser grants and clear the shared profile;
- pin the macOS helper's Team ID and disable raw-write operations until safe
  object validation lands;
- Node 24.22.1+ verified runtime in an endorsed offline artifact; remove all
  Node 20/NodeSource `curl | bash` generation paths;
- exact commit and artifact digest required in newly issued recipes;
- raw unsigned SWK siblings rejected in ordinary production recipes; and
- durable boot suspension/revoke in manual lock, plus dead-man lease expiry no
  later than the affirmation until full STK suspension lands.

**Operations/exposure decision:** count affected boxes/apps/sessions by
non-content metadata, establish first/last possible exposure, preserve relevant
privacy-redacted logs, and record whether creator migrations, companion deploys,
community adapters, or suspect outbound TLS actually occurred. Rotate or ask
owners to rotate LLM/provider credentials only where exposure is plausible;
avoid a blanket claim of compromise without evidence.

**Gate:** a focused adversarial suite proves each dangerous path is disabled.
If a complete durable-lock change cannot ship in this timebox, remove the
physical-security claim and force affected auto-mode boxes to explicit approval
mode after owner consent; a local marker alone is not an accepted mitigation.

### Phase 0 — Threat model and inventory (security lead + all component owners)

**Timebox:** one week.

**Deliverables:**

- enumerate every private key/seed, generation site, copy, file, environment
  variable, process, API, backup, log, and rotation path;
- diagram process principals and trust edges from early boot through apps;
- label each current product claim as proven, qualified, or unsupported;
- create tracked issues for every item in this plan, with an owner and target
  release;
- add temporary CI guards against new `privateKeyPem` network/storage surfaces
  and new full-`Keypair` consumers;
- inventory every host-root process, privileged socket/helper, paired-session
  route, cross-creator update/migration path, adapter ingestion path, browser
  principal, boot trust input, runtime/toolchain installer, and mutable ref;
- check production configuration rather than assuming optional gates are set
  (`ADAPTER_REVIEW_ANTHROPIC_KEY`, TOTP KEK, enforcement flags, helper signing);
  and
- publish the route capability matrix and process/data-flow diagrams as review
  artifacts.

**Gate:** no new feature may introduce another raw-key path while this work is
in progress.

### Phase 1 — Immediate containment (box runtime + release engineering)

**Deliverables:**

- remove the `npm install` self-update fallback;
- exact-pin and audit boundary-critical dependencies;
- stop secrets in process environments where file descriptor/IPC delivery is
  possible; lock permissions and disable core dumps immediately;
- finish replacing full `Keypair` consumers with narrow custodian operations;
- build the signed offline-installable release artifact and bind its digest to
  endorsements;
- make the production installer/update consume that artifact without live
  dependency resolution;
- run the general daemon as an unprivileged user and put creator migrations in
  the sandbox defined by §10.1;
- ship central session authorization and the companion route sweep;
- ship signed/quarantined adapter semantics before re-enabling community input;
- ship per-app browser contexts and continuous policy before re-enabling the
  browser API;
- harden the macOS helper; and
- ship durable boot suspension plus the selected re-pair step-up policy.

**Gate:** production release/update succeeds with package registries and source
hosts blocked, any artifact/manifest change fails verification, and every P0/P1
boundary-specific adversarial test in §11 passes on the real production image.

### Phase 2 — Out-of-process software custody (box security/runtime)

**Deliverables:**

- `flagship-keyd`, IPC protocol, policy engine, hardened unit, migration tool,
  audit events, and negative-test harness;
- STK/SWK/CGK removed from the Node process and ordinary filesystem paths after
  migration;
- early-boot design implemented for software mode with honest unattended-unlock
  limitations;
- app/AI/container isolation verified against the key boundary.

**Gate:** a hostile daemon component cannot extract the long-lived key bytes or
perform an operation outside its typed capability.

### Phase 3 — Opaque TLS and ACME (box TLS/ACME + mobile)

**Deliverables:**

- custodian-generated TLS keys and CSR;
- opaque ACME-account signing;
- dedicated opaque-signer TLS frontend;
- elimination of private-key PEM from issuer, cert manager, and persistent
  store contracts;
- native privileged operations fail closed without a verified pin;
- CAA/CT monitoring and incident path exercised.

**Gate:** hostile ACME and general daemon tests observe no key; real hardware
renews and serves TLS successfully; all native paths reject a rogue valid cert.

### Phase 4 — Hardware isolation and measured boot (platform + installer)

**Deliverables:**

- supported TPM matrix and fallback policy;
- non-exportable TLS keys and the strongest practical STK/boot-key protection;
- measured/approved boot policy, signed policy advancement, recovery, and
  rollback;
- UI/status reports `hardware-isolated` versus `software-isolated` without
  leaking hardware identity.

**Gate:** physical extraction and PCR-policy tests pass on every supported
hardware class, and an interrupted update cannot brick access.

### Phase 5 — Friendly names and custom domains (feature branches)

Implement human `voi.ci` service slugs on the appropriate naming feature branch
and reconcile `TODO-VOICI-SERVICE-SLUGS.md` with the canonical docs when work
lands. Implement custom-domain key changes on `feat/custom-domains` after
rebasing it on its required marketplace/payment parent. Do not place unlaunched
feature code on `main`.

**Gate:** all §9 and names/domain tests pass; custom domains contain no sibling
raw-key replication; reassigned slugs cannot inherit security state.

## 13. Definition of done

The program is complete only when all of the following are true:

- the phone remains the ownership root and a box replacement creates a new,
  explicitly authorized identity;
- no creator/app/adapter/build/AI-controlled bytes execute with host root or
  the general daemon's authority; migrations have only their app's sandbox and
  data role;
- companion and other non-owner sessions pass a central default-deny capability
  gate, and exhaustive route tests prove “read-only” cannot deploy or mutate;
- community adapters remain inert unless their provenance/reviewer signatures,
  sandbox evidence, declared capabilities, and owner decision satisfy the
  selected policy; model review is never an authorization signature;
- production STK and TLS private bytes are absent from the Node daemon, ACME
  client, service containers, logs, environment, backups, and network messages;
- hardware-supported boxes use non-exportable keys, and software-only boxes are
  clearly identified with an honest limitation statement;
- production installation and update execute a signed, digest-bound,
  reproducible artifact with no live dependency resolution;
- every supported box runs a maintained runtime at or above the current
  security floor; production bootstrap contains no `curl | bash`, mutable ref,
  live source build, or unverified repository setup;
- production recipes contain no unauthenticated secret/capability sibling; SWK
  delivery is signed, server-bound, and sealed to the registered box except in
  an explicitly labelled, signed secret-bearing offline mode;
- release authority is separate from CA authority and boundary changes require
  threshold review/signing;
- every privileged native connection requires a verified STK-bound certificate
  pin; browser limitations are explicitly documented;
- CA/control-plane compromise cannot silently become native-client service
  identity, though denial of service remains possible;
- `voi.ci` names remain redirects/marketing locators, custom domains remain
  verified mappings, and neither is an authorization primitive;
- custom-domain failover works without exporting one box's TLS private key;
- manual lock and dead-man lapse create durable boot-worker suspension, revoke
  or expire all auto leases, survive deletion/replacement of `/boot`, and can
  be cleared only by a newer owner/admin authorization;
- the hardware-isolated profile authenticates measured early boot before any
  disk key is released; the software profile makes no evil-maid claim;
- each app has a separate browser context and continuous navigation/resource
  enforcement, with no shared owner/app cookies or post-redirect read escape;
- the macOS helper accepts only Flagship's designated client and cannot be made
  to follow arbitrary paths or overwrite an internal/startup disk;
- account-root re-pair follows the approved independent-factor/admin policy
  while preserving explicit last-device recovery, grace, audit, and quarantine;
- theft, dependency compromise, CA misissuance, release compromise, renewal
  outage, rotation, recovery, and rollback drills have dated evidence;
- public security claims match the weakest supported production mode rather
  than the best laboratory configuration.

## 14. First engineering tickets to open

1. **SEC-MIG-001 (P0):** Freeze cross-creator auto-update and every
   cross-creator migration; reject creator-supplied JavaScript/TypeScript host
   migrations on all paths and inventory any production exposure.
2. **SEC-AUTH-001 (P0):** Make `/api/build/*` and
   `/api/llm/sessions*` owner-only, revoke active companion/derived build keys,
   and add regression tests.
3. **SEC-NODE-001 (P0):** Replace Node 20 with verified Node 24.22.1+ artifacts,
   rebuild/endorse both architectures, and add runtime-floor gates.
4. **SEC-BOOTSTRAP-001 (P0):** Delete NodeSource `curl | bash` and all live
   production runtime/repository setup; embed the verified runtime.
5. **SEC-INSTALL-001 (P0):** Version the recipe/endorsement envelope with exact
   commit, artifact/provenance digest, architecture, anti-rollback generation,
   and fail-closed verifier floor.
6. **SEC-LOCK-001 (P0):** Add durable owner/STK-set boot suspension, owner-only
   resume, revoke-all leases, and phone lock orchestration.
7. **SEC-DEADMAN-001 (P0):** Couple auto-lease expiry to dead-man affirmation
   and post STK suspension on lapse.
8. **SEC-BROWSER-001 (P0):** Disable app browser grants and clear the shared
   profile pending per-app contexts and continuous navigation enforcement.
9. **SEC-MAC-001 (P0):** Pin the macOS helper Team ID/designated requirement and
   temporarily refuse writes until safe image/log/device validation ships.
10. **SEC-ADAPTER-001 (P0):** Stop automatic community adapter publish/
    consumption; quarantine existing entries without deleting evidence.
11. **SEC-RECIPE-001 (P1):** Remove raw unsigned SWK from ordinary recipes,
    define the signed offline carrier, and add a complete recipe-sibling
    authentication inventory/test gate.
12. **SEC-DAEMON-001 (P1):** Run the general daemon non-root and specify narrow
    privileged brokers for power, container lifecycle, networking, and host
    maintenance.
13. **SEC-MIG-002 (P1):** Implement the one-shot migration sandbox, restricted
    database role, resource limits, snapshot/rollback, and hostile-migration
    suite.
14. **SEC-AUTH-002 (P1):** Create typed principals/token audiences, checked-in
    route capability metadata, default-deny middleware, and exhaustive route
    matrix tests.
15. **SEC-ADAPTER-002 (P1):** Implement provenance classes, signed append-only
    metadata, deterministic on-box revalidation, human reviewer signatures,
    owner diff/approval, and sandbox evidence.
16. **SEC-BROWSER-002 (P1):** Build per-app contexts, request/navigation
    interception, local-network/rebinding defense, current-origin checks, and
    cross-context isolation tests.
17. **SEC-MAC-002 (P1):** Replace path arguments with opaque image/media IDs and
    implement FD-safe staging plus Disk Arbitration/I/O Registry validation.
18. **SEC-REPAIR-001 (P1):** Approve and implement the re-pair step-up matrix;
    correct the “attacker cannot hold the key” assumption and preserve
    last-device recovery evidence.
19. **SEC-MBOOT-001 (P1):** Specify UKI/Secure Boot/TPM measurements, local
    attestation pairing, phone quote verification, policy advancement, and
    recovery for each supported hardware class.
20. **SEC-KEY-001:** Complete raw-key inventory and add the CI boundary guard.
21. **SEC-UPD-001:** Remove `npm install` fallback; fail and roll back on an
    inexact install.
22. **SEC-REL-001:** Specify the digest-bound reproducible release artifact,
    threshold endorsement envelope, transparency log, and emergency channel.
23. **SEC-KEY-002:** Specify `flagship-keyd` IPC, caller matrix, operation policy,
    and migration state machine.
24. **SEC-ACME-001 / SEC-TLS-001:** Replace raw ACME/TLS PEM contracts with
    custodian handles and select the opaque-signer TLS frontend.
25. **SEC-STK-001 / SEC-PIN-001:** Remove STK copies from ordinary files/env,
    define hardware/software profiles, and make all privileged native transport
    fail closed without a verified pin.
26. **SEC-DOM-001 / SEC-NAME-001:** Remove custom-domain key replication and
    make every friendly-name link generation-bearing and non-authoritative.
27. **SEC-IR-001:** Execute the creator-root, companion-deploy, adapter,
    stolen-box, lock-bypass, evil-maid, malicious-helper, browser escape,
    root-store, rogue-cert, release-key, and ACME-account response drills.

## 15. Security strategy and operations

### 15.1 Release policy and security floors

- Maintain one machine-readable security-floor manifest for Node, OS snapshot,
  kernel, OpenSSL/root bundle, Chromium, container runtime, Go/Rust toolchains,
  mobile/Studio OS floors, protocol/verifier versions, and revoked artifact/
  adapter/release keys. `ready`, artifact build, endorsement, and daemon startup
  consume the same data.
- Define response objectives: actively exploited/authority-crossing P0s are
  contained immediately and patched/endorsed within 24 hours where feasible;
  High issues have a named owner and target within seven days; EOL migrations
  finish before upstream support ends. Exceptions are written, time-bounded,
  owner-approved, and visible in the release manifest.
- A security release is a small auditable diff. It does not wait behind feature
  work, translation, or a broad release train. Only `main` ships; after an
  emergency deploy, push the exact deployed commit to `main` immediately under
  the repository rule.
- Keep offline recovery media and verifier keys capable of installing an
  endorsed security artifact when DNS, CA, GitHub, package registries,
  `.com`, or `.services` are unavailable or hostile.

### 15.2 Least privilege in production operations

- Separate Cloudflare/Fly/GitHub/App Store/Play/Node artifact/adapter/release
  duties. Use hardware-backed maintainer and release keys, short-lived CI
  credentials, protected environments, two-person approval for trust-root and
  privilege-boundary changes, and no shared human credentials.
- Production secrets never enter local shell history, CI logs, support bundles,
  model prompts, or app content. Audit access to release, DNS, storage, signing,
  and backup systems; alert on new credential, policy, route, artifact, or key
  use. Respect the repo's model-redaction rule in all incident tooling.
- Backups are encrypted, independently restorable, and protected from the same
  principal that can alter production. Test restore plus key/revocation state;
  a restored stale database must not resurrect a lease, session, adapter,
  release, or boot suspension.

### 15.3 Detection, inventory, and owner communication

- Record privacy-minimal security events for app release/migration digest,
  session principal/capability decision, build/deploy actor class, adapter
  provenance, runtime/artifact version, lock/suspend/resume generation, boot
  measurement decision, helper target class, and key operation. Never record
  owner content, full tokens, prompts, DOM, secrets, precise location, or model-
  identifying personal context.
- Maintain revocation/inventory views for box releases, runtimes, companion and
  build sessions, creator releases, adapters, privileged-helper versions, and
  boot policy generations. A security owner must be able to answer “what is
  affected?” without reading app data.
- Security UI distinguishes **requested**, **durably accepted**, **applied**,
  **partially failed**, and **recovered**. Especially for lock, update, re-pair,
  and key rotation, never turn an HTTP acknowledgement into a stronger claim.
- Pre-write notices for mandatory box update, provider-key rotation, revoked
  adapter/app release, changed boot measurement, and physical-security
  limitation. Notify only affected owners and state evidence versus precaution
  honestly.

### 15.4 Independent assurance

- Require focused external review before GA of the update/migration sandbox,
  companion/owner authorization matrix, install/endorsement verifier, boot and
  unlock protocol, app browser, macOS helper, and recovery/root rotation.
- Maintain a public security contact, safe-harbor disclosure policy, response
  runbook, and remediation/credit process. Re-test reported bug classes across
  all analogous routes/platforms rather than patching one endpoint.
- Fuzz every untrusted parser and state machine at the boundary: recipes,
  endorsements, migrations/manifests/adapters, XPC, CDP mediation, boot worker,
  ACME, tunnel frames, archives, and canonical signed messages. Seed corpora
  with every past security regression.
- Run quarterly tabletop exercises and at least annual real-hardware drills for
  release-key compromise, stolen locked box, evil maid, control-plane restore,
  CA/root-store event, malicious creator update, companion takeover, and
  emergency offline update. Track dated evidence and unresolved observations.

The first review meeting must assign owners and containment deadlines for every
P0 before discussing implementation language or TPM vendor details. The second
meeting approves the invariants, attacker model, re-pair availability policy,
and production-versus-software fallback claims. Those choices matter, but the
security boundary and acceptance tests must drive them.
