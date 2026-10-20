# Outbound hosts: where a box's AI calls may leave through the hub

Status: built on `main` (2026-10-20). Needs D1 migration `0106_outbound_hosts.sql` before the
`.com` deploy, and a `.services` deploy.

## What this is, and what it is not

Flagship does not run a general proxy. Two things on `.services` do carry bytes for a box, both
end-to-end encrypted so we cannot read them:

- **Inbound.** A connection to `<server>.<user>.flagship.services` is passed through the relay to
  the box's tunnel (SNI passthrough; TLS ends on the box).
- **Outbound, AI calls only.** When an owner turns the relay on for an AI credential, the box asks the
  hub to open `host:443` and runs TLS to the provider over that stream, so the provider sees the
  hub's address and not the owner's. Only the box's own LLM harness uses this (`providerRelay`
  in `packages/server-daemon`); apps running on the box have no handle to it. A credential with
  `relay: false` sends its call straight from the box.

## The known risk

The hub checks that the caller is an authenticated box and that the destination is a public
HTTPS name. It cannot check that the caller is our harness: an owner has root on their own box and
could send the same frames from modified software. So the hub could be used to reach a host that
is not an AI provider, from the shared `flagship-services` egress address. That is a risk we
accept for the privacy it buys, and manage with the list below.

## The list

`.com` keeps one row per host in D1 (`outbound_hosts`), and a per-host daily total
(`outbound_host_daily`: streams, bytes up, bytes down, refusals).

- **A new host is allowed.** The first time a box asks for a host the hub has not seen, `.com`
  records it as allowed. A new AI provider just works.
- **The owner can block a host with one flag** (`npm run outbound-hosts -- block <host> <why>`).
  The hub notices within about two minutes and refuses it (`forbidden-host`).
- **Up to 100 new hosts a day** are recorded. After that, an unseen host is refused until the
  next day or until the owner allows it.
- **`.com` unreachable:** the hub keeps its last answer, and an unseen host is allowed only if it
  is one of the known AI providers compiled into the hub.
- **No `.com` secret on the hub:** the known providers only.
- Per-box limits are unchanged: 8 streams, 120 opens a minute, about 4 MiB/s, port 443, public
  addresses only.

## Nothing here names a user

The hub calls `.com` with its own shared secret and sends only a host (or a list of hosts with
counts for the last 15 minutes, summed across every box). No table has an account, box, device or
address column, and a test fails if one is added. The hub still logs only totals. Daily rows are
dropped after 60 days.

## Reviewing it

```
npm run outbound-hosts                      last day, busiest first
npm run outbound-hosts -- --new             hosts first seen today
npm run outbound-hosts -- --days 7 --blocked
npm run outbound-hosts -- block <host> <note>
npm run outbound-hosts -- allow <host>
```

It points out new hosts, a host that took a lot of uploaded data (AI calls are mostly download),
and allowed hosts that do not look like API hosts. Look at it at least weekly.

## What a person sees

When the hub will not open an address (blocked, or one the hub cannot dial), the box says: "the
Flagship relay didn't connect to <host> because that outbound address couldn't be reached from
here (try again later, or turn the relay off for this key to connect directly), so the AI call
wasn't sent." It never says the host was blocked; a legitimate user learns what to try next.

## The starting list

The providers that come baked into the apps (`packages/llm-providers`): `api.anthropic.com`,
`api.openai.com`, `generativelanguage.googleapis.com`, `openrouter.ai`. (Ollama is local and
never uses the hub.) Every other host, including Flagship's own inference host, is added the
first time a box asks for it.

## TODO: a heuristic blocker

Blocking by hand (`npm run outbound-hosts -- block <host>`) is the whole system today. If the
number of hosts or complaints makes that too slow, design a heuristic system that flags or blocks
by itself, without learning who is calling. Ideas to weigh then: upload-heavy hosts (AI calls are
mostly download); a host that is new, busy and not an API-looking name; many different boxes
reaching a host nobody else uses (we cannot count boxes, so this needs a coarse, non-identifying
signal); a host that appears on abuse lists. Until then the review command's "worth a look"
lines are the heuristic.

## If you see an attack from us

Tell `security@flagshipserver.com` the address and the time. We will look at the host, and if it
is not an AI provider we will block it. A block takes effect within about two minutes.
