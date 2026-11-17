# Flagship DnsBroker Worker

Standalone Cloudflare Worker that owns the Zone:DNS:Edit API token for
`flagship.services`. The main `flagshipserver.com` Worker has no direct
DNS access; it RPCs into this Worker over its public URL.

## Why a separate Worker

Cloudflare's permission groups do not allow per-record-type scoping on
DNS edit tokens. A single token capable of writing A records can also
write NS records, MX records, anything. We can't shrink the token, so we
shrink the attack surface around it: the broker has a tiny code surface
(one endpoint, one file of policy), no D1, no R2, no assets, no
business logic beyond "verify a signature, call CF".

## Endpoints

### `POST /service`: the issuance service's challenge records (0.4, item F6)

Since 0.3 `.com`'s certificate issuance service owns the ACME account and answers DNS-01 itself; this route is the
only DNS write it needs, so `.com` holds no zone token (`src/service.ts`). The caller sends
`authorization: Bearer <DNS_BROKER_SECRET>` (a secret both Workers hold) and one `op`:

| `op` | Effect |
|---|---|
| `challenge.create` `{name, value, token}` | TXT at `_acme-challenge.<user>.<apex>`, `_acme-challenge.<box>.<user>.<apex>` or one label deeper (an old box certificate's app names, for the admin revoke); never the apex, a reserved label (`tunnel`, `gym`, `www`, ...) or deeper. The value must be a DNS-01 digest; with `ACME_ACCOUNT_THUMBPRINTS` set it must be the digest of `<token>.<thumbprint>` for one of those accounts. Idempotent; at most 4 records at a name. |
| `challenge.delete` `{id}` | Deletes a record only if it is a TXT record at an `_acme-challenge.` name under the apex. |
| `zone.list`, `zone.get` `{id}` | Read only: zone-health and the reap plan read the zone through these. The reap's deletes of old address records are refused (the root wildcard made them moot). |

An hourly cron removes challenge records older than an hour (`.com`'s own cron did while it held the token). A
`.com` compromise can still have certificates issued under the service's ACME account (it holds that key), but can no
longer touch the root wildcard, the CAA pair, NS or any other record.

### `POST /rpc` (the 0.2 box-signed RPCs; retired, see `policy.ts`)

JSON body, JSON response. Three kinds:

| `kind`                | Authority                                                                                       | Effect                                                  |
|-----------------------|-------------------------------------------------------------------------------------------------|---------------------------------------------------------|
| `publishTxtChallenge` | Pod daemon signature for pod-namespace ACME; AppGrant or IRK signature for user-zone ACME       | Creates a TXT record at `_acme-challenge.<host>`         |
| `publishARecord`      | Pod daemon signature over `(serverId\|targetIp\|recordType\|issuedAt)`; target IP allowlisted    | REFUSED under the root-wildcard layout (a record at a box name stops the zone wildcard below it) |
| `deleteRecord`        | Same authority that created the record (pod daemon for ACME or pod-A; IRK for user-zone records) | Deletes by id after asserting name + type match the authority's scope |

All RPC envelopes are time-windowed (default 5 minutes) and verified
before any Cloudflare call. The broker independently fetches the
expected daemon / IRK pubkey from the main Worker's public lookup
endpoints (`/api/server/by-domain/<id>` and `/api/users/<u>/pubkey-cert`)
— it does not trust whichever Worker called it. A fully-compromised
main Worker still cannot forge DNS without a valid signature against
the registered key.

On policy failure the response body is exactly `{"ok":false}` with no
diagnostics. The denial reason is logged via `console.warn`.

## Env-var contract

### Public vars (in `wrangler.toml`)

| Name                          | Meaning                                                                                                  |
|-------------------------------|----------------------------------------------------------------------------------------------------------|
| `MAIN_WORKER_URL`             | Base URL of the main Worker (`https://flagshipserver.com`). Used for public pubkey lookups.              |
| `CLOUDFLARE_SERVICES_ZONE_ID` | Zone id of `flagship.services` on Cloudflare.                                                            |
| `FLAGSHIP_APEX`               | `flagship.services` — apex this broker manages. Names outside this apex are refused.                     |
| `SERVICES_PASSTHROUGH_IPV4`   | Single allowlisted A-record target (Fly anycast).                                                        |
| `SERVICES_PASSTHROUGH_IPV6`   | Single allowlisted AAAA-record target (Fly anycast).                                                     |
| `RPC_REPLAY_WINDOW_MS`        | Max age of a signed RPC envelope, in ms. Default `300000` (5 min).                                       |

### Secrets (set via `wrangler secret put`)

| Name                       | Scope                                                  |
|----------------------------|--------------------------------------------------------|
| `CLOUDFLARE_DNS_API_TOKEN` | API token with `Zone:DNS:Edit` on `flagship.services`. |
| `DNS_BROKER_SECRET`        | Shared with `flagship-com` (`/service` callers). At least 32 characters (`openssl rand -hex 32`). |

Var `ACME_ACCOUNT_THUMBPRINTS` (in `wrangler.toml`): the `thumbprint` that
`GET https://flagshipserver.com/api/certificates/account` answers. Unset, any DNS-01 digest is accepted at an allowed
name.

### Set on the MAIN Worker (not this Worker)

| Name             | Meaning                                              |
|------------------|------------------------------------------------------|
| `DNS_BROKER_URL` | Public URL of this Worker (e.g. `https://flagship-dns-broker.workers.dev`). |

| `DNS_BROKER_SECRET` (secret) | The same value the broker holds. |

With both set, `.com`'s issuance service and the reap route use the broker
(`apps/com/src/brokerZone.ts`). The main Worker MUST NOT keep
`CLOUDFLARE_DNS_API_TOKEN` once an order has issued through the broker
(`wrangler secret delete CLOUDFLARE_DNS_API_TOKEN` in `apps/com`): while it is
there, the old clean-up paths (revoke, delete, transfer, admin GC) still use it.

## Token rotation runbook

1. Mint a replacement token in the Cloudflare dashboard with the same
   `Zone:DNS:Edit` scope on `flagship.services`. Use a one-week
   expiry on the new token so a leaked one doesn't outlive its
   rotation.
2. From the repo root:
   ```
   cd apps/dns-broker
   wrangler secret put CLOUDFLARE_DNS_API_TOKEN
   # paste the new token at the prompt
   ```
   The new secret is in effect for all new requests within seconds.
3. Hit `POST /rpc` with a known-good signed envelope and assert a 200.
4. Revoke the old token in the Cloudflare dashboard.
5. Tail logs (`wrangler tail`) for an hour and confirm no 502s from the
   broker — the runbook owner can confirm visually via the
   `/status/` page on `flagshipserver.com`.

The broker never returns the token in any response, and the only place
it appears in code is in the `authorization: Bearer …` header attached
to `https://api.cloudflare.com/client/v4/...` calls inside `index.ts`.
A grep of the broker source for `apiToken` / `Bearer ` should produce
only those direct-CF call sites.

## Deploy

Release step 20 (`scripts/release.sh`, `dnsbroker`) does this, and skips itself while `apps/com/wrangler.toml` sets no
`DNS_BROKER_URL`:

```
cd apps/dns-broker
wrangler secret put CLOUDFLARE_DNS_API_TOKEN
openssl rand -hex 32 | tee /dev/tty | wrangler secret put DNS_BROKER_SECRET   # same value on flagship-com
npm run deploy
```

This Worker is deployed independently of `apps/com` and has its own
log stream. Rolling back the main Worker does not roll back the broker
and vice versa.
