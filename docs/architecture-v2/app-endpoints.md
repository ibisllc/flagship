# How the daemon reaches an app on Podman (decision B, 2026-10-27)

Status: DESIGN v2 (2026-10-27): owner-approved direction, reviewed; section 3a and section 8 settle the review points. Nothing below is built yet. Written after the first live gym run of arch-v2 on
Debian 13 showed that no app on a Podman box is reachable.

## 1. The problem, as measured

The daemon runs each app with `-p 127.0.0.1:<hostPort>:<containerPort>` and reaches it at `127.0.0.1:<hostPort>`.
The app bridges (`fs-apps`, `fs-staging`, `fs-build`) are created `mode=unmanaged` so the daemon owns them and they
exist from boot (the egress gateway binds the bridge address). In unmanaged mode netavark only attaches the veth: it
sets up no NAT, no port forwarding and no sysctls (podman-network-create(1)). Live box, Podman 5.4.2:

- the published port is held by `conmon` and forwards nothing (`curl 127.0.0.1:<port>` -> no answer);
- netavark wrote DNAT rules for Postgres (a managed network) and none for the app;
- `route_localnet` was 0 on the bridge and setting it did not help;
- the container's bridge IP answers directly, for root and for the daemon's user.

This is a contract mismatch, not a missing setting. Docker's classic stack hides it with its userland proxy.

## 2. Decision

Keep the daemon-owned unmanaged bridges. Stop publishing ports. The daemon connects to the container directly, through
ONE internal endpoint resolver. Order of priorities: security, then availability, then performance. Rejected:
a daemon-side forwarder (a listener per app, a recovery lifecycle, an extra hop), broker-installed DNAT (a new
privileged operation), managed bridges (netavark deletes a bridge when its last container leaves, which breaks the
gateway), host networking (defeats the egress isolation).

## 3. The endpoint resolver

Callers name a SERVICE; the resolver returns its current, verified endpoint. A caller never supplies an address.

```
resolveEndpoint({ serviceId, env, component, role }) -> { host, port, generation, incarnation } | unavailable
```

Properties (each needs a test):

1. Trusted discovery. The address comes from the engine (`podman inspect` through the broker), for the container the
   daemon itself created (name and label `flagship.service=<serviceId>`, `flagship.generation=<n>`), and only if that
   container sits on the expected network. The port is the manifest's `runtime.port` (already validated), never a free
   value. A manifest cannot make the daemon dial an arbitrary host.
2. Identity is the CONTAINER GENERATION, not the IP. Every start or replacement gets a new generation; an endpoint
   carries it. A pooled connection or cached endpoint from an older generation is dropped.
3. Safe address reuse. When a container stops, its endpoint is invalidated BEFORE the address can be reassigned;
   in-flight proxied connections to it are closed. After a daemon restart the table is rebuilt from the engine, not
   from stored state.
4. Fail closed. Unknown, inconsistent (wrong network, wrong label, two containers claiming one service) or missing
   means "unavailable" (the proxy answers 503), never a fallback to another path.
5. Engine-assigned addresses first. No static-IP allocator: it adds its own reconciliation and still does not give
   identity.

Roles: `http` (proxy, readiness), `data` (dedicated database), `ai` (local AI). A role only picks the validated port.

## 3a. Settled after review (owner and advisor, 2026-10-27)

**Lookup key.** `serviceId` + `env` (`live` | `staging` | `build`) + `component` (`main` for a single-process app, the
component name for an app group) + `role`. Live and staging copies of one app never share an answer.

**Identity.** Two counters, both written as container labels by the daemon:
`flagship.generation` (one per deploy: install, update, rollback; a rollback gets a FRESH number, never the old one) and
`flagship.incarnation` (one per container start, read from the engine: the container id plus its `StartedAt`). An
engine restart of the same container changes the incarnation, not the generation. Readiness belongs to an
incarnation, and an endpoint is only trusted while its incarnation is current.

**Observation.** The broker (engine parsing stays there) returns a typed record `{ containerId, generation, startedAt,
running, networks: [{ name, ip }] }`, never raw inspect output (it can hold secrets). The resolver lives in the daemon,
which owns routing, readiness and connection lifetimes.

**Address-reuse fence (the part an inspect-then-connect cannot give).** An address is owned by one SERVICE for the life
of that service on that box, not by a container:

1. The daemon allocates each service a static address from a pool in the bridge subnet (`--ip`), recorded in the
   installed-services store. Netavark never picks an address for an app. (This reverses the earlier "engine-assigned
   first" rule: without it nothing prevents another app inheriting a dead app's address.)
2. A stale dial can therefore only reach (a) nothing, or (b) a later incarnation of the SAME service, which is the
   same app and the same permissions. It can never reach another app.
3. An address returns to the pool only after: the endpoint is invalidated, every tracked connection and pending dial
   for that service is closed, the container is removed, AND a quarantine has passed (60 s). Delete of the service is
   the only event that frees it.
4. Pending dials are registered BEFORE they connect, so an invalidation that races a dial cancels it.
5. Order on any stop, replace, update or rollback: stop admitting new connections, close existing ones (WebSocket,
   streaming HTTP, pooled sockets, pending dials), then stop and remove the container.
6. The pool is checked at boot against the engine (an address held by a container that is not the recorded service's is
   a fault: that service stays unavailable).

To verify live before building on it: that Podman 5.4 honours `--ip` on an `unmanaged` bridge network.

**One resolver, both engines.** Docker boxes resolve to their existing loopback mapping through the same interface, so
generation, incarnation and invalidation semantics are shared and tested once.

## 4. What changes (inventory of this checkout)

| Consumer | Today | Becomes |
|---|---|---|
| `serviceProxy.ts:302`, `runtime.ts:515` (reverse proxy) | `127.0.0.1:<allocated port>` | resolver, `http` |
| `serviceRunner.ts` `httpAnswers`, `buildStartCheck` (readiness) | `127.0.0.1:<port>` | resolver, `http` |
| `serviceRunner.ts:790` `portArgs` | `-p 127.0.0.1:h:c` | none (Docker/classic keeps `-p`) |
| `buildmodes/staging.ts:846` (AI test copy probes) | `127.0.0.1:<port>` | resolver, `http`, staging network only |
| `localAi/service.ts`, `localAi/containers.ts` | `127.0.0.1:<port>`, `-p ...:8080` | resolver, `ai` |
| `dataLayer/dedicated.ts:135` (per-app database) | `-p`, loopback | resolver, `data` |
| `appGroups/runner.ts` (multi-process apps, links) | loopback probes + gateway links | SEPARATE inventory (section 5) |
| `InstalledService.containerPort` / `installedServicesStore.hostPort` | the allocated loopback port (confusing name) | kept as a stable handle for Docker; unused by the Podman path |

Two engine paths stay: `docker`/classic keeps `-p` (existing boxes), `podman` uses the resolver. The choice is the
engine already recorded in `/var/lib/flagship/engine-active`.

## 5. Multi-process app links need their own look

Links are not necessarily daemon-originated, a container cannot use the host's loopback, and direct addressing must
not give apps broad access to each other. Before building: list every link kind in `appGroups`, who dials whom, and
what grants it today (the owned gateway ports). Preserve explicit per-app permissions and the staging/apps/build
separation; the `flagship_icc` bridge rules and the egress chains stay the single owner of isolation.

## 6. Existing users (a requirement of this release)

- Existing boxes keep running exactly as they do (Docker, no switch file). Classic stays supported for them; it is
  NOT removed by this release. It is, however, currently an unresolved failure for NEW Debian 13 boxes
  (gym, 2026-10-27: install returns 500) and must be understood separately.
- Upgrade in place: the owner-signed engine switch (`archV2Switch.ts`: trial boot, auto revert) and the Docker->Podman
  migration with rollback (`engine/migrate.ts`). Both must run in the gym against a real Docker box.
- Where an in-place switch is not possible: backup, then restore onto a new arch-v2 box (data sovereignty already
  gives the owner a backup path). Needs an end-to-end gym lane and a runbook.

## 7. Launch gate (recovery and isolation, not just "an install works")

1. Every consumer above works on live Debian 13 + Podman + gVisor.
2. Negative tests: an app cannot reach another app, staging, a host management service, or a forbidden destination.
3. Restart, reboot, replacement, IP reuse, concurrent install and failed update: no wrong-app routing, no moment
   without isolation.
4. The full applicable gym (both lanes for existing boxes), then load and resource-exhaustion tests.
5. The existing-box upgrade and restore lanes pass.

## 8. Decisions on the open questions

1. Resolver in the daemon; the broker supplies the typed observation (section 3a).
2. Connections are tracked by service and incarnation and destroyed on invalidation (HTTP, streaming, WebSocket,
   pending dials, pooled sockets); a transparent WebSocket proxy closes both sockets; a graceful close frame needs
   protocol awareness and is not required.
3. Readiness is per incarnation: probe the expected container, then accept only if that incarnation is still
   current when the probe returns.
