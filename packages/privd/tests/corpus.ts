/**
 * The request corpus both brokers answer (tests/conformance.test.ts writes the TS verdicts into
 * vectors/v1-policy.json; rust/crates/flagship-broker/tests/privd_conformance.rs checks the Rust
 * broker against the same file, and the live check runs the Rust binary on it). Every case the
 * privd tests use, the hostile ones, and each docker case again under Podman.
 */
import { FILES_HELPER_IMAGE, FOLDER_FINGERPRINT_SCRIPT, type GpuRunClaim } from "../src/policy.js";

export interface CorpusCase {
  name: string;
  op: string;
  args: unknown;
  engine?: "docker" | "podman";
  mounts?: string;
  arch?: string;
  trust?: Record<string, unknown>;
  /** flagship-gpud's attached allocations, by id (run-claims.json); none when absent. */
  gpu?: Record<string, GpuRunClaim>;
}

export const TEST_TRUST = { keys: ["a".repeat(64)], threshold: 1, nodeFloor: "24.0.0", minSequence: 3, pqKeyIds: [] as string[], legacyManifests: [] as string[] };
const PQ_TRUST = { ...TEST_TRUST, pqKeyIds: ["d".repeat(64)], legacyManifests: ["e".repeat(64)] };

const VOL = "flagship-files-alice--chess";
const ROOT = "/var/lib/flagship-files";
const CTX = "/var/flagship/data/app-clones/alice--chess";
const COMPOSE = "/opt/flagship/installer/data-services/docker-compose.yml";
const MOUNTS = `/dev/loop3 ${ROOT}/${VOL} ext4 rw 0 0\n/dev/sda1 / ext4 rw 0 0\n`;

const cases: CorpusCase[] = [];
let n = 0;
const add = (op: string, args: unknown, extra: Partial<CorpusCase> = {}) => cases.push({ name: `${op}-${++n}`, op, args, ...extra });
const docker = (...argv: string[]) => add("docker", { argv });
const host = (file: string, argv: string[], mounts?: string) => add("host", { file, argv }, mounts !== undefined ? { mounts } : {});

// power, restart, wire-level shapes the policy sees
add("power", { action: "poweroff" });
add("power", { action: "reboot" });
add("power", { action: "halt; rm -rf /" });
add("power", { action: "reboot", extra: 1 });
add("power", {});
add("power", JSON.parse('{"__proto__": {"action": "reboot"}}'));
add("systemd.restart", { unit: "docker.service" });
add("systemd.restart", { unit: "flagship-daemon.service" });
add("systemd.restart", { unit: "ssh.service" });
add("systemd.restart", { unit: "docker.service; id" });
add("systemd.restart", { unit: 5 });
add("shell", { cmd: "id" });
add("hello", { version: 1 });

// docker: what a container may and may not be
docker("run", "--rm", "--runtime=runsc", "--network=flagship-apps", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", "10001:10001", "--memory", "512m", `img@sha256:${"a".repeat(64)}`);
for (const bad of [
  ["run", "--privileged", "img"], ["run", "--cap-add=SYS_ADMIN", "img"], ["run", "--cap-add", "ALL", "img"], ["run", "--device=/dev/sda", "img"],
  ["run", "--pid=host", "img"], ["run", "--ipc", "host", "img"], ["run", "--userns=host", "img"], ["run", "--network=host", "img"], ["run", "--net", "host", "img"],
  ["run", "--security-opt", "seccomp=unconfined", "img"], ["run", "--security-opt=apparmor=unconfined", "img"], ["run", "-v", "/:/host", "img"], ["run", "--volume=/etc:/etc", "img"],
  ["run", "--mount", "type=bind,src=/,dst=/h", "img"], ["run", "--mount=type=bind,src=/var/flagship,dst=/x", "img"], ["run", "--user", "root", "img"], ["run", "-u", "0:0", "img"],
  ["run", "-v", "/var/run/docker.sock:/var/run/docker.sock", "img"], ["run", "--volumes-from", "other", "img"], ["run", "--runtime=weird", "img"], ["run", "--sysctl", "kernel.x=1", "img"],
  ["run", "--PRIVILEGED", "img"], ["run", "--Network=HOST", "img"], ["run", "--user=root:root", "img"], ["run", "--runtime", "runc", "img"], ["run", "--security-opt", "no-new-privileges:true", "img"],
  ["run", "--env-file", "/etc/shadow", "img"], ["run", "--env-file=/etc/shadow", "img"], ["run", "--label-file", "/root/.ssh/id_ed25519", "img"],
  ["run", "--cidfile", "/etc/cron.d/x", "img"], ["run", "--gpus", "all", "img"], ["run", "--cgroup-parent", "/", "img"], ["create", "--privileged", "img"],
]) docker(...bad);
docker("run", "--mount", "type=volume,src=flagship-files-alice--chess,dst=/data", "img");
docker("run", "--mount", "type=bind,src=/run/flagship-resolv-apps.conf,dst=/etc/resolv.conf,readonly", "img");
docker("run", "--mount", "type=bind,src=/run/flagship-daemon/flagship-resolv-apps.conf,dst=/etc/resolv.conf,readonly", "img");
docker("run", "--mount", "type=volume,src=somebody-elses,dst=/data", "img");
docker("create", "--mount", "type=volume,src=flagship-files-x,dst=/data", "img");
docker("run", "--mount");
for (const bad of [["exec", "c", "sh"], ["system", "prune"], ["plugin", "install", "x"], ["swarm", "init"], ["cp", "c:/etc/shadow", "/var/flagship/x"], ["save", "-o", "/tmp/x", "i"], ["load", "-i", "/tmp/x"], ["context", "use", "x"], ["login"], ["image", "build", "."], ["network", "prune"], ["image"], ["constructor"], ["__proto__", "x"], ["toString"], ["hasOwnProperty", "x"], ["image", "constructor"]]) docker(...bad);
for (const ok of [["ps", "-a"], ["inspect", "c"], ["stop", "c"], ["rm", "-f", "c"], ["image", "inspect", "i"], ["network", "create", "--internal", "n"], ["volume", "ls"], ["info"], ["system", "df"], ["version", "--format", "{{.Server.Version}}"], ["info", "--format", "{{.ServerVersion}}"], ["info", "--format", "{{json .}}"], ["pull", "oci-archive:/root/x.tar"], ["image", "prune", "-f"], ["tag", "a", "b"], ["rmi", "a"]]) docker(...ok);
// builds
docker("build", "-t", "x", "--network", "flagship-build", CTX);
docker("build", "--network", "flagship-build", "--add-host", "registry.npmjs.org:10.0.0.1", "--memory", "2g", "--cpu-period", "100000", "--cpu-quota", "200000", "--ulimit", "nproc=256:256", "-t", "img", CTX);
for (const bad of [
  ["build", "-t", "x", "/var/flagship"], ["build", "-t", "x", "/var/flagship/data/app-clones/../../secrets"], ["build", "-f", "/etc/passwd", CTX], ["build", "-t", "x", "/var/flagship/data/app-clones/./hidden/.."],
  ["build", "-o", "/etc", CTX], ["build", "--output=type=local,dest=/etc", CTX], ["build", "--secret", "id=x,src=/etc/shadow", CTX], ["build", "--build-context", "h=/", CTX],
  ["build", "--iidfile", "/etc/x", CTX], ["build", "--cache-to", "type=local,dest=/etc", CTX], ["build", "-t", "img", "/var/tmp/.flagship-x"], ["build", "-t", "img", "/"], ["build"], ["build", CTX],
  ["build", "--network=host", CTX], ["build", "-t", CTX], ["build", "-t", "x", `${CTX}/`],
]) docker(...bad);
docker("build", "-t", "x", "/var/flagship/data/app-clones/a/.hidden");
// compose
docker("compose", "-f", COMPOSE, "--env-file", "/var/flagship/data-services.env", "up", "-d", "postgres");
docker("compose", "version", "--short");
docker("compose", "version", "--format", "json", "x");
for (const bad of [["compose", "-f", "/tmp/evil.yml", "up"], ["compose", "-f", COMPOSE, "exec", "postgres", "sh"], ["compose", "-f", COMPOSE, "up", "-d", "--build"], ["compose", "-f", COMPOSE, "--env-file", "/etc/shadow", "up"], ["compose", "version", "--format", "{{.X}}"]]) docker(...bad);
add("docker", { argv: ["compose", "-f", COMPOSE, "ps"], env: { LD_PRELOAD: "/x" } });
// malformed
for (const argv of [[], "run img", ["run", 5], ["run", "a\u0000b"], ["ps", "x".repeat(4097)], ["ps", "😀".repeat(2049)], ["ps", "x".repeat(4096)], Array.from({ length: 257 }, () => "ps"), null]) add("docker", { argv });
add("docker", { argv: ["ps"], shell: "true" });
add("docker", { argv: ["ps"], stdin: "text" });
add("docker", { argv: ["ps"], stdin: 5 });
add("docker", { argv: ["ps"], env: null });
add("docker", { argv: ["ps"], env: ["PGPASSWORD"] });
add("docker", { argv: ["ps"], env: { PGPASSWORD: "p", PGOPTIONS: "-c x" } });
add("docker", { argv: ["ps"], env: { PGPASSWORD: 5 } });
add("docker", { argv: ["ps"], env: { PGPASSWORD: "x".repeat(513) } });
// volumes
docker("volume", "create", "--label", "flagship.files=prod", VOL);
docker("volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${ROOT}/${VOL}/data`, "--label", "flagship.quota=loop", VOL);
docker("volume", "create", "--driver=local", "-o=type=none", "-o", "o=bind", "--opt", `device=${ROOT}/${VOL}/data`, VOL);
for (const bad of [
  ["volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind", "--opt", "device=/etc", VOL], ["volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${ROOT}/flagship-files-bob--x/data`, VOL],
  ["volume", "create", "--opt", "type=ext4", "--opt", "device=/dev/sda1", VOL], ["volume", "create", "--driver", "rexray", VOL], ["volume", "create", "a", "b"], ["volume", "create", "--name", "x"],
  ["volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${ROOT}/${VOL}/data`],
]) docker(...bad);
// networks
docker("network", "create", "--driver", "bridge", "--internal", "-o", "com.docker.network.bridge.name=fs-build", "-o", "com.docker.network.bridge.enable_icc=false", "flagship-build");
docker("network", "create", "--driver", "bridge", "-o", "com.docker.network.bridge.name=fs-apps", "-o", "com.docker.network.bridge.enable_icc=true", "--label", "a=b", "flagship-apps");
for (const bad of [
  ["network", "create", "--driver", "macvlan", "-o", "parent=eth0", "lan"], ["network", "create", "-d=ipvlan", "lan"], ["network", "create", "-o", "com.docker.network.bridge.name=br0", "x"],
  ["network", "create", "--subnet", "10.0.0.0/8", "x"], ["network", "create", "--opt=com.docker.network.bridge.name=fs-x", "x"], ["network", "create", "--internal"], ["network", "create", "a", "b"],
  ["network", "create", "--internal=true", "x"], ["network", "create", "-o", "com.docker.network.bridge.name=fs-waytoolongname1", "x"],
]) docker(...bad);
docker("network", "connect", "flagship-apps", "c");
// exec into the data services
docker("exec", "-e", "PGPASSWORD=x", "flagship-postgres", "pg_dumpall", "-U", "a");
docker("exec", "flagship-forgejo", "sqlite3", "/var/lib/gitea/data/forgejo.db", ".backup '/x'");
docker("exec", "-i", "-e", "PGPASSWORD", "flagship-postgres", "pg_restore", "-l");
for (const bad of [
  ["exec", "flagship-postgres", "sh", "-c", "id"], ["exec", "flagship-myapp", "pg_dump"], ["exec", "-u", "0", "flagship-postgres", "psql"], ["exec", "--privileged", "flagship-postgres", "psql"],
  ["exec", "-e", "LD_PRELOAD=/x", "flagship-postgres", "psql"], ["exec", "-e", `PGPASSWORD=${"😀".repeat(300)}`, "flagship-postgres", "psql"], ["exec", "-e", "PGPASSWORD=a\nb", "flagship-postgres", "psql"],
  ["exec", "-e"], ["exec"], ["exec", "flagship-postgres"], ["exec", "flagship-postgres", "psql", "--output", "/etc/x"],
]) docker(...bad);
docker("exec", "-e", `PGPASSWORD=${"x".repeat(512)}`, "flagship-postgres", "psql");
docker("exec", "-e", "PGPASSWORD=a\rb\u2028c", "flagship-postgres", "psql");
// the files helper
const helper = (...over: string[]) => ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--cap-add", "DAC_READ_SEARCH", "--security-opt", "no-new-privileges", "--read-only", "--user", "0:0", ...over, "--mount", `type=volume,src=${VOL},dst=/data,readonly`, "--entrypoint", "tar", FILES_HELPER_IMAGE, "-cf", "-", "-C", "/data", "."];
docker(...helper());
docker("run", "-i", "--rm", "--network", "none", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--cap-add", "FSETID", "--security-opt", "no-new-privileges", "--read-only", "--user", "0:0", "--mount", `type=volume,src=${VOL},dst=/data`, "--entrypoint", "tar", FILES_HELPER_IMAGE, "-xpf", "-", "-C", "/data");
docker(...helper("--memory", "256m", "--pids-limit", "64"));
docker(...helper("--cap-add", "SYS_ADMIN"));
docker(...helper().map((a) => (a === "none" ? "bridge" : a)));
docker(...helper().map((a) => (a === FILES_HELPER_IMAGE ? "alpine" : a)));
docker(...helper().map((a) => (a === "--read-only" ? "--rm" : a)));
docker(...helper().map((a) => (a.startsWith("type=volume") ? "type=bind,src=/,dst=/data" : a)));
docker(...helper().map((a) => (a === "tar" ? "bash" : a)));
docker(...helper("--pid", "host"));
docker(...helper("--mount", `type=volume,src=${VOL},dst=/data`));
docker(...helper(), "/var/flagship/x");
docker(...helper(), "--privileged");
// Podman-only readings (Docker refuses these itself; under Podman the broker must)
for (const bad of [
  ["run", "--rootfs", "/", "img"], ["ps", "--module", "/var/tmp/.flagship-x/evil.conf"], ["ps", "--out=/etc/cron.d/x"], ["run", "--network-cmd-path", "/tmp/x", "img"], ["run", "--hooks-dir", "/tmp", "img"],
  ["run", "--log-opt", "path=/etc/x", "img"], ["run", "--log_opt", "path=/etc/x", "img"], ["run", "--network", "ns:/proc/1/ns/net", "img"], ["run", "--network=pasta:-P,/etc/x", "img"], ["run", "--conmon-pidfile", "/etc/x", "img"],
  ["run", "--uidmap", "0:0:1", "img"], ["run", "--annotation", "run.oci.keep_original_groups=1", "img"], ["inspect", "--root", "/tmp/s", "c"], ["rm", "--runtime-flag", "debug-log=/etc/x", "c"], ["pull", "DIR:/var/lib/flagship-keyd"],
  ["run", "docker-archive:/var/tmp/.flagship-x/i.tar"], ["tag", "oci:/etc", "x"], ["run", "--tls-verify=false", "img"], ["pull", "--authfile", "/root/a.json", "img"], ["run", "--pod", "x", "img"],
]) docker(...bad);
docker("exec", "flagship-postgres", "psql", "-c", "select 'dir:x'");

// docker.file
const file = (args: Record<string, unknown>) => add("docker.file", args);
file({ argv: ["save", "img:1"], stdoutPath: "/var/flagship/data/app-copies/x/image.tar.partial" });
file({ argv: ["load", "-q"], stdinPath: "/var/tmp/.flagship-copy/image.tar" });
file({ argv: ["exec", "-i", "-e", "PGPASSWORD", "flagship-postgres", "pg_restore", "-l"], stdinPath: "/var/flagship/x.dump", env: { PGPASSWORD: "p" } });
file({ argv: helper(), stdoutPath: "/var/flagship/data/_dumps/x.tar.partial" });
for (const p of ["/etc/shadow", "/var/flagship/identity/box.key", "/var/flagship/identity", "/var/flagship/keyd/x", "/var/flagship/swk.hex", "/var/flagship/acme/cert/a.pem", "/var/flagship/../../etc/shadow", "/var/flagshipx/y", "relative", "/var/flagship/./x", "/var/flagship/a\u2028b.key", "/var/flagship/a\nb.key", `/var/flagship/${"x".repeat(1020)}`]) {
  file({ argv: ["save", "img"], stdoutPath: p });
  file({ argv: ["load", "-q"], stdinPath: p });
}
file({ argv: ["save", "-o", "/etc/x", "img"], stdoutPath: "/var/flagship/a" });
file({ argv: ["load", "-i", "/etc/x"], stdinPath: "/var/flagship/a" });
file({ argv: ["exec", "flagship-postgres", "psql"], env: { LD_PRELOAD: "/x" } });
file({ argv: ["cp", "c:/etc", "-"], stdoutPath: "/var/flagship/a" });
file({ argv: ["save", "img"] });
file({ argv: ["load", "-q"] });
file({ argv: ["save", "img"], stdoutPath: 5 });
file({ argv: ["save", "Img"], stdoutPath: "/var/flagship/a" });
file({ argv: ["run", "--privileged", "img"], stdoutPath: "/var/flagship/a" });
file({ argv: ["save", "img"], stdoutPath: "/var/flagship/a", extra: true });
file({ argv: ["save", "oci-archive:/root/x"], stdoutPath: "/var/flagship/a" });

// systemctl
const sc = (...argv: string[]) => add("systemctl", { argv });
sc("daemon-reload");
sc("start", "--no-block", "containerd.service", "docker.socket", "docker.service");
sc("show", "docker.service", "--property=ActiveState", "--property=SubState");
sc("show", "docker.service", "--property=ActiveState,SubState");
sc("enable", "--now", "ssh");
sc("enable", "flagship-keyd.service", "flagship-tlsd.service");
sc("is-active", "flagship-data-services.service");
for (const bad of [["start", "getty@tty1.service"], ["stop", "flagship-keyd.service; id"], ["enable", "docker.service"], ["mask", "ssh"], ["edit", "flagship-daemon.service"], ["set-property", "flagship-daemon.service", "CPUQuota=1%"], ["start", "--root=/tmp", "ssh"], ["poweroff"], ["start"], ["daemon-reload", "x"], ["restart", "flagship-broker.service"], ["status", "--property=X", "ssh"], ["start", "sshd-keygen@x.service"]]) sc(...bad);
add("systemctl", { argv: Array.from({ length: 17 }, () => "ssh") });

// host
host("mount", ["-o", "loop,nodev,nosuid,discard,noinit_itable", `${ROOT}/${VOL}.img`, `${ROOT}/${VOL}`]);
host("mount", ["-o", "remount,ro", `${ROOT}/${VOL}`]);
host("umount", ["-l", `${ROOT}/${VOL}`]);
host("umount", [`${ROOT}/${VOL}`]);
host("resize2fs", ["/dev/loop3"], MOUNTS);
host("losetup", ["-c", "/dev/loop3"], MOUNTS);
host("resize2fs", ["/dev/sda1"], MOUNTS);
host("resize2fs", ["/dev/loop4"], MOUNTS);
host("resize2fs", ["/dev/loop3"]);
host("mount", ["-o", "loop", `${ROOT}/${VOL}.img`, `${ROOT}/${VOL}`]);
host("mount", ["-o", "loop,nodev,nosuid,discard,noinit_itable", `${ROOT}/${VOL}.img`, "/etc"]);
host("mount", ["-o", "loop,nodev,nosuid,discard,noinit_itable", "/var/flagship/evil.img", `${ROOT}/${VOL}`]);
host("mount", ["-o", "loop,nodev,nosuid,discard,noinit_itable", `${ROOT}/${VOL}.img`, `${ROOT}/flagship-files-other`]);
host("mount", ["--bind", "/", `${ROOT}/${VOL}`]);
host("umount", ["/"]);
host("mkdir", ["0755", ROOT]);
host("mkdir", ["0777", `${ROOT}/${VOL}/data`]);
host("mkdir", ["0755", `${ROOT}/orphaned`]);
host("truncate", ["1073741824", `${ROOT}/${VOL}.img`]);
host("truncate", ["0", `${ROOT}/${VOL}/.flagship-ballast`]);
host("fallocate", ["-l", "4096", `${ROOT}/${VOL}/.flagship-ballast`]);
host("mkfs.ext4", ["-q", "-F", "-b", "4096", "-T", "default", "-m", "0", "-E", "lazy_itable_init=1,lazy_journal_init=1,nodiscard", `${ROOT}/${VOL}.img`]);
host("touch", [`${ROOT}/${VOL}.pending`]);
host("rm", [`${ROOT}/orphaned/${VOL}.1760000000000.img`]);
host("rm", [`${ROOT}/${VOL}.img`]);
host("mv", [`${ROOT}/${VOL}.img`, `${ROOT}/orphaned/${VOL}.1760000000000.img`]);
host("chattr", ["+i", `${ROOT}/${VOL}`]);
host("rmdir", [`${ROOT}/${VOL}`]);
host("rmdir", [`${ROOT}/orphaned`]);
host("cp", ["-a", "--", `/var/lib/docker/volumes/${VOL}/_data/.`, `${ROOT}/${VOL}/data`]);
host("cp", ["-a", "--", `/var/lib/containers/storage/volumes/${VOL}/_data/.`, `${ROOT}/${VOL}/data/`]);
host("du", ["-sk", `/var/lib/containers/storage/volumes/${VOL}/_data`]);
host("du", ["-sk", `${ROOT}/${VOL}`]);
host("chmod", ["0777", `/var/lib/docker/volumes/${VOL}/_data`]);
host("chmod", ["0777", `/var/lib/containers/storage/volumes/${VOL}/_data`]);
host("fingerprint", [`${ROOT}/${VOL}/data`]);
host("fingerprint", [`/var/lib/containers/storage/volumes/${VOL}/_data`]);
host("networkctl", ["reload"]);
for (const [f, a] of [
  ["mkdir", ["0777", "/etc/cron.d"]], ["mkdir", ["4755", `${ROOT}/${VOL}`]], ["truncate", ["0", "/etc/shadow"]], ["fallocate", ["-l", "1", "/var/flagship/x"]],
  ["mkfs.ext4", ["/dev/sda1"]], ["mkfs.ext4", ["-q", "-F", "-b", "4096", "-T", "default", "-m", "0", "-E", "root_owner=0:0", `${ROOT}/${VOL}.img`]], ["touch", ["/etc/nologin"]],
  ["rm", [ROOT]], ["rm", ["-rf", ROOT]], ["rm", ["/etc/shadow"]], ["rmdir", ["/etc"]], ["mv", [`${ROOT}/${VOL}.img`, `${ROOT}/orphaned/flagship-files-bob--x.1.img`]],
  ["mv", ["/etc/shadow", `${ROOT}/orphaned/${VOL}.1.img`]], ["chattr", ["-i", "/etc/passwd"]], ["chmod", ["4755", "/var/lib/docker/volumes/x/_data"]], ["chmod", ["0777", "/etc"]],
  ["cp", ["-a", "--", "/etc/.", `${ROOT}/${VOL}/data`]], ["cp", ["-a", "--", `/var/lib/docker/volumes/${VOL}/_data`, `${ROOT}/${VOL}/data`]], ["du", ["-sk", "/root"]], ["fingerprint", ["/root"]], ["networkctl", ["up", "eth0"]],
  ["sh", ["-c", "id"]], ["constructor", ["x"]], ["toString", ["x"]],
] as Array<[string, string[]]>) host(f, a);
add("host", { file: 5, argv: ["x"] });
add("host", { file: "mount", argv: "x" });
add("host", { file: "sh", argv: [] });
add("host", { argv: ["x"] });
add("host", { file: "mount", argv: ["x"], extra: 1 });
add("host", { file: "fingerprint", argv: [FOLDER_FINGERPRINT_SCRIPT] });
// Podman bridges and the icc table
host("ip", ["link", "add", "fs-apps", "type", "bridge"]);
host("ip", ["addr", "add", "10.89.0.1/24", "dev", "fs-apps"]);
host("ip", ["addr", "add", "172.20.0.1/16", "dev", "fs-build"]);
host("ip", ["addr", "add", "192.168.200.1/24", "dev", "fs-staging"]);
host("ip", ["link", "set", "fs-apps", "up"]);
host("sysctl", ["-q", "-w", "net.ipv6.conf.fs-apps.disable_ipv6=1"]);
for (const [f, a] of [
  ["ip", ["link", "add", "eth0", "type", "bridge"]], ["ip", ["link", "del", "fs-apps"]], ["ip", ["addr", "add", "8.8.8.8/32", "dev", "fs-apps"]], ["ip", ["addr", "add", "10.0.0.1/24", "dev", "eth0"]],
  ["ip", ["addr", "add", "172.32.0.1/24", "dev", "fs-apps"]], ["ip", ["addr", "add", "10.0.0.1/7", "dev", "fs-apps"]], ["ip", ["addr", "add", "10.0.0.256/24", "dev", "fs-apps"]], ["ip", ["route", "add", "default", "via", "10.0.0.1"]],
  ["ip", ["link", "set", "eth0", "down"]], ["ip", ["-o", "addr", "show", "dev", "fs-apps"]], ["sysctl", ["-w", "net.ipv4.ip_forward=0"]], ["sysctl", ["-q", "-w", "net.ipv6.conf.eth0.disable_ipv6=1"]],
  ["sysctl", ["-q", "-w", "net.ipv6.conf.all.disable_ipv6=1"]], ["sysctl", ["-q", "-w", "net.ipv6.conf.fs-apps.disable_ipv6=0"]],
] as Array<[string, string[]]>) host(f, a);
host("icc", ["fs-apps", "fs-build"]);
host("icc", ["fs-apps", "fs-build", "fs-staging", "podman1", "br-0123456789ab"]);
host("icc", ['x"; flush ruleset']);
host("icc", Array.from({ length: 9 }, (_, i) => `fs-${i}`));
// iptables
host("iptables", ["-t", "filter", "-N", "DOCKER-USER"]);
host("iptables", ["-t", "nat", "-I", "PREROUTING", "1", "-j", "FLAGSHIP-EGRESS-NAT"]);
host("iptables", ["-w", "-t", "filter", "-C", "FORWARD", "-j", "FLAGSHIP-EGRESS-FWD"]);
host("ip6tables", ["-t", "filter", "-F", "FLAGSHIP-EGRESS6"]);
host("ip6tables", ["-t", "filter", "-X", "FLAGSHIP-EGRESS6"]);
for (const a of [["-t", "filter", "-F", "INPUT"], ["-P", "INPUT", "ACCEPT"], ["-t", "filter", "-I", "INPUT", "1", "-j", "ACCEPT"], ["-t", "raw", "-F", "FLAGSHIP-EGRESS6"], ["-w"], ["-t", "filter", "-I", "INPUT", "2", "-j", "FLAGSHIP-EGRESS-IN"]]) host("iptables", a);
const rules = ["*filter", ":FLAGSHIP-EGRESS-FWD - [0:0]", "-A FLAGSHIP-EGRESS-FWD -i fs-apps -p tcp -j REJECT --reject-with tcp-reset", "-A FLAGSHIP-EGRESS-FWD -j RETURN", "COMMIT", ""].join("\n");
add("iptables.restore", { family: 4, rules });
add("iptables.restore", { family: 6, rules });
add("iptables.restore", { family: 4, rules: "*nat\n-A FLAGSHIP-EGRESS-NAT -p tcp --dport 80 -j REDIRECT --to-ports 8080\nCOMMIT" });
add("iptables.restore", { family: 4, rules: "-A FLAGSHIP-EGRESS-FWD -j REJECTED" });
add("iptables.restore", { family: 4, rules: "  -A FLAGSHIP-EGRESS-FWD -j ACCEPT  \r" });
for (const bad of [
  "*filter\n-A INPUT -j ACCEPT\nCOMMIT", "*raw\nCOMMIT", "*filter\n-A FLAGSHIP-EGRESS-FWD -j DOCKER\nCOMMIT", "*filter\n-F\nCOMMIT", "*filter\n-A FLAGSHIP-EGRESS-FWD -g INPUT\nCOMMIT",
  "*filter\n:INPUT ACCEPT [0:0]\nCOMMIT", "*filter\n-A FLAGSHIP-EGRESS-FWD -j\u3000DOCKER\nCOMMIT", "*filter\n-A FLAGSHIP-EGRESS-FWD -p tcp\r-j DOCKER\nCOMMIT", "*filter\n-A FLAGSHIP-EGRESS-FWD -p tcp\u2028x\nCOMMIT",
  "-A FLAGSHIP-EGRESS-FWD -m comment --comment `id`", "-A FLAGSHIP-EGRESS-FWD -j\u00a0LOG", "-A FLAGSHIP-EGRESS-FWD -g\tX", `-A FLAGSHIP-EGRESS-FWD ${"x".repeat(200)} ; reboot`,
]) add("iptables.restore", { family: 4, rules: bad });
add("iptables.restore", { family: "4", rules });
add("iptables.restore", { family: 5, rules });
add("iptables.restore", { family: 4, rules: "" });
add("iptables.restore", { family: 4, rules: 7 });
add("iptables.restore", { family: 4, rules, table: "raw" });

// nft
const nftOk = ["add table inet flagship_egress", "flush table inet flagship_egress", "add chain inet flagship_egress forward { type filter hook forward priority 0; policy drop; }", 'add rule inet flagship_egress forward iifname "fs-apps" ip daddr 10.0.0.1 tcp dport 443 accept'].join("\n");
add("nft.apply", { script: nftOk });
add("nft.apply", { script: "add rule inet flagship_egress forward delete table inet flagship_egress" });
add("nft.apply", { script: "\ufeffadd table inet flagship_egress\u3000" });
for (const bad of [
  "flush ruleset", "delete table inet filter", "add table inet other", "add rule inet flagship_egress forward exec /bin/sh", "add rule inet flagship_egress forward accept; flush ruleset",
  'include "/etc/x.nft"', "add rule ip nat prerouting accept", "add rule inet flagship_egress forward `id`", "add rule inet flagship_egress forward delete table filter", "table bridge flagship_icc",
]) add("nft.apply", { script: bad });
add("nft.apply", { script: 5 });
add("nft.apply", { script: "" });

// release, wipe, setup
add("release", { action: "install", commit: "b".repeat(40), sha256: "c".repeat(64) }, { arch: "arm64" });
add("release", { action: "install", commit: "b".repeat(40), sha256: "c".repeat(64) }, { arch: "amd64", trust: PQ_TRUST });
add("release", { action: "install", commit: "b".repeat(40), sha256: "c".repeat(64) }, { arch: "amd64", trust: { ...TEST_TRUST, pqKeyIds: ["d".repeat(64)] } });
add("release", { action: "restore", commit: "d".repeat(40) });
add("release", { action: "install", commit: "main", sha256: "c".repeat(64) });
add("release", { action: "install", commit: "b".repeat(40), sha256: "c".repeat(64), trustKeys: "evil" });
add("release", { action: "restore", commit: `${"d".repeat(40)} --state /etc` });
add("release", { action: "install", commit: "b".repeat(40) });
add("release", { action: "install", commit: "B".repeat(40), sha256: "c".repeat(64) });
add("release", { action: "upgrade", commit: "b".repeat(40) });
add("release", { action: "install", commit: "b".repeat(40), sha256: "c".repeat(64) }, { arch: "riscv64" });
add("wipe", { target: "data" });
add("wipe", { target: "/" });
add("wipe", { target: "data", path: "/" });
for (const step of ["gvisor", "health-reporter", "update-guard", "container-links", "data-unit", "debug-access", "debug-access-close", "system-repair", "server-code", "rust-stack", "../../tmp/x", "constructor", ""]) add("setup", { step });
add("setup", { step: "gvisor", script: "/tmp/x.js" });
add("setup", { step: 1 });

// docker run read as the CLI reads it (AT-PRV-03..07): attached values, shorthand groups, `=` forms
const IMG = `img@sha256:${"a".repeat(64)}`;
const R = (...f: string[]) => ["run", "-d", "--runtime", "runsc", ...f, IMG];
for (const ok of [
  R(), R("-e", "A=b"), R("-eA=b"), R("-it"), R("-it", "--rm"), R("-p", "127.0.0.1:8080:80"), R("-p127.0.0.1:8080:80"), R("--network", "flagship-apps"), R("--net=flagship-apps"),
  R("-u", "10001:10001"), R("-u10001"), R("--user=10001:0"), R("--rm=true"), R("--rm=false"), R("-w/app"), R("-d=true"), R("--tmpfs", "/tmp:rw,size=8m"), R("-l", "a=b"),
  ["run", "--runtime=runsc", "--", IMG, "-v", "/:/x"], ["run", "--runtime=runsc", IMG, "--privileged"], ["create", "--runtime=runsc", "--name", "x", IMG],
  ["run", "-d", "--name", "flagship-alice--chess", "--runtime=runsc", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--network", "flagship-apps", "--dns", "10.89.0.1",
    "--add-host", "host.flagship.internal:10.89.0.1", "--mount", "type=bind,src=/run/flagship-daemon/flagship-resolv-apps.conf,dst=/etc/resolv.conf,readonly", "--memory", "512m",
    "--cpus", "1.0", "--pids-limit", "256", "--read-only", "--tmpfs", "/tmp:rw,size=64m", "-e", "PORT=8080", "-p", "127.0.0.1:41000:8080", "--mount",
    "type=volume,src=flagship-files-alice--chess,dst=/data", IMG, "node", "server.js"],
  ["run", "--rm", "-i", "--name", "flagship-migrate-0a1b2c3d4e5f", "--runtime=runsc", "--network=none", "--mount", `type=volume,src=flagship-pgsock-${"0".repeat(24)},dst=/var/run/postgresql,readonly`,
    "--user", "10001:10001", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory", "256m", "--cpus", "0.5", "--pids-limit", "64",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "-e", "PGPASSWORD", "-e", "PGOPTIONS", "--entrypoint", "psql", IMG, "-h", "/var/run/postgresql", "-p", "5432", "-U", "u", "-d", "d", "-1",
    "--set=ON_ERROR_STOP=1", "--no-psqlrc", "-f", "-"],
]) docker(...ok);
for (const bad of [
  R("-v/:/host"), R("-v=/:/host"), R("-v"), ["run", "-dv", "/:/host", "--runtime", "runsc", IMG], R("-itv", "/:/host"), R("-itv/:/host"), R("-tv=/:/h"), R("--volume=/:/h"),
  R("-u0"), R("-uroot"), R("-u=0"), R("-u", "00"), R("-u", "+0:0"), R("-u", "-0"), R("--user=0"), R("-du0"), R("-itu", "root:root"), R("--user=root"),
  R("-eX=/var/flagship/identity"), R("--env=A=/var/run/docker.sock"), R("--mount=type=bind,src=/,dst=/h"), R("--device=/dev/kvm"), R("--cap-add=SYS_ADMIN"), R("--privileged=true"),
  R("--privileged=false"), R("--privileged"), R("--security-opt=seccomp=unconfined"), R("--security-opt=no-new-privileges=false"), R("--pid=host"), R("--ipc=host"), R("--uts=host"),
  R("--userns=host"), R("--cgroupns=host"), R("--network", "container:flagship-postgres"), R("--network=container:alice--chess"), R("--net=container:x"), R("--net", "host"),
  R("--network=host"), R("--network", "ns:/proc/1/ns/net"), R("--network", "a,alias=b"), R("--use-api-socket"), R("--annotation", "dev.gvisor.internal.x=1"),
  R("--link", "flagship-postgres:db"), R("--log-driver", "syslog"), R("--log-opt", "path=/etc/x"), R("--volume-driver", "x"), R("--storage-opt", "size=1"), R("--group-add=0"),
  R("--gpus=all"), R("--device-read-bps", "/dev/sda:1mb"), R("--blkio-weight-device=/dev/sda:10"), R("--volumes-from=flagship-postgres"), R("--isolation=hyperv"),
  R("--PRIVILEGED"), R("-Z"), R("-dZ"), R("--rm=yes"), R("-d=1"), R("---privileged"), R("--=x"), R("--log_opt", "x"), R("--unknown-flag"), R("--mount", "type=volume,src=x,dst=/data"),
  R("--mount", `type=volume,src=flagship-pgsock-${"0".repeat(24)},dst=/var/run/postgresql`), R("--mount", `type=volume,src=flagship-pgdata-${"0".repeat(24)},dst=/var/lib/postgresql`),
  ["run", "-d", IMG], ["run", "-d", "--runtime", "runc", IMG], ["run", "-d", "--runtime=runsc", "--runtime=runc", IMG], ["run", "--runtime", "runsc"], ["run", "--runtime"],
  ["run", "-d", "--runtime", "kata", IMG], ["create", "-d", IMG], ["run", "--"], ["run", "-"], ["create", "--runtime=runsc", "--mount", "type=volume,src=flagship-files-x,dst=/data", IMG],
]) docker(...bad);
// an app's dedicated database (dataLayer/dedicated.ts dedicatedRunArgs)
const PGKEY = "0123456789abcdef01234567";
const pg = (o: { key?: string; over?: (a: string[]) => string[]; extra?: string[]; cmd?: string[] } = {}) => {
  const k = o.key ?? PGKEY;
  const a = [
    "run", "-d", "--name", `flagship-pgd-${PGKEY}`, "--label", "flagship.role=dedicated-postgres", "--restart", "unless-stopped", "--runtime=runsc", "--cap-drop=ALL",
    ...["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"].flatMap((c) => ["--cap-add", c]), "--security-opt=no-new-privileges", "--network", "flagship-apps",
    "--memory", "256m", "--memory-swap", "256m", "--cpus", "0.50", "--pids-limit", "128", "--shm-size", "64m", "-e", "POSTGRES_USER=flagship_admin",
    "-e", `POSTGRES_PASSWORD=${"Ab9_-".repeat(6)}xy`, "-e", "POSTGRES_DB=postgres", "-e", "POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256",
    "-p", "127.0.0.1:41234:5432", "--mount", `type=volume,src=flagship-pgdata-${k},dst=/var/lib/postgresql`, "--mount", `type=volume,src=flagship-pgsock-${k},dst=/var/run/postgresql`,
    ...(o.extra ?? []), FILES_HELPER_IMAGE, ...(o.cmd ?? ["postgres", "-c", "listen_addresses=*", "-c", "max_connections=20", "-c", "shared_buffers=32MB", "-c", "statement_timeout=30s"]),
  ];
  return o.over ? o.over(a) : a;
};
docker(...pg());
for (const bad of [
  pg({ key: "fedcba9876543210fedcba98" }), pg({ over: (a) => a.filter((x) => x !== "--runtime=runsc") }), pg({ over: (a) => a.map((x) => (x === "--runtime=runsc" ? "--runtime=runc" : x)) }),
  pg({ extra: ["--cap-add", "SYS_ADMIN"] }), pg({ extra: ["-v", "/:/host"] }), pg({ extra: ["--privileged"] }), pg({ extra: ["--network", "host"] }), pg({ extra: ["--user", "0"] }),
  pg({ over: (a) => a.map((x) => (x === FILES_HELPER_IMAGE ? "postgres:18" : x)) }), pg({ cmd: ["postgres", "-c", "archive_command=sh -c id"] }), pg({ cmd: ["sh", "-c", "id"] }),
  pg({ over: (a) => a.map((x) => (x.startsWith("POSTGRES_PASSWORD=") ? "POSTGRES_PASSWORD=a\nb" : x)) }), pg({ over: (a) => a.map((x) => (x === "-p" ? "--publish" : x === "127.0.0.1:41234:5432" ? "0.0.0.0:41234:5432" : x)) }),
  pg({ over: (a) => a.map((x) => (x.startsWith("type=volume,src=flagship-pgdata") ? `type=volume,src=flagship-files-alice--chess,dst=/var/lib/postgresql` : x)) }),
  pg({ over: (a) => a.map((x) => (x.startsWith("type=volume,src=flagship-pgsock") ? `type=bind,src=/,dst=/var/run/postgresql` : x)) }),
  pg({ over: (a) => a.filter((x, i) => !(x.startsWith("type=volume,src=flagship-pgsock") || (x === "--mount" && a[i + 1]?.startsWith("type=volume,src=flagship-pgsock")))) }),
  pg({ over: (a) => a.map((x) => (x === `flagship-pgd-${PGKEY}` ? "flagship-postgres" : x)) }), pg({ extra: ["-e", "LD_PRELOAD=/x"] }), pg({ over: (a) => ["create", ...a.slice(1)] }),
]) docker(...bad);
docker("exec", `flagship-pgd-${PGKEY}`, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "flagship_admin");
docker("exec", `flagship-pgd-${PGKEY}`, "sh", "-c", "id");
docker("exec", "flagship-pgd-xyz", "pg_isready");
docker("volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${ROOT}/flagship-pgdata-${PGKEY}/data`, "--label", "flagship.quota=loop", `flagship-pgdata-${PGKEY}`);
docker("volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${ROOT}/flagship-pgdata-${PGKEY}/data`, `flagship-pgdata-${"f".repeat(24)}`);
host("fallocate", ["-l", "536870912", `${ROOT}/flagship-pgdata-${PGKEY}.img`]);
host("fallocate", ["-l", "536870912", `${ROOT}/${VOL}.img`]);
host("fallocate", ["-l", "536870912", `${ROOT}/flagship-pgdata-xyz.img`]);
host("fallocate", ["-l", "536870912", "/var/lib/docker/volumes/x.img"]);
host("truncate", ["536870912", `${ROOT}/flagship-pgdata-${PGKEY}.img`]);
host("mount", ["-o", "loop,nodev,nosuid,discard,noinit_itable", `${ROOT}/flagship-pgdata-${PGKEY}.img`, `${ROOT}/flagship-pgdata-${PGKEY}`]);
host("mount", ["-o", "loop,nodev,nosuid,discard,noinit_itable", `${ROOT}/flagship-pgdata-${PGKEY}.img`, `${ROOT}/flagship-pgdata-${"f".repeat(24)}`]);
// GPU apps (rust/crates/flagship-gpu attach.rs): exactly the runtime and CDI devices flagship-gpud
// attached for that container, read from its root-owned run-claims; nothing else gets a device.
const GPU: Record<string, GpuRunClaim> = {
  "app-alice--llm-k1": { allocationId: "app-alice--llm-k1", appId: "alice--llm", container: "flagship-alice--llm", runtime: "runsc-nvproxy", devices: ["nvidia.com/gpu=0"] },
  "app-carol--mig-k3": { allocationId: "app-carol--mig-k3", appId: "carol--mig", container: "flagship-carol--mig", runtime: "runsc-nvproxy", devices: ["nvidia.com/gpu=1:0", "nvidia.com/gpu=2"] },
  "app-bob--render-k2": { allocationId: "app-bob--render-k2", appId: "bob--render", container: "flagship-bob--render", runtime: "kata-vfio", devices: ["flagship.vfio/group=12"] },
};
const gpuRun = (o: { name?: string; runtime?: string; devices?: string[]; label?: string; extra?: string[]; sub?: string } = {}) => [
  o.sub ?? "run", "-d", "--name", o.name ?? "flagship-alice--llm", `--runtime=${o.runtime ?? "runsc-nvproxy"}`, ...(o.devices ?? ["nvidia.com/gpu=0"]).flatMap((d) => ["--device", d]),
  "--label", `flagship.gpu.allocation=${o.label ?? "app-alice--llm-k1"}`, "--cap-drop=ALL", "--security-opt=no-new-privileges", "--network", "flagship-apps", "--read-only",
  "--user", "10001:10001", "--memory", "2048m", "-e", "FLAGSHIP_GPU_MEMORY_BUDGET_MIB=4096", ...(o.extra ?? []), IMG,
];
const gpuDocker = (argv: string[], claims: Record<string, GpuRunClaim> | null = GPU) => add("docker", { argv }, claims ? { gpu: claims } : {});
gpuDocker(gpuRun());
gpuDocker(gpuRun({ name: "flagship-carol--mig", devices: ["nvidia.com/gpu=1:0", "nvidia.com/gpu=2"], label: "app-carol--mig-k3" }));
gpuDocker(gpuRun({ name: "flagship-bob--render", runtime: "kata-vfio", devices: ["flagship.vfio/group=12"], label: "app-bob--render-k2" }));
for (const bad of [
  gpuRun({ devices: ["nvidia.com/gpu=1"] }), // a device the app's allocation doesn't hold
  gpuRun({ devices: ["nvidia.com/gpu=0", "nvidia.com/gpu=2"] }), // one more than it holds
  gpuRun({ devices: [] }), // fewer than it holds
  gpuRun({ devices: ["nvidia.com/gpu=0", "nvidia.com/gpu=0"] }),
  gpuRun({ devices: ["nvidia.com/gpu=all"] }),
  gpuRun({ devices: ["/dev/nvidia0"] }), // a raw device path
  gpuRun({ devices: ["/dev/vfio/12"] }),
  gpuRun({ label: "app-bob--render-k2", runtime: "kata-vfio", devices: ["flagship.vfio/group=12"] }), // another app's claim, on this app's container
  gpuRun({ name: "flagship-bob--render" }), // this claim on another container
  gpuRun({ runtime: "runc" }), gpuRun({ runtime: "runsc" }), gpuRun({ runtime: "kata" }), gpuRun({ runtime: "kata-vfio" }), // runtimes the claim doesn't name
  gpuRun({ extra: ["--runtime=runsc"] }),
  gpuRun({ label: "app-nobody-k9" }),
  gpuRun({ label: "../../etc" }),
  gpuRun({ extra: ["--label", "flagship.gpu.allocation=app-carol--mig-k3"] }),
  gpuRun({ extra: ["--gpus", "all"] }), gpuRun({ extra: ["--privileged"] }), gpuRun({ extra: ["-v", "/dev:/dev"] }), gpuRun({ extra: ["--device-cgroup-rule", "c 195:* rwm"] }),
  gpuRun({ extra: ["--user", "0"] }), gpuRun({ extra: ["--network", "host"] }), gpuRun({ sub: "create" }),
]) gpuDocker(bad);
gpuDocker(gpuRun(), null); // no claims published: no GPU
docker("run", "-d", "--runtime=runsc", "--device", "nvidia.com/gpu=0", IMG); // a device without an allocation
// WASI app workers (docs/wasi-apps.md): their unit instances, the verbs the daemon uses, typed drop-ins
const WASI = "flagship-wasi@0123456789abcdef.service";
sc("start", "--no-block", WASI);
sc("stop", WASI);
sc("reset-failed", WASI);
sc("show", WASI, "--property=ActiveState,Result");
sc("freeze", WASI);
sc("thaw", WASI);
for (const bad of [
  ["enable", WASI], ["restart", WASI], ["mask", WASI], ["is-active", WASI], ["start", "flagship-wasi@0123456789ABCDEF.service"], ["start", "flagship-wasi@.service"],
  ["start", "flagship-wasi@0123456789abcdef0.service"], ["start", "flagship-wasi@0123456789abcde.service"], ["start", "flagship-wasi@../../etc/x.service"],
  ["start", `${WASI}\nExecStart=/bin/sh`], ["start", "flagship-wasi@0123456789abcdef.socket"], ["freeze", "docker.service"], ["thaw", "flagship-daemon.service"],
  ["stop", WASI, "docker.service"], ["start", "getty@0123456789abcdef.service"],
]) sc(...bad);
const wu = (args: Record<string, unknown>) => add("wasi.unit", args);
const wasiOk = { action: "write", instance: "0123456789abcdef", world: "http-proxy", memoryMiB: 384, tasks: 64, cpuPercent: 50, restart: "on-failure" };
wu(wasiOk);
wu({ ...wasiOk, world: "command", restart: "never", filesPath: `${ROOT}/${VOL}/data` });
wu({ ...wasiOk, restart: "always", filesPath: `/var/lib/containers/storage/volumes/${VOL}/_data` });
wu({ action: "remove", instance: "0123456789abcdef" });
for (const bad of [
  { ...wasiOk, world: "http-proxy\nExecStartPre=/bin/sh -c id" }, { ...wasiOk, restart: "on-failure\nUser=root" }, { ...wasiOk, world: "serve" }, { ...wasiOk, memoryMiB: 1e9 },
  { ...wasiOk, memoryMiB: 64.5 }, { ...wasiOk, memoryMiB: "64" }, { ...wasiOk, tasks: 1 }, { ...wasiOk, cpuPercent: 801 }, { ...wasiOk, filesPath: "/etc" },
  { ...wasiOk, filesPath: `${ROOT}/flagship-pgdata-${PGKEY}/data` }, { ...wasiOk, filesPath: `${ROOT}/${VOL}/data/../../../etc` }, { ...wasiOk, filesPath: `${ROOT}/${VOL}/data\nBindPaths=/:/x` },
  { ...wasiOk, filesPath: 5 }, { ...wasiOk, instance: "../../../etc/systemd" }, { ...wasiOk, instance: "0123456789ABCDEF" }, { ...wasiOk, instance: 5 }, { ...wasiOk, text: "[Service]\nUser=root" },
  { ...wasiOk, unit: "flagship-daemon.service" }, { action: "remove", instance: "0123456789abcdef", world: "command" }, { action: "install", instance: "0123456789abcdef" },
  { action: "remove", instance: "0123456789abcdef/../../../etc" }, {},
]) wu(bad);
add("setup", { step: "wasi-runtime" });
add("setup", { step: "gpu-broker" });

/** Every docker and docker.file case again, under Podman. */
export const CORPUS: CorpusCase[] = [
  ...cases,
  ...cases.filter((c) => c.op === "docker" || c.op === "docker.file").map((c) => ({ ...c, name: `${c.name}-podman`, engine: "podman" as const })),
];
