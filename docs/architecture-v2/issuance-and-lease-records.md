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
| `status-assertion/v1` | the `.com` status key (pinned like the relay blessing) | relay | revocation: 60 s lifetime, refreshed every 20 s, fail closed, 65 s to disconnect |
| `route-claim/v1` | a phone's route key | relay | the phone keeps its claim by liveness; a higher generation from the same phone supersedes |
| `certificate-order/v1` | the device (box or phone) key | issuance service | the issuance service derives the names from its own state; the request never decides them |

The box's exact control name needs a registration that is not revoked, a fresh status assertion and the box's own
signature, and NO serving lease. App routes and app certificates need a lease whose `notAfter` has not passed.

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

flagship/status-assertion/v1|<box>|<regGen>|<policyGen>|<revoked>|<revision>|<validFromMono>|<validForMs>
    <revoked> = 0 | 1; <revision> only grows; <validForMs> <= 60000; a relay measures validity on its own monotonic clock
    from receipt and never extends it when it forwards the assertion

flagship/route-claim/v1|<account>|<phoneRoutePub>|<hostname>|<generation>|<sessionNonce>|<issuedAt>
    <hostname> is exactly `<user>.flagship.services` (the phone name); a box can never hold this claim

flagship/certificate-order/v1|<class>|<device>|<regGen>|<csrSha256>|<requestId>|<issuedAt>
    <class> = control | apps | phone; the service ignores any SAN list in the CSR beyond checking it equals the set
    it derived from trusted state
```

## 3. Rules the verifiers enforce (each is a test)

1. **Relay admission.** An app stream is admitted only with a fresh unrevoked status assertion AND a lease whose
   `notAfter` is in the future AND an installed-app route binding for that exact name. A control-name stream needs
   the assertion only. The bare phone name is refused for every box.
2. **Lease expiry.** At `notAfter` the relay stops admitting app streams, closes existing ones within 5 s, removes the
   box from canonical-app allocation and failover sets, and leaves the control route alone.
3. **Revocation.** Committing a revocation advances `revision` before the admin sees success, is pushed to every
   relay, and ends the whole tunnel; a relay that stops receiving assertions fails closed when the last one expires.
   Externally observable within 65 s. A revoked generation never revives.
4. **Issuance.** One service owns the ACME account and does DNS-01 for all three classes. Control orders need an
   unrevoked registration (also after the lease expired). App orders need a lease valid at the order AND re-checked
   before challenge completion and finalization. The phone name is never ordered for a box. Boxes renew their own
   certificates only inside the renewal window (the service refuses earlier orders). A certificate issued in a race
   with revocation is queued for CA revocation and the relay revocation still holds.
5. **No downgrade.** Under the owner's strict policy every record above also needs its hybrid PQ companion; a lease or
   assertion without one is refused, and the policy generation prevents an older broader lease from being replayed.
6. **Liveness is not authority.** The tunnel's ping/pong and the unsigned application beat only keep a connection and
   carry the revocation revision; they never extend a lease or a claim. A claim lapses after about two minutes
   without a beat on the authenticated connection.

## 4. Open questions these formats expose

- Which key signs `status-assertion`: a dedicated `.com` key chained to the maintainer CA (like the relay blessing),
  or the CA key itself? A separate key limits a `.com` compromise to routing.
- The relay's trust anchor for leases: the admin root key per account (the relay learns it from `.com`, which can lie)
  or the key the BOX pins and presents in HELLO (the relay cannot lie about it, but then a box could present a stale
  one). The spec's answer is "independent relay authorization": the relay checks the lease's signature against a key
  `.com` publishes AND the box's pinned key must match, so neither alone suffices.
- Whether the renewal key lives in the phone's secure hardware (cannot sign while locked, so no daily renewal on a
  locked phone) or in a software key the phone holds open for the session (renews in the background, weaker custody).
- `routeScopeSha256` and `certScopeSha256` hash a canonical list of names; the listing format is to be fixed with the
  route allocator (H5/H9), because a control-name collision with an app alias must be impossible by construction.
