# `.maintainers/ca-endorsements/`

Committed home of signed `CaEndorsement` envelopes — the present-tense,
liveness-sensitive leases that authorize the live `.com` hot CA key to
mint `UserPubKeyBinding` (directory attestation) and `DemoDirective`
artifacts.

This directory **starts empty** (only this README + the
`bundle.json` array, which is `[]` until the first ceremony). A
`CaEndorsement` is added ONLY by the human YubiKey ceremony documented
in [`docs/ca-operations.md`](../../docs/ca-operations.md) — "CaEndorsement
ceremony runbook". The ca-track holder key (key #1) signs each lease;
the verifier in every consumer (the daemon's `releaseVerifier` +
the `.com` Worker's `caGate`) checks the FULL chain
(`verifyMandateChainFromPin(BAKED_PIN, ca-track mandates)` →
`verifyCaEndorsements(...)`) at request/startup time.

## Files

- `bundle.json` — a JSON array of every committed `CaEndorsement`,
  in filename-sorted order. The Cloudflare Worker has no filesystem,
  so it `import`s this single bundled array (esbuild inlines it). The
  daemon, which does have a filesystem, reads the individual
  `*.json` files directly via `releaseVerifier`. The ceremony writes
  BOTH the individual `<id>.json` AND regenerates `bundle.json` so the
  two consumers stay in lockstep (the runbook spells out the exact
  command).

## Trust-model note

An empty `bundle.json` is **safe-by-construction**: the #30 chokepoint
fail-closes `no-authorized-ca-keys`. The Worker ships in OBSERVE mode
(env `CA_ENDORSEMENT_ENFORCE` unset/false) so an empty endorsement set
changes nothing observable in production — it only emits a structured
log line. ENFORCE is engaged by a human only AFTER a valid endorsement
is committed here.
