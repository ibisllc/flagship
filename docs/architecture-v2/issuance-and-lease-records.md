# Signed records for phone TLS, routing claims, serving leases and revocation (plan H1 to H9)

Status: PROPOSED wire formats for owner review, written 2026-10-30. Nothing here is built. They follow the
repository's rules (`flagship/<purpose>/v1|field|field`, strict v1 canonical builder, lower-hex keys, integers within
`Number.MAX_SAFE_INTEGER`, strict Ed25519, a hybrid PQ companion when the owner's policy is strict). They put into
bytes the owner's decisions of 2026-10-30 (journal, Appendices H and I); each line says which decision it carries.

## 1. Who signs what

| Record | Signed by | Checked by | Carries decision |
|---|---|---|---|
| `serving-policy/v1` | the admin root (sensitive-order key) | `.com`, issuance service, relay | grace is 7 days, 30 days or indefinite; reducing it advances the policy generation |
| `renewal-key-delegation/v1` | the admin root | issuance service, relay | a narrowly delegated renewal key (cannot add boxes, widen scope, extend past the grace, change policy or undo revocation) |
| `serving-lease/v1` | the admin root or the delegated renewal key, about daily while a phone is online | relay (route admission), issuance service (certificate permission) | the dead-man is its nullable `notAfter` |
| `revocation-entry/v1` | `.com`'s existing revocation-list key | relay | revocation is pushed, not polled: an append-only log with a monotonic sequence (owner, 2026-10-31) |
| `route-claim/v1` | a phone's route key | relay | the phone keeps its claim by liveness; a higher generation from the same phone supersedes |
| `certificate-order/v1` | the device (box or phone) key | issuance service | the issuance service derives the names from its own state; the request never decides them |

The box's exact control name needs a registration that is not revoked (checked when its tunnel is admitted and kept
current by the pushed revocation log) and the box's own signature, and NO serving lease. App routes and app certificates need a lease whose `notAfter` has not passed.

## 2. The records

All times are epoch milliseconds from the verifier's own authenticated clock, never the box's. `<box>` is the box's
immutable identity public key (64 hex); `<gen>` is the registration generation (an explicit owner re-enrolment starts
a new one; revocation is terminal for a generation).

```text
flagship/serving-policy/v1|<account>|<box>|<regGen>|<policyGen>|<grace>|<routeScopeSha256>|<certScopeSha256>|<issuedAt>
    <grace> = 7d | 30d | indefinite        (never a large number standing in for "forever")

flagship/renewal-key-delegation/v1|<account>|<renewalPub>|<policyGen>|<expiresAt>

flagship/serving-lease/v1|<account>|<box>|<regGen>|<policyGen>|<leaseId>|<issuedAt>|<notAfter>
    <notAfter> = <ms> | none               (none only under an `indefinite` policy)
    <leaseId>  = 32 hex, unique; a replayed or older lease for the same policy generation never extends authority

flagship/revocation-entry/v1|<sequence>|<box>|<regGen>|<revokedAt>
    <sequence> only grows, one per committed revocation; a relay applies entries in order and fetches "since N" on any
    gap or reconnect before it admits a new tunnel

flagship/route-claim/v1|<account>|<phoneRoutePub>|<hostname>|<generation>|<sessionNonce>|<issuedAt>
    <hostname> is exactly `<user>.flagship.services` (the phone name); a box can never hold this claim

flagship/certificate-order/v1|<class>|<device>|<regGen>|<csrSha256>|<requestId>|<issuedAt>
    <class> = control | apps | phone; the service ignores any SAN list in the CSR beyond checking it equals the set
    it derived from trusted state
```

## 3. Rules the verifiers enforce (each is a test)

1. **Relay admission.** A tunnel is admitted only for a registered box whose generation the relay's revocation log
   (current to its last sequence) does not revoke. An app stream also needs a lease whose `notAfter` is in the future
   AND an installed-app route binding for that exact name. A control-name stream needs neither. The bare phone name is
   refused for every box. The lease's signature must verify under the key `.com` publishes for the account AND equal
   the admin key the box pinned and presents in HELLO (owner, 2026-10-31): neither source alone suffices.
2. **Lease expiry.** At `notAfter` the relay stops admitting app streams, closes existing ones within 5 s, removes the
   box from canonical-app allocation and failover sets, and leaves the control route alone.
3. **Revocation (pushed, owner 2026-10-31).** Committing a revocation appends a signed entry with the next sequence
   before the admin sees success; `.com` pushes it to every relay instance over one long-lived connection per relay
   (a Durable Object), and the relay ends the whole tunnel at once. The admin's app shows "confirmed by every relay"
   once each relay acknowledged the sequence. One heartbeat per relay about once a minute (cost scales with relays, not
   boxes). A relay that has not heard from `.com` for about 1 minute refuses NEW tunnels; established tunnels keep
   running for a 10 minute grace, then are dropped until contact returns. A revoked generation never revives.
4. **Issuance.** One service owns the ACME account and does DNS-01 for all three classes. Control orders need an
   unrevoked registration (also after the lease expired). App orders need a lease valid at the order AND re-checked
   before challenge completion and finalization. The phone name is never ordered for a box. Boxes renew their own
   certificates only inside the renewal window (the service refuses earlier orders). A certificate issued in a race
   with revocation is queued for CA revocation and the relay revocation still holds.
5. **No downgrade.** Under the owner's strict policy every record above also needs its hybrid PQ companion; a lease or
   assertion without one is refused, and the policy generation prevents an older broader lease from being replayed.
6. **Renewal on use (owner 2026-10-31).** Every admin device (phones and the webapp) re-signs the box's lease when the
   app is opened, with a hardware-backed renewal key that signs without a prompt (non-extractable WebCrypto key in the
   webapp). There is no background renewal: the box stops serving apps when no admin device opened Flagship within the
   grace. A fresh install holds no renewal key; logging in again issues a new delegation. The only UI: the server page
   shows the deadline ("Stays online until <date> if no admin opens Flagship", or "No time limit"), and admins change
   the grace there (Face ID, a new `serving-policy/v1`; shortening advances the policy generation).
7. **Liveness is not authority.** The tunnel's ping/pong and the unsigned application beat only keep a connection and
   carry the revocation revision; they never extend a lease or a claim. A claim lapses after about two minutes
   without a beat on the authenticated connection.

## 4. Settled questions (owner, 2026-10-31)

- Revocation: pushed log with sequence numbers instead of per-box status assertions every 20 s (unsustainable).
  Lost contact: refuse new tunnels after ~1 min, drop established ones after a 10 min grace.
- Lease trust: both `.com`'s published account key and the box's pinned admin key must agree.
- Renewal key: hardware-backed, no prompt, renewed on app open on every admin device (webapp included); a fresh
  install discards it.
- Name lists: canonical, sorted, lowercase, one per line, each tagged `control`, `apps` or `phone`; the route
  allocator reserves every control name so no app alias can take one; shared vectors in TS, Swift, Kotlin and Rust
  and a collision test.
