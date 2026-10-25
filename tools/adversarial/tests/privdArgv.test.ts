/**
 * V01 adversarial suite: the root broker's docker argument policy and its other typed ops
 * (packages/privd, SEC-DAEMON-001 / architecture B01). Threat: the daemon is compromised and asks the
 * broker for whatever argv it likes. B01's acceptance is that it still cannot mount host paths, run as
 * root on the host, reach devices, leave the app sandbox or cross into another app.
 *
 * Every argv here is one the policy must REFUSE; a test that passes means the refusal holds. A test kept
 * as `it.fails` documents a refusal that does NOT hold today (a finding), without changing product code.
 *
 *   AT-PRV-01  long-form flags that give a container the host are refused
 *   AT-PRV-02  host bind mounts in every long form are refused
 *   AT-PRV-03  FINDING: a short flag with its value attached (`-v/:/host`) is not recognised
 *   AT-PRV-04  FINDING: a value-taking short flag inside a group (`-dv /:/host`) is not recognised
 *   AT-PRV-05  FINDING: `-u0` / `-uroot` (attached) runs a container as root
 *   AT-PRV-06  FINDING: `--network container:<data service>` joins another container's namespace (Docker)
 *   AT-PRV-07  FINDING: an ordinary run may pick runc or leave the runtime out (outside gVisor)
 *   AT-PRV-08  docker exec reaches only the two data services, with listed commands and env
 *   AT-PRV-09  subcommands outside the closed set are refused
 *   AT-PRV-10  request shapes: NUL, oversize, extra keys, prototype keys, non-strings
 *   AT-PRV-11  Podman: the translated argv is held to Docker's and Podman's own rules
 *   AT-PRV-12  systemctl: units, verbs and flags outside the managed set are refused
 *   AT-PRV-13  the state directory and the docker socket are never visible to a container
 */
import { describe, expect, it } from "vitest";
import { PrivdError, dockerExec, systemctlExec, validateDockerArgs } from "../../../packages/privd/src/index.js";

const IMAGE = "registry.example/app@sha256:" + "a".repeat(64);

function refused(f: () => unknown): void {
  let threw: unknown = null;
  try {
    f();
  } catch (e) {
    threw = e;
  }
  expect(threw, "expected the broker to refuse").toBeInstanceOf(PrivdError);
}
const docker = (argv: string[], engine: "docker" | "podman" = "docker") => dockerExec({ argv }, engine);
const run = (...flags: string[]) => ["run", "-d", "--runtime", "runsc", ...flags, IMAGE];

describe("privd docker argument policy (compromised daemon)", () => {
  it("AT-PRV-01 long-form host flags are refused (catches: a flag missing from FORBIDDEN_FLAGS)", () => {
    const cases: string[][] = [
      ["--privileged"], ["--privileged=true"], ["--cap-add", "SYS_ADMIN"], ["--cap-add=ALL"], ["--device", "/dev/sda"], ["--device=/dev/kvm"],
      ["--pid", "host"], ["--pid=host"], ["--ipc=host"], ["--uts=host"], ["--userns=host"], ["--cgroupns=host"], ["--volumes-from", "flagship-postgres"],
      ["--security-opt", "seccomp=unconfined"], ["--security-opt=apparmor=unconfined"], ["--security-opt", "label=disable"], ["--sysctl", "kernel.x=1"],
      ["--group-add", "0"], ["--gpus", "all"], ["--cgroup-parent=/"], ["--env-file", "/etc/shadow"], ["--label-file=/root/.ssh/id_ed25519"],
      ["--cidfile", "/etc/cron.d/x"], ["--network", "host"], ["--network=host"], ["--net=host"], ["--user", "0"], ["--user=root"], ["--user", "0:0"],
      ["--runtime", "/tmp/evil"], ["--PRIVILEGED"],
    ];
    for (const c of cases) refused(() => docker(run(...c)));
  });

  it("AT-PRV-02 host bind mounts in long form are refused (catches: a mount spelling that slips through)", () => {
    for (const c of [
      ["-v", "/:/host"], ["--volume", "/:/host"], ["--volume=/etc:/x"], ["-v=/:/host"], ["--mount", "type=bind,src=/,dst=/host"],
      ["--mount=type=bind,source=/etc,target=/x"], ["--mount", "type=volume,src=flagship-files-alice--chess,dst=/data,volume-opt=device=/"],
      ["--mount", "type=bind,src=/run/flagship-resolv-x.conf,dst=/etc/resolv.conf"],
    ]) refused(() => docker(run(...c)));
  });

  // FINDING AT-PRV-03 (high): packages/privd/src/policy.ts validateDockerArgs compares the whole argument
  // (`-v/:/host`) with "-v", so a shorthand with its value attached is not seen. The docker CLI (pflag)
  // parses `-vVALUE` as `-v VALUE`: a compromised daemon gets the host's root filesystem in a container.
  it.fails("AT-PRV-03 an attached short-flag value (-v/:/host) is refused (catches: shorthand parsing gap)", () => {
    refused(() => docker(run("-v/:/host")));
  });

  // FINDING AT-PRV-04 (high): a group of short flags ending in a value-taking one (`-dv /:/host`, `-itv /:/x`)
  // is parsed by docker as -d -v /:/host; the policy sees an unknown "-dv" and then a bare "/:/host".
  it.fails("AT-PRV-04 a short-flag group ending in -v (-dv /:/host) is refused (catches: grouped shorthand gap)", () => {
    refused(() => docker(["run", "-dv", "/:/host", "--runtime", "runsc", IMAGE]));
  });

  // FINDING AT-PRV-05 (high): the root check reads `--user`/`-u` only as separate or `=` forms; `-u0` and
  // `-uroot` reach docker as user 0. With AT-PRV-03 it is root over the host filesystem.
  it.fails("AT-PRV-05 an attached -u0 / -uroot is refused (catches: root user via shorthand)", () => {
    refused(() => docker(run("-u0")));
    refused(() => docker(run("-uroot")));
  });

  // FINDING AT-PRV-06 (medium): under Docker, `--network container:flagship-postgres` (or another app's
  // container) shares that container's network namespace, so an app reaches the database's loopback
  // listeners or another app's private ports. The `:` check exists only in validatePodmanArgs.
  it.fails("AT-PRV-06 joining another container's network namespace is refused under Docker (catches: cross-app via network mode)", () => {
    refused(() => docker(run("--network", "container:flagship-postgres")));
    refused(() => docker(run("--network=container:alice--chess")));
  });

  // FINDING AT-PRV-07 (medium): the runtime check accepts runc and an absent --runtime for an ordinary run,
  // so a compromised daemon can start an app's image outside gVisor (the app sandbox the plan keeps for all
  // app and staging workloads). The files helper is validated separately and need not share this rule.
  it.fails("AT-PRV-07 an ordinary run must name runsc (catches: gVisor bypass)", () => {
    refused(() => docker(["run", "-d", "--runtime", "runc", IMAGE]));
    refused(() => docker(["run", "-d", IMAGE]));
  });

  it("AT-PRV-08 docker exec reaches only the data services with listed commands (catches: exec into an app or a shell)", () => {
    expect(() => docker(["exec", "-i", "flagship-postgres", "pg_dump", "x"])).not.toThrow();
    for (const c of [
      ["exec", "alice--chess", "sh"], ["exec", "flagship-postgres", "sh", "-c", "id"], ["exec", "-u", "0", "flagship-postgres", "psql"],
      ["exec", "--privileged", "flagship-postgres", "psql"], ["exec", "-e", "LD_PRELOAD=/x", "flagship-postgres", "psql"],
      ["exec", "-e", "PGPASSWORD=x\nY=1", "flagship-postgres", "psql"], ["exec", "-w", "/", "flagship-postgres", "psql"], ["exec", "flagship-postgres"],
    ]) refused(() => docker(c));
  });

  it("AT-PRV-09 subcommands outside the closed set are refused (catches: cp/commit/plugin/swarm as escape hatches)", () => {
    for (const c of [["cp", "/etc/shadow", "x:/"], ["commit", "x"], ["plugin", "install", "x"], ["swarm", "init"], ["context", "create", "x"],
      ["system", "prune", "-af"], ["image", "load", "-i", "/etc/x"], ["network", "prune"], ["volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind", "--opt", "device=/", "x"],
      ["compose", "-f", "/tmp/evil.yml", "up"], ["buildx", "build", "."], ["--host", "tcp://1.2.3.4", "ps"], ["-H", "unix:///x", "ps"]]) refused(() => docker(c));
  });

  it("AT-PRV-10 malformed requests are refused before any argv rule (catches: type confusion in the request)", () => {
    refused(() => dockerExec({ argv: ["run", "a\u0000b"] }));
    refused(() => dockerExec({ argv: Array.from({ length: 300 }, () => "ps") }));
    refused(() => dockerExec({ argv: ["ps", "x".repeat(5000)] }));
    refused(() => dockerExec({ argv: [] }));
    refused(() => dockerExec({ argv: "run --privileged x" }));
    refused(() => dockerExec({ argv: ["ps"], uid: 0 }));
    refused(() => dockerExec({ argv: ["ps"], file: "/bin/sh" }));
    refused(() => dockerExec({ argv: [["run"]] }));
    refused(() => dockerExec({ argv: ["ps"], env: { DOCKER_HOST: "tcp://1.2.3.4:2375" } }));
  });

  it("AT-PRV-11 Podman keeps Docker's rules and its own (catches: an engine switch reopening a hole)", () => {
    for (const c of [run("--privileged"), run("-v", "/:/host"), run("--rootfs", "/"), run("--hooks-dir", "/tmp"), run("--network", "container:x"),
      ["run", "-d", "--runtime", "runsc", "docker-archive:/etc/shadow"], run("--annotation", "run.oci.keep_original_groups=1"), run("--uidmap", "0:0:1")]) {
      refused(() => docker(c, "podman"));
    }
  });

  it("AT-PRV-12 systemctl only for the managed units, verbs and flags (catches: masking, editing or reaching other units)", () => {
    for (const c of [["start", "getty@tty1.service"], ["mask", "flagship-keyd.service"], ["edit", "flagship-daemon.service"], ["link", "/tmp/x.service"],
      ["start", "--root=/tmp", "ssh"], ["set-environment", "X=1"], ["kill", "flagship-keyd.service"], ["start", "ssh;id"], ["enable", "docker.service"]]) {
      refused(() => systemctlExec({ argv: c }));
    }
  });

  it("AT-PRV-13 the box's state directory and the engine socket never reach a container (catches: path spelled in any argument)", () => {
    for (const c of [run("--mount", "type=volume,src=x,dst=/var/flagship"), run("-e", "X=/var/flagship/identity"), run("--tmpfs", "/var/run/docker.sock"),
      ["build", "--tag", "x", "/var/flagship"], ["build", "--tag", "x", "/var/flagship/data/app-clones/../identity"]]) {
      refused(() => validateDockerArgs(c));
    }
  });
});
