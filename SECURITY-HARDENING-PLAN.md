# Flagship security-hardening plan

**Date:** 2026-10-22

**Audience:** Flagship engineering, security, release, mobile, and operations

**Status:** Engineering directive for review; verified stop-ship findings are
listed below, but no implementation is implied by this document

**Handoff:** This is the consolidated recipe, including review items N01–N14
and the subsequent owner decisions. Use §§16–18 together with the earlier
mechanisms and ship gates. Assign engineering owners and reviewers before
execution; §18.15 identifies protocol designs that still need review and
prototypes. Document completion is not implementation or release approval.

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

This recipe also covers the cross-cutting controls that make those boundaries
hold under malformed traffic, retries, partial outages, restores and evolving
app identity: maintained HTTP parsing; connection-time network enforcement;
complete signed recovery records; transactional approvals/revocation; policy
freshness and fenced leadership; keyless browser migration; safe data restore;
lineage-aware forks and upstream sync; and resource/rollout operations. See §18
for the integrated implementation contracts and evidence gates.

### 1.1 Priority and release decision

| Priority | Meaning | Current items |
|---|---|---|
| **P0 / stop-ship** | Disable or fix before another public box image, third-party app install, or Remote session | Root migration execution; companion build/deploy; Node 20 and `curl \| bash`; mutable install ref; ineffective lock/dead-man denial; browser cross-origin/profile escape; macOS root-helper caller/path/device validation; HTTP duplicate dispatch/framing ambiguity; address-classification and dial-time bypasses |
| **P1 / pre-GA** | Must pass before claiming the affected feature is secure | Anonymous/community adapter trust; passkey-recovery wait/veto enforcement; signed artifact/provenance; Secure Boot/measured boot for physical-theft claims; daemon privilege separation; complete recovery-record signatures; operation/revocation transactions; authorization freshness; safe restore/import |
| **P2 / defense in depth** | Important, scheduled work after the immediate boundary is closed | Out-of-process key custody, TPM non-exportability, CT monitoring, reproducible builds, threshold release signing, advanced recovery drills, cross-service resource reserve and incident-evidence hardening |

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
   declares the capabilities it accepts. A companion is read-only unless a
   phone-approved, service-scoped delegation authorizes the action. A generic
   paired session never implies build/deploy authority. The website holds no
   private security/signing keys: operations requiring signatures go to the
   phone for biometric-gated signing of the exact action.
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

### 3.8 Current-IRK re-pair bypasses recovery proof — P1

`packages/control-plane/src/rePair.ts` accepts `oldIrkSignature` as a complete
recovery credential and skips TOTP/recovery proof. The comment calls the
registered key something an attacker “provably cannot hold”; theft of a key
file, unlocked device, browser storage, or compromised endpoint disproves that
assumption. The current code does **not** skip every protection: it still waits
the account-type grace period and stamps the 14-day quarantine at completion.
The verified gap is that a current-IRK signature can bypass the independent
recovery proof. The approved recovery path for an owner with no available
registered device is passkey-based recovery followed by a waiting period that
gives any remaining active admin a chance to reject the pending device; see
§10.6. Do not add another factor on top of that ceremony or allow the IRK-only
path to skip its wait/veto protections.

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

Manual “Lock and turn off” is a two-plane transaction. The phone
immediately sends the box-direct power order while it sets owner-signed
suspension and revokes all active auto-unlock leases. Do not delay local
shutdown while waiting for the boot worker. The UI reports the two outcomes
separately: for example, “Box powered off; remote lock pending” until the boot
worker durably acknowledges suspension. Retry a pending cloud suspension and
never say “locked” when only the local marker was written.

“Lock and restart” must instead wait for durable suspension acknowledgement
before restarting: otherwise early boot could reuse an unrevoked auto-unlock
lease. If suspension cannot be confirmed, offer shutdown with the pending-lock
status rather than an immediate restart.

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

Reusable names here mean marketing locators such as `voi.ci/<slug>`, never
account usernames or canonical publisher `author--slug` identities. Those
identities are permanently retired on deletion and never reassigned (§18.11).

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
| Companion Remote session | Read/request-approval by default; build/deploy only under an explicit phone-signed, service-scoped, expiring delegation; no private signing keys, host secrets, or implicit authority over other services |
| Co-manager/share session | Only the share's signed per-action scope; never inherits owner merely by entering the paired-session store |
| App token | That app's narrow daemon API only; never `/api/build`, `/api/llm`, `/api/screens`, key custody, or another app |
| MCP/build token | One build and its exact tool set; cannot become a paired session or deploy without a separate owner authorization |

Use distinct token audiences and stores (or cryptographically bound `aud` and
capability claims) so a token minted for one principal cannot be replayed at
another gate. Every route registers method, path, read/write classification,
accepted principals, required capability, and whether an application-layer
signature/biometric is required. Unregistered routes reject by default. A CI
inventory fails when a paired-session route lacks metadata.

The website never receives or stores private security/signing keys, including
account/admin, recovery, app-access proof, release, and box keys. It may hold
public verification material and narrowly scoped session credentials; those
credentials cannot sign orders or bypass a required phone signature. Every
operation that requires a user signature sends its typed payload to the phone
for biometric-gated signing. The phone independently checks purpose, target,
service/release digest, scope, nonce and expiry, and shows the meaningful action
before signing; browser-supplied display text is not authoritative. The daemon
verifies the signature and exact action binding. Normal box-to-box protocol
signing remains with box keys outside the website.

Patch `/api/build/*` and `/api/llm/sessions*` immediately with an owner-only
check. Rotate/revoke all existing companion tokens, MCP keys created by a
companion, and builds/deployments attributable to those sessions; inspect the
privacy-safe activity journal before deciding whether owner notification or app
removal is required. Add a test that runs every companion token against every
daemon route/method and permits only the declared capability matrix, including
the explicit delegated build/deploy case in §16.2.

### 10.3 Community adapter trust

Immediate containment is to stop publishing and consuming anonymous adapters;
leave submissions quarantined and display no automatic candidate. Do not make
setting `ADAPTER_REVIEW_ANTHROPIC_KEY` the re-enable condition.

The safer product model has three provenance classes:

1. **Repo-authored:** the adapter is in the exact source commit the owner chose.
   It is still untrusted app code but shares that repo's provenance.
2. **Flagship AI-vetted:** deterministic validation, isolated build/test and
   the defined AI-review pipeline complete before Flagship signs an attestation
   binding the exact adapter digest, base revision, validator/model version,
   test evidence and capabilities. This is not a human security-review or safety
   certification. An admin may indefinitely trust currently attested digests
   per service; that standing choice, not the model verdict, authorizes use.
   Additional human review may be recorded separately without becoming an
   undisclosed requirement for the agreed AI-vetted option.
3. **Community suggestion:** anonymous or pseudonymous content remains an inert
   diff until a service admin explicitly chooses its exact digest. It is never
   selected or installed automatically and carries no “safe” badge; an owner
   may still choose a clearly labeled manual install after reviewing the diff
   and acknowledging missing or failed review.

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
  metadata, host services, and rebinding unless a separately approved
  local-network capability authorizes the destination (§18.2); metadata and
  protected host services remain blocked even with a whole-LAN grant;
- a current main-frame URL/origin check immediately before and after every
  `fill`, `click`, DOM read, screenshot, input request, and raw input action;
  mismatch closes/quarantines the tab and returns a policy error;
- app identity attached inside `BrowserManager`, not supplied by a later HTTP
  handler after `Target.createTarget`; creation races fail closed;
- do not make a fixed developer-authored domain allowlist the only way to use
  the browser. Let an app clearly request a typed browser capability and access
  list through the harness; the harness asks the user/admin and records a
  revocable grant scoped to that service, capabilities, exact URLs and/or
  explicitly approved wildcard domains, and chosen duration. Offer sensible
  choices such as once, this session, or remember for this service. Approval
  includes redirects initiated by approved sites, including to other public
  origins, without another prompt. Explain that behavior and wildcard reach
  before approval. Bind redirect-derived access to the browser-observed
  navigation chain; it is not permission for arbitrary unrelated direct
  navigation. Local/private and protected-destination checks still apply;
- derive the destination and requested action from the live browser state, not
  app-supplied labels. Public internet destinations should be broadly usable
  after approval. Local/private-network access gets a separate exact-target
  or whole-local-network warning and grant; metadata endpoints, the Flagship
  host/control plane, and
  other protected host services stay unreachable from app browser contexts;
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
TOCTOU races, allow/deny/prompt behavior for granted and new destinations, and
proof that cookies from app A, app B, and the owner browser are mutually
invisible.

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

Treat account recovery and new-device enrollment as a pending ceremony, not an
instant login that silently becomes an administrator:

- when no registered device is available, successful enrolled passkey recovery
  (including its recovery passphrase where that enrollment requires one) may
  restore the account key and start a pending new-device enrollment; do not
  require an additional unavailable-device approval;
- start the published waiting period, immediately notify every active admin
  and registered device, and let any active admin reject/remove (“boot”) the
  pending device during that period;
- the pending device receives no admin authority and cannot shorten the wait,
  change recovery policy, suppress notices, or veto its own enrollment;
- if an active admin rejects it, cancel the pending enrollment and revoke its
  temporary sessions/credentials. If the wait ends without rejection, activate
  the device and apply the normal quarantine and audit rules;
- a bare current-IRK signature must not skip the wait, notices, or admin veto
  window. Existing devices may use their normal authenticated admin flow; and
- bind the recovery proof and pending enrollment to the account, new device,
  initiation generation, nonce, and expiry. Consume one-time factors
  atomically.

Keep the existing grace, audit, old-key proof served to boxes, box-side chain
verification, and 14-day quarantine. Correct comments and UI that equate key
possession with proof that an attacker cannot hold it. Build a recovery matrix
for stolen key file, stolen unlocked phone, SIM/email compromise, one remaining
device, multiple devices, no TOTP, lost passkey, control-plane rollback, and
concurrent re-pair attempts. Test that a passkey-recovered pending device can
be rejected throughout the wait and receives no admin authority before it
ends.

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
  unclassified routes and undelegated companion mutations fail CI.
- Specifically prove an undelegated companion cannot create/adapt/deploy/discard a build,
  mint/replace/retrieve an MCP or LLM credential, call legacy vibe-code, mutate
  app/data/access state, or smuggle a write through a read endpoint.
- Exercise the delegated companion path: only the named service and operations
  work, expiry/revocation take effect, and replay or payload substitution fails.
  Verify no browser storage, page context, tool output or response contains a
  private security/signing key; required signatures come from the phone after
  biometric approval of the exact operation.
- Submit adapters with secret-exfiltration attempts, weakened access, delayed
  payloads and reviewer prompt injection. Verify rejection by applicable
  deterministic/sandbox controls and that a positive model verdict alone
  never authorizes execution. Test manual digest approval and the explicit
  per-service standing AI-vetted policy; changed unvetted digests stay inert
  pending manual acceptance. Tamper, roll back, expire or equivocate the signed
  index/attestation and prove boxes reject it. Review is not proof of benign code.

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
- ship durable boot suspension plus the passkey-recovery wait/veto policy in
  §10.6.

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
- passkey recovery with no registered device starts a pending enrollment with
  a waiting period, immediate notices, an active-admin rejection window, and
  no admin authority before activation; a bare IRK signature cannot skip it;
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
    metadata, deterministic on-box revalidation, exact-digest AI-vetting
    attestations, manual/standing per-service owner policy, and sandbox evidence.
16. **SEC-BROWSER-002 (P1):** Build per-app contexts, request/navigation
    interception, local-network/rebinding defense, current-origin checks, and
    cross-context isolation tests.
17. **SEC-MAC-002 (P1):** Replace path arguments with opaque image/media IDs and
    implement FD-safe staging plus Disk Arbitration/I/O Registry validation.
18. **SEC-REPAIR-001 (P1):** Implement passkey-based pending enrollment,
    waiting period and active-admin rejection; ensure IRK-only proof cannot
    skip the window, and preserve last-device recovery evidence.
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

## 16. Owner usability decisions and implementer advisory

These are product decisions from the 2026-10-22 owner review. Preserve the
default security boundaries while keeping service-level controls easy to find
and independently configurable. A warning acknowledges a scoped risk; it must
not grant authority beyond the named service or bypass a mandatory isolation
boundary.

### 16.1 Creator app updates and migrations — agreed direction

- Keep update controls per service. Third-party automatic updates may be
  disabled independently for each service; an admin can review and approve an
  update for that service, with its publisher, version, and requested changes
  visible.
- Admin approval may authorize the service update, but never host-root
  execution. Migrations stay inside the restricted migration sandbox even
  after explicit approval.

### 16.2 Companion Remote build/deploy — agreed direction

- Companion Remote remains read-only by default. An admin may grant
  **Build and deploy** independently for a named service, after a warning that
  the session can change that service's code and release a version.
- Scope the grant to the named service, expire it with the companion session,
  and make it revocable. It grants no access to other services or host secrets.
- No private security/signing key is ever present in the website. Send every
  required user-signing operation to the phone for biometric approval; the
  website can request an action and submit the resulting signed order. Keep
  build credentials on the server and keep delegated authority within its
  phone-approved scope.

### 16.3 Community adapters — current behavior and owner decisions

- Current code does perform deterministic validation before queueing a
  submission in D1/R2: source/revision and license checks, adapter-rule and
  edited-file checks, plus checks for added secrets and server addresses. The
  ordinary submit response is asynchronous (`202`); `wait: true` returns the
  validation verdict. Passing those checks is not a human security review.
- The AI review is optional (`ADAPTER_REVIEW_ANTHROPIC_KEY`) and cannot be
  treated as an authorization decision. With no key, rule-passing adapters may
  still be queued and included by the daily publisher in the public
  `ibisllc/flagship-adapters` repository. Boxes currently consume that shared
  catalog automatically.
- **Owner decision:** preserve deterministic validation and show the AI-review
  status prominently. When review succeeds, say the community adapter was
  checked with AI and that this is not a safety guarantee. When review is
  unavailable or fails, label that plainly; do not imply it was checked. This
  status does not prevent an admin from choosing to install after reviewing
  the exact diff and acknowledging the warning. AI review remains advisory and
  never authorizes an adapter by itself.
- **Owner decision:** offer manual digest acceptance or the revocable,
  per-service option “Always trust adapters vetted by Flagship using AI.”
  This standing policy lasts indefinitely and accepts each exact digest only
  with a currently valid Flagship-signed AI-vetting attestation. Every changed
  unvetted digest still requires manual acceptance; accepting one does not
  authorize future unvetted versions. Show source project, revision, digest,
  review status and useful change summary. Keep choices independent by service.
- Encourage adapter authors to make updates survive minor upstream releases:
  prefer stable public interfaces and semantic anchors over brittle file
  offsets, keep changes minimal, declare compatibility ranges, and validate
  against representative upstream versions. Track compatibility evidence and
  report when an adapter no longer fits its base instead of silently applying
  it.
- Provide a simple, searchable public directory of projects with community
  adapters. Include the upstream project and owner links, license, adapter
  status, supported versions, review status, and latest digest. Make it easy
  for a maintainer to contact Flagship or contribute/adopt an official
  `flagship.app.json`; do not expose submitter or box-owner identities.
- Enrich the adapter manifest with versioned, typed capability declarations
  so adapters can request useful integrations and service features. A
  declaration is a request, not a grant: capabilities are default-deny,
  explicitly approved by the admin per service, enforced by narrow brokers,
  and included in the digest-bound review/acceptance. Never let adapter JSON
  grant host access, read another service's data, or bypass the app sandbox.

### 16.4 Lost-device account recovery — agreed direction

- If the owner has lost all registered devices but can complete the enrolled
  passkey recovery ceremony, allow them to start a pending new-device
  enrollment. Preserve any recovery passphrase required by that enrolled
  ceremony; do not require approval from a device they no longer have.
- Apply the agreed waiting period and notify every active admin immediately.
  Any active admin may reject/remove (“boot”) the pending device during the
  wait. If no active admin rejects it before the wait ends, activate it under
  the existing quarantine and audit rules.
- The pending device has no admin authority during the wait. The current IRK
  alone cannot skip the wait or the active-admin rejection window. This policy
  is meant to preserve recovery usability while giving a remaining co-admin a
  practical chance to stop a stolen-passkey takeover.

### 16.5 Headless browser access and service isolation — agreed direction

- The headless browser is a useful way for apps to reach websites and should
  remain flexible. An app may ask the harness for a browser feature or URL;
  the harness presents the request to the user/admin, who can approve it for
  that service. Provide practical grant durations such as once, this session,
  or remembered for that service, with a clear way to review and revoke grants.
- The app must clearly state its requested access list. The admin may approve
  exact URLs and/or wildcard domains for that service, with a clear explanation
  of each wildcard's reach. Treat that list as permission for the service to
  perform the navigation behavior it entails: redirects initiated by approved
  sites may reach other public destinations without another prompt. Explain
  this reach at approval; do not claim listed sites are a strict destination
  boundary. Unrelated direct destinations require added scope or the optional
  public-web grant. Local/private access needs a separate exact-device or
  revocable whole-local-network grant; protected host services and metadata
  stay blocked.
- Services from the same developer do not get to inspect each other's browser
  state, cookies, local storage, DOM, or JavaScript data by default. There is
  no security benefit in letting one service silently take another's data just
  because their publisher matches. If a real product feature needs sharing,
  provide an explicit service-to-service API or broker permission that names
  the data and actions shared and is approved by the user/admin. Keep separate
  browser contexts regardless of publisher identity.

### 16.6 App-to-app messages — agreed direction

- Extend the existing sibling-chat API, retaining permissionless messaging
  among the owner's own deployments and adding cross-deployment addressing
  (for example, `message(receiverAppAuthor, receiverAppSlug, rawMessage,
  deployUser = self)`). A cross-user target is only the canonical logical
  address `author--app.targetuser`; there is no server selector or cross-user
  broadcast/fan-out option. The current
  `/api/live_siblings/*` and multipod APIs are mainly same-app replica tools;
  extend them deliberately rather than exposing their live peer list as a
  general app-discovery API.
- A listener subscription is logically keyed by
  `(appAuthor, appSlug, deploymentScope = local-only | all, serverScope = a
  server | all)`. Registering a listener—even one that accepts messages from
  anyone—does not itself prompt the user, create an outbound connection, or
  authorize cross-deployment traffic. It only says which messages this app is
  willing to receive, subject to the cross-deployment grants below. Prefer
  explicit scope defaults (`local-only`) so `all` is an intentional choice.
  Server-specific listener/replica controls remain local to the owning
  account; they do not create externally addressable server-specific inboxes.
- Each initial send creates a conversation and returns a conversation code to
  the sender. The recipient receives
  `(senderAppAuthor, senderAppSlug, timeSubmitted, rawMessage,
  recipientConversationCode)`. Replies use
  `message(recipientConversationCode, rawMessage)`; the harness routes them to
  the original sender, which receives its own distinct code for the same
  conversation. The harness keeps the mapping; the apps do not learn each
  other's routing codes or need to reveal network addresses to keep a
  conversation going. Use three independently generated, high-entropy random
  identifiers: app 1's local conversation ID, an inter-harness conversation ID,
  and app 2's local conversation ID. The harnesses translate among these three
  namespaces; no app receives the other identifiers. Each harness validates its
  own binding to its local app runtime, authenticated remote peer, recipient,
  authorization and session generation; the remote harness cannot select or
  overwrite that binding. Authenticate inter-harness frames and reject unknown
  or mismatched routes. Random IDs prevent accidental reuse and guessing but
  do not themselves detect a corrupted routing table: validate the complete
  route binding and fail closed on inconsistencies. Every app call also
  authenticates its app token; knowing another app's ID grants no access.
- Keep conversation mappings in bounded runtime state. A conversation becomes
  established only when the first reply is delivered back to the initiator;
  an initial one-way/spam message is not a live conversation and must not be
  counted as a reply relationship. If a runtime loses its mapping, a later
  send using that runtime's stale conversation ID may produce a local
  `conversation-dead` result only for a conversation previously established
  as two-way. Do not reveal this state to an unrelated app or remote sender.
  Retain a minimal established-conversation record or obtain authenticated
  evidence from the surviving peer before emitting this result; if all such
  evidence is lost, the harness cannot infer prior two-way establishment.
  Bind new random IDs to a fresh runtime generation so stale references cannot
  attach to a new conversation. Apply table-size, payload and rate limits;
  lifetime authorization ends on explicit revocation or lost conversation
  state, rather than an arbitrary timer silently contradicting **Allow**.
- Cross-owner communication is a separate trust relationship because boxes
  must establish network contact and direct connectivity can expose addresses.
  An outbound cross-network attempt alerts the sending admin before contact;
  the alert identifies the target app/deployment and can carry an optional
  human recognition phrase (generated as a six-digit code by default, editable
  to at most 30 characters). The phrase is shown to both admins so they can
  compare it through a separate channel; it only helps if the receiver has an
  independently expected phrase. A phrase supplied by an unknown sender is
  not identity proof. It is not an authentication factor, message content, or
  substitute for bilateral approval; protect it in transit between admin
  notices and keep it out of ordinary logs.
- For inbound traffic, first check whether the local target app currently has
  a matching listener. If not, discard the initial message silently: do not
  alert, queue it, or reveal that no listener exists. If a listener exists,
  alert the receiving admin before delivering the body to the app. Identify
  the request as “a remote machine claiming to run [sender slug] by [sender
  author] is trying to contact your copy of [receiver slug] by [receiver
  author]”; show the optional recognition phrase if
  present. Offer **Allow** (authorize this conversation for its lifetime) and
  **Always allow** (let any foreign app start conversations with this local
  app, without per-sender prompts). Both grants are scoped to that receiving
  app, revocable, and lost if the relevant harness authorization state is
  reset; listener registration alone never creates either grant. Continue to
  require an authorized listener for delivery even under **Always allow**.
- An invited visitor can instead present cryptographic proof of active access
  to the recipient's restricted app, explicitly authorizing harness chat on
  that visitor's behalf. Validate the redeemed grant and proof of possession;
  a shareable invite URL or knowledge of an invite secret alone is insufficient.
  Bind a fresh challenge/proof to that exact recipient app/deployment, visitor's
  per-app identity, requested chat purpose, source endpoint/session, expiry and
  one-use nonce. User signatures follow the phone/biometric rule above; the
  website never holds the signing key. Re-check revocation and derive the
  visitor's current effective `member`, `manager` or `master` rank at the
  receiving harness; never accept a caller's asserted rank. Re-check access on
  later deliveries: withdrawal ends the invitation-authorized channel and
  rank changes update delivered authorization metadata without inventing a
  harness-wide prohibition on writes by rank.
- Valid invitation-bound chat authorization replaces the receiving admin's
  per-contact alert. Deliver verified access status and rank separately from
  raw message text so the app can apply its own rank policy. This proves that
  a current app visitor authorized the connection, not that the remote machine
  runs publisher-authentic code. Preserve per-app visitor identity isolation:
  no account-wide identifier is exposed across apps. When existing authority
  also covers the outgoing route, no additional chat-admin alert is needed;
  an app-access grant cannot override another server owner's outbound policy.
- Permit one active invitation-authenticated conversation per visitor identity
  and recipient app, across all of that app's servers and the visitor's
  devices/invites. The current app lead is the sole authority for admitting
  cross-user starts and atomically reserving the slot. Record consumed proof
  nonces and active bindings so retries, replay and ordinary restarts cannot
  open a second conversation within the same lead generation. After validating the
  visitor's current proof, a duplicate start can return “This connection has
  already been used; consider alerting the remote administrator.” This result
  is confined to that authenticated visitor's own slot; unrelated callers
  retain the generic acceptance response. Deduplicate retries of the same
  request. A verified close/dead state releases the slot for a fresh authorized
  start; never reuse an already consumed proof or silently replace the current
  conversation. No-listener drops do not consume a proof or reserve a slot.
- Scope outbound and inbound grants to app identities and deployment scope;
  after approval, re-check them at delivery and make revocation effective
  promptly. Coalesce/rate-limit pending approval alerts and cap pending state,
  but do not alert at all when no listener exists. Messaging among the same
  owner's servers remains permissionless. Prefer daemon-to-daemon connectivity
  so app code is not given peer IPs; explain that direct connections can reveal
  addresses to the other box. Do not retain recognition phrases in ordinary
  logs or expose them to app code.
- Cross-user traffic always resolves the canonical app/user address to its
  current authorized app lead. Knowing another server's name does not permit
  bypassing that lead or opening a separate cross-user inbox on a sibling.
  The lead distributes routing and internal-state changes to its siblings;
  this replication is internal and invisible to external callers. Validate
  lead changes against the account's signed authority and fence former leads
  using a generation so two servers cannot independently admit conversations.
  Exclude the sending app runtime from every recipient search.
- A catastrophic lead change may lose conversation routing and terminate
  existing conversations. The harness does not promise transparent recovery,
  reliable delivery, or exactly-once app effects. Document this for app
  developers: cache needed state, use application message IDs, ACKs, retry and
  deduplication, and establish a new conversation when necessary. Planned lead
  changes may transfer state; catastrophic recovery starts a fresh routing
  generation and rejects old handles and old-generation admission proofs.
  Fresh visitor proof and current app-access authorization are required to
  reopen a lost invitation-authenticated conversation. Loss of routing state
  must never restore withdrawn access or silently authorize an old session.
- Use immutable canonical app identity `(creator, slug)` (shown to people as
  `slug--author`). It is defined on `feat/marketplace`, so this feature must
  branch from that dependency rather than invent an incompatible identity.
  An honest local harness derives sender identity from the app token, preventing
  one local app from impersonating another. A remote machine owner can modify
  their harness and claim an arbitrary app author/slug; authenticating the peer
  box does not attest to its software. Treat remote app identity as a claim,
  and expose verified invitation/access facts separately. Keep app identity
  consistent across local and cross-deployment messages: canonical app identity,
  not a mutable
  display name or globally reusable account/server identifier. The harness
  uses deployment identity internally to apply the bilateral grant, but the
  app-facing inbound tuple need only contain claimed remote app identity,
  submission time, body, and its local conversation code; do not disclose
  sender account/server identity by default. The opaque
  conversation code is a per-conversation routing handle, not a stable peer
  identity. Apps may exchange additional self-asserted protocol details in the
  body. Without `deployUser`, route only within the owner's deployments.
  Cross-user callers select the target user/app and cannot select its server.
- Messaging among the owner's own deployments and listener registration do
  **not** prompt or require admin approval; a listener may accept messages from
  any sender. Its scope selects which deployment(s) of the receiving app listen,
  not an allow-list of sender identities. Cross-owner sends require the sending
  admin's outgoing and receiving admin's incoming approval, scoped to app
  identities and deployment scope, or the verified invitation-bound chat
  authorization above; listener registration itself does not approve that
  relationship. Advise app builders to handle untrusted senders
  safely and to ignore or stay silent toward spam rather than registering
  listeners across every deployment without need.
- A send response means only “the harness accepted this message for
  processing.” For cross-deployment sends, it must not reveal whether the
  remote app, deployment, or approval exists; use the same response for
  unknown targets, missing grants, offline/closed receivers, no matching
  listener, and non-response. Do not expose delivery/read receipts. The
  recipient independently decides whether and how to reply, and replies are
  subject to the reverse-direction grant. The harness's connection method is
  an implementation choice: relaying avoids direct peer-IP disclosure but
  exposes routing metadata to the relay; direct box-to-box connections reveal
  peer IP addresses to the boxes, so preserve the bilateral warning/approval
  if direct routing is used. Exchanging a domain in the app payload is an
  app-level choice and is not required by the conversation-code mechanism.
- Bind locally authenticated sender identity, remote app claims and verified
  visitor-access facts to separate fields in the harness envelope; raw message
  text cannot override them. Treat free-text bodies as hostile app data, including when an
  app passes them to a model: never as system instructions, executable content,
  or proof of authority. Add payload limits, expiry, replay/deduplication
  controls, per-app quotas, and abuse monitoring. Rate-limit senders that
  generate unusually high unanswered traffic, using aggregate volume and
  unanswered ratios with gradual cooldowns; do not expose per-recipient
  delivery or response facts to the sender. Preserve legitimate fire-and-
  forget uses: a lack of reply alone is not proof of spam and must not trigger
  an immediate blanket ban.
- Preserve the platform's content-privacy boundary: control-plane and relay
  components should route end-to-end-protected message bodies and avoid
  plaintext retention. Routing metadata (source/target app identity, optional
  server, timing, and volume) may still reveal relationships to infrastructure
  operators; document this limit and minimize/log-protect metadata.
- Once the API ships, add a model-prompt chapter for building/adapting services
  that documents initial send, listener scopes/filters, per-side conversation
  codes and async replies, cross-deployment approval and invitation-proof
  exceptions, lead-only cross-user addressing, catastrophic lead-change
  recovery, the one-active-conversation rule, safe listener patterns,
  message-as-untrusted-data handling, and spam etiquette. Do not advertise an
  API before its harness and routing implementation exist.

### 16.7 Install, fork, update and persistent security UX — agreed direction

- Keep the install screen lean. Retain existing create, Git-import and
  marketplace paths where available; do not add a generic “install from
  anywhere” picker. The per-service page already offers an app backup archive.
  Add one “Install from archive” path only if implementation review confirms
  there is no matching single-app archive import; reuse that service-backup
  format rather than inventing another package type.
- An unchanged third-party bundle remains signed by its actual publisher. A Git
  repository compiled by Flagship into a local app is authored and signed by
  the local user. Editing an installed app with AI/MCP creates a locally
  authored, locally signed fork. Preserve upstream repository, publisher,
  authenticated source status, and exact base commit as provenance; provenance
  is not authority to execute or overwrite the local fork. The permanent
  author/app identity and per-server publisher-key pin rules in §18.11
  still apply.
- The app owns portable-data and session serialization. Flagship transports the
  files declared by the app's export; it does not secretly inspect or migrate
  browser sessions. An owner-created archive is signed over its exact manifest
  and contents, is presented as an owner-authored snapshot/fork, and does not
  restore permissions, credentials, revoked authority, or upstream signing
  identity. Explain sensitive session contents and require explicit export and
  import approval.
- Offer “check upstream / propose sync” for a fork with recorded upstream
  lineage. It fetches one verified candidate commit and stages a three-way
  comparison/rebase against the recorded base and local edits. It never silently
  changes the fork and is not covered by the upstream app's automatic-update
  setting. AI-assisted conflict repair runs only in isolated staging with
  sample data and redacted output. Before a model call using a user's key or
  paid credits, disclose provider and reasonable cost/credit estimate and get
  per-operation consent. Show commit, source/capability/adapter diff, conflicts,
  test and health results, and data/schema effects. The owner separately
  approves the exact staged artifact for promotion. Failure leaves live code
  and data untouched; rollback preserves current revocations and authority.
- Keep each security-sliver item independent and visible for its own duration;
  the sliver grows instead of collapsing or truncating. Active issues remain
  until resolved; after resolution use minimum visible durations of 90 days for
  critical, 30 high, 14 moderate and 7 low. Approval/acknowledgement does not
  shorten or reset the timer. Platform policy sets severity; app text cannot.
  Expired items remain in audit history. Avoid duplicate push loops for an
  unchanged condition.

## 17. Implementation contract for the owner decisions

This section makes §16 actionable. It specifies desired behavior, not work
already implemented. Earlier emergency restrictions apply until their safe
replacement passes its gates; permanent policy is §16 plus this contract.
Update earlier matrices and tests when implementing a replacement so an old
blanket prohibition does not defeat a deliberate scoped grant. Preserve the
isolation, signature, key-custody and artifact-verification boundaries in §2.

### 17.1 Shared authorization and phone-signing mechanism

- Put versioned canonical payloads and verifiers in `packages/protocol`, using
  the existing purpose-tag conventions. Separate approval of a capability from
  approval of an exact operation. Payloads bind issuer, audience, account/app
  scope, action, relevant content digest, request nonce, generation and expiry.
  Do not sign arbitrary strings supplied by a website or app.
- The browser submits an unsigned action request. The daemon/control plane
  supplies the authoritative typed action and a fresh challenge. The phone
  validates its target against locally trusted identity, displays the action,
  obtains biometric approval, and signs. The recipient verifies signature,
  scope, freshness, generation and single-use nonce before atomically applying
  it. Changing any field requires a new signature. Return a result tied to the
  original request ID; a request acknowledgement is not action completion.
- No private account, recovery, signing, access-proof or box key is exposed to
  website JavaScript, browser storage, URLs, analytics, downloads or tool
  output. Short-lived scoped UI sessions carry no signing authority. Keep
  normal infrastructure signing in native/box principals. Inventory and remove
  existing frontend key generation/import/export/signing paths when migrating;
  move those user workflows to the phone rather than silently disabling them.
- Store grants as typed records with an immutable grant ID, exact subject and
  scope, signature/provenance, generation, creation/expiry and revocation state.
  Expiry is optional for lifetime conversation grants; session delegations
  must expire. Keep admission-proof expiry separate from conversation lifetime.
  Check live authority at execution, not just when the UI opened. Persist
  consumed sensitive-order nonces and revocations against replay/restore.
- Put permission settings under each service, with Allow once / Session /
  Remember where appropriate, readable scope, expiry and Revoke. A grant for
  one service never expands another service's authority. Pending requests can
  be denied/cancelled and are bounded; do not repeatedly prompt for a denied
  operation until its request/scope materially changes or the admin retries.

### 17.2 Service updates, adapters and companion workflows

| Workflow | Record and enforcement | Completion/failure behavior |
|---|---|---|
| Third-party update | Per-service update policy; creator identity, release digest, capability diff, migration manifest and snapshot ID | Stage first; phone approves new authority. Opted-in code-only updates may follow policy. Execute migrations only through §10.1 sandbox; report code/schema generation together and restore the snapshot only through the declared rollback path. |
| Community adapter | Per-service manual acceptance of an exact digest, or standing trust in exact digests with valid Flagship AI-vetting attestations; bind source/base revision, review evidence and capability digest | Show AI review success/unavailable/failure accurately. Changed unvetted digests require manual acceptance; standing vetted trust is indefinite and revocable. Capability expansion still needs approval. Malformed artifacts or failed integrity checks cannot be made valid by clicking through a warning. |
| Companion delegation | Phone-signed grant binding companion session, named service, permitted build/deploy operations and expiry no later than session expiry | Default read-only; verify the grant on every tool/route and revoke derived credentials with it. Keep build credentials server-side. Operations requiring signed orders, including an exact release install/deploy where required, still go to the phone with the release digest. |

Implement update/migration changes at `servicePlatform.ts`, `updateClient.ts`
and `runMigration.ts`, rather than adding a UI-only toggle. Enforce companion
scope centrally before build/LLM handlers as well as inside downstream tools.
For adapters, update submission/publishing metadata and on-box consumption:
acceptance is not a property of the public catalog. Keep the searchable adapter
directory and upstream-maintainer outreach described in §16.3; distinguish an
upstream-authored adapter from an independently submitted community adapter.

### 17.3 Browser permission mechanism

- Store a per-service grant containing capabilities/actions, normalized origin
  patterns, optional URL restrictions, allowed schemes/ports, local-network
  exceptions and duration. The app supplies an explanation and requested list;
  the harness shows the normalized effective list to the admin. Preserve a
  separate persistent browser context for each service.
- Compile exact hosts and approved wildcard domains using parsed URLs and DNS
  label boundaries. Define wildcard apex matching explicitly; `*.example.com`
  must never match `example.com.attacker.test`. Show the expanded meaning of
  broad grants. A URL path restriction is not an independent browser security
  principal: the same-origin site may execute scripts with that origin's
  authority, and the prompt must not claim path-level cookie isolation.
- Apply the effective grant to navigation, redirects, subresources, workers,
  WebSockets, popups and downloads. Approved-site redirects proceed without
  another prompt, including to other public origins. Track the actual redirect
  chain and resulting document in the browser manager; app-supplied claims of
  a redirect cannot expand scope. The resulting page can perform its approved
  browser actions. Unrelated direct navigations/links outside effective scope
  can request added scope. Local-address and metadata protections still run
  after DNS resolution and on every redirect, even under a wildcard grant.
- All reads/actions verify tab/context ownership and effective current scope.
  A transition between two covered origins is permitted; an origin mismatch
  means departure from the effective grant, not any change of hostname.
  Revocation cancels affected pending work and prevents further reads. Keep
  same-publisher services isolated; explicit harness messages can exchange
  voluntarily shared data without exposing another context's storage.
- Implement in the browser manager/context registry and network interceptor,
  with `browser/apiHandlers.ts` using those checks. A route-only URL check
  cannot enforce redirects or requests initiated by page scripts.

### 17.4 Lock, recovery and hardware UX mechanisms

- Treat power state and boot-suspension state as independent reported results.
  A phone-signed lock starts durable suspension/lease revocation and requests
  shutdown immediately. Show confirmed states only; retain/retry the pending
  remote operation while accurately reporting unavailable confirmation.
  Lock-and-restart waits for durable suspension first. Resume requires a later
  phone-signed generation; lease renewal alone cannot resume a suspension.
- Couple dead-man lease expiry to the signed affirmation deadline before the
  timer can be advertised as active. An offline final suspension post must not
  leave an auto-unlock lease valid beyond that deadline. Exercise phone, box
  and boot-worker failures independently.
- Recovery is `requested -> waiting -> activated` or `rejected/cancelled`.
  Record server-side start/activation times and the enrolled recovery proof;
  notify active admins immediately. The pending device gets no admin/session
  shortcut. A valid veto wins atomically against activation. Use the existing
  agreed wait duration and show its actual deadline across clients.
- Detect hardware capabilities during enrollment. Show hardware-isolated or
  software-isolated mode before enabling unattended unlock. Normal endorsed
  updates advance measured-boot policy through the approved path; unexpected
  measurements enter a distinct recovery ceremony. Software-mode acceptance
  cannot manufacture TPM protection or justify an evil-maid security claim.

### 17.5 Chat API and local data contracts

The following are logical contracts, not claims that endpoints already exist.
Expose one SDK over versioned daemon routes and extend the existing sibling
transport; keep replica-management APIs separate from public chat addressing.

```ts
listen({ originScope, ownedInstanceScope }): Subscription
message({ receiverAuthor, receiverApp, body, targetUser = "self",
          requestId, accessProof? }): { accepted: true, conversationId }
message({ conversationId, body, requestId }): { accepted: true }
close({ conversationId }): { accepted: true }
```

- Resolve the calling app/runtime from its app token. It cannot register for
  another app. `originScope` is same-account or all-accounts willingness;
  `ownedInstanceScope` selects this owned server or owned instances, never
  remote-owned servers. These explicit field names replace ambiguous `local`
  / `all` shorthand. Registering a listener never prompts an admin.
- A cross-user target is exclusively `author--app.targetuser`, resolved to its
  current authorized lead. Reject server selectors in cross-user requests;
  there is no remote server-list or broadcast operation. Local replica APIs
  may still address owned servers. Exclude the originating runtime from local
  recipient searches. External traffic always enters through the target lead.
- Return an initial local conversation ID without exposing remote existence,
  listener, approval or delivery state. Invalid local request syntax/auth can
  fail normally; all remote outcomes retain the generic accepted result.
  SDK events carry sender author/slug claims, submission time, raw body and the
  receiver's local conversation ID. Verified access/rank metadata is a separate
  harness field. Do not imply sender-supplied time is a trusted clock.
- Generate three independent CSPRNG IDs of at least 128 bits: local app A ID,
  inter-harness wire ID, local app B ID. Keep the two local IDs off the wire
  between peers. Each routing record binds its local ID, local app/runtime,
  peer identity/session, wire ID, logical target, lead generation, authority
  reference and state. Validate the full binding at each hop. Do not accept a
  peer-supplied local app ID or let a remote close overwrite another binding.
- Use the existing authenticated box identity/transport mechanisms to protect
  frames; infrastructure relays carry encrypted bodies. Box authentication
  establishes a peer key, while remote app author/slug remain claims. Do not
  invent application cryptography or turn an app message into arbitrary raw
  IP networking. Keep message payloads and recognition phrases out of logs.
- `requestId` deduplicates a local app's retries: the same authenticated caller
  and request return the same result, while changed content under that ID is
  rejected. This does not promise reliable delivery or exactly-once app effects.
  Developers use body-level message IDs, ACKs, caching and deduplication.

### 17.6 Chat admission, approval and conversation state

The initiator starts in `pending-outbound`; approved contact proceeds to
`pending-inbound`. The lead checks matching listener registrations before
queueing or alerting. No listener means immediate silent drop, with bounded
local pending metadata only; no inbound queue, no approval prompt and no proof
consumption. Match across internal registrations rather than bypassing the
lead to probe a sibling.

For a matching listener, admit when a standing receiving-app policy or a valid
invitation-bound proof applies. Otherwise hold an inert bounded request and
ask the receiving admin, using the “remote machine claiming to run…” wording.
The sender's admin authorizes previously unapproved outgoing scope before
contact. Existing authorization avoids repeated prompts within that scope.
The recognition phrase is optional UI-only metadata: six generated digits or
up to 30 user-selected characters, encrypted in transit and never delivered to
the app. Its value is comparison through an independent human channel.

**Allow** authorizes this conversation until revoked or its state is lost.
**Always allow** authorizes new inbound conversations from anyone to this
receiving app while that policy remains valid; it does not authorize other
apps, create a listener or approve another owner's outgoing traffic. Include
deny/cancel/revoke actions. Group repeated pending requests, cap pending body
bytes/count/age, and rate-limit alert creation separately from messages.

Bilateral conversation approval includes replies in that conversation; no
second outbound approval is required merely to answer. It does not authorize
unrelated new conversations or other apps.

An admitted first message enters `awaiting-first-reply`. Mark `established`
only after the return message reaches the initiator harness; an authenticated
internal acknowledgement lets the peer update its state. That acknowledgement
does not become a public delivery receipt for unestablished first contacts.
Closing, lost route, revoked authority or a fenced lead ends the channel.
Emit `conversation-dead` only to a previously established participant for which
there is retained or peer-authenticated establishment evidence. If all evidence
is lost, expire the local unknown route without inventing past establishment.
Keep a small metadata/tombstone ledger if this notification must survive an
ordinary restart; do not retain bodies solely to implement it.

### 17.7 Invitation proof and one active conversation

- Obtain the receiver lead's fresh challenge bound to logical app/user target
  and current lead generation. The invited visitor's phone signs a typed chat
  authorization using the app-specific identity associated with redeemed
  access. Bind the challenge, nonce, current access-grant reference, source
  endpoint/session key, requested purpose and short admission expiry. A browser
  cookie, copied invite URL or arbitrary signed text is insufficient.
- The receiving lead verifies proof of possession and the existing app-access
  authority, resolves the visitor's stable per-app identity across their devices
  and invite grants, checks revocation, and computes current effective rank.
  It passes verified access/rank separately to the app, whose own code decides
  what the rank may do. The grant authorizes a visitor's chat connection and
  attests nothing about code on the visitor's remote host.
- In one atomic transaction, check/deduplicate the request, check/consume its
  fresh nonce, and reserve `activeChat(recipientApp, visitorPerAppId,
  leadGeneration)`. Only the current lead performs admission. An existing slot
  produces the agreed duplicate-connection warning only after valid current
  proof for that same visitor; other callers see generic acceptance. A retry
  of the same request returns its existing result instead of a duplicate alert.
- Admission reserves the single slot even before the first reply; establishment
  remains a separate two-way state. A bounded pending-admission timeout can
  close the old routes and release an abandoned unestablished slot atomically;
  a late reply on that closed route cannot revive the reservation. Close/dead/revoked state releases
  the slot; a consumed nonce is never reusable. Do not persist duplicate
  reservations for different servers/devices of the same visitor.
- Re-check visitor access and rank during delivery. Withdrawal ends the channel;
  demotion changes metadata without the harness inventing app-specific rank
  restrictions. Valid prior access grants remove the receiving-admin alert;
  they do not override an independent sending server owner's network policy.
- Provide an authenticated “close my existing conversation” action for device
  switching, followed by a fresh signed start. Competing starts never silently
  evict the existing slot. Bind the slot to recipient installation and
  recipient-scoped visitor identity; unrelated apps or recipient deployments
  must not correlate that visitor through a shared identifier. Admission-proof
  expiry does not expire an established conversation-lifetime grant.

### 17.8 Lead changes and state-loss boundary

- Reuse the account's signed lead/route authority, with a monotonic generation
  and fencing check on admissions and inter-harness frames. Gossip alone cannot
  make a new lead authoritative. Reject stale generations; a partition cannot
  permit two independently authoritative lead admission paths.
  A generation number alone is not fencing: verify that the existing lead
  mechanism supplies an exclusive, bounded authority lease or equivalent
  quorum/transactional exclusion. Specify its clock/expiry assumptions and
  refuse new admissions when exclusive authority cannot be confirmed. Add this
  mechanism if the existing leader election only gives eventual convergence.
- The lead distributes routing/listener/permission changes and conversation
  metadata to siblings. Transfer a state checkpoint during planned handover
  where possible. Security-relevant access withdrawals and policy revocations
  must remain authoritative independently of optional message-body caches.
- Catastrophic replacement may drop every old conversation. A fresh generation
  invalidates old IDs, challenges, admission proofs and slot reservations.
  Reopening uses current app-access state and fresh proof; never restore a
  withdrawn right from an old checkpoint. Do not use simultaneous old/new lead
  acceptance to disguise recovery as seamless.
- Document failure events and recovery examples in the builder/adaptation
  prompt when shipping the API: app ACK/retry logic, message IDs, cached state,
  duplicate handling, first-contact silence, lead-loss reconnect and untrusted
  inbound text. Apply model privacy redaction when that information is returned
  to a model. Do not expose account/server identities through model tool output.

### 17.9 Integration sequence and acceptance evidence

1. Land shared signed-order/capability schemas, live revocation checks and
   phone flows; update the companion matrix and frontend key inventory.
2. Implement service-scoped updates, adapter acceptance/status, browser grants,
   lock status and recovery state transitions on all affected clients. Use the
   already specified migration/browser/boot isolation gates before re-enabling
   their emergency-disabled paths.
3. Build local cross-app chat on token isolation and the three-ID mapping; then
   add lead-only cross-user transport, approvals and invitation admission. Since
   canonical publisher/app identity depends on `feat/marketplace`, develop that
   feature on a dependent branch; do not ship unlaunched marketplace code on
   `main` as an incidental chat change.
4. Exercise meaningful negative cases: cross-app ID injection; corrupted/stale
   route binding; no-listener silence; cancelled/expired/revoked approvals;
   false sender labels; nonce replay; parallel starts on two servers; invite
   withdrawal/rank change; first-reply loss; split leadership; checkpoint loss;
   stale proof after catastrophic replacement. Verify bodies/keys/phrases do
   not appear in logs, browser signing state or model output.
5. Prove each UX exception as well as each denial: manually accepted unreviewed
   adapter, delegated one-service Remote build, approved wildcard/redirect,
   immediate shutdown with pending suspension, notification-free invited chat,
   app-wide **Always allow**, lifetime **Allow**, and fresh reconnect after lead
   loss. Record what actually shipped and what remains a design proposal.

These are implementation and verification instructions. Passing this document
review does not establish that the current code satisfies them.

## 18. Cross-cutting implementation contracts from the additional review

These requirements complete §§1–17; they are part of this plan, not optional
appendix material. They add implementation detail where the existing sections
were incomplete. If a generic proposal below conflicts with an explicit owner
decision in §§16–17, the owner decision controls; preserve its security
invariants and use these contracts to implement it. IDs N01–N14 are retained
for ticket traceability.

### 18.1 N01 — HTTP ingress and request framing

Replace the hand-written control-API HTTP parser with a maintained parser
behind the existing box-local TLS termination. Preserve SNI routing, ACME ALPN,
streaming and WebSockets; do not move TLS termination to Flagship. Until
replacement lands, make dispatch a one-way state transition before awaiting a
handler, pause/detach input and reject trailing or pipelined requests on
single-request connections. This is containment, not the final parser fix.

One parser interpretation must govern authentication, routing and forwarding.
Reject malformed request lines, duplicate/conflicting Host or authority,
invalid lengths, obsolete folding and ambiguous Transfer-Encoding/Content-Length
framing. Never concatenate or silently overwrite security headers. Bound
pre-authentication header bytes/counts, allocations, time and concurrency; use
32 KiB headers and 1 MiB control JSON as starting test limits, then benchmark
real clients. Upload/archive routes have explicit streaming limits rather than
raising global caps. Enforce header/body/idle deadlines and backpressure on
relay, LAN and loopback; client disconnect cancels work where possible. Match
Host/:authority to authenticated SNI and supported aliases; derive forwarding
metadata from transport, discard caller-supplied forwarding/Connection-nominated
identity headers, and audit the streaming app parser too. Errors expose generic
IDs externally and sanitized detail locally.

Acceptance: the duplicate-dispatch regression seed in §18.17 invokes once;
exercise malformed/duplicate headers, TE/CL conflicts, fragmented and slow
headers, disconnects, WebSocket upgrades and repeated transport delivery. Every
case has one bounded result. Legitimate large uploads remain streamed; no
service-level override can waive framing ambiguity. Reference RFC 9112 §6.3.

### 18.2 N02 — One destination policy, enforced by each dialer

Use a reviewed binary-address classifier with CIDR comparisons, normalizing
IPv4-mapped IPv6 before classification. Cover expanded IPv6, unspecified,
loopback, private, link-local, multicast, mapped/translation and reserved
ranges, scoped/interface-local addresses, plus public-address hairpin paths to
the owner's own box/control plane. Share the parser/classification library
across browser egress, Git imports, provider URLs, adapter fetches, webhooks,
backups and domain validation; then verify every real dialer enforces it.

Resolve, classify, select and dial the numeric address without a second
uncontrolled DNS lookup; retain the hostname for TLS verification. Re-check
every redirect, reconnect and alternate route. Put host-driven Git/fetch work in
an unprivileged network namespace or broker; disable untrusted Git redirects,
SSH proxy commands, credential helpers, hooks, global/system config and
unapproved protocols. Private-repository access may use an exact per-service
endpoint grant and scoped credential. IPv6 must be demonstrably disabled at
the relevant boundary or successfully filtered: inability to install ip6tables
does not prove it is disabled. Test Docker restart, interface/firewall reload,
container-IP reuse, raw sockets, host networking, alternative ports, UDP/QUIC
and spoofed/stale app-to-IP attribution. Do not start a workload before its
policy is active.

Be honest about TLS filtering: the transparent proxy sees SNI, not encrypted
HTTP paths, authority or bodies. A host grant permits data transmission to
that host, possibly a multi-tenant or upload service; it is not DLP. Reauthorize
every plain-HTTP request or close after one, reject unapproved CONNECT/tunnels,
and do not claim CDP Fetch alone covers WebRTC or every protocol. For strict
integrations, use a typed on-box broker that constructs requests. Keep DNS
filters' query reconstruction, record/additional-section validation and TCP/
UDP work bounded; wildcard DNS can carry data in names.

Phone-authorized browser actions bind service, context, tab, frame, document/
navigation generation, verified origin and exact operation. Invalidate input
when any binding changes; if the binding cannot be enforced at dispatch, cancel
the action and ask the user to retry rather than race-checking before/after.
Downloads/screenshots receive the same context/generation checks and bounded
retention. Permission choices remain those in §16.5 and §17.3: listed sites
(including their redirects to other public origins), public web, one
selected local device, or revocable whole-local-network per service. LAN grants
never include metadata, host control APIs or another app's data.

Acceptance: E01 classifier vectors; DNS rebinding cannot alter the dial;
Git redirect cannot reach metadata; correct behavior for redirects, public web,
approved LAN devices and IPv6; every browser/navigation transport uses the
effective grant. Reference OWASP SSRF Prevention Cheat Sheet.

### 18.3 N03 — Sign the complete recovery record and its evolution

Version recovery records so signatures bind every behavior-changing value:
account authority generation, credential ID, wrapped-UMK digest,
wrapped-admin-root digest, retained wrapped ACME-key digest, fetch-token hash,
PRF-salt hash, KDF/algorithm versions, intended recovery policy, record
generation and nonce. For updates/deletions bind the prior record digest and
represent optional fields explicitly as `keep`, `replace` or `remove`; omission
cannot inherit security state silently. Check ciphertext sizes/digests before
storage and validate the same envelope in native clients before unwrap.

Audit each signed protocol field: accepted fields, behavioral effect,
canonicalization and verifier. Reject unknown security-bearing fields within a
version, use explicit protocol version changes, preserve purpose tags and
separator checks, and define UTF-8, integer bounds and duplicate-key handling.
Use shared TypeScript/Swift/Kotlin vectors. Do not rewrite deployed canonical
bytes without a migration plan.

Migrate recovery on the phone, retain the working old record until the new one
has been verified by a real restore check, and label unsigned legacy extras.
Unavailable verification blocks only the affected update/enrollment with a
specific upgrade path.

Acceptance: mutate, omit, swap and replay every field; no valid signature may
authorize a different effective record. Use compare-and-swap for concurrent
changes. Malicious storage substitution is detected; suppression/unavailability
remain documented limitations.

### 18.4 N04 — Enforce recovery wait/veto at the authority layer

The wait/veto rule in §16.4 must survive direct possession of a recovered IRK
and admin root. Separate account/recovery proof from operational device
authority. Sensitive actions require a device signature and locally verified
active enrollment; caller-supplied device IDs are not authority. A root starts
recovery but cannot directly authorize ordinary sensitive actions, activate a
device, replace the root or weaken recovery policy. Active devices continue to
approve normal enrollments.

Define typed, generation-bound `RecoveryStart`, `RecoveryVeto`,
`RecoveryCancel` and `RecoveryActivate` events for a specific pending ID,
device key, recovery method and deadline. Persist state and make transitions
atomic; a valid veto accepted before activation wins every race. Cancel derived
pending credentials too. Trust Flagship's signed recovery ledger/clock for
ordering, deadline and receipt of vetoes. Signed vetoes can be carried by
periodic authenticated peer status updates; peers retry/forward until Flagship
durably acknowledges. Push is only a wake-up hint. The wait window is at least
twice the configured offline-alert threshold and longer than the peer retry
budget plus margin; freeze both threshold and deadline when the attempt begins.
No requirement that a lost/offline device acknowledge.

Before veto signing, show a deliberate “Are you sure?” screen naming the
recovery attempt and stating that veto cancels it and a retry begins a fresh
full wait. Require phone biometric signing; a push swipe or accidental single
tap is insufficient. Immediately alert active admins and show start, deadline,
veto action and attempt status in the durable inbox/sliver. Independently show
offline device/server banners with last contact and delayed-update implications,
and this prompt: “If this is unusual, please check on the physical safety of
your device and server.” Silence alone is not proof of attack. The warning
supplements, never replaces, immediate recovery notices.

Persist enrolled authority mode outside optional config. After device-authority
migration, missing/corrupt state enters native recovery rather than falling back
to bare-root/IRK mode. Add verifier support first; migrate each box only after a
working native admin and recovery path are verified. Mark legacy boxes visibly;
they cannot claim the new guarantee.

Acceptance: give a pending device both old roots and try every sensitive route;
deny until activation. Exercise veto/activation deadline races, replays,
out-of-order/retried peer updates, lost acknowledgements, configured timing and
the 2× rule, offline banners, literal physical-safety text, fat-finger guard,
fresh full wait after veto, ordinary admin enrollment and no-device recovery.
Retain the documented residual: a total partition may prevent a signed veto
from reaching Flagship before the deadline. Flagship is trusted not to activate
early or suppress a durably accepted veto. No UI should imply a delivery
guarantee through total partition. An active malicious admin can veto each
fresh attempt; a veto cancels only that attempt, never permanently disables
recovery. Do not add an automatic ignore-veto escape or an independent witness
requirement. Any future dispute route needs a separate owner decision.

### 18.5 N05 — Approval, execution and revocation are transactions

Keep separate typed grant and operation records. A grant identifies issuer,
subject, account generation, service installation, audience, capability and
constraints, parent grant(s), policy revision, issue/expiry/revoke state. An
operation identifies authenticated requester, idempotency key, canonical
payload hash, artifact/capability digests, expected state revision, grant
dependencies, challenge, approval deadline, state and result digest. These are
logical fields, not a new ad hoc wire format. A phone signature binds the exact
operation and expected target state; the phone derives its summary from
validated fields and trusted identity, not app-supplied marketing text.

Use durable states `requested -> awaiting-approval -> authorized -> executing
-> applied | failed | cancelled | outcome-unknown`. Persist before acknowledging
a durable transition. Consume approval nonce and operation atomically. Recheck
authority, generation, content hash, state revision and expiry at execution and
before irreversible commit. Use downstream idempotency IDs and reconciliation;
never blindly retry an uncertain destructive effect. Concurrent admin edits
use compare-and-swap and display changed state.

Index derived authority: companion/MCP/build tokens, jobs, browser actions,
downloads, streams, secret handles and conversations. Parent revocation
invalidates children and actively cancels open work, not just future HTTP
handshakes. If a migration crosses an irreversible commit, finish safe cleanup,
block new work and report actual outcome. Revocation cannot retract already
delivered data or undo external side effects. Initial target: enforce within
five seconds on reachable local components; offline components show pending
with N07 freshness deadline. Store revocation epochs outside ordinary app
rollback.

Use authenticated time/generation checkpoints for grants, recovery, boot leases
and update metadata. Track monotonic time during boot and durable authenticated
time across reboot. Backward wall-clock movement cannot extend authority;
forward movement cannot complete recovery silently. If software-only restore
cannot establish time, pause time-sensitive authority and offer native recovery.
Unauthenticated NTP or HTTP Date alone cannot decide a privileged deadline.

UX: one per-service Access and permissions page lists grants/children, scope,
expiry, device and Revoke; offer “stop this service and revoke its access.”
Secret-reading access is separate from ordinary read/GET. Acceptance: mutate an
approved payload, revoke during build/migration/browser/stream, race admins,
crash at each commit point and restore old state; prove scoped success and
cross-service denial.

### 18.6 N06 — Complete the keyless-web migration

Inventory browser key generation/import/export, unwrap, recovery, signing,
backup and cross-device flows (`recovery.js`, `keyfile.js`,
`keyfileBackup.js`, companion handoff included). Move usable setup/recovery and
keyfile workflows to native phone flows before removing web paths; document a
second supported native-device route so owners without a working phone are not
stranded. Rotate/revoke previously browser-held authority; deleting local
storage does not revoke stolen copies. Clear obsolete worker caches only after
a verified native transition and keep recovery for offline clients.

No private signing, identity, recovery, authorization or channel-encryption key
may exist in website JavaScript, even ephemerally. In particular, move the
companion QR handoff ephemeral X25519 private key to a reviewed native-assisted
flow. Web may relay opaque ciphertext or a short-lived scoped bearer ticket,
not private key/plaintext. Phone signs every required action after biometric
approval. Browser TLS keys are not website JS keys.

Treat bearers as sensitive authority: hash at rest if redisplay is unnecessary;
session lists show opaque IDs; audience/service/operations/lifetime are narrow;
revoke token families with parent device/grant. Remove long-lived URL tokens.
WebSockets use an authenticated single-use short-lived upgrade ticket bound to
route/session/service/Origin, atomically consumed and redacted from logs. Evaluate
HttpOnly cookie/BFF only with CSRF protection; CORS is not authentication.
Bind `postMessage` to exact origins/windows/nonces; isolate owner/Remote UI from
app origins, restrictive CSP, no third-party scripts on approval screens, safe
diff/name rendering and content-free pushes. Document that compromised web
hosting/service worker can misrepresent UI or steal browser-visible sessions,
while phone verification still protects signed actions.

Acceptance: inspect every browser-visible flow; test stolen/replayed tickets,
Origin mismatch, cancelled phone approval, stale worker, revocation during a
WebSocket and final-device recovery. No prohibited private key reaches web JS.

### 18.7 N07 — Freshness, propagation and exclusive leadership

Signed entries prove who authored them, not that a newer withdrawal is absent.
Keep ordinary convergence, but separately define current authorization. Each
authenticated checkpoint binds app installation, authority epoch, ordered
policy revision, revocation digest, leader term and freshness deadline. Verify
underlying owner/device signatures; the lead cannot invent membership. Use
causal revisions/conflict rules, not unbounded wall-clock last-writer-wins or a
peer-supplied far-future timestamp.

External guest/revocable permissions work only while the box holds a current
authenticated lease for that exact policy revision. On expiry, fail closed for
affected external access while preserving local owner control and app data.
Known local revocation is immediate. Duration must be chosen through a protocol
and outage threat model, not an unexplained five-minute default. Show which
replicas may still have old state and the actual deadline.

For every replicated security document (app-access list, browser URL allowlist,
adapter trust and others), display propagation lights bound to exact document
digest and replica: green for human devices, blue for servers, dark until
acknowledged, bright when that replica confirms. Distinguish offline/pending/
failed; never infer safety from dark or global freshness from bright. New edits
cannot inherit acknowledgements for old digests; retain history. Lights aid
operators but do not replace expiry enforcement. If a replica cannot refresh
before its lease expires, affected external access pauses. Preserve enrolled
owner local/native management and recovery during cloud outage.

Cross-user chat requires an exclusive lead term, not the highest gossip rank.
Multiple boxes need a persisted majority lease/term with explicit membership
and non-overlapping leases; singleton persists term locally. Planned handover
fences old lead. Loss of quorum stops new cross-user admissions, while local
messaging remains available; queued apps retry with bounded backoff. Catastrophic
replacement needs phone-authorized new term and former-authority expiry/fencing.
Clock drift and lease assumptions are protocol-reviewed. Generation alone
cannot instantly stop an isolated former lead. Keep high-water marks outside
restored service data; if every witness is lost, enter explicit recovery, never
guess freshness. The lease refreshes authority without expiring the user's
conversation-lifetime Allow or prompting again.

Acceptance: partition/restart a replica after access removal; verify guest use
stops after freshness expiry and resumes only after current revision. Test two
leads, clock jumps, stale checkpoints, regrant ordering, forced replacement and
propagation UI (“pending on one offline server,” not “revoked everywhere”).

### 18.8 N08 — Chat receiver safety and abuse controls

Preserve §16.6–§17.8: no admin prompt for local sends/listeners; foreign send
approval before app delivery when a listener exists; silently drop with no
listener; one cross-user logical target `author--app.targetuser` resolved to
lead; no sender-selected server; three different random IDs; invitation proof;
one active invitation conversation; no self-delivery; no false identity claims.

Permissionless delivery is not delegation of receiver powers. Messages are
untrusted data; reply is voluntary. A listener cannot use chat to borrow the
receiver's files, credentials, browser grant or outbound network permission.
Privileged RPC needs the receiver app's own explicit policy/capability. Provide
SDK examples that do not feed bodies to system instructions or execute URLs/
commands automatically. Trusted envelope fields (derived local identity,
remote claimed author/slug, verified access/rank metadata, time) are separate
from raw body. Remote author/slug is always a claim; filter text never proves
publisher identity. Scope local identity to installation/runtime generation.
If regex filters exist, use bounded non-backtracking evaluation and length/
complexity limits; start with explicit literal/glob semantics.

Bind routes to installation/runtime generation, grant dependency, peer key,
direction, lead term and close state. Use bounded monotonic replay counters per
direction and bounded replay window. Persist counters with restored channel
state or create a fresh channel generation. Retries reuse idempotency IDs and
do not duplicate within promised dedup window; do not promise exactly-once app
effects. Keep local conversation ID only in its app, wire ID between harnesses,
other app's ID private. IDs prevent guessing, not routing-table corruption.

Challenge/listener checks must not create an app-existence oracle. Initial
acceptance comes from a bounded local queue, independent of remote listener,
approval or delivery. A challenge is stateless/authenticated or equivalently
bounded; check listener before retrieving/consuming proof or alerting. Remote
outcomes use generic acceptance. Duplicate-slot warning is the narrow exception
after valid proof of that visitor's own slot. Do not expose delivery/read status.

Rate-limit across local app, peer key, receiving installation, source network
and host resource pool; claims can be invented and keys rotated. Bound starts,
bytes, pending approvals, fan-in, proof work and body lifetime before expensive
work. For unanswered-message abuse use absolute volume plus ratio/growth and
feedback, gradual cooldown; reply rate is not proof of innocence and silence
alone is not spam. Coalesce alerts and offer receiving-service Block/Mute while
preserving legitimate fire-and-forget behavior and emergency owner actions.
Recognition phrases are admin-only, encrypted, safely rendered up to 30 chars;
six digits are a human hint, never cryptographic authentication. Keep wire IDs,
peer coordinates and phrases out of models and ordinary logs. Cross-user
transport must protect bodies end-to-end from relays; routing metadata can still
reveal relationships and must be minimized/log-protected.

Once implemented, update `llm/systemPrompt.ts`, builder SDK and adaptation
guidance together with local sends, safe filters, cross-user approval, invite
proof, first-contact silence, lead-loss, safe RPC and spam etiquette. Use sample
identities only; never reveal owner/account/server placement or installed-app
inventory. Do not advertise unavailable APIs. Document local chat as a data
channel in app capability descriptions and offer listener pause/block controls
without initial-send prompts. A willing peer can share data it legitimately
holds; the platform must not promise non-exfiltration through permitted peers.
Acceptance includes confused
deputy, regex exhaustion, forged labels, proof relay, sibling/lead bypass,
missing-listener oracle, replay, crash/reset, mid-channel revocation, alert
flood and legitimate high-volume local-message tests.

### 18.9 N09 — Restore is a new execution/admission event

Inventory backups separately: app data/code, provider credentials, recovery
material and operational security state. Generic restore never restores session
tokens, consumed nonces, old leader leases, browser grants or current authority.
New hardware gets a new box identity. Portable apps own and document their
export/import boundary; credentials/sessions/authority are reconnected or
reissued separately. See §16.7 for app archive/signature/session rules.

Verify archive authentication, version, scope and manifest before activation.
Extract in disposable unprivileged quota-limited storage. Allow expected file
types/paths only; reject duplicates, conflicting normalization, links escaping,
devices and ambiguous sparse files. Bound manifest size, file count, expanded
bytes, nesting, decompression work and time before writing. Compare every part
with the complete manifest; reject missing/duplicate/unexpected parts. Integrity
does not prove benign content. Preflight space and reserve recovery capacity.
Pin executable image digests; tags cannot resolve to new code silently.

Restore DB as target app's constrained role. Cluster-admin dumps and Forgejo
repositories require separate isolated pipelines: never execute foreign SQL as
production cluster admin or extract untrusted tar to host paths. Audit triggers,
functions, hooks and executable metadata before starting with new credentials.
Restore permissions only as inert drafts, reconcile fresh signed revocations,
deny stale guests until §18.7 catch-up, rotate tokens/browser sessions/copied
provider credentials on scope/owner change, and never revive boot leases/chat
IDs. Summarize recovered data, code version, reconnects, permissions awaiting
approval and failed parts. Atomically activate coherent code/schema/data;
retain old working data until owner confirms; rollback never rolls authority
back. Use application checkpoint/quiesce for DB+files or disclose inconsistency.

Backups need independent recovery copies whose deletion credentials are
unavailable to app/daemon workloads, tested restore drills and owner-controlled
offline/native recovery if cloud/release services fail. Restore wizard reviews
at service level, not per file. An app archive install is one option only if
missing today; server-archive restore is separate. Show the archive's declared
contents before import and offer data export if safe executable restoration
cannot be completed. Keep its password/key native and out of model inputs.
Sensitive sessions require
explicit approval and native archive key custody. Acceptance: hostile archive,
oversize/duplicates, symlink swap, SQL/functions, hooks, old tags, partial
restore, full disk, power failure and revoked-user backup; data rollback cannot
revive revoked tokens. PostgreSQL executable restore warning:
https://www.postgresql.org/docs/17/app-pgrestore.html.

### 18.10 N10 — State honestly what lock/lease revocation can revoke

Deleting an online lease prevents future retrieval from an honest boot worker;
it does not invalidate a copied sealed lease plus its decryption key or disk
plaintext captured while unlocked. A database expiry is not cryptographic
expiry of downloaded bytes, and attacker-controlled software boot can ignore
local expiry. Distinguish shutdown, boot-service suspension and hardware/profile
guarantee in UI. Inventory sleep, hibernation, crash dumps, recovery media and
alternate LUKS slots. Never promise revocation of stolen plaintext.

For hardware-backed auto-unlock, prototype fresh per-boot authorization bound
to TPM-attested measured state, ephemeral unlock-session public key, nonce,
boot epoch and suspension generation. Seal disk secret so release requires
current authorization; use a reviewed TPM policy resistant to replay, state
rollback and power loss, not a nonce in JSON. Boot worker never receives
plaintext disk key. Software-only devices may retain phone approval and durable
remote suspension with an explicit weaker guarantee against captured secrets.
Running-OS compromise remains out of scope. Rate-limit authenticated STK
suspension writes and reject generation overflow/jumps so stolen STK cannot
permanently block owner resume; only owner/admin starts a valid new epoch.
Review owner/admin resume, STK set-only suspension, shared/co-manager unlock,
recovery media and offline keys together. App overrides and share/access ranks
cannot clear suspension.

Acceptance: capture a pre-lock lease, suspend, remove markers and replay across
profiles; record remaining replay. Test old TPM state, copied disk, hibernation,
LUKS slots, shared unlock, clock rollback and interrupted resume on real hardware
for hardware claims.

### 18.11 N11 — Identity, publisher pins, forks and update continuity

Resolve friendly `author--app.targetuser` to immutable publisher/app identity,
account generation and installation ID. A rename/reclaim cannot inherit old
releases, invites, secrets or chat routes. Pin resolved target for a conversation;
remote author/slug stays a claim. Every bundle signature covers exact package
digest, canonical permanent identity, version and capability manifest. Persist
first verified publisher key/key epoch per server. Same-name different-key
package is rejected unless a valid continuity chain exists; Flagship cannot
silently create a new identity under retired name. Even a valid rotation chain
requires a per-service high-salience warning and phone-signed approval before
new key/code/data access. Show old/new fingerprints and continuity status;
offer “Trust this new key for this service” / “Reject and pause updates.” Keep
sliver for severity duration; candidate key cannot replace code or access data
before approval. Lost old key without continuity means new identity.

Verified update from same pinned publisher and installation lineage preserves
runtime data, separate browser context and sessions; this is a trust decision
that publisher code may use retained data/capabilities. Capability expansion
still needs approval. New-server restore is a new installation unless explicit
app export transfers declared state; app owns session serialization. Uninstall
deletes all app-specific state and does not delete durable publisher pin (system
identity metadata). Never leave hidden quarantine/recently-deleted app content;
offer export before final uninstall confirmation. Retain only minimal, scoped
non-content revocation tombstones to prevent stale authority/name reuse.

Offer manual, staged, automatic update modes per service, manual preselected.
Auto-apply only exact verified same-key updates within approved capabilities;
key change, capability growth, integrity/provenance error pauses. Roll back only
to signed code meeting active security floor/schema. Signature proves publisher
and bytes, not good intent. Upstream sync for locally signed forks is an explicit
proposal under §16.7, not an app-update mode. Keep app origins bound to verified
identity with new generation for new identity; use host-only secure cookies and
isolate management UI from app origins. Verify public-suffix assumptions; do
not rely on sibling hostnames or clearing an offline visitor's browser storage
to establish the boundary. Uninstall deletes app files, DB, browser context,
sessions, credentials/secret handles, runtime/API tokens, pending approvals,
listeners, chat slots, subscriptions, code/build artifacts and route ownership.
Document scope/retention of the minimal non-content identity/revocation records.

Acceptance: modes/default, same-key session persistence, new-key stop, warning
and signed approval, uninstall deletion with pin retention, export/import as
new install without authority, cross-account restore, retired-name attempt,
key alert, no pre-approval update and old-origin revisit.

### 18.12 N12 — Build/model boundary, credentials, and provenance

Preserve staging: models use sample data, never live service data; redact every
box-written result/tool output. Treat repository text, adapters, browser content,
logs and chat as hostile data, not instructions. Enforce capabilities at every
tool/broker, including indirect calls. Build workers stay outside daemon
authority: no live data/provider keys/signing credentials/Docker socket/shared
writable cross-tenant cache. Network-limited builds still run compiler and
dependency scripts. Prefer isolated rootless workers; consider microVMs for
hostile cross-tenant creators. Publish isolation profile honestly. Promotion
binds exact bytes, source, adapter digest, toolchain, tests and capabilities;
never rebuild after approval.

Typed on-box credential brokers return handles constrained by provider/account/
operations, destination/TLS identity/method/size/cost; strip credentials across
redirects and never forward a provider token to another base URL. Raw API key is
an explicit exception with warning that app can copy it; it never grants
account/admin/box keys. Revocation may require provider rotation.

Adapter AI review is an attestation, not authorization. Bind Flagship-signed
attestation to exact input digest, base revision, validator/model version and
test evidence; revoke as needed. Per-service manual mode or indefinite trust of
exact currently attested digests is allowed. Changed digest without attestation
requires manual acceptance; pending/failed/expired review is not “vetted.”
Signature/integrity errors and sandbox violations are hard failures, not
warnings a user can waive. Official means authenticated upstream control, not
popularity/safety. Unchanged adapter digest avoids repetitive prompts; new
upstream app version gets capability diff, compatibility and update decision.
Apply patches transactionally; ambiguous anchors/partial patches fail. Keep
searchable public community-adapter directory (project, maintainer/adoption
path, license, digest, supported versions, honest status) without owner install
counts, private repo details or submitter identities. Support upstream adoption
and official manifest; never let adapter JSON grant host access or read other
service data.

For imported/edited apps, the local owner is the signer; retain upstream URL,
publisher, base commit and authentication status as provenance. Sync is explicit:
fetch a specific verified candidate; compare base and local diff; build/rebase
only in isolated staging; show source/capability/adapter/data/schema effects,
conflicts and tests. AI repair needs per-operation consent after provider and
reasonable cost/credit estimate if using user key or paid quota. The exact
staged artifact gets separate owner promotion approval. Failure leaves live app
and data untouched; discard or explicitly label staging. Health rollback is
atomic and never reverts revocations. Acceptance: Git import/fork signer and
lineage, clean/conflicting rebase, paid-key consent, no live mutation on failure,
exact artifact promotion and rollback preserving authority.

Also test malicious build scripts and model tool calls, shared-cache poisoning,
provider credential leakage on redirects, and unchanged adapters across
compatible upstream releases. They must not expose live data or host authority,
alter approved artifacts, or evade capability-expansion approval.

### 18.13 N13 — Resource reserve, safe rollout and incident operations

Budget unauthenticated sockets, handshakes, queues, signature checks, DNS,
decompression, browser tabs, builds, DB, inbox, disk bytes/inodes, logs and
pending alerts per service and host; per-IP alone fails shared networks and
distributed attackers. Enforce before expensive work. Reserve CPU/memory/disk
and management lane for native lock/revoke/recovery; an app cannot consume last
space needed to persist revocation. Load-test pausing a spammed app without
disabling unrelated apps. Owners may tune budgets with hard device limits shown;
these caps are not payment gates.

Maintain compatibility matrix (phone, box, boot worker, web shell, helper,
protocol, verifier); deploy verifying receivers before issuing clients/enforcing
minimum versions. Test mixed versions. Unknown grants/signature versions never
fall back to legacy broad authority. Separate minimum-security from preferred
version. Health rollback only to code meeting floor/schema; otherwise preserve
data and enter restricted recovery with signed artifact. Never roll back
revocations. Authenticate floor metadata with purpose/generation/expiry and
dedicated release authority; defend against compromised cloud bricking devices
with threshold roles and offline recovery. Stale update catalog blocks new
updates, not unrelated local apps. Use established update-metadata framework
(for example TUF roles/freshness/root rotation) rather than one signed URL.

Track verified artifact/config running on consenting boxes. Signed local event
records include grant/operation states, signer role, digests, revocation epochs
and result, but never bodies/tokens/phrases/keys/private source. Phone-held
checkpoints detect some rollback; root-compromised box may suppress logs, so do
not call logs tamper-proof. Native preview/export requires owner consent. Incident
actions are scoped (pause service, revoke grants, rotate provider key, isolate
box, distribute signed artifact); no general operator remote execution/plaintext
inspection channel. Test release-key loss, malicious CI, backup deletion/cloud
outage with dated receipts. Run `npm run rate-limits` per AGENTS.md weekly and
before launch; stage cohorts and define rollback/data criteria. No production
probes or secret disclosure during document work.

### 18.14 N14 — Human-control defaults, security sliver and evidence

Normal path: app declares useful powers; harness derives concise truthful
explanation; phone approves meaningful scope; app runs without recurring
prompts within scope. Requests expanding scope appear in one inbox and per-app
permission page. For each approval show verified service/publisher when known,
requested action/data/destination/duration and undo path. Claimed remote names
remain claims; app explanation cannot rename target or suppress warning. Reject
deceptive controls/bidi in names; low-level IDs/digests are expandable details.
Offer Allow once/session/remember where meaningful; conversation Allow keeps
its agreed lifetime. Denial cooldown prevents repeated phone interruption.

The top-of-app security sliver is persistent and independent per issue: CA
expiry, recovery/veto, publisher-key rotation, offline replicas delaying policy,
major trust/permission change. Each line carries severity, affected target,
state, last update, deadline/action and time remaining. Grow to fit all lines;
on short screens allow scroll but never merge/truncate them. Active items remain
until resolved; then retain critical 90d, high 30d, moderate 14d, low 7d.
Acknowledgement/approval does not shorten/reset. Severity comes from platform,
not app. Escalation creates new higher-severity event; expiry only removes from
sliver, not audit history. Avoid repeat push for unchanged condition. Test
several severities and independent clocks, including after approve/reject.

Default per-service controls: community adapter manual or indefinitely trust
exact Flagship-attested digests; creator updates manual preselected, staged or
automatic same-key/in-scope; browser listed sites or optional public web; local
network exact device or revocable whole LAN; companion read-only with scoped
delegation; local chat/listeners no prompt; cross-user Allow/Always allow under
§17; offline guests fail closed at freshness expiry with propagation lights;
software-only profile explicitly weaker; restored legacy app isolated first.
Malformed signatures, invalid integrity and broken isolation have no ordinary
override. Dangerous but supported scope (public web, broad LAN, unvetted adapter)
may be explicitly accepted with warning where §§16–17 say so.

Recovery, trusted-device loss and biometric failure remain native/documented;
do not silently replace biometric signature with unlocked browser or device-
unlock-only approval. Accessibility or alternate biometric policy changes need
owner review. Report outcomes accurately: accepted != delivered; shutdown sent
!= power confirmed; revoke stored != every offline replica current. Acceptance
includes durability, timeouts, durations and UI parity on supported clients.

### 18.15 Cross-cutting work sequence and acceptance matrix

Use dependency waves, not a reason to defer live P0s:

1. **Targeted containment:** reachable P0s plus N01 parser, N02 classifier/
   dialer and N03 recovery signatures. Prove ingress and actual dial paths.
2. **Authority foundation:** N04 recovery device authority, N05 transaction and
   revocation engine, N06 native/keyless migration, N07 freshness/lead fencing.
   Exercise mixed-client and real-device recovery.
3. **Workload/data:** N09 restore, N11 identity lifecycle, N12 build/secret
   provenance; complete migration/browser/helper boundaries from §§10/17. Run
   hostile archive/build/migration tests on appliance and restore drills.
4. **Communication:** N08 local SDK then cross-user lead/invitation admission
   and abuse controls. Preserve no-prompt local/invited paths. Marketplace
   identity dependency remains on the correct feature branch.
5. **Physical/operations:** N10 replay-resistant TPM work and N13 resource,
   rollout and incident drills. Hardware claims need dated hardware evidence.

For every grant/operation test authorized success, cross-service/install
generation, revoked/expired parent, changed payload, replay, concurrency,
cancelled phone prompt, unknown protocol, missing config, power loss/full disk,
stale restore, offline peer and malicious cloud metadata. Test shared vectors on
TypeScript/Swift/Kotlin, native approval/recovery, browser contexts, Linux
network namespace, and privileged helper on real platforms. A unit boolean is
not evidence production wiring calls it. Exercise TLS, native pinning, ingress,
stream/WebSocket, relay and LAN together. Measure approval frequency, repeated
denials, revocation latency, stale-policy expiry, restore success, false network
blocks and management latency using privacy-minimal metrics; improve UX without
disabling enforcement.

Assign a named engineering owner and reviewer to each work package. N04's
device-authority/recovery protocol, N07's majority leases, membership changes,
freshness durations and clock-drift bounds, and N10's TPM authorization policy
require focused design review and working prototypes before their guarantees
can be claimed. Those are engineering deliverables, not settled wire protocols
in this recipe. Revalidate dated runtime/CA advisories against official sources
before selecting the shipped runtime floor.

Implement launched-feature fixes on the approved path to `main`; unlaunched
feature code remains on its own branch. Marketplace-dependent chat work needs
a compatible dependent branch. Do not move unrelated multilingual work or
untracked files as part of implementing this plan.

### 18.16 Evidence and review confidence

“Reproduced” means a small local, non-network check exercised the actual module.
“Observed” means the behavior is visible in the inspected source. “Design gap”
means an invariant is missing or underspecified; it is not an exploit claim.

| Evidence | Observation | Limits of the conclusion |
|---|---|---|
| E01 — reproduced | `egress/policy.ts:isPublicAddress` returns true for `0:0:0:0:0:0:0:1`, `::ffff:7f00:1` and `::ffff:a00:1`, although these represent loopback/private destinations | Confirms a classifier defect. No live SSRF or production reachability was tested; resolver normalization and downstream routing affect exploitability |
| E02 — reproduced | `runtime.ts:_handleHttpConnectionForTest` dispatches one complete request twice if another byte arrives while its async handler is pending | Confirms duplicate dispatch. Which operations can be repeated depends on downstream authorization/idempotency |
| E03 — observed | The daemon parser buffers input without the explicit head/body limits and deadlines present in `appConnection.ts`; it overwrites duplicate headers and uses permissive `parseInt` for Content-Length | Requires front-to-back framing and denial-of-service tests; not a demonstrated request-smuggling exploit |
| E04 — observed | `buildmodes/gitImport.ts` validates DNS, then invokes host `git clone` by name; the shown path does not bind Git's eventual connection to the checked address | A check/connect and redirect gap to test. No live rebinding attempt was made |
| E05 — observed | `accessSync.ts` stops catch-up after the default 120 seconds when no peer is known live, then serves its local list | Existing availability choice can expose stale rights after partition; entries themselves are independently verified, which should be preserved |
| E06 — observed | `rePair.ts:handleObjectRePair` verifies the incoming/new IRK and explicitly implements self-cancel, not the agreed existing-admin veto | A concrete mismatch between current code and desired behavior; other endpoint surfaces still need an inventory |
| E07 — observed | `adminAuthorityLocal.ts` accepts the bare pinned admin root directly; `recovery.js` and the recovery store support a wrapped admin root | Merely marking a recovered phone pending cannot constrain someone who can produce otherwise-valid root signatures |
| E08 — observed | `webauthnRecovery.ts` verifies an upload claim over username, credential ID, wrapped-UMK hash and time, while storing fetch-token hash, PRF-salt hash, wrapped admin root and wrapped ACME key outside that claim | Signature coverage gap. Tampering need not decrypt anything to break or alter recovery; account takeover was not reproduced |
| E09 — observed | `pairedSessionStore.ts` accepts `?sessionToken=...`; `screens/screensWs.ts` documents that transport; browser profiles persist tokens | More exposure through URL-bearing systems. No token leakage incident is claimed |
| E10 — observed | `serverArchive/restore.ts` already rejects unexpected entry types/paths and checks part hashes, but its small-metadata reader accumulates bytes without a local size cap and its path map does not reject duplicate entry names | Preserve the existing guards; add bounded parsing and uniqueness. No malicious archive was executed |
| E11 — observed | `appCopy/ops.ts` restores as an app DB role, but `volumeDump.ts` also has cluster-admin SQL restore and host-side Forgejo tar restore | Different trust levels need different restore pipelines; authenticated backup does not establish benign SQL/files |
| E12 — observed | Boot auto mode fetches a reusable sealed LUKS key and locally unseals it using the STK; `boot-stage.sh` documents the `/boot` key | Server refusal cannot invalidate an already obtained ciphertext plus its decryption key |
| E13 — observed | The egress proxy authorizes initial SNI/HTTP Host and then splices the stream; DNS forwarding sends the accepted query onward; IPv6 firewall installation failure is caught and logged | These are connection-level controls with deployment assumptions, not comprehensive HTTP/data-flow mediation |

Paths in this table are under `packages/server-daemon/src/` unless otherwise
named: recovery handlers are under `packages/control-plane/src/`, browser
recovery is `apps/web/public/webapp/lib/recovery.js`, and boot paths are
`installer/boot-stage.sh` and `packages/boot-core/src/routes.ts`.

Useful controls already present must survive the work: app-scoped DB restores;
archive path/type checks and hashes; egress dialing the checked numeric address
in its own proxy; stripping incoming `X-Flagship-*` headers; per-app connection
limits; canonical-field separator checks; and independent verification of
replicated access entries. `rePair.ts`'s implementation already fails closed
when TOTP verification lacks its KEK, despite stale comments suggesting a
structural fallback. Do not report that stale comment as a live bypass.

Re-run these checks against the release commit before fixing/releasing and add
adversarial integration tests. The additional review's baseline
was local commit `97095cff30d14a1618175ec10098d901b76c531c` on
`feat/multilingual`; branch/deployment may differ. Current dated Node/CA
assertions must be verified against official release evidence before choosing
the shipped runtime floor; do not freeze a dated version forever.

### 18.17 Focused regression seeds

These are compact local reproductions, not network tests or production exploit
claims. Preserve the original test harness if it is more stable than these
commands.

Address classification (expected public-only classifier result in parentheses):

```sh
node --import tsx --input-type=module -e '
import { isPublicAddress } from "./packages/server-daemon/src/egress/policy.ts";
for (const ip of ["::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1",
                  "::ffff:7f00:1", "::ffff:a00:1", "2606:4700:4700::1111"])
  console.log(ip, isPublicAddress(ip));
'
```

Observed before fix: `false, true, false, true, true, true`; the second,
fourth and fifth results are wrong. Correct behavior rejects all loopback and
private representations while accepting the public IPv6 test address.

Duplicate dispatch with a pending handler:

```sh
node --import tsx --input-type=module -e '
import { Duplex } from "node:stream";
import { _handleHttpConnectionForTest as attach }
  from "./packages/server-daemon/src/runtime.ts";
const socket = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
let calls = 0;
attach(socket, async () => { calls++; return new Promise(() => {}); });
socket.emit("data", Buffer.from(
  "POST /probe HTTP/1.1\r\nHost: example.test\r\nContent-Length: 1\r\n\r\nx"));
socket.emit("data", Buffer.from("y"));
console.log({ completeRequestsSent: 1, handlerInvocations: calls });
socket.destroy();
'
```

Observed before fix: `{ completeRequestsSent: 1, handlerInvocations: 2 }`.
Required result is exactly one handler invocation with bounded handling of
trailing input.

Completion requires code and operations to pass these evidence gates on
supported configurations, the approved useful integrations to work, and
external security claims to match actual limitations. Neither document review
nor this consolidated recipe proves the product secure.
