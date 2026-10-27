# How the daemon reaches an app on Podman (decision B, 2026-10-27)

Status: DESIGN, owner-approved direction; nothing below is built. Written after the first live gym run of arch-v2 on
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
resolveEndpoint(serviceId, role) -> { host, port, generation } | unavailable
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

## 8. Open questions

- Resolver location: in the daemon (reading through the broker) or typed in the broker? Leaning daemon, broker supplies
  the inspect result.
- How a long-lived upgraded connection (WebSocket) is closed on generation change.
- Whether the readiness probe should also check the container's generation label before trusting an answer.
