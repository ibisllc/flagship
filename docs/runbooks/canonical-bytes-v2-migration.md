# Canonical-bytes v2 — length-prefix framing migration

**Status:** Planning. Targeted for staged rollout starting 2026-09; full
sunset of v1 by 2027-12. Tracked as task #96.

## Why migrate

Today every envelope uses `|`-joined canonical bytes:

```
flagship/<purpose>/v1|<field1>|<field2>|...
```

The per-field separator-rejection added in #12 + the AppGrant envelope
forecloses the canonicalization-ambiguity attack class on **new** envelopes
authored after that hardening. Legacy envelopes (BootChallenge,
ImageRebuildRequest, ServerRevocation, MembershipMutation, MigrationRequest,
InviteToken, InviteAcceptance, AuthCode, AuthCodeRevocation, InstallBlob,
PublishServerDns, Dns01PublishRequest, Dns01DeleteRequest, ClaimUsername,
LlmPromoIssueRequest, RegisterRck, SetRoutingTarget, EntitlementRevocationList,
RootEntitlement, AppEntitlement, TunnelHelloV2, etc.) still use raw `|`-join
without per-field validation.

The v2 format eliminates the separator concern by structural framing:

```
flagship/<purpose>/v2|<len1>:<field1>|<len2>:<field2>|...
```

Where `<lenN>` is the UTF-8 byte length of the next field as ASCII
decimal. Verifiers split by parsing the length first, then reading
that many bytes — independent of the bytes' contents.

Field shapes are unchanged. The `<lenN>:` prefix removes the ambiguity
that a future change to a field's allowed character set could introduce
a separator-collision attack.

## Migration design

### Wire interop during the migration window

Each signer ships **only v2** after a coordinated rollout per envelope type.
Each verifier accepts **both v1 and v2** for the duration of the migration
window — at least 12 months from the first v2 envelope ship date for that
envelope type, longer for envelopes used in long-lived persisted state
(install trailers, peer-backup chunk metadata).

### Per-envelope rollout phases

For each existing envelope kind:

1. **Plan** — pick the migration date; document in this runbook with a
   target row.
2. **Add v2 canonicalizer in packages/protocol** alongside the existing
   v1 function. Tests cover the new function explicitly; the canonical
   bytes for the same logical envelope are intentionally DIFFERENT in
   v1 vs v2 (different tag prefix).
3. **Add v2 verifier in packages/protocol**. The verifier exposed to
   callers tries v1 first (for backward compat), then v2. Callers that
   want to reject v1 explicitly can call a `verify*V2Only` variant.
4. **Verifier deploy** — ship v2-accepting verifiers to .com Worker,
   the daemon, the phone app, the webapp peer, and the browser extension.
   Wait at least 30 days for daemons-in-the-wild to update.
5. **Signer cutover** — flip the signer to v2 only. Old v1-only verifiers
   start rejecting; logs surface the rejection so the operator can spot
   stragglers.
6. **Sunset window** — accept v1 for the remainder of the documented
   window (12 months for routine envelopes, 24+ months for trailer-style
   envelopes).
7. **Drop v1 acceptance** — remove the v1 canonical bytes function and
   verifier. Final commit retains them in a `legacy.ts` file with a
   "do not import" comment for archaeology purposes.

### Stage groups

Rolling out 25+ envelope types sequentially is high-toil. Group them by
risk + freshness sensitivity:

| Group | Envelopes | Earliest v2 ship | Reason |
|---|---|---|---|
| A — short-lived runtime | BootChallenge, TunnelHelloV2, SetRoutingTarget, PublishServerDns, Dns01PublishRequest, Dns01DeleteRequest, LlmPromoIssue | 2026-09 | Reissued frequently; quickest to roll over |
| B — moderate-lived | AppEntitlement (deprecated; skip), EntitlementRevocationList, RootEntitlement (deprecated; skip), PushTokenRegister, AuthCode | 2026-11 | 90-day cycles; one window per envelope |
| C — long-lived state | InstallBlob, RegisterServer, ClaimUsername, MembershipMutation, MigrationRequest, InviteToken/InviteAcceptance | 2027-02 | Persisted state may live years; longer overlap |

Group A starts first; Group B follows once A is stable; Group C waits
on B. All target full sunset of v1 by 2027-12.

### Already on v2-equivalent semantics

These envelopes were either added after the H1 hardening or built with
length-aware framing from the start:

- AppGrant (#90)
- AppAccessInvite + AppAccessAcceptance (#79)
- RotateRck / RecoverRck / RevokeRecoverRck (#75)
- MergeBack (#76)
- PodIdentityBinding (#89)
- UsernameRename (#93)

They already validate fields for `|` and control characters at sign-time.
The v2 migration includes them mechanically (same tag-prefix change,
same length-prefix structural addition), but their security properties
don't change.

### Test strategy

For each migrated envelope:

1. Existing v1 round-trip tests stay green throughout the migration.
2. New v2 round-trip tests added at canonicalize-time.
3. Cross-version interop tests: sign with v1, verify with v1+v2-aware
   verifier (must accept); sign with v2, verify with v1-only verifier
   (must reject).
4. A "no canonical-byte regressions" snapshot test pins the exact bytes
   produced for a fixed input — catches accidental reordering.

### Audit hook

Once v2 is the only accepted format for an envelope, add an audit-log
entry on each verifier path. If a v1 envelope arrives post-sunset,
emit a single per-day operator alert so we know the deprecation was
respected in the wild.

## Tracking

When you ship a v2 canonicalizer for an envelope kind, add a row here:

| Envelope | v2 canon shipped | v2 verifier shipped | v2 signer cutover | v1 sunset |
|---|---|---|---|---|
| _none yet_ | | | | |

Update this row as each phase completes so future contributors see the
state of the migration without grepping the codebase.
