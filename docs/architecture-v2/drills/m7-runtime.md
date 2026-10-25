# Milestone 7 runtime drill: WASI apps (P04), app groups and dedicated databases (P05)

**Not run yet.** This is the procedure for the release manager; record the results here (the
RESULT lines, the commit, the VM, versions) the way `m5-upcloud.md` does, then delete the VMs.

What can't be checked on a Mac is checked here, on a throwaway Debian 13 VM, as root, by
`tools/arch-drills/m7/drill.ts` driving the daemon's own modules against the real engine, systemd
and kernel. The unit and contract tests that run anywhere are listed at the end.

## 1. The VM

- UpCloud, plain Debian 13 template, `de-fra1`, plan `4xCPU-8GB`, 60 GB MaxIOPS, label
  `flagship-env=arch-drill`, the token at `~/.config/flagship/upcloud-token` (as for m5/m6). Run it
  once on **amd64** and once on **arm64** (UpCloud's ARM plan, or any Debian 13 arm64 host): the
  worker compiles WebAssembly natively on each.
- From the Mac, at the commit under test:

  ```sh
  C=$(git rev-parse HEAD); git archive --format=tar -o /tmp/m7.tar $C
  scp /tmp/m7.tar tools/arch-drills/m7/setup-box.sh root@$IP:/root/
  ssh root@$IP "bash /root/setup-box.sh $C /root/m7.tar"
  ```

  `setup-box.sh` lays the tree out as an installed release at `/opt/flagship`, installs Docker,
  Podman, gVisor's prerequisites, `psql` and busybox, builds keyd/broker/core **and the WASI
  worker** `--locked`, and writes `installer/rust/PINS.json` with the worker's SHA-256, exactly as
  `tools/box-artifact/build.ts` does.

## 2. Phases

Each phase on each engine; every check prints `RESULT {...}`; the exit code is the number of
failures.

```sh
ssh root@$IP 'cd /opt/flagship && for e in docker podman; do
  for p in wasi groups dbhostile; do npx tsx tools/arch-drills/m7/drill.ts $p $e; done
done 2>&1 | tee /root/m7.log; grep -c "\"ok\":false" /root/m7.log'
```

Stop Docker before the Podman runs if both fight over the bridges (`systemctl stop docker`), as m5
did after its migration phase.

| Phase | Acceptance test (IMPLEMENTATION-PLAN.md §13.1) | Checks |
|---|---|---|
| `wasi` | P04: WASI fixture serving HTTP; infinite loop; memory limit; host-call refusal; cache isolation; backup + restore | the pinned worker installs; the SDK fixture answers on its loopback port; identity headers reach it; data in the files folder; owner env never on disk; `/spin` stopped by fuel or the wall clock (503), `/grow` by the memory limit, the app keeps serving; the worker runs as its own uid with no capabilities; unit fences (dynamic user, no new privileges, IPAddressDeny, memory/task limits); the worker sees none of `/var/flagship`, other apps' folders or the engine socket; a process under the same address filter can't reach out; `kill -9` → restarted and serving; the same module for two apps → two workers, two users; no compiled module on disk; an undeclared host call refused before serving; `http_fetch` to an approved host works, to an unapproved declared host is refused and raises the request, to an undeclared host never reaches the broker; a backup freezes the worker (cgroup freezer) while the files folder is archived; restoring into a fresh folder brings the notes and the counter back; uninstall removes the unit and its folder |
| `groups` | P05: group rollback; consistent backup | gVisor and the egress gateway up; members start api → worker → main; the main process reaches its component through the gateway link; another app's container is cut; a backup pauses every member at once; an update with an unstartable member rolls every member back and the link still works; stopping removes every member |
| `dbhostile` | P05: hostile DB can't exhaust a sibling or the management reserve | two dedicated instances, each with its own limits (256 MiB, 0.5 CPU, 128 pids); filling one ends in no-space inside its image; the host's free space doesn't move (image allocated up front); the sibling still writes; the management reserve file is untouched; a 30-million-row sort fails inside the hostile instance's limits and it recovers; the sibling answers meanwhile; connection exhaustion stays in the hostile instance; a CPU-spinning query doesn't slow the sibling; dumps and restores run in the instance; a migration reaches it through its socket with no network; the socket needs a password; dropping removes containers and images |

## 3. Then the live gym

On a real account and box (release gym run, `scripts/gym-release-run.sh`), two groups:

- `wasi-apps` (A1): upload + signed install by digest, served through the relay, identity headers,
  data, loop/memory limits, `/api/app-runtime`, an update keeps the data, an undeclared host call
  refused, a second app with the same module, uninstall.
- `app-groups-db` (A1): a three-process app starts in order, an update with an unstartable member
  rolls back and keeps serving, uninstall; two apps with dedicated databases (driven through the
  WASI SDK's `db_query`): one fills its database until it fails, the other keeps writing.

Both need a box whose release carries the pinned WASI worker; `app-groups-db` also needs the egress
gateway enforcing and, for its database half, the dedicated profile (new Podman boxes) and WASI.

## 4. What already passed off-box (this commit's tests)

- `cargo test -p flagship-wasi` (rust/): worker, CGI, HTTP front, host calls, compiled-module
  binding, the worker binary end to end with a socket broker, committed fixture hashes.
- `npx vitest run packages/server-daemon/tests/{wasi,appGroups,dedicatedDb}.test.ts
  packages/server-daemon/tests/serverArchive/wasiArchive.test.ts`: the unit's fences, the worker
  config accepted by the real binary, lifecycle over fake systemd, broker refusals, module store and
  upload, deploy pipeline, install/update/uninstall through ServicePlatform; group order, failure,
  rollback of every member, quiesce, restore after restart; dedicated instance limits, provisioning,
  partial-failure cleanup, the migration socket plan, archive module parts.
