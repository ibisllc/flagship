# Per-app account id (v2)

A visitor's key toward one app on one account (`deriveAppAccountId` in
`packages/protocol/src/keys.ts`; webapp `keystore.js`, Swift `ServiceInvite`,
Kotlin `ServerKeys` read these vectors):

    seed = HKDF-SHA256(UMK, salt = "", info = "flagship/app-aid/v2|<accountZone>|<appRef>")
    key  = Ed25519 from seed

- `accountZone` is the HOSTING account's zone, `<account>.<data apex>`, from
  `appAccountZone(serverId, dataApex)`: the label just left of the data apex in
  the box name the client signs for and posts to (TLS proves it). Never taken
  from a link parameter. Names outside the data apex (`fshp.app`, custom
  domains) give no zone. Org servers sit under the org's name, so an org app
  scopes to the org.
- `appRef` is the app's service id (`<creator>--<slug>`).

`cases` pin keys; `sameAppOtherHost` is the marketplace case (one app id, two
host accounts, two unrelated keys); `sameAppAnyInviter` shows the inviter is not
an input; `accountZones` pins the zone of each kind of box name;
`invalidAppRefs` and `invalidAccountZones` must be refused before deriving.
Rationale and the flag day: `docs/service-access-gating.md`, "Per-app identity".
