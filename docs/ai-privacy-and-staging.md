# AI privacy, staging and egress

**Status:** owner decisions 2026-10-12; build in progress (see AGENTS.md).
Supersedes the same-container idea in `dev-prod-dataspace-harness-spec.md` §4
for AI builds (it keeps that spec's synthesizer and dev dataspace).

## The rule

An AI (the box's own model with the owner's key, or an IDE agent over MCP)
only ever sees and controls **sample data from the repo or the internet**, on a
**private staging copy**, and **never again** once the app is live. Nothing it
can read may help a compromised or curious AI provider tell **who** the owner
is or **where** they are.

Threat model: the provider (or anyone who controls a model's output) is
hostile. It reads everything sent to it and controls every tool call and every
line of code the model writes. With the owner's own key the provider already
knows who pays; Flagship must not add the Flagship account, the server, the
owner's other apps, their address, time zone, locale or habits.

## 1. What the model may see

| Never | How it is kept out |
|---|---|
| Account name, server name, any `*.flagship.services` address | Not in any prompt; tool results, errors and logs go through `llm/modelPrivacy.ts` (`buildModelRedactor`) |
| The owner's other apps (names, descriptions, stores) | Removed from the chat prompt; name clashes are the box's to resolve |
| Plan/tier, clock times, time zone, locale | Not in prompts; `get_journal` returns kind/actor/summary only; staging runs `TZ=UTC`, `LANG=C.UTF-8` |
| The live URL or service id | `deploy` returns `{ok:true}`; the URL travels on a side channel the box keeps |
| Real data, real visitors, real logs | Staging copy only (§2); no tool reads a live container |
| Owner secret values | Names only (as before); staging injects placeholders, so even an app that prints its env leaks nothing |
| The box's public IP | AI traffic goes through the Flagship relay (§4); staging has no internet (§3); build RUN steps reach package registries only (§3) |

The redactor is applied to **box-written** text only. The repo's own files
(`read_file`, `list_files`) are passed unchanged: they belong to the repo, and
rewriting them would corrupt the code the model edits.

What the model still sees, by the owner's choice: the repo, the owner's own
instructions and attachments, the app's chosen name, and the NAMES of env vars
the app uses.

## 2. Staging, then live (AI create and AI edit)

One step for the owner ("Use AI to adapt and deploy"); two phases on the box.

**Staging (the AI's phase).**
- The AI's `deploy` builds the image and runs it as `flagship-stg-<buildId>` on
  the `flagship-staging` network, never routed from the internet (no owner
  preview either: the owner's browser headers would reach logs the AI reads).
- Its data stores are a fresh **dev dataspace** (`provisionDevDataspace`,
  seeded by the synthesizer from the app's migrations when it has a schema).
- Identity env is neutral: `FLAGSHIP_HOST=app.example`, `FLAGSHIP_CREATOR=owner`,
  a staging app id; owner env vars get placeholder values.
- Tools: `deploy` (to staging, with the start check), `check_app` (the box
  requests a path from the staging copy over loopback with neutral headers and
  returns status, content type and the first few KB), `get_logs` (staging
  container only), `finish` (the AI says it works). All results are redacted.

**Going live (the box's phase, after the AI is gone).**
1. The build is **sealed**: the AI key for it is forgotten, an MCP key is
   revoked, and every tool on that build refuses from then on.
2. The staging container and dev dataspace are removed.
3. The box installs (create) or redeploys (edit) the live service with the
   **same image** it staged, real data stores, real env, and runs migrations
   itself. The AI is not told the outcome.
4. If the manifest declares egress hosts (§3), the app still goes live, with
   no internet; its page asks the owner to allow those hosts, and only their
   signed approval opens them. Nothing waits, and nothing opens by default.

A live service can never be attached to an AI session: edits always start a
new build that stages a copy with empty or synthetic data. The chat ("vibe")
path's Deploy runs the same staged loop with the chat's files.

## 3. Network

- **Build sandbox** (`docker build`, network `flagship-build`): RUN steps reach
  only package registries (npm, PyPI, Alpine/Debian mirrors, GitHub, Go/Rust/Ruby
  registries) through the box's egress gateway; DNS answers only those names.
  `validate` rejects `ADD <url>` and `FROM`/`--from` outside the public
  registries (Docker Hub, ghcr.io, quay.io, mcr.microsoft.com, public.ecr.aws,
  gcr.io), because dockerd fetches those from the host network.
- **Staging** (`flagship-staging`): no internet at all; only its dev data
  stores on the host gateway.
- **Live apps** (`flagship-apps`): no internet by default. An app reaches only
  the hosts its manifest declares in `network.egress`, and only after the
  owner approves them with a signed grant (`flagship/app-egress/v1`, sensitive
  order key; consent is the signature the box verifies, never a boolean).
  Enforced by the box's egress gateway (TLS SNI and HTTP Host allowlists, a
  filtering DNS) plus firewall rules that drop everything else from the app
  bridges.

## 4. AI provider relay

Calls to a provider leave the box through the Flagship hub
(`flagship.services`) over the box's existing tunnel: TLS runs end to end
between the box and the provider, so Flagship sees only the destination host,
timing and size, and the provider sees Flagship's address instead of the
owner's. It is a per-key setting, **on by default**, shown when the owner adds
a key ("Better for your anonymity: the provider sees Flagship's address, not
yours") and in the key list. If a key asks for the relay and it is unavailable
the call fails rather than going direct. Local endpoints (a LAN Ollama) are
always direct. Later, possibly: a monthly relay allowance on Free and
unlimited on Pro (gating lives on `feat/marketplace`).

## 5. Residual risk (say it plainly)

Code the AI wrote runs on real data once live. The staging wall keeps the AI
from seeing that data; the egress wall keeps the code from sending it
anywhere the owner didn't approve. A malicious app can still misuse data it
legitimately holds inside its own UI.
