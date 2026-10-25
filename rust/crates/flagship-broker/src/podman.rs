//! The engine a `docker` op runs on: packages/privd/src/podman.ts, rule for rule. The daemon
//! writes the docker form; on a Podman box the request is translated exactly as the daemon
//! translates it as root (`engineArgv`), then held to the docker rules again and to Podman's own,
//! since Podman runs as root under the broker with nothing between it and the host.

use crate::wire::{ErrorCode, PrivdError};
use regex::Regex;
use std::path::Path;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineKind {
    Docker,
    Podman,
}

impl EngineKind {
    pub fn binary(self) -> &'static str {
        match self {
            Self::Docker => "/usr/bin/docker",
            Self::Podman => "/usr/bin/podman",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Podman => "podman",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "docker" => Some(Self::Docker),
            "podman" => Some(Self::Podman),
            _ => None,
        }
    }
}

/// Written by the box's installer and the Docker-to-Podman move (engine/migrate.ts).
pub const ENGINE_ACTIVE_FILE: &str = "/var/lib/flagship/engine-active";

/// `readActiveEngine`: the box's own record, else `fallback` (the unit's environment).
pub fn read_active_engine(path: &Path, fallback: EngineKind) -> EngineKind {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let letters: String = text.chars().filter(char::is_ascii_lowercase).collect();
            if letters == "podman" {
                EngineKind::Podman
            } else {
                EngineKind::Docker
            }
        }
        Err(_) => fallback,
    }
}

fn forbidden(m: impl Into<String>) -> PrivdError {
    PrivdError::new(ErrorCode::Forbidden, m)
}

fn no_translation(what: &str) -> PrivdError {
    forbidden(format!("podman: {what} has no translation"))
}

const SAME_SUBCOMMANDS: &[&str] = &[
    "run", "create", "start", "stop", "kill", "rm", "restart", "ps", "inspect", "logs", "pull",
    "build", "exec", "pause", "unpause", "save", "load", "rmi", "tag", "images", "wait", "image",
    "volume", "compose",
];
const BRIDGE_NAME_OPTION: &str = "com.docker.network.bridge.name";
const ICC_OPTION_FALSE: &str = "com.docker.network.bridge.enable_icc=false";
const ICC_OPTION_TRUE: &str = "com.docker.network.bridge.enable_icc=true";

fn format_map(sub: &str, want: &str) -> Option<&'static str> {
    match (sub, want) {
        ("info", "{{.ServerVersion}}") => Some("{{.Version.Version}}"),
        ("info", "{{.CgroupDriver}}") => Some("{{.Host.CgroupManager}}"),
        ("version", "{{.Server.Version}}") => Some("{{.Client.Version}}"),
        _ => None,
    }
}

fn translate_format(sub: &str, args: &[String]) -> Result<Vec<String>, PrivdError> {
    let mut out = args.to_vec();
    let mut i = 1usize;
    while i < out.len() {
        let is_format = matches!(out.get(i).map(String::as_str), Some("--format" | "-f"));
        let next = i.saturating_add(1);
        if is_format && next < out.len() {
            let want = out.get(next).cloned().unwrap_or_default();
            match format_map(sub, &want) {
                Some(to) => {
                    if let Some(slot) = out.get_mut(next) {
                        *slot = to.to_owned();
                    }
                }
                None => return Err(no_translation(&format!("docker {sub} --format {want}"))),
            }
        }
        i = i.saturating_add(1);
    }
    Ok(out)
}

fn translate_network(args: &[String]) -> Result<Vec<String>, PrivdError> {
    let verb = args.get(1).map(String::as_str);
    if matches!(
        verb,
        Some("inspect" | "ls" | "rm" | "connect" | "disconnect" | "prune")
    ) {
        return Ok(args.to_vec());
    }
    if verb != Some("create") {
        return Err(no_translation(&format!(
            "docker network {}",
            verb.unwrap_or_default()
        )));
    }
    let mut out: Vec<String> = ["network", "create", "--disable-dns"]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    let mut i = 2usize;
    while let Some(a) = args.get(i) {
        if a == "--internal" {
            out.push("--label".into());
            out.push("flagship.internal=true".into());
            i = i.saturating_add(1);
            continue;
        }
        if (a == "-o" || a == "--opt") && i.saturating_add(1) < args.len() {
            i = i.saturating_add(1);
            let opt = args.get(i).map(String::as_str).unwrap_or_default();
            if let Some(name) = opt
                .strip_prefix(BRIDGE_NAME_OPTION)
                .and_then(|r| r.strip_prefix('='))
            {
                out.extend(
                    ["--interface-name", name, "--opt", "mode=unmanaged"]
                        .iter()
                        .map(|s| (*s).to_owned()),
                );
            } else if opt == ICC_OPTION_FALSE {
                out.push("--label".into());
                out.push("flagship.icc=false".into());
            } else if opt != ICC_OPTION_TRUE {
                return Err(no_translation(&format!("network option {opt}")));
            }
            i = i.saturating_add(1);
            continue;
        }
        out.push(a.clone());
        i = i.saturating_add(1);
    }
    Ok(out)
}

/// `podmanArgv`: the Podman argv for a docker-form request.
pub fn podman_argv(args: &[String]) -> Result<Vec<String>, PrivdError> {
    let sub = args.first().map(String::as_str).unwrap_or_default();
    if sub == "info" || sub == "version" {
        return translate_format(sub, args);
    }
    if sub == "network" {
        return translate_network(args);
    }
    if SAME_SUBCOMMANDS.contains(&sub) {
        return Ok(args.to_vec());
    }
    Err(no_translation(&format!("docker {sub}")))
}

const PODMAN_FORBIDDEN: &[&str] = &[
    "--rootfs",
    "--conmon-pidfile",
    "--pidfile",
    "--log-opt",
    "--log-driver",
    "--hooks-dir",
    "--annotation",
    "--cgroup-conf",
    "--cgroups",
    "--uidmap",
    "--gidmap",
    "--subuidname",
    "--subgidname",
    "--pod",
    "--pod-id-file",
    "--preserve-fds",
    "--preserve-fd",
    "--personality",
    "--seccomp-policy",
    "--chrootdirs",
    "--env-host",
    "--decryption-key",
    "--authfile",
    "--cert-dir",
    "--creds",
    "--signature-policy",
    "--tls-verify",
    "--image-volume",
    "--sdnotify",
    "--init-ctr",
    "--hostuser",
    "--passwd-entry",
    "--group-entry",
    "--requires",
    "--rdt-class",
    "--blkio-weight-device",
    "--device-read-bps",
    "--device-write-bps",
    "--device-read-iops",
    "--device-write-iops",
    "--volumepath",
    "--root",
    "--runroot",
    "--storage-driver",
    "--storage-opt",
    "--conmon",
    "--runtime-flag",
    "--network-cmd-path",
    "--network-config-dir",
    "--network-backend",
    "--module",
    "--config",
    "--connection",
    "--url",
    "--identity",
    "--remote",
    "--ssh",
    "--syslog",
    "--tmpdir",
    "--transient-store",
    "--imagestore",
    "--db-backend",
    "--cdi-spec-dir",
    "--registries-conf",
    "--out",
    "--noout",
    "--events-backend",
    "--cgroup-manager",
];

#[allow(clippy::expect_used)]
static PODMAN_TRANSPORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?i-u:docker-archive|oci-archive|oci|dir|docker-daemon|containers-storage|sif|ostree|tarball):",
    )
    .expect("a fixed pattern compiles")
});

fn is_box_bridge(v: &str) -> bool {
    v.strip_prefix("fs-").is_some_and(|r| {
        (1..=12).contains(&r.len())
            && r.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}

/// `validatePodmanArgs`: what only Podman would do with an argv the docker rules passed.
pub fn validate_podman_args(a: &[String]) -> Result<(), PrivdError> {
    let exec = a.first().map(String::as_str) == Some("exec");
    for (i, x) in a.iter().enumerate() {
        let name = x
            .to_lowercase()
            .split('=')
            .next()
            .unwrap_or_default()
            .replace('_', "-");
        if PODMAN_FORBIDDEN.contains(&name.as_str()) {
            return Err(forbidden(format!("{name} is not allowed")));
        }
        if !exec && PODMAN_TRANSPORT.is_match(x) {
            return Err(forbidden(
                "an image comes from a registry or the box's own store, never a host path",
            ));
        }
        let value = || {
            if x.contains('=') {
                crate::js::after_first(x, '=').to_owned()
            } else {
                a.get(i.saturating_add(1)).cloned().unwrap_or_default()
            }
        };
        if name == "--network" || name == "--net" {
            let v = value();
            if v.contains(':') || v.contains('/') {
                return Err(forbidden("a container joins a named network only"));
            }
        }
        if name == "--interface-name" && !is_box_bridge(&value()) {
            return Err(forbidden("a network uses only the box's own bridges"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn translates_like_engine_argv() {
        assert_eq!(
            podman_argv(&v(&["version", "--format", "{{.Server.Version}}"])),
            Ok(v(&["version", "--format", "{{.Client.Version}}"]))
        );
        assert_eq!(
            podman_argv(&v(&[
                "network",
                "create",
                "--driver",
                "bridge",
                "--internal",
                "-o",
                "com.docker.network.bridge.name=fs-build",
                "-o",
                "com.docker.network.bridge.enable_icc=false",
                "flagship-build"
            ])),
            Ok(v(&[
                "network",
                "create",
                "--disable-dns",
                "--driver",
                "bridge",
                "--label",
                "flagship.internal=true",
                "--interface-name",
                "fs-build",
                "--opt",
                "mode=unmanaged",
                "--label",
                "flagship.icc=false",
                "flagship-build"
            ]))
        );
        assert!(podman_argv(&v(&["system", "df"])).is_err());
        assert!(podman_argv(&v(&["info", "--format", "{{json .}}"])).is_err());
    }

    #[test]
    fn refuses_what_only_podman_reads() {
        for bad in [
            &["run", "--rootfs", "/", "img"][..],
            &["ps", "--module", "/var/flagship/x.conf"],
            &["ps", "--out=/etc/cron.d/x"],
            &["run", "--network-cmd-path", "/tmp/x", "img"],
            &["run", "oci-archive:/root/x.tar"],
            &["pull", "DIR:/var/lib/flagship-keyd"],
            &["run", "--network", "ns:/proc/1/ns/net", "img"],
            &["run", "--network=pasta:-P,/etc/x", "img"],
            &["run", "--log_opt", "path=/etc/x", "img"],
        ] {
            assert!(validate_podman_args(&v(bad)).is_err(), "{bad:?}");
        }
        assert!(validate_podman_args(&v(&["exec", "flagship-postgres", "psql", "dir:x"])).is_ok());
        assert!(
            validate_podman_args(&v(&["run", "--network", "flagship-apps", "img@sha256:aa"]))
                .is_ok()
        );
        assert!(
            validate_podman_args(&v(&["network", "create", "--interface-name", "eth0"])).is_err()
        );
    }

    #[test]
    fn reads_the_box_record() {
        let dir = std::env::temp_dir().join(format!("fs-engine-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("engine-active");
        assert_eq!(
            read_active_engine(&f, EngineKind::Podman),
            EngineKind::Podman
        );
        let _ = std::fs::write(&f, "podman\n");
        assert_eq!(
            read_active_engine(&f, EngineKind::Docker),
            EngineKind::Podman
        );
        let _ = std::fs::write(&f, "docker\n");
        assert_eq!(
            read_active_engine(&f, EngineKind::Podman),
            EngineKind::Docker
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
