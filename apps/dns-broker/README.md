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

## Endpoint

`POST /rpc` — JSON body, JSON response. Three kinds:

| `kind`                | Authority                                                                                       | Effect                                                  |
|-----------------------|-------------------------------------------------------------------------------------------------|---------------------------------------------------------|
| `publishTxtChallenge` | Pod daemon signature for pod-namespace ACME; AppGrant or IRK signature for user-zone ACME       | Creates a TXT record at `_acme-challenge.<host>`         |
| `publishARecord`      | Pod daemon signature over `(serverId\|targetIp\|recordType\|issuedAt)`; target IP allowlisted    | Creates an A or AAAA record; refuses to overwrite        |
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

### Set on the MAIN Worker (not this Worker)

| Name             | Meaning                                              |
|------------------|------------------------------------------------------|
| `DNS_BROKER_URL` | Public URL of this Worker (e.g. `https://flagship-dns-broker.workers.dev`). |

The main Worker only needs `DNS_BROKER_URL`. The main Worker MUST NOT
have `CLOUDFLARE_DNS_API_TOKEN` set anymore in the production
deployment; if both are set the broker takes precedence and a
predeploy-check can flag the duplicate.

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

```
cd apps/dns-broker
wrangler secret put CLOUDFLARE_DNS_API_TOKEN
wrangler deploy
```

This Worker is deployed independently of `apps/com` and has its own
log stream. Rolling back the main Worker does not roll back the broker
and vice versa.
