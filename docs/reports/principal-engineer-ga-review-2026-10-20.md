# Principal-engineer GA review — 2026-10-20

Status: **GA is not ready.**

Scope: skeptical review of Flagship as a personal-cloud product, based on
`changes-since-store-builds-2026-10-18.md` revision 3, `docs/relay-addresses.md`, the cited
implementation, the final-gym artifacts, `AGENTS.md`, and `docs/launch-mvp.md`.

Primary evidence:

- [Changes since the store builds](changes-since-store-builds-2026-10-18.md)
- [Relay-address design](../relay-addresses.md)
- [Launch MVP and required hardware proof](../launch-mvp.md)
- [Workers CPU budget](../runbooks/workers-cpu-budget.md)
- [Final gym summary](../../gym-results/live-run-2026-10-20T01-13-51-627Z/summary.json) and
  [Worker tail](../../gym-results/live-run-2026-10-20T01-13-51-627Z/worker-tail.json)
- [iOS relay implementation](../../apps/mobile/shared/Sources/FlagshipAPI/Client/RelayFallback.swift)
  and [Android relay implementation](../../apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/RelayFallback.kt)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and
  [error 1102](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1102/)
- [Apple Network Framework suspension guidance](https://developer.apple.com/forums/thread/840808)

Evidence marks used throughout:

- **[V] Verified** — stated directly in the reviewed documents, visible in the implementation or
  recorded in a cited test/gym artifact.
- **[I] Inferred** — a conclusion drawn from verified facts, but not itself demonstrated by a test.
- **[G] Guess** — plausible, but the available evidence is insufficient to distinguish it from
  alternatives.

The marks describe the strength of the evidence, not whether a conclusion is favorable.

---

## 1. Executive decision

**[I] Do not declare GA.** The release candidate has unresolved failures in the exact paths that
define the product: phone-rooted authority, first boot, device pairing, relay fallback, recovery of
user data, and control-plane availability.

**[V] The launch scope itself requires a phone-created box on current code, real backup restore,
republished VM appliances, and real iPhone/Android LAN routing before launch.** Those are not
optional review suggestions; they are already recorded in `docs/launch-mvp.md` under “Proven on
real hardware before launch.”

**[V] More than 1,100 commits and roughly 370,000 added lines separate the mobile store baselines
from the reviewed tree.** Roughly half of the work landed in four days. This is not a normal patch
release; it is a new product generation being treated as an update.

**[I] Unit-test volume is being used as a substitute for system evidence.** The repository has
large TS, Kotlin and Swift suites, but the missing evidence is concentrated at platform boundaries:
store builds, iOS networking, Android TLS behavior, Windows UAC, published VM images, Cloudflare
limits, DNS propagation and real storage devices.

**[I] The correct GA posture is to reduce the launch surface, finish the hardware and production
gates, and pay for predictable control-plane execution.** Continuing to add features before those
gates pass increases uncertainty faster than tests are reducing it.

### Immediate GA blockers

1. **[V] iOS relay routing under a real DNS block has not run on hardware.**
2. **[V] Android’s handshake was observed closing under a DNS block and the cause remains unknown.**
3. **[V] iOS account/device pairing has no two-device hardware run.**
4. **[V] A fresh Windows hosted-VM first boot has not been retested after the UART and appliance
   fixes.**
5. **[V] The Windows “Restart as administrator” path after canceling UAC is unverified.**
6. **[V] The full backup/restore path has not been proven on a production-format physical box.**
7. **[V] Existing app data has not been interruption-tested through the new loop-image migration.**
8. **[V] The final gym recorded customer-facing Worker routes far above the Free plan’s 10 ms CPU
   budget.**
9. **[V] Old real accounts without an admin root have not created a server against the new
   enforcement.**
10. **[V] The exact iOS/Android store build numbers have not been checked against the store
    consoles.**
11. **[V] The CA lease renewal, final endorsement, production wildcard/CAA step and final release
    artifacts remain release-time dependencies.**
12. **[I] The relay-address security claim must be corrected or the design must be changed: a box
    pin authenticates the far end, not the first-hop relay.**

---

## 2. Product and architecture assessment

### 2.1 What the product claims to be

**[V] The phone is the account’s trust root.** Administrative authority, server creation, device
admission, recovery, boot approval and destructive actions are intended to flow from phone-held
keys and explicit user actions.

**[V] TLS terminates on the user’s box.** The `.services` Fly application is intended to be a blind
SNI relay, while `.com` holds identity and persistent coordination state.

**[V] The box is expected to continue running user applications while central services are
unavailable.** However, account setup, server registration, certificate issuance, routing changes,
pairing, recovery and some boot paths still depend on vendor infrastructure.

**[I] “Personal cloud” is therefore true for content confidentiality but only partially true for
control-plane sovereignty.** The vendor cannot normally read application plaintext, but it remains
an availability authority and a metadata observer.

### 2.2 Where the architecture is sound

**[V] End-to-end TLS plus a phone-verified, STK-signed certificate fingerprint gives the phone a
strong box identity once a pin is established.** A relay, DNS server or network attacker cannot
silently terminate that TLS connection with a different certificate.

**[V] Sensitive operations increasingly use canonical signed envelopes shared across TS, Swift,
Kotlin and the webapp.** Moving authority checks into `.com` and the box is materially stronger
than relying on UI gating.

**[V] The RCK separates the account’s authority over a name from the currently serving box.** That
is the right primitive for migration and failover, provided replacement rules remain atomic and
the phone’s authority is not bypassed.

**[V] The project has useful release guards: migration drift checks, release-clean scans, parity
checks, signed test vectors and a live multi-box gym.** These catch classes of regression that
ordinary unit tests would miss.

### 2.3 Where the architecture contradicts the philosophy

**[I] `.com` remains too central for the advertised trust story.** It can suppress orders, return
relay addresses, delay doorbell lanes, withhold notices, affect certificate/routing workflows and
make account operations unavailable even though it cannot decrypt box traffic.

**[V] Data-sovereignty recovery when `.com` is gone was built and then parked.** That is a product
choice, but it means “your server” still lacks a supported owner-controlled rescue path when the
vendor control plane is unavailable.

**[I] The system has stronger cryptographic authority than operational independence.** The phone
may authorize a change, yet DNS, Cloudflare Workers, the Fly relay, CA leases, endorsements and
store-distributed clients all have to be aligned before the action works.

**[I] The product should state this boundary plainly:** Flagship protects content from the vendor;
it does not yet make server lifecycle independent of the vendor.

### 2.4 Complexity and rate of change

**[V] The change window includes authority redesign, backup formats, storage layout, migration,
peer backup, DNS architecture, Worker budgeting, two mobile redesigns, Windows VM fixes and new
security-notice infrastructure.** Each would normally justify its own release candidate.

**[V] A stale-tree squash silently reverted landed work, WIP-labelled commits reached `main`, and
many agents edited overlapping trees.** The repairs may be correct, but the process allowed
unreviewed integration failure on the release branch.

**[I] The dominant GA risk is interaction risk, not a missing unit test.** Examples include a new
store build speaking to old `.com`, a new box release behind an old CA lease, a local iOS proxy
surviving backgrounding, or a volume migration colliding with a backup.

**Recommendation [I]:** freeze features now. Permit only release blockers, observability, rollback
and evidence-producing tests until GA.

---

## 3. Step-by-step review of every change theme

### T1. Admin-only add server and add device

**Change [V]:** Server creation, RCK registration, take-over and device admission moved from client
policy to signed server-side enforcement rooted in the admin key.

**Security [I]:** This closes a real authority gap: possession of the shared membership key no
longer implies authority to create infrastructure or admit devices.

**UX [V]:** Current store builds can hit the new refusal, and phone release builds had incomplete
add-device/join flows during the window.

**Philosophy [I]:** This matches the phone-as-trust-root model only if legacy accounts have a safe
admin-root transition. Refusing them outright turns a security upgrade into account lockout.

**GA recommendation [I]:** Prove old-account migration and publish store builds before enabling
the `.com` enforcement. Add a server-side compatibility metric for refusal codes during rollout.

### T2. Server sharing, co-management, ranks and one list per app

**Change [V]:** Another account can view or manage a server, admin devices accept shares, managers
can issue member invites, ranks are enforced, and app membership is distributed across boxes.

**Security [I]:** Admin-signed acceptance keeps `.com` from becoming the sharing authority, but
the design still cannot distinguish hostile non-admin devices that derive equivalent UMK material.

**UX [V]:** This is a broad household-sharing feature with no real-phone end-to-end run in the
reviewed evidence.

**Philosophy [I]:** Per-app identity and box-verified membership fit the privacy model. The remaining
same-person device indistinguishability should be documented as a boundary, not implied away.

**GA recommendation [I]:** Run two accounts on multiple physical devices through share, accept,
demote, revoke, invite and offline convergence using the production CA chain.

### T3. Debug access v2 and signed environment changes

**Change [V]:** Production debug SSH became key-only, admin-signed, expiring, revocable and visible;
environment changes became variable-specific and nonce-bound.

**Security [I]:** This converts an uncontrolled backdoor class into a controlled backdoor class.
It remains privileged remote access to user-owned machines.

**UX [I]:** Expiry and revocation are understandable only if Activity reliably tells the owner
who opened access, for which key, and when it closes.

**Philosophy [I]:** Owner-visible support access can coexist with personal ownership, but silent or
operator-only access cannot.

**GA recommendation [I]:** Validate grant, use, revoke and expiry on a phone-created box. Publish an
explicit promise that support cannot enable it without the owner’s admin signature.

### T4. Backup policy, scheduled backup, one file, quotas and Migrate

**Change [V]:** Backups became scheduled policy, a single resumable `.flagship` format, phone copy,
per-app limits and the data path for Migrate.

**Security [I]:** Encryption and admin-deposited key pools are appropriate, but recovery security is
irrelevant if the artifact cannot restore after the source is lost.

**UX [I]:** “Backup complete” is a dangerous success state unless the resulting file has been
validated structurally and periodically restored.

**Philosophy [I]:** A personal cloud must treat recoverability as a primary feature, not an
auxiliary workflow. Destructive migration should be downstream of a proven restore, not merely a
completed archive write.

**GA recommendation [I]:** Add restore verification receipts, interruption-test the loop-volume
conversion, and complete a destroy-source/restore-target drill with real files and PostgreSQL.

### T5. Peer backup v2

**Change [V]:** Encrypted erasure-coded shards are distributed across accounts through blind
matching, filler and relay mailboxes.

**Security [V]:** The first erasure matrix was not MDS and could lose data with four surviving
shards; the replacement is exhaustively tested in process.

**UX [I]:** A “peer backup” option implies recoverability from other people’s servers, but there is
no live end-to-end group and production secrets were not established in the report.

**Philosophy [I]:** Mutual-aid storage fits the product, but launching it before a real recovery
turns users into an experiment whose failure appears only during disaster.

**GA recommendation [I]:** Disable the policy at GA. Enable it only after cross-account, real-network
restore with churn, missing peers and relay interruption.

### T6. Add/Restore server and restore from backup

**Change [V]:** Creation, co-management and restore were unified, and restored apps are rebound to
the importing account rather than a reclaimable old name.

**Security [I]:** Rebinding closes a name-reuse takeover path.

**UX [I]:** A unified chooser is clearer, but it makes unproven restore look as mature as ordinary
creation.

**Philosophy [I]:** Recovery should be a first-class path, but equal visual prominence should follow
equal reliability.

**GA recommendation [I]:** Keep restore visible only after the destructive real-box drill passes;
otherwise label it preview and prevent source destruction.

### T7. Security notices and forced-update lock

**Change [V]:** An offline-YubiKey-signed notice can display a banner or prevent normal app use for a
named security reason.

**Security [I]:** Offline signing, anti-rollback and a bounded window are reasonable safeguards. A
locked phone being unable to approve server boot creates an availability coupling between app
update distribution and home-server recovery.

**UX [I]:** A full-screen security lock will be perceived as vendor control of the owner’s server,
especially if the server reboots while the app is locked.

**Philosophy [I]:** Forced update is in tension with phone ownership. It is defensible only for a
narrow, documented emergency and only if boot approval remains possible.

**GA recommendation [I]:** Keep lock mode disabled. Test the real YubiKey publish/retract path and
separate minimal boot-unlock authorization from the locked application surface.

### T8. Account-gone and account deletion

**Change [V]:** A deleted account gets one stable response, clients stop polling and warn before
discarding the local admin key; the last-device deletion count was corrected.

**Security [I]:** Warn-before-key-destruction is necessary because the phone may hold the last
usable recovery authority.

**UX [I]:** A dedicated account-removed screen is better than generic 401/403 failures, but reusing
the same username for a new account can confuse a stale device if identity is inferred from 404
state rather than a pinned account identifier.

**Philosophy [I]:** Human-readable names must not substitute for cryptographic account identity.

**GA recommendation [I]:** Test deletion while all clients are signed in, then re-register the same
name and prove every stale client treats it as a different account.

### T9. RCK reuse and atomic swap

**Change [V]:** Pending orders reuse their RCK, and `.com` allows an atomic same-account replacement
only before a routing target exists.

**Security [I]:** The conditional update is the right shape; any path that sets a target without the
same invariant would reopen name control.

**UX [I]:** This removes a severe retry failure where a dropped response could orphan a name.

**Philosophy [I]:** Retry-safe identity operations are mandatory when setup crosses phones,
builders and a remote control plane.

**GA recommendation [I]:** Add a live drop-response retry test and an invariant test covering every
writer of routing targets.

### T10. Plain-language error mapper

**Change [V]:** Native apps translate transport and service failures into product language while
retaining raw errors in logs.

**Security [I]:** Friendly text is acceptable until distinct trust failures are collapsed into
ordinary availability failures. The relay-hint path currently does exactly that.

**UX [I]:** Central mapping reduces accidental framework jargon, but call-site migration without a
lint rule will regress.

**Philosophy [I]:** Plain language should explain uncertainty, not erase it. “Relay route could not
be verified” is both understandable and truthful.

**GA recommendation [I]:** Add lint/source checks and preserve separate identity, trust, relay,
offline and server-refusal categories.

### T11. Activity accordions and inline approvals

**Change [V]:** Activity became sectioned, paged and actionable, with approvals handled in place.

**Security [I]:** Putting authorization decisions beside their audit context helps, provided rows
cannot be reordered or hidden by stale state.

**UX [I]:** Bounded sections are better than an unstructured feed, but one-open-at-a-time behavior
needs large-text and assistive-technology testing.

**Philosophy [I]:** User-owned infrastructure needs a comprehensible ledger, not an operator log.

**GA recommendation [I]:** Run VoiceOver/TalkBack, 200% text and stale-approval conflict tests on
hardware.

### T12. Offline server page

**Change [V]:** Offline status was simplified, monitoring hidden until a successful recheck, and DNS
negative-cache handling was added.

**Security [I]:** The UI must not reinterpret a certificate failure as simple offline status.

**UX [I]:** “Offline” is useful only when the system can distinguish box failure, DNS failure,
relay failure and trust failure in diagnostics.

**Philosophy [I]:** Product language may be simple while operational evidence stays precise.

**GA recommendation [I]:** Keep the single user-facing sentence, but expose a shareable diagnostic
code and preserve the real failure class.

### T13. Android Material 3 redesign, polish and tablet

**Change [V]:** The Android UI was substantially rewritten across navigation, components, motion,
accessibility and tablet layouts.

**Security [I]:** UI rewrites can bypass authority gates even when backend checks remain; the result
may be confusing refusals rather than privilege escalation.

**UX [V]:** Instrumented gyms are not in CI and no owner hardware review of the redesign is
recorded.

**Philosophy [I]:** Platform-native UI is appropriate, but parity should mean equivalent outcomes,
not visual imitation.

**GA recommendation [I]:** Run the release APK on phone and tablet through every authority,
backup, restore and destructive flow; put emulator gyms in CI.

### T14. iOS Dynamic Type, haptics and motion

**Change [V]:** Fonts, targets, motion, settings and status presentation were broadly rewritten.

**Security [I]:** No direct security boundary changed, but destructive confirmations and biometric
prompts can regress during broad view rewrites.

**UX [V]:** There is no iOS CI workflow, and the reviewed evidence did not include a current
real-device run.

**Philosophy [I]:** Accessibility work is part of correctness, not polish, but it needs device and
assistive-technology evidence.

**GA recommendation [I]:** Add release-configuration CI and run VoiceOver, Reduce Motion, large text,
sheet dismissal on lock and biometric-queue tests on hardware.

### T15. Teal and contrast token system

**Change [V]:** One brand color was split into semantic roles, then partially reversed; bright teal
remains at roughly 2.30:1 on light paper.

**Security [I]:** No security primitive changed, but weak selected-state indication can cause users
to misunderstand active modes or choices.

**UX [V]:** The color is below WCAG 1.4.11’s 3:1 threshold when used for information-bearing borders
or selected-state markers.

**Philosophy [I]:** Brand preference should not override state legibility in controls.

**GA recommendation [I]:** Keep bright teal for decorative/labelled graphics; use the deeper token
for state boundaries, focus and selection.

### T16. One product version, 0.2 Beta

**Change [V]:** A version file now drives store, Studio and product labels.

**Security [I]:** Consistent versions help incident response and forced-update targeting.

**UX [I]:** “0.2 Beta” is honest only if store metadata and support material use the same label.

**Philosophy [I]:** A beta label does not excuse loss of user data or broken trust flows.

**GA recommendation [I]:** Verify build numbers in App Store Connect and Play Console immediately
before upload, and record them in release evidence.

### T17. No mocks or developer mode in release

**Change [V]:** Mock clients, gym seams and developer controls were removed or compile-gated from
release clients.

**Security [I]:** This reduces accidental bypass and fake state in production.

**UX [V]:** Removing mocks exposed real-account crashes and a recipe-encoding failure, showing that
mock paths had concealed product defects.

**Philosophy [I]:** Release behavior must always be testable without shipping its test bypasses.

**GA recommendation [I]:** Put iOS release-clean builds in CI and add real-protocol fixtures rather
than release-accessible seams.

### T18. GA close-out

**Change [V]:** Wipe guards, per-install LUKS secrets, debug-endpoint removal, gVisor mirrors and a
narrower Debian-only installer were added.

**Security [I]:** Removing the public build-time LUKS passphrase is essential. Existing installed
boxes retaining the public slot remain vulnerable until reburned.

**UX [I]:** An installer failure that looked like success is a severe trust defect; visible failure
and a held console are necessary but need published-artifact tests.

**Philosophy [I]:** “The box is yours” is incompatible with a known public disk-unlock slot, even on
pre-GA devices.

**GA recommendation [I]:** Identify every existing box with the public slot, notify/reburn it, prove
both published appliance architectures, and take a manual D1 export before destructive cleanup.

### T19. Windows and Studio findings

**Change [V]:** The Windows run found broken first-boot resize, hidden bootstrap failures,
hard-coded production control hosts, negative-DNS delays and poor low-memory errors.

**Security [I]:** First-boot update installs the newest endorsed descendant without a separate phone
confirmation; the endorsement and rollback gate therefore carry exceptional risk.

**UX [V]:** Windows and Linux are labelled preview, but the published amd64 appliance was known to
stall and the corrected published artifact was not retested in the report.

**Philosophy [I]:** “Preview” may cover rough edges, not a non-booting primary workflow.

**GA recommendation [I]:** Publish new artifacts only after clean-machine Windows first boot, UAC
cancel/restart, stop/start, second boot and phone unlock all pass.

### T20. Android auto-unlock lease signer

**Change [V]:** Android used the admin root where the worker expected the IRK, so approval succeeded
but automatic unlock was never stored.

**Security [I]:** The server correctly refused the wrong signer; the client incorrectly treated a
post-approval lease failure as failure of the already-completed approval.

**UX [I]:** Users would see repeated restart approval and contradictory error state.

**Philosophy [I]:** Signed-message vectors must precede store builds for cross-component authority
paths, not be added after a signer mismatch ships.

**GA recommendation [I]:** Run approve, automatic reboot, revoke and next-reboot behavior on a
physical admin-root Android device.

### T21. Root-wildcard DNS

**Change [V]:** Per-account records were replaced with one DNS-only root wildcard and apex CAA.

**Security [I]:** Fewer mutable records reduce exhaustion and orphan risk, but the layout depends on
Cloudflare behavior that differs from RFC 4592.

**UX [I]:** A five-second authoritative inconsistency can become a thirty-minute user outage through
negative caching.

**Philosophy [I]:** Infrastructure simplicity is valuable only when its external assumptions are
monitored continuously.

**GA recommendation [I]:** Revision 3’s gym result closes the old “never run on final layout” gap for
the gym. Production still needs wildcard/CAA verification, safe reap order and a standing alarm
during ACME challenges.

### T22. Parked data sovereignty and retained boot hardening

**Change [V]:** Offline LAN rescue was removed from launch; boot now limits relay wait and can serve
the on-disk certificate, while re-pair adoption requires proof rooted in prior authority.

**Security [I]:** Proof-based re-pairing is necessary. Serving an expired certificate favors local
availability but does not help clients that correctly enforce validity.

**UX [I]:** Faster boot with the relay down is useful, but the scenario has not run live.

**Philosophy [I]:** Parking vendor-independent rescue narrows the meaning of personal ownership.

**GA recommendation [I]:** Prove reboot with relay and `.com` blocked. Revisit sovereignty recovery
as the first post-GA security feature, not a distant product enhancement.

### T23. Workers Free plan and the doorbell

**Change [V]:** Hot handlers were batched/cached, box polling was reduced through a heartbeat
doorbell, and clients back off after `.com` failure.

**Security [I]:** A hostile `.com` could already withhold orders; doorbell caching adds bounded stale
state and another place for operational failure to look like absence.

**UX [I]:** CPU exhaustion appears to users as temporary service failure, while request exhaustion
can disable the entire control plane until midnight UTC.

**Philosophy [I]:** Choosing Free for a trust and boot control plane optimizes the wrong constraint.
The monthly plan cost is negligible compared with the cost of non-deterministic account recovery.

**GA recommendation [I]:** Use Workers Paid for GA. Continue CPU work for latency and efficiency,
but do not make a 10 ms hard cap part of the product’s reliability model.

### T24. CI, gyms, parity and readiness

**Change [V]:** CI broadened, a live gym exercises multi-box flows, parity is machine-checked and a
release readiness command aggregates gates.

**Security [I]:** Cross-language vectors and production-like live flows are useful, but green CI
cannot compensate for absent iOS CI and untested hardware boundaries.

**UX [I]:** The gym finds real product bugs, which also shows that mock gyms should not be treated as
release evidence.

**Philosophy [I]:** A readiness command should report missing evidence as red, not allow manual
claims to remain green.

**GA recommendation [I]:** Make hardware receipts, production-plan parity, store versions, current
CA lease and published-artifact hashes first-class release inputs.

### T25. Platform and product work from 2026-10-08 through 2026-10-14

**Change [V]:** This includes update rollback, AI staging/privacy, gVisor runtimes, PostgreSQL 18,
API keys, app identity, app copy, LAN direct, billing core, free inference, repo adapters, remote
flows and rate limits.

**Security [I]:** Several are independent security programs hidden inside one release: sandboxing,
AI privacy, data migration, identity, egress and update trust.

**UX [I]:** Shipping all of them together makes failures difficult to attribute and support.

**Philosophy [I]:** The product is trying to launch a platform, not just a server appliance. That
requires narrower promises and explicit feature maturity labels.

**GA recommendation [I]:** Keep inference off until its end-to-end path is proven; verify the
egress fence fails closed or clearly document the exception; prove all three runtimes and non-root
`/data` on a real box.

### T26. Minimum OS floors

**Change [V]:** Android and Wear moved to API 33; iOS/watchOS remain 18/11; Mac Studio moved to
macOS 15.

**Security [I]:** Requiring security-critical platform APIs is a legitimate reason to raise floors.

**UX [I]:** The change silently removes Android 9–12 and older Mac users unless store reach and
existing-install counts are known.

**Philosophy [I]:** “Oldest safe version” is coherent, but vendor-support generalities should not
replace measured customer impact.

**GA recommendation [I]:** Record Play device reach, active installed-version distribution and
vendor bulletins in the release decision.

---

## 4. Relay-address threat analysis

### 4.1 The core design claim is overstated

**[V] `docs/relay-addresses.md` says a wrong address can only fail and that a successful pinned-box
handshake proves the address is the relay and is authorized.**

**[I] A successful handshake proves only eventual reachability to the pinned box.** A public TCP
forwarder controlled by compromised `.com` can tunnel to the genuine relay, pass the probe, observe
the phone IP, SNI, timing and volume, and selectively block traffic.

**[I] The forwarder still cannot decrypt or impersonate a known box.** End-to-end TLS and the dynamic
certificate pin remain meaningful.

**[I] The design therefore preserves content confidentiality but does not preserve separation of
identity-state metadata from relay metadata.** If that separation is part of the security model,
unsigned `.com` hints violate it.

### 4.2 Malicious `.com`

- **[V]** Can return any syntactically public IP and withhold updates.
- **[I]** Can cause denial by returning blackholes or stale addresses.
- **[I]** Can return a transparent forwarder that passes the pin probe.
- **[V]** Cannot directly satisfy the known box pin with an unrelated TLS endpoint.
- **[V]** With no known box, the design uses untested addresses and relies on ordinary TLS.
- **[I]** The documents do not establish every bootstrap flow’s independent signed identity binding.

**Recommendation [I]:** Restore a signed relay-address document, signed by an offline maintainer
authority already pinned in the clients, with a monotonic sequence, short expiry and anti-rollback.
A hot `.com` signature would not solve compromise of `.com`.

### 4.3 Hostile network

- **[V]** Can block `.com`, DNS or selected addresses and force cached/compiled fallback.
- **[I]** Simple redirection fails TLS/pin validation.
- **[I]** Transparent forwarding can pass while adding no plaintext access beyond what an on-path
  network already has.
- **[V]** If DNS returns an address, Android preserves the real TLS error rather than using the
  fallback path.

### 4.4 Stale address

- **[V]** Success is cached ten minutes, failure two minutes, and the stored `.com` list has no
  enforced expiry.
- **[I]** Reassignment after a successful probe creates a time-of-check/time-of-use race, although
  the actual request repeats TLS and pin validation.
- **[I]** A stale address normally fails closed; a stale owner that transparently forwards can pass
  and observe metadata.
- **[I]** A malicious cached address can remain ahead of the compiled seed while `.com` is down.

### 4.5 iOS loopback CONNECT proxy

**[V] The proxy binds to `127.0.0.1`, accepts unauthenticated CONNECT, allows any hostname below the
data apex on port 443, and has no connection count or idle timeout.**

**[V] End-to-end TLS prevents the forwarder from reading Flagship content.**

**[G] The documents do not prove whether another sandboxed iOS app can reach the ephemeral loopback
port.** The implementation has no application-level client authentication, so isolation must not be
assumed.

**[I] If reachable, another app can use the forwarder as a constrained relay tunnel and exhaust
connections by holding them open.**

**[I] Port reuse is a low-probability but real stale-session risk because already-returned
`URLSession` instances retain the old proxy port.**

**[V] The code does not close/recreate the listener on app suspension.** Apple’s Network Framework
guidance recommends shutting listeners down before suspension because behavior is not an API
guarantee and suspended listeners can hang clients.

**Recommendation [I]:** Add foreground/background lifecycle handling, invalidate old URLSessions,
limit concurrent clients, enforce header and idle deadlines, and test suspend/resume and port reuse
on real devices.

### 4.6 Error semantics

**[V] Android turns any `IOException` after a relay hint into `UnknownHostException`; iOS consumes a
recent pin mismatch and returns to the original DNS error.**

**[I] This hides stale addresses, blocked relay paths, pin mismatches and compromised hinting behind
one misleading diagnosis.**

**Recommendation [I]:** Display “The relay route could not be verified,” retain the underlying
category in structured logs, and never downgrade a trust failure to ordinary DNS failure.

---

## 5. Workers Free-plan analysis

**[V] Cloudflare documents 10 ms CPU per request on Workers Free and error 1102 when CPU is
exceeded.**

**[V] The final gym recorded `GET /api/server/:x/migration` at 114 ms CPU and p95 45 ms, and
`POST /api/dev/sample-user/create` at 111 ms.** It also recorded `/pods`, usage reporting, health,
eviction-chain and migration-assignment above 10 ms.

**[I] These requests can fail in production even though the gym marked them `ok`.** The discrepancy
means the gym’s plan/enforcement did not prove production behavior.

**[V] Migration status is read by the phone and both boxes.** A killed read is retriable, but it can
stall the user-visible migration and make recovery state ambiguous.

**[V] Sample-user creation is admin-secret-gated.** Its failure primarily affects gym/demo
operators, but partial initialization must remain idempotently recoverable.

**[I] Using Paid for GA is the correct risk decision.** CPU optimization should continue, but a
single low-cost plan upgrade removes an unnecessary hard execution ceiling from identity and
recovery paths.

Required code changes:

1. **[I]** Join or batch migration-session and eviction-state reads.
2. **[I]** Add every observed over-budget customer route to the CPU harness.
3. **[I]** Move sample-user cryptography/provisioning out of the synchronous Worker request.
4. **[I]** Fail the Free-plan live gate on any recorded CPU time above 10 ms, even when the outcome
   is labelled `ok`, until enforcement parity is established.
5. **[I]** Record the gym and production plan/limits in release evidence.

---

## 6. Verification required before GA

| Claim | Evidence now | Required proof |
|---|---|---|
| Old real accounts can create servers after admin-root enforcement | **[N]** | Oldest production-format account; create, cancel, retry and finish on release clients. |
| Sharing/ranks/one-list work on phones | **[N]** | Two accounts, multiple physical phones, live CA chain, offline convergence and revoke. |
| Debug access v2 works on a phone-created box | **[C]** | Grant, key-only login, revoke, expire and Activity verification. |
| Existing data safely moves to loop images | **[C]** | Populated disk clone; interrupt every copy/swap boundary; checksum and reboot. |
| Full backup/restore works | **[C]** | Real files/PostgreSQL/runtimes; destroy source; restore and compare application data. |
| Android phone-copy worker survives device lifecycle | **[C]** | Background, lock, process death, low storage and retry on physical Android. |
| Peer backup restores end to end | **[C]** | Real accounts/networks and shard loss, or disable it. |
| Account-gone cannot confuse a reused name | **[N]** | Delete while all clients are active, reuse name, prove cryptographic identity separation. |
| RCK retry cannot orphan/steal a name | **[N]** | Drop first response; retry same/different RCK; test cross-account refusal. |
| iOS release build is clean and usable | **[N]/[C]** | Archive exact store config, binary scan, install on hardware, full smoke. |
| Store build numbers are unused | **[C]** | Check App Store Connect and Play Console immediately before upload. |
| LUKS public build key is gone from shipped artifacts | **[C]** | Boot both published architectures and USB; old passphrase fails; one slot remains. |
| Windows release artifacts boot and elevate correctly | **[N]/[C]** | Signed installer, UAC cancel/restart, fresh VM first boot, second boot and stop/start. |
| Android auto-unlock fix works | **[C]** | Approve, two automatic reboots, revoke, then required approval. |
| Cloudflare wildcard behavior remains safe | **[C]** | Continuous authoritative/public probes during real ACME issuance and deletion. |
| Box recovers after relay outage | **[N]** | Block `.services` and `.com`, reboot, restore network and observe recovery. |
| Free-plan CPU/capacity estimates are real | **[C]** | Run `freePlan` on an account confirmed Free with production-equivalent load. |
| Security-notice signing/retraction works | **[C]** | Real YubiKey harmless banner, client receipt, retraction and boot-unlock check. |
| Rate-limit budgets are effective | **[C]** | Weekly inspection plus adversarial burst tests on every public route class. |
| Android 13 floor is acceptable | **[C]** | Play reach/installed-device data and current vendor bulletins. |

---

## 7. GA scope decision

### Must pass before GA

1. **[I]** Correct the relay metadata/security claim or ship signed relay-address manifests.
2. **[V]** Real DNS-block relay tests on iOS and Android, with the Android closure explained.
3. **[V]** Two-device iOS pairing on hardware.
4. **[V]** Fresh Windows hosted-VM first boot and UAC cancel/restart if Windows preview is published.
5. **[I]** Real-data loop-volume interruption tests and destructive restore drill.
6. **[I]** Old-account server creation and enforced store-before-`.com` rollout.
7. **[I]** Paid Worker plan or production-equivalent proof that every normal route fits Free.
8. **[I]** Exact release builds installed on hardware, with store build numbers confirmed.
9. **[I]** CA lease renewal, final endorsement and appliance rebuild from the endorsed commit.
10. **[I]** Production wildcard/CAA creation, zone health, safe reap and DNS alarm.
11. **[I]** A manual D1 export plus verified off-Worker backup before irreversible production scrub.

### May ship only as disabled or explicitly preview

- **[I] Peer backup:** disabled until real recovery passes.
- **[I] Flagship Inference:** off until its public host and end-to-end path pass.
- **[V] Android phone USB burn:** remain off `main` as planned.
- **[I] Wear OS:** preview/unsupported until hardware run.
- **[I] Linux Studio:** preview until a real desktop run.
- **[I] Security-notice lock:** unsigned and dormant until boot-unlock behavior is corrected.
- **[I] Data-sovereignty rescue:** document as absent rather than implying offline recovery.

### Can ship as known defects

- **[I]** Bright teal used decoratively at 2.30:1; information-bearing state borders should be fixed.
- **[I]** Sample-user CPU cost, after customer routes are safe or the Worker is Paid.
- **[I]** Windows/Linux preview polish gaps that do not prevent boot, pairing, stop or recovery.
- **[I]** Delayed alias propagation from the doorbell, if accurately explained and observable.

---

## 8. UX assessment and recommendations

### 8.1 Trust should be visible without being theatrical

**[I]** The product currently exposes many security concepts indirectly: admin roots, IRKs, leases,
pins, notices, CA endorsements and recovery keys. Users should see consequences, not protocol names.

Recommended vocabulary:

- **[I]** “This phone can approve changes” instead of “admin root.”
- **[I]** “Verified connection to your server” instead of generic “online.”
- **[I]** “The relay route could not be verified” instead of “name did not resolve.”
- **[I]** “Backup created and checked” only after structural validation; “restore tested” only after
  a restore receipt exists.
- **[I]** “Your server is waiting for approval” instead of an indefinite setup spinner.

### 8.2 Destructive actions need recoverability evidence

**[I]** Delete, migrate, account removal, device removal and key destruction should show the newest
verified backup and when it was last restored, not merely whether a backup file exists.

**[I]** Migrate should not wipe the source until the target has served the restored apps and the
phone has verified their expected data.

### 8.3 Preview must have a concrete meaning

**[I]** Preview should mean core workflows pass but polish/support coverage is incomplete. It should
not mean first boot is untested or the published appliance is known broken.

**Recommendation [I]:** Define preview acceptance criteria: install, pair, first boot, restart,
stop, update and recover must pass; backup import, accessibility polish and broad hardware coverage
may remain incomplete.

### 8.4 Error handling must preserve diagnosis

**[I]** One friendly sentence may front each error, but every failure should retain a stable reason
code that users can copy and support can act on.

**[I]** Trust failures, authentication refusals, relay failures, `.com` failures and box-offline
states must remain distinct even when the prose is simple.

---

## 9. Security recommendations

### Before GA

1. **[I]** Sign relay-address manifests independently of `.com`.
2. **[I]** Move `.com` to Workers Paid and retain CPU alarms.
3. **[I]** Keep peer backup and forced-update lock disabled.
4. **[I]** Remove the known public LUKS slot from every retained physical test/customer box.
5. **[I]** Prove admin-root migration for legacy accounts.
6. **[I]** Add an audit/invariant test for every routing-target writer.
7. **[I]** Treat restore verification as part of backup completion.
8. **[I]** Separate boot approval from any future forced-update lock.
9. **[I]** Add production alarms for DNS wildcard failure, CA-lease horizon, endorsement age,
   backup age, CPU exhaustion and request ceiling.

### First post-GA security work

1. **[I]** Restore a vendor-independent LAN rescue path for user data.
2. **[I]** Define and publish the metadata threat model for `.com`, `.services`, DNS, networks and
   local apps.
3. **[I]** Eliminate or formally constrain maintainer debug access.
4. **[I]** Make security-notice recovery possible without stranding boot approval.
5. **[I]** Run regular destructive recovery exercises, not only creation/update gyms.

---

## 10. Release-engineering recommendations

**[I] Replace the current sequence of manual facts with one signed release manifest.** It should
name:

- endorsed box commit and endorsement hash;
- CA lease expiry and bundle hash;
- `.com`, `.services`, webapp and inference commits;
- D1 schema head;
- DNS wildcard/CAA observations;
- iOS/Android version and store build numbers;
- Studio and VM-appliance artifact hashes;
- hardware-test receipt IDs;
- newest D1 backup/export;
- Cloudflare plan and CPU gate result.

**[I] The deploy script should refuse when any required field is absent or older than its allowed
horizon.** Human approval remains necessary for YubiKey and store actions, but the resulting facts
should be machine-readable.

**[I] Add a release freeze rule:** after the final full gym and hardware pass, any change to
authority, protocol, storage, networking, installer or release code invalidates the relevant
receipts and requires rerunning them.

**[I] Stop treating “all unit tests passed” as the top-line release result.** The top line should be
the required physical and production journeys, followed by unit coverage.

---

## 11. What cannot be judged from the available evidence

- **[V]** Whether iOS prevents another sandboxed app from reaching the loopback listener.
- **[V]** URLSession proxy behavior across suspension, process eviction and port reuse.
- **[V]** Why the gym Worker accepted 114 ms while production is expected to have 10 ms.
- **[V]** The currently deployed production commits, plan, secrets, DNS state and schema without
  inspecting production.
- **[V]** App Store Connect and Play Console build-number history.
- **[V]** Whether metadata correlation by `.com` violates the intended public privacy promise.
- **[V]** Actual recoverability of existing user data after the storage rewrite.
- **[V]** Current hardware behavior for the listed iOS, Android and Windows paths.
- **[V]** Support staffing, incident communication and manual recovery capability.
- **[V]** Whether the product can sustain the operational cadence implied by CA leases, YubiKey
  endorsements, DNS canaries, store reviews, appliance publication and destructive recovery drills.

---

## 12. Commit-sized changes

Each item is intentionally scoped to one reviewable commit.

1. Restore an offline-maintainer-signed relay-address manifest with sequence, expiry and
   anti-rollback.
2. Replace “relay hint failed means DNS failed” with a distinct `relay-route-unverified` error.
3. Stop and invalidate the iOS relay forwarder and URLSession when suspension becomes possible.
4. Recreate the iOS relay forwarder and session on foreground entry.
5. Add connection-count, header-read and idle deadlines to `RelayForwarder`.
6. Add iOS tests for forwarder restart, stale proxy port and concurrent loopback clients.
7. Replace migration status’s separate session/eviction reads with one D1 query or batch.
8. Add migration, assignment, health, usage, eviction and sample-create CPU scenarios.
9. Fail the Free-plan gym gate on any recorded `cpuTime > 10 ms`, regardless of outcome label.
10. Record Worker plan/limits in the release evidence artifact.
11. Move sample-user provisioning behind an asynchronous job or operator-only Worker.
12. Add a crash-recoverable journal around plain-volume-to-loop-image conversion.
13. Add post-conversion file-count, size and checksum verification before deleting the old volume.
14. Add an iOS CI workflow for release configuration and the release-clean Mach-O scan.
15. Add Android emulator gyms to the required Android CI workflow.
16. Feature-gate peer backup off unless production readiness evidence is present.
17. Feature-gate security-notice lock mode off while leaving banner notices available.
18. Add a production wildcard canary that alarms on NODATA/NXDOMAIN during ACME activity.
19. Add a release guard requiring current CA-lease and endorsement hashes.
20. Add a release guard requiring approved/available minimum iOS and Android store builds before
    `.com` enforcement changes.
21. Add a routing-target writer inventory test enforcing the RCK replacement invariant.
22. Add a restore-verification receipt to the backup metadata and UI.
23. Prevent Migrate source wipe until the target has served a phone-verified restored app.
24. Split boot-unlock approval from the future security-notice lock gate.
25. Use the deeper teal token for selected-state borders and focus indicators.
26. Add stable, copyable diagnostic codes to every mapped user-facing network error.
27. Add a machine-readable release manifest covering commits, schema, artifacts, DNS, stores and
    hardware receipts.
28. Add a release-freeze invalidation map so relevant code changes expire prior test receipts.
29. Document the metadata visible to `.com`, `.services`, DNS, networks and local apps.
30. Document preview acceptance criteria for Windows, Linux and Wear surfaces.

---

## 13. Final recommendation

**[I] Flagship should launch later with fewer enabled features, not now with a larger disclaimer.**

**[I] The shortest credible route to GA is:** freeze features; use Workers Paid; disable peer backup
and lock notices; fix or sign relay hints; prove iOS/Android relay behavior; prove two-device iOS
pairing; publish and boot-test both VM artifacts; complete the real-data migration and destructive
restore drill; verify legacy accounts; renew the CA lease; create the final endorsement; then rerun
the full production-equivalent gym and exact release builds.

**[I] After those pass, the remaining UI polish, preview-platform breadth and disabled future
features can ship as documented limitations.** Before they pass, the missing evidence sits in the
product’s trust, boot and recovery paths and must block GA.
