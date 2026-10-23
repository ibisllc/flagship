//! What the v1 broker will and will not run: packages/privd/src/policy.ts, rule for rule and
//! message for message. Every function maps request arguments to an exact argv for a fixed
//! binary or refuses.

use crate::js;
use crate::wire::{ErrorCode, PrivdError};
use flagship_runtime::exec::Exec;
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;
use std::time::Duration;

type Args = Map<String, Value>;

fn forbidden(m: impl Into<String>) -> PrivdError {
    PrivdError::new(ErrorCode::Forbidden, m)
}
fn bad(m: impl Into<String>) -> PrivdError {
    PrivdError::new(ErrorCode::BadRequest, m)
}

fn no_extra(args: &Args, allowed: &[&str]) -> Result<(), PrivdError> {
    match args.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(bad(format!("unknown field {k}"))),
        None => Ok(()),
    }
}

fn exec(file: &'static str, args: Vec<String>, ms: u64, input: Option<String>) -> Exec {
    Exec {
        file,
        args,
        timeout: Duration::from_millis(ms),
        input,
    }
}

const UNITS: &[&str] = &[
    "flagship-daemon.service",
    "docker.service",
    "flagship-data-services.service",
];

pub fn power_exec(args: &Args) -> Result<Exec, PrivdError> {
    no_extra(args, &["action"])?;
    match args.get("action").and_then(Value::as_str) {
        Some(a @ ("poweroff" | "reboot")) => {
            Ok(exec("/usr/bin/systemctl", vec![a.to_owned()], 15_000, None))
        }
        _ => Err(bad("action must be poweroff or reboot")),
    }
}

pub fn restart_exec(args: &Args) -> Result<Exec, PrivdError> {
    no_extra(args, &["unit"])?;
    match args.get("unit").and_then(Value::as_str) {
        Some(u) if UNITS.contains(&u) => Ok(exec(
            "/usr/bin/systemctl",
            vec!["restart".to_owned(), u.to_owned()],
            60_000,
            None,
        )),
        _ => Err(forbidden("that unit cannot be restarted from here")),
    }
}

// ── docker ────────────────────────────────────────────────────────────────

const SIMPLE_SUBCOMMANDS: &[&str] = &[
    "run", "create", "start", "stop", "kill", "rm", "restart", "ps", "inspect", "logs", "pull",
    "build", "info", "version",
];
const SUB_SUBCOMMANDS: &[(&str, &[&str])] = &[
    ("image", &["inspect", "ls", "rm", "prune"]),
    (
        "network",
        &["create", "inspect", "ls", "rm", "connect", "disconnect"],
    ),
    ("volume", &["create", "inspect", "ls", "rm"]),
];
const COMPOSE_FILE: &str = "/opt/flagship/installer/data-services/docker-compose.yml";
const COMPOSE_ENV: &str = "/var/flagship/data-services.env";
const COMPOSE_SUB: &[&str] = &[
    "up", "down", "ps", "pull", "logs", "start", "stop", "restart",
];
const FORBIDDEN_FLAGS: &[&str] = &[
    "--privileged",
    "--cap-add",
    "--device",
    "--device-cgroup-rule",
    "--pid",
    "--ipc",
    "--uts",
    "--userns",
    "--cgroupns",
    "--volumes-from",
    "--security-opt",
    "--sysctl",
    "--group-add",
    "--init-path",
    "--mount-propagation",
];

#[allow(clippy::expect_used)]
fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed pattern compiles")
}

static FILES_MOUNT_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^type=volume,src=flagship-(?:dev)?files-[A-Za-z0-9_.-]{1,128},dst=/data(,readonly)?$")
});
static RESOLV_MOUNT_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^type=bind,src=/run/flagship-resolv-[a-z0-9-]+\.conf,dst=/etc/resolv\.conf,readonly$")
});
static COMPOSE_ARG_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(-d|--no-color|--remove-orphans|--wait|[a-z][a-z0-9_-]{0,63})$"));
static NNP_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^no-new-privileges(:true)?$"));
static ROOT_USER_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^(0|root)(:|$)"));

/// `BUILD_CONTEXT_RE`: `/var/flagship/data/app-clones/` then `/`-joined segments of
/// `[A-Za-z0-9_.-]+`, none of which is `.` or `..`.
fn is_build_context(x: &str) -> bool {
    let Some(rest) = x.strip_prefix("/var/flagship/data/app-clones/") else {
        return false;
    };
    rest.split('/').all(|seg| {
        !seg.is_empty()
            && seg != "."
            && seg != ".."
            && seg
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
    })
}

pub fn docker_exec(args: &Args) -> Result<Exec, PrivdError> {
    no_extra(args, &["argv", "stdin"])?;
    let shape = || bad("argv must be a short list of strings");
    let list = args
        .get("argv")
        .and_then(Value::as_array)
        .ok_or_else(shape)?;
    if list.is_empty() || list.len() > 256 {
        return Err(shape());
    }
    let mut a: Vec<String> = Vec::with_capacity(list.len());
    for item in list {
        let s = item.as_str().ok_or_else(shape)?;
        if js::utf16_len(s) > 4096 || s.contains('\0') {
            return Err(shape());
        }
        a.push(s.to_owned());
    }
    let sub = a.first().map(String::as_str).unwrap_or_default();
    if sub == "compose" {
        return compose_exec(a);
    }
    if let Some((_, allowed)) = SUB_SUBCOMMANDS.iter().find(|(k, _)| *k == sub) {
        let second = a.get(1).map(String::as_str).unwrap_or_default();
        if !allowed.contains(&second) {
            return Err(forbidden(format!("docker {sub} {second} is not allowed")));
        }
    } else if !SIMPLE_SUBCOMMANDS.contains(&sub) {
        return Err(forbidden(format!("docker {sub} is not allowed")));
    }
    validate_docker_args(&a)?;
    let ms = if sub == "build" {
        20 * 60_000
    } else {
        5 * 60_000
    };
    let input = args.get("stdin").and_then(Value::as_str).map(str::to_owned);
    Ok(exec("/usr/bin/docker", a, ms, input))
}

fn compose_exec(a: Vec<String>) -> Result<Exec, PrivdError> {
    let at = |i: usize| a.get(i).map(String::as_str);
    if at(1) != Some("-f") || at(2) != Some(COMPOSE_FILE) {
        return Err(forbidden("compose may only manage the box's data services"));
    }
    let mut i = 3usize;
    if at(i) == Some("--env-file") {
        if at(i.saturating_add(1)) != Some(COMPOSE_ENV) {
            return Err(forbidden("compose env file is fixed"));
        }
        i = i.saturating_add(2);
    }
    let verb = at(i).unwrap_or_default();
    if !COMPOSE_SUB.contains(&verb) {
        return Err(forbidden(format!("compose {verb} is not allowed")));
    }
    for x in a.iter().skip(i.saturating_add(1)) {
        if !COMPOSE_ARG_RE.is_match(x) {
            return Err(forbidden(format!("compose argument {x} is not allowed")));
        }
    }
    Ok(exec("/usr/bin/docker", a, 10 * 60_000, None))
}

/// `validateDockerArgs`: every rule that keeps a container from being the host.
pub fn validate_docker_args(a: &[String]) -> Result<(), PrivdError> {
    let first = a.first().map(String::as_str);
    let get = |i: usize| a.get(i).map(String::as_str);
    let mut i = 0usize;
    while let Some(x) = get(i) {
        let lower = x.to_lowercase();
        let name = lower.split('=').next().unwrap_or_default();
        let has_eq = x.contains('=');
        let last = i.saturating_add(1) == a.len();
        if lower.contains("docker.sock") {
            return Err(forbidden("the docker socket is never mounted"));
        }
        if lower.contains("/var/flagship")
            && !(first == Some("build") && last && is_build_context(x))
        {
            return Err(forbidden(
                "the box's state directory is never visible to a container",
            ));
        }
        if FORBIDDEN_FLAGS.contains(&name) {
            if name == "--security-opt" {
                let v = if has_eq {
                    js::split_nth(x, '=', 1).unwrap_or_default()
                } else {
                    get(i.saturating_add(1)).unwrap_or_default()
                };
                if NNP_RE.is_match(v) {
                    if !has_eq {
                        i = i.saturating_add(1);
                    }
                    i = i.saturating_add(1);
                    continue;
                }
            }
            return Err(forbidden(format!("{name} is not allowed")));
        }
        if name == "--network" || name == "--net" {
            let v = if has_eq {
                js::split_nth(x, '=', 1)
            } else {
                get(i.saturating_add(1))
            };
            if v == Some("host") {
                return Err(forbidden("host networking is not allowed"));
            }
        }
        if name == "-v" || name == "--volume" {
            return Err(forbidden("host-path mounts are not allowed"));
        }
        if name == "--mount" {
            let v = if has_eq {
                js::after_first(x, '=')
            } else {
                i = i.saturating_add(1);
                get(i).unwrap_or_default()
            };
            if first != Some("run") || !(FILES_MOUNT_RE.is_match(v) || RESOLV_MOUNT_RE.is_match(v))
            {
                return Err(forbidden("only an app's files volume may be mounted"));
            }
            i = i.saturating_add(1);
            continue;
        }
        if name == "--user" || name == "-u" {
            let v = if has_eq {
                js::split_nth(x, '=', 1).unwrap_or_default()
            } else {
                i = i.saturating_add(1);
                get(i).unwrap_or_default()
            };
            if ROOT_USER_RE.is_match(v) {
                return Err(forbidden("a container may not run as root"));
            }
        }
        if name == "--runtime" {
            let v = if has_eq {
                js::split_nth(x, '=', 1).unwrap_or_default()
            } else {
                i = i.saturating_add(1);
                get(i).unwrap_or_default()
            };
            if v != "runsc" && v != "runc" {
                return Err(forbidden("unknown container runtime"));
            }
        }
        if first == Some("build") && (name == "-f" || name == "--file") {
            return Err(forbidden(
                "a build uses the Dockerfile the box wrote, not a path",
            ));
        }
        i = i.saturating_add(1);
    }
    Ok(())
}

// ── nft ───────────────────────────────────────────────────────────────────

const TABLE: &str = "flagship_egress";
static NFT_LINE: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
        re(&format!("^(?:add|flush|delete) table inet {TABLE}$")),
        re(&format!(
            r"^add chain inet {TABLE} [a-z_][a-z0-9_]{{0,31}}(?: \{{ type (?:filter|nat) hook (?:forward|input|output|prerouting|postrouting) priority -?[0-9]{{1,4}}; policy (?:accept|drop); \}})?$"
        )),
        re(&format!(
            r#"^add (?:rule|set|element) inet {TABLE} [a-z_][a-z0-9_ ,.:/{{}}'"=+<>!-]{{0,400}}$"#
        )),
    ]
});
static NFT_PRIORITY: LazyLock<Regex> =
    LazyLock::new(|| re(r" priority -?[0-9]{1,4}; policy (?:accept|drop); "));
static NFT_BAD_CHAR: LazyLock<Regex> = LazyLock::new(|| re(r"[;`$\\]"));
static NFT_BAD_WORD: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?-u:\b)(include|jump to|exec|import|define|flush ruleset)(?-u:\b)"));

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The `delete table (?!inet flagship_egress)\b` alternative, which needs a lookahead.
fn deletes_another_table(line: &str) -> bool {
    let bytes = line.as_bytes();
    let needle = "delete table ";
    line.match_indices(needle).any(|(p, _)| {
        let before_ok = p == 0 || bytes.get(p.saturating_sub(1)).is_some_and(|b| !is_word(*b));
        let rest = line
            .get(p.saturating_add(needle.len())..)
            .unwrap_or_default();
        before_ok
            && rest.as_bytes().first().is_some_and(|b| is_word(*b))
            && !rest.starts_with("inet flagship_egress")
    })
}

pub fn nft_exec(args: &Args) -> Result<Exec, PrivdError> {
    no_extra(args, &["script"])?;
    let script = match args.get("script").and_then(Value::as_str) {
        Some(s) if !s.is_empty() && js::utf16_len(s) <= 256 * 1024 => s,
        _ => return Err(bad("script must be text")),
    };
    for raw in script.split('\n') {
        let line = js::trim(raw);
        if line.is_empty() {
            continue;
        }
        if !NFT_LINE.iter().any(|r| r.is_match(line)) {
            return Err(forbidden(format!(
                "nft line not allowed: {}",
                js::slice_units(line, 80)
            )));
        }
        if NFT_BAD_CHAR.is_match(&NFT_PRIORITY.replace(line, " ")) {
            return Err(forbidden("nft line has a character that is not allowed"));
        }
        if NFT_BAD_WORD.is_match(line) || deletes_another_table(line) {
            return Err(forbidden("nft line has a word that is not allowed"));
        }
    }
    Ok(exec(
        "/usr/sbin/nft",
        vec!["-f".to_owned(), "-".to_owned()],
        30_000,
        Some(script.to_owned()),
    ))
}
