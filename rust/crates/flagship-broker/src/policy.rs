//! What the v1 broker will and will not run: packages/privd/src/policy.ts, rule for rule and
//! message for message. Every function maps request arguments to an exact argv for a fixed
//! binary or refuses. Nothing goes through a shell except the one fixed fingerprint script.

use crate::js;
use crate::podman::{EngineKind, podman_argv, validate_podman_args};
use crate::wire::{ErrorCode, PrivdError};
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::LazyLock;

pub type Args = Map<String, Value>;

/// A daemon file the broker copies into its own folder before the command uses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyIn {
    pub from: String,
    pub to: String,
}

/// `Exec`: one fixed binary, its argv, a time limit, and what goes to and comes from it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PrivExec {
    pub file: &'static str,
    pub args: Vec<String>,
    pub timeout_ms: u64,
    pub input: Option<String>,
    pub stdin_file: Option<String>,
    pub stdout_file: Option<String>,
    pub env: BTreeMap<String, String>,
    pub copy_in: Vec<CopyIn>,
}

/// The broker's own folder: root only.
pub const PRIVD_STATE_DIR: &str = "/var/lib/flagship-privd";
/// Where the unprivileged daemon keeps files the broker may read or write for it.
pub const DAEMON_TRANSFER_ROOTS: &[&str] = &["/var/flagship/", "/var/tmp/.flagship-"];
pub const RELEASE_REPO: &str = "/opt/flagship";
pub const FILES_IMAGE_ROOT: &str = "/var/lib/flagship-files";
/// The image the daemon's files helpers run in (volumeDump.ts FILES_HELPER_IMAGE).
pub const FILES_HELPER_IMAGE: &str = "pgvector/pgvector:0.8.7-pg18-trixie@sha256:9d9c930220cb9bf2f956d10a8f909cf9973d9672ca0278aef2c1e6facccad2e0";
/// The daemon's folder fingerprint (appQuota/loopVolumes.ts FOLDER_FINGERPRINT_SCRIPT), byte for byte.
pub const FOLDER_FINGERPRINT_SCRIPT: &str = r#"find "$1" \( -type f -printf 'f %m %s %P\n' \) -o \( -type d -printf 'd %m %P\n' \) -o \( -printf '%y %P\n' \) | LC_ALL=C sort | sha256sum | cut -d' ' -f1"#;
pub const SETUP_STEPS: &[&str] = &[
    "gvisor",
    "health-reporter",
    "update-guard",
    "container-links",
    "data-unit",
    "debug-access",
    "debug-access-close",
    "system-repair",
    "server-code",
    "rust-stack",
];

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

fn exec(file: &'static str, args: Vec<String>, ms: u64) -> PrivExec {
    PrivExec {
        file,
        args,
        timeout_ms: ms,
        ..PrivExec::default()
    }
}

fn owned(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| (*s).to_owned()).collect()
}

#[allow(clippy::expect_used)]
fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed pattern compiles")
}

/// `stringArgv`: a non-empty list of at most `max` strings, each short and without NUL.
fn string_argv(v: Option<&Value>, max: usize) -> Result<Vec<String>, PrivdError> {
    let shape = || bad("argv must be a short list of strings");
    let list = v.and_then(Value::as_array).ok_or_else(shape)?;
    if list.is_empty() || list.len() > max {
        return Err(shape());
    }
    let mut out = Vec::with_capacity(list.len());
    for item in list {
        let s = item.as_str().ok_or_else(shape)?;
        if js::utf16_len(s) > 4096 || s.contains('\0') {
            return Err(shape());
        }
        out.push(s.to_owned());
    }
    Ok(out)
}

fn at(a: &[String], i: usize) -> &str {
    a.get(i).map(String::as_str).unwrap_or_default()
}

const UNITS: &[&str] = &[
    "flagship-daemon.service",
    "docker.service",
    "flagship-data-services.service",
];

pub fn power_exec(args: &Args) -> Result<PrivExec, PrivdError> {
    no_extra(args, &["action"])?;
    match args.get("action").and_then(Value::as_str) {
        Some(a @ ("poweroff" | "reboot")) => {
            Ok(exec("/usr/bin/systemctl", vec![a.to_owned()], 15_000))
        }
        _ => Err(bad("action must be poweroff or reboot")),
    }
}

pub fn restart_exec(args: &Args) -> Result<PrivExec, PrivdError> {
    no_extra(args, &["unit"])?;
    match args.get("unit").and_then(Value::as_str) {
        Some(u) if UNITS.contains(&u) => {
            Ok(exec("/usr/bin/systemctl", owned(&["restart", u]), 60_000))
        }
        _ => Err(forbidden("that unit cannot be restarted from here")),
    }
}

// ── docker ────────────────────────────────────────────────────────────────

const SIMPLE_SUBCOMMANDS: &[&str] = &[
    "run", "create", "start", "stop", "kill", "rm", "restart", "ps", "inspect", "logs", "pull",
    "build", "info", "version", "pause", "unpause", "rmi", "tag", "exec",
];
const FILE_SUBCOMMANDS: &[&str] = &["save", "load", "exec", "run"];

fn sub_subcommands(sub: &str) -> Option<&'static [&'static str]> {
    match sub {
        "image" => Some(&["inspect", "ls", "rm", "prune", "tag"]),
        "network" => Some(&["create", "inspect", "ls", "rm", "connect", "disconnect"]),
        "volume" => Some(&["create", "inspect", "ls", "rm", "prune"]),
        "system" => Some(&["df"]),
        _ => None,
    }
}

const EXEC_CONTAINERS: &[&str] = &["flagship-postgres", "flagship-forgejo"];
const EXEC_COMMANDS: &[&str] = &[
    "pg_dump",
    "pg_dumpall",
    "pg_restore",
    "psql",
    "pg_isready",
    "sqlite3",
    "tar",
    "rm",
    "forgejo",
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
    "--gpus",
    "--cgroup-parent",
    "--env-file",
    "--label-file",
    "--cidfile",
    "--iidfile",
    "--metadata-file",
    "--output",
    "--secret",
    "--ssh",
    "--build-context",
    "--cache-to",
    "--cache-from",
];
const BUILD_FLAGS: &[&str] = &[
    "--network",
    "--add-host",
    "--memory",
    "--cpu-period",
    "--cpu-quota",
    "--ulimit",
    "-t",
    "--tag",
    "--label",
];
const CLIENT_ENV: &[&str] = &["PGPASSWORD", "PGOPTIONS"];
const HELPER_CAPS: &[&str] = &[
    "DAC_READ_SEARCH",
    "DAC_OVERRIDE",
    "CHOWN",
    "FOWNER",
    "FSETID",
];
const HELPER_ENTRYPOINTS: &[&str] = &["tar", "du", "sh", "find", "head"];
const HELPER_REQUIRED: &[&str] = &[
    "--rm",
    "--read-only",
    "--network",
    "--cap-drop",
    "--security-opt",
    "--entrypoint",
];

const VOL: &str = "flagship-(?:dev)?files-[A-Za-z0-9_.-]{1,128}";

static FILES_MOUNT_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^type=volume,src=flagship-(?:dev)?files-[A-Za-z0-9_.-]{1,128},dst=/data(,readonly)?$")
});
static RESOLV_MOUNT_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^type=bind,src=/run/(?:flagship-daemon/)?flagship-resolv-[a-z0-9-]+\.conf,dst=/etc/resolv\.conf,readonly$",
    )
});
static COMPOSE_ARG_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^(-d|-v|-q|--no-color|--remove-orphans|--wait|--format|json|[a-z][a-z0-9_-]{0,63})$")
});
static COMPOSE_VERSION_ARG_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(--short|--format|json|\{\{\.Version\}\})$"));
static NNP_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^no-new-privileges(:true)?$"));
static ROOT_USER_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^(0|root)(:|$)"));
static BIND_DEVICE: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^device=/var/lib/flagship-files/(flagship-(?:dev)?files-[A-Za-z0-9_.-]{1,128})/data$")
});
static SAVE_IMAGE_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-z0-9][a-z0-9._/:@-]{0,255}$"));
static HELPER_SIZE_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^[0-9]{1,6}[kmg]?$"));
static NETWORK_NAME: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$"));
static NETWORK_OPTS: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^com\.docker\.network\.bridge\.(?:name=fs-[a-z0-9-]{1,12}|enable_icc=(?:true|false))$")
});
static NEVER: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
        re(r"^/var/flagship/identity(/|$)"),
        re(r"^/var/flagship/keyd(/|$)"),
        re(r"(?s)^/var/flagship/.*\.(hex|pem|key)$"),
    ]
});

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

/// `forEngine`: Docker as written, or Podman's translation held to the docker rules again
/// (when `docker_rules`) and to Podman's own.
fn for_engine(
    a: Vec<String>,
    engine: EngineKind,
    docker_rules: bool,
) -> Result<(&'static str, Vec<String>), PrivdError> {
    if engine != EngineKind::Podman {
        return Ok((EngineKind::Docker.binary(), a));
    }
    let mapped = podman_argv(&a)?;
    if docker_rules {
        validate_docker_args(&mapped)?;
    }
    validate_podman_args(&mapped)?;
    Ok((EngineKind::Podman.binary(), mapped))
}

pub fn docker_exec(args: &Args, engine: EngineKind) -> Result<PrivExec, PrivdError> {
    no_extra(args, &["argv", "stdin", "env"])?;
    let a = string_argv(args.get("argv"), 256)?;
    let sub = at(&a, 0).to_owned();
    if sub == "compose" {
        let c = compose_exec(a)?;
        let (file, argv) = for_engine(c.args.clone(), engine, false)?;
        return Ok(PrivExec {
            file,
            args: argv,
            ..c
        });
    }
    if let Some(allowed) = sub_subcommands(&sub) {
        if !allowed.contains(&at(&a, 1)) {
            return Err(forbidden(format!(
                "docker {sub} {} is not allowed",
                at(&a, 1)
            )));
        }
    } else if !SIMPLE_SUBCOMMANDS.contains(&sub.as_str()) {
        return Err(forbidden(format!("docker {sub} is not allowed")));
    }
    if sub == "exec" {
        validate_docker_exec(&a)?;
    }
    if sub == "build" {
        validate_docker_build(&a)?;
    }
    if sub == "volume" && at(&a, 1) == "create" {
        validate_volume_create(&a)?;
    }
    if sub == "network" && at(&a, 1) == "create" {
        validate_network_create(&a)?;
    }
    validate_docker_args(&a)?;
    let input = args.get("stdin").and_then(Value::as_str).map(str::to_owned);
    let env = client_env(args.get("env"))?;
    let (file, argv) = for_engine(a, engine, true)?;
    Ok(PrivExec {
        file,
        args: argv,
        timeout_ms: if sub == "build" {
            20 * 60_000
        } else {
            5 * 60_000
        },
        input,
        env,
        ..PrivExec::default()
    })
}

/// `clientEnv`: only the database settings a `-e NAME` forwards.
fn client_env(v: Option<&Value>) -> Result<BTreeMap<String, String>, PrivdError> {
    let mut env = BTreeMap::new();
    let Some(v) = v else { return Ok(env) };
    let Value::Object(m) = v else {
        return Err(bad("env must be an object"));
    };
    for (k, x) in m {
        match x.as_str() {
            Some(s)
                if CLIENT_ENV.contains(&k.as_str())
                    && js::utf16_len(s) <= 512
                    && !s.contains('\0') =>
            {
                env.insert(k.clone(), s.to_owned());
            }
            _ => return Err(forbidden("env may carry only PGPASSWORD and PGOPTIONS")),
        }
    }
    Ok(env)
}

fn validate_docker_build(a: &[String]) -> Result<(), PrivdError> {
    let mut i = 1usize;
    while i < a.len().saturating_sub(1) {
        let f = at(a, i);
        let name = f.split('=').next().unwrap_or_default();
        if !BUILD_FLAGS.contains(&name) {
            return Err(forbidden(format!("build flag {name} is not allowed")));
        }
        if !f.contains('=') {
            i = i.saturating_add(1);
        }
        i = i.saturating_add(1);
    }
    if a.len() < 2 || !is_build_context(a.last().map(String::as_str).unwrap_or_default()) {
        return Err(forbidden("a build's context is an app clone"));
    }
    Ok(())
}

/// The flag of `--flag` or `--flag=value` (`None` for a positional), and the attached value.
fn split_flag(f: &str) -> (Option<&str>, Option<&str>) {
    if !f.starts_with('-') {
        return (None, None);
    }
    match f.find('=') {
        Some(eq) if eq > 0 => (f.get(..eq), f.get(eq.saturating_add(1)..)),
        _ => (Some(f), None),
    }
}

/// The value of a flag: the attached one, or the next argument (advancing `i`).
fn flag_value(a: &[String], attached: Option<&str>, i: &mut usize) -> String {
    match attached {
        Some(v) => v.to_owned(),
        None => {
            *i = i.saturating_add(1);
            at(a, *i).to_owned()
        }
    }
}

fn validate_volume_create(a: &[String]) -> Result<(), PrivdError> {
    let mut opts: Vec<String> = Vec::new();
    let mut driver: Option<String> = None;
    let mut name: Option<String> = None;
    let mut i = 2usize;
    while i < a.len() {
        let f = at(a, i);
        let (flag, attached) = split_flag(f);
        match flag {
            Some("--label" | "-l") => {
                flag_value(a, attached, &mut i);
            }
            Some("--driver" | "-d") => driver = Some(flag_value(a, attached, &mut i)),
            Some("--opt" | "-o") => opts.push(flag_value(a, attached, &mut i)),
            None if name.is_none() => name = Some(f.to_owned()),
            _ => {
                return Err(forbidden(format!(
                    "volume create argument {f} is not allowed"
                )));
            }
        }
        i = i.saturating_add(1);
    }
    if opts.is_empty() && driver.as_deref().is_none_or(|d| d == "local") {
        return Ok(());
    }
    let device = opts
        .iter()
        .find_map(|o| BIND_DEVICE.captures(o))
        .and_then(|c| c.get(1).map(|m| m.as_str().to_owned()));
    let ok = driver.as_deref() == Some("local")
        && opts.len() == 3
        && opts.iter().any(|o| o == "type=none")
        && opts.iter().any(|o| o == "o=bind")
        && device.is_some()
        && device == name;
    if ok {
        Ok(())
    } else {
        Err(forbidden("a volume binds only its own app's disk image"))
    }
}

fn validate_network_create(a: &[String]) -> Result<(), PrivdError> {
    let mut name: Option<&str> = None;
    let mut i = 2usize;
    while i < a.len() {
        let f = at(a, i);
        let (flag, attached) = split_flag(f);
        if f == "--internal" {
        } else if matches!(flag, Some("--driver" | "-d")) {
            if flag_value(a, attached, &mut i) != "bridge" {
                return Err(forbidden("a network uses the bridge driver"));
            }
        } else if f == "-o" || f == "--opt" {
            i = i.saturating_add(1);
            let v = at(a, i);
            if !NETWORK_OPTS.is_match(v) {
                return Err(forbidden(format!("network option {v} is not allowed")));
            }
        } else if flag == Some("--label") {
            flag_value(a, attached, &mut i);
        } else if flag.is_none() && name.is_none() && NETWORK_NAME.is_match(f) {
            name = Some(f);
        } else {
            return Err(forbidden(format!(
                "network create argument {f} is not allowed"
            )));
        }
        i = i.saturating_add(1);
    }
    if name.is_none() {
        return Err(forbidden("name the network"));
    }
    Ok(())
}

/// `EXEC_ENV`: `PGPASSWORD`, or `PGPASSWORD=` and at most 512 UTF-16 units without NUL or newline.
fn exec_env_ok(s: &str) -> bool {
    match s.strip_prefix("PGPASSWORD") {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('=')
            .is_some_and(|v| !v.contains('\0') && !v.contains('\n') && js::utf16_len(v) <= 512),
        None => false,
    }
}

fn validate_docker_exec(a: &[String]) -> Result<(), PrivdError> {
    let mut i = 1usize;
    while i < a.len() && at(a, i).starts_with('-') {
        let f = at(a, i);
        if f == "-i" {
            i = i.saturating_add(1);
            continue;
        }
        if f == "-e" {
            if !exec_env_ok(at(a, i.saturating_add(1))) {
                return Err(forbidden("exec may pass only PGPASSWORD"));
            }
            i = i.saturating_add(2);
            continue;
        }
        return Err(forbidden(format!("exec flag {f} is not allowed")));
    }
    if !EXEC_CONTAINERS.contains(&at(a, i)) {
        return Err(forbidden("exec reaches only the box's data services"));
    }
    let cmd = at(a, i.saturating_add(1));
    if !EXEC_COMMANDS.contains(&cmd) {
        return Err(forbidden(format!("exec may not run {cmd}")));
    }
    Ok(())
}

pub fn docker_file_exec(args: &Args, engine: EngineKind) -> Result<PrivExec, PrivdError> {
    no_extra(args, &["argv", "stdinPath", "stdoutPath", "env"])?;
    let a = string_argv(args.get("argv"), 256)?;
    let sub = at(&a, 0).to_owned();
    if !FILE_SUBCOMMANDS.contains(&sub.as_str()) {
        return Err(forbidden(format!(
            "docker {sub} does not stream through a file"
        )));
    }
    if sub == "save" && (a.len() != 2 || !SAVE_IMAGE_RE.is_match(at(&a, 1))) {
        return Err(forbidden("save takes one image"));
    }
    if sub == "load" && !(a.len() == 2 && at(&a, 1) == "-q") {
        return Err(forbidden("load takes only -q"));
    }
    if sub == "exec" {
        validate_docker_exec(&a)?;
    }
    validate_docker_args(&a)?;
    let stdin_path = match args.get("stdinPath").and_then(Value::as_str) {
        Some(p) => Some(transfer_path(p)?),
        None => None,
    };
    let stdout_path = match args.get("stdoutPath").and_then(Value::as_str) {
        Some(p) => Some(transfer_path(p)?),
        None => None,
    };
    if sub == "save" && stdout_path.is_none() {
        return Err(bad("save needs stdoutPath"));
    }
    if sub == "load" && stdin_path.is_none() {
        return Err(bad("load needs stdinPath"));
    }
    let env = client_env(args.get("env"))?;
    let (file, argv) = for_engine(a, engine, true)?;
    Ok(PrivExec {
        file,
        args: argv,
        timeout_ms: 60 * 60_000,
        stdin_file: stdin_path,
        stdout_file: stdout_path,
        env,
        ..PrivExec::default()
    })
}

/// `transferPath`: a path under the daemon's transfer roots, normalised, never a key file.
pub fn transfer_path(p: &str) -> Result<String, PrivdError> {
    if !p.starts_with('/')
        || p.contains('\0')
        || js::utf16_len(p) > 1024
        || p.split('/').any(|c| c == ".." || c == ".")
    {
        return Err(forbidden("bad path"));
    }
    if !DAEMON_TRANSFER_ROOTS.iter().any(|r| p.starts_with(r)) {
        return Err(forbidden(
            "the broker streams only the daemon's own transfer files",
        ));
    }
    if NEVER.iter().any(|r| r.is_match(p)) {
        return Err(forbidden("that file is never streamed"));
    }
    Ok(p.to_owned())
}

fn compose_exec(a: Vec<String>) -> Result<PrivExec, PrivdError> {
    if at(&a, 1) == "version" {
        if a.len() > 4
            || a.iter()
                .skip(2)
                .any(|x| !COMPOSE_VERSION_ARG_RE.is_match(x))
        {
            return Err(forbidden("compose version takes only its format flags"));
        }
        return Ok(exec("/usr/bin/docker", a, 30_000));
    }
    if a.get(1).map(String::as_str) != Some("-f")
        || a.get(2).map(String::as_str) != Some(COMPOSE_FILE)
    {
        return Err(forbidden("compose may only manage the box's data services"));
    }
    let mut i = 3usize;
    if a.get(i).map(String::as_str) == Some("--env-file") {
        if a.get(i.saturating_add(1)).map(String::as_str) != Some(COMPOSE_ENV) {
            return Err(forbidden("compose env file is fixed"));
        }
        i = i.saturating_add(2);
    }
    let verb = at(&a, i);
    if !COMPOSE_SUB.contains(&verb) {
        return Err(forbidden(format!("compose {verb} is not allowed")));
    }
    for x in a.iter().skip(i.saturating_add(1)) {
        if !COMPOSE_ARG_RE.is_match(x) {
            return Err(forbidden(format!("compose argument {x} is not allowed")));
        }
    }
    Ok(exec("/usr/bin/docker", a, 10 * 60_000))
}

/// `validateDockerArgs`: every rule that keeps a container from being the host.
pub fn validate_docker_args(a: &[String]) -> Result<(), PrivdError> {
    let helper = is_files_helper_run(a);
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
        if helper {
            i = i.saturating_add(1);
            continue;
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

/// `isFilesHelperRun`: a throwaway container over one app files volume, in its locked shape.
fn is_files_helper_run(a: &[String]) -> bool {
    if a.first().map(String::as_str) != Some("run") {
        return false;
    }
    let Some(image_at) = a.iter().position(|x| x == FILES_HELPER_IMAGE) else {
        return false;
    };
    let mut seen: Vec<&str> = Vec::new();
    let mut mounts = 0usize;
    let mut i = 1usize;
    while i < image_at {
        let f = at(a, i);
        let v = at(a, i.saturating_add(1));
        let ok = match f {
            "--rm" | "-i" | "--read-only" => {
                seen.push(f);
                i = i.saturating_add(1);
                continue;
            }
            "--network" => v == "none",
            "--cap-drop" => v == "ALL",
            "--cap-add" => HELPER_CAPS.contains(&v),
            "--security-opt" => v == "no-new-privileges",
            "--user" => v == "0:0",
            "--memory" | "--pids-limit" => HELPER_SIZE_RE.is_match(v),
            "--mount" => {
                mounts = mounts.saturating_add(1);
                FILES_MOUNT_RE.is_match(v)
            }
            "--entrypoint" => HELPER_ENTRYPOINTS.contains(&v),
            _ => false,
        };
        if !ok {
            return false;
        }
        seen.push(f);
        i = i.saturating_add(2);
    }
    mounts == 1 && HELPER_REQUIRED.iter().all(|r| seen.contains(r))
}

// ── systemctl ─────────────────────────────────────────────────────────────

const MANAGED_UNITS: &[&str] = &[
    "docker.service",
    "docker.socket",
    "containerd.service",
    "docker",
    "ssh",
    "ssh.service",
    "flagship-daemon.service",
    "flagship-data-services",
    "flagship-data-services.service",
    "flagship-keyd.service",
    "flagship-tlsd.service",
    "flagship-health.timer",
];
const UNIT_VERBS: &[&str] = &[
    "start",
    "stop",
    "restart",
    "reload",
    "reset-failed",
    "is-active",
    "show",
    "enable",
    "status",
];
const ENABLE_UNITS: &[&str] = &[
    "ssh",
    "ssh.service",
    "flagship-health.timer",
    "flagship-keyd.service",
    "flagship-tlsd.service",
];
static SHOW_PROPERTY_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"^--property=[A-Za-z]{1,64}(,[A-Za-z]{1,64})*$"));

pub fn systemctl_exec(args: &Args) -> Result<PrivExec, PrivdError> {
    no_extra(args, &["argv"])?;
    let a = string_argv(args.get("argv"), 16)?;
    if a.len() == 1 && at(&a, 0) == "daemon-reload" {
        return Ok(exec("/usr/bin/systemctl", a, 60_000));
    }
    let verb = at(&a, 0);
    if !UNIT_VERBS.contains(&verb) {
        return Err(forbidden(format!("systemctl {verb} is not allowed")));
    }
    let rest = a.get(1..).unwrap_or_default();
    let units: Vec<&str> = rest
        .iter()
        .map(String::as_str)
        .filter(|x| !x.starts_with('-'))
        .collect();
    if units.is_empty() {
        return Err(bad("name a unit"));
    }
    if units.iter().any(|u| !MANAGED_UNITS.contains(u)) {
        return Err(forbidden("that unit is not one the daemon manages"));
    }
    for f in rest
        .iter()
        .map(String::as_str)
        .filter(|x| x.starts_with('-'))
    {
        if matches!(f, "--no-block" | "--now" | "--quiet" | "--no-pager") {
            continue;
        }
        if verb == "show" && SHOW_PROPERTY_RE.is_match(f) {
            continue;
        }
        return Err(forbidden(format!("systemctl flag {f} is not allowed")));
    }
    if verb == "enable" && !units.iter().all(|u| ENABLE_UNITS.contains(u)) {
        return Err(forbidden("that unit is not enabled from here"));
    }
    Ok(exec("/usr/bin/systemctl", a, 60_000))
}

// ── host operations ───────────────────────────────────────────────────────

static IMAGE_MOUNT: LazyLock<Regex> = LazyLock::new(|| re(&format!("^{FILES_IMAGE_ROOT}/{VOL}$")));
static IMAGE_FILE: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"^{FILES_IMAGE_ROOT}/{VOL}\.img$")));
static IMAGE_DATA: LazyLock<Regex> =
    LazyLock::new(|| re(&format!("^{FILES_IMAGE_ROOT}/{VOL}/data/?$")));
static IMAGE_PENDING: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"^{FILES_IMAGE_ROOT}/{VOL}\.pending$")));
static IMAGE_BALLAST: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"^{FILES_IMAGE_ROOT}/{VOL}/\.flagship-ballast$")));
static ORPHAN_FILE: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"^{FILES_IMAGE_ROOT}/orphaned/({VOL})\.[0-9]{{1,16}}\.img$"
    ))
});
static VOLUME_DATA: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        "^/var/lib/(?:docker/volumes|containers/storage/volumes)/{VOL}/_data$"
    ))
});
static LOOP_DEVICE: LazyLock<Regex> = LazyLock::new(|| re(r"^/dev/loop[0-9]{1,4}$"));
static DIGITS_16: LazyLock<Regex> = LazyLock::new(|| re(r"^[0-9]{1,16}$"));
static EGRESS_CHAIN: LazyLock<Regex> =
    LazyLock::new(|| re(r"^FLAGSHIP-EGRESS(?:6|-NAT|-FWD|-IN)$"));
static BOX_BRIDGE: LazyLock<Regex> = LazyLock::new(|| re(r"^fs-[a-z0-9-]{1,12}$"));
static PRIVATE_CIDR: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^(?:10\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])|172\.(?:1[6-9]|2[0-9]|3[01])|192\.168)(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){2}/(?:[89]|[12][0-9]|3[0-2])$",
    )
});
static SYSCTL_V6: LazyLock<Regex> =
    LazyLock::new(|| re(r"^net\.ipv6\.conf\.([^.=]+)\.disable_ipv6=1$"));
static IFACE: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-zA-Z0-9_.-]{1,15}$"));
const EGRESS_PARENTS: &[&str] = &["PREROUTING", "DOCKER-USER", "INPUT", "FORWARD"];
const MOUNT_OPTS: &str = "loop,nodev,nosuid,discard,noinit_itable";
const MKFS_ARGS: &[&str] = &[
    "-q",
    "-F",
    "-b",
    "4096",
    "-T",
    "default",
    "-m",
    "0",
    "-E",
    "lazy_itable_init=1,lazy_journal_init=1,nodiscard",
];

/// `iccTable`: the nft table that keeps containers on one bridge apart under Podman
/// (egress/firewall.ts renderIccTable), byte for byte.
pub fn icc_table(bridges: &[String]) -> String {
    let mut lines: Vec<String> = owned(&[
        "table bridge flagship_icc",
        "delete table bridge flagship_icc",
        "table bridge flagship_icc {",
        "  chain forward {",
        "    type filter hook forward priority -100; policy accept;",
    ]);
    for b in bridges {
        lines.push(format!(
            "    meta ibrname \"{b}\" meta obrname \"{b}\" counter drop"
        ));
    }
    lines.extend(owned(&["  }", "}", ""]));
    lines.join("\n")
}

/// The box's mount table, for the loop-device checks.
pub type MountsReader<'a> = &'a dyn Fn() -> String;

fn loop_at_image(dev: &str, mounts: MountsReader<'_>) -> bool {
    LOOP_DEVICE.is_match(dev)
        && mounts().split('\n').any(|l| {
            let mut f = l.split(' ');
            f.next() == Some(dev) && IMAGE_MOUNT.is_match(f.next().unwrap_or_default())
        })
}

fn host_command(name: &str, a: &[String], mounts: MountsReader<'_>) -> Option<PrivExec> {
    let n = a.len();
    let s = |i: usize| at(a, i);
    let all = || a.to_vec();
    let orphans = format!("{FILES_IMAGE_ROOT}/orphaned");
    match name {
        "mount" => ((n == 4
            && s(0) == "-o"
            && s(1) == MOUNT_OPTS
            && IMAGE_FILE.is_match(s(2))
            && s(3) == s(2).strip_suffix(".img").unwrap_or(s(2)))
            || (n == 3
                && s(0) == "-o"
                && matches!(s(1), "remount,ro" | "remount,rw")
                && IMAGE_MOUNT.is_match(s(2))))
        .then(|| exec("/usr/bin/mount", all(), 60_000)),
        "umount" => ((n == 1 && IMAGE_MOUNT.is_match(s(0)))
            || (n == 2 && s(0) == "-l" && IMAGE_MOUNT.is_match(s(1))))
        .then(|| exec("/usr/bin/umount", all(), 60_000)),
        "chattr" => (n == 2 && matches!(s(0), "+i" | "-i") && IMAGE_MOUNT.is_match(s(1)))
            .then(|| exec("/usr/bin/chattr", all(), 30_000)),
        "losetup" => (n == 2 && s(0) == "-c" && loop_at_image(s(1), mounts))
            .then(|| exec("/usr/sbin/losetup", all(), 60_000)),
        "resize2fs" => (n == 1 && loop_at_image(s(0), mounts))
            .then(|| exec("/usr/sbin/resize2fs", all(), 10 * 60_000)),
        "cp" => (n == 4
            && s(0) == "-a"
            && s(1) == "--"
            && VOLUME_DATA.is_match(s(2).strip_suffix("/.").unwrap_or(s(2)))
            && s(2).ends_with("/.")
            && IMAGE_DATA.is_match(s(3)))
        .then(|| exec("/usr/bin/cp", all(), 30 * 60_000)),
        "du" => (n == 2
            && s(0) == "-sk"
            && (IMAGE_MOUNT.is_match(s(1))
                || IMAGE_DATA.is_match(s(1))
                || VOLUME_DATA.is_match(s(1))))
        .then(|| exec("/usr/bin/du", all(), 10 * 60_000)),
        "chmod" => {
            (n == 2 && s(0) == "0777" && (VOLUME_DATA.is_match(s(1)) || IMAGE_DATA.is_match(s(1))))
                .then(|| exec("/usr/bin/chmod", all(), 30_000))
        }
        "mkdir" => (n == 2
            && matches!(s(0), "0755" | "0777")
            && (s(1) == FILES_IMAGE_ROOT
                || s(1) == orphans
                || IMAGE_MOUNT.is_match(s(1))
                || IMAGE_DATA.is_match(s(1))))
        .then(|| {
            exec(
                "/usr/bin/mkdir",
                owned(&["-p", "-m", s(0), "--", s(1)]),
                30_000,
            )
        }),
        "truncate" => (n == 2
            && DIGITS_16.is_match(s(0))
            && (IMAGE_FILE.is_match(s(1)) || IMAGE_BALLAST.is_match(s(1))))
        .then(|| {
            exec(
                "/usr/bin/truncate",
                owned(&["-s", s(0), "--", s(1)]),
                60_000,
            )
        }),
        "fallocate" => {
            (n == 3 && s(0) == "-l" && DIGITS_16.is_match(s(1)) && IMAGE_BALLAST.is_match(s(2)))
                .then(|| exec("/usr/bin/fallocate", all(), 10 * 60_000))
        }
        "mkfs.ext4" => (n == MKFS_ARGS.len().saturating_add(1)
            && MKFS_ARGS.iter().enumerate().all(|(i, x)| s(i) == *x)
            && IMAGE_FILE.is_match(s(n.saturating_sub(1))))
        .then(|| exec("/usr/sbin/mkfs.ext4", all(), 10 * 60_000)),
        "touch" => (n == 1 && IMAGE_PENDING.is_match(s(0)))
            .then(|| exec("/usr/bin/touch", owned(&["--", s(0)]), 30_000)),
        "rm" => (n == 1
            && (IMAGE_FILE.is_match(s(0))
                || IMAGE_PENDING.is_match(s(0))
                || IMAGE_BALLAST.is_match(s(0))
                || ORPHAN_FILE.is_match(s(0))))
        .then(|| exec("/usr/bin/rm", owned(&["-f", "--", s(0)]), 60_000)),
        "rmdir" => (n == 1 && (IMAGE_MOUNT.is_match(s(0)) || s(0) == orphans))
            .then(|| exec("/usr/bin/rmdir", owned(&["--", s(0)]), 30_000)),
        "mv" => {
            let vol = if n == 2 {
                ORPHAN_FILE
                    .captures(s(1))
                    .and_then(|c| c.get(1).map(|m| m.as_str().to_owned()))
            } else {
                None
            };
            vol.filter(|v| {
                IMAGE_FILE.is_match(s(0)) && s(0) == format!("{FILES_IMAGE_ROOT}/{v}.img")
            })
            .map(|_| exec("/usr/bin/mv", owned(&["-T", "--", s(0), s(1)]), 60_000))
        }
        "fingerprint" => (n == 1 && (IMAGE_DATA.is_match(s(0)) || VOLUME_DATA.is_match(s(0))))
            .then(|| {
                exec(
                    "/bin/sh",
                    owned(&["-c", FOLDER_FINGERPRINT_SCRIPT, "_", s(0)]),
                    30 * 60_000,
                )
            }),
        "networkctl" => {
            (n == 1 && s(0) == "reload").then(|| exec("/usr/bin/networkctl", all(), 30_000))
        }
        "ip" => ((n == 5
            && s(0) == "link"
            && s(1) == "add"
            && BOX_BRIDGE.is_match(s(2))
            && s(3) == "type"
            && s(4) == "bridge")
            || (n == 5
                && s(0) == "addr"
                && s(1) == "add"
                && PRIVATE_CIDR.is_match(s(2))
                && s(3) == "dev"
                && BOX_BRIDGE.is_match(s(4)))
            || (n == 4
                && s(0) == "link"
                && s(1) == "set"
                && BOX_BRIDGE.is_match(s(2))
                && s(3) == "up"))
            .then(|| exec("/usr/sbin/ip", all(), 30_000)),
        "sysctl" => (n == 3
            && s(0) == "-q"
            && s(1) == "-w"
            && SYSCTL_V6
                .captures(s(2))
                .and_then(|c| c.get(1))
                .is_some_and(|m| BOX_BRIDGE.is_match(m.as_str())))
        .then(|| exec("/usr/sbin/sysctl", all(), 30_000)),
        "icc" => (n <= 8 && a.iter().all(|b| IFACE.is_match(b))).then(|| PrivExec {
            input: Some(icc_table(a)),
            ..exec("/usr/sbin/nft", owned(&["-f", "-"]), 30_000)
        }),
        _ => None,
    }
}

const HOST_FILES: &[&str] = &[
    "mount",
    "umount",
    "chattr",
    "losetup",
    "resize2fs",
    "cp",
    "du",
    "chmod",
    "mkdir",
    "truncate",
    "fallocate",
    "mkfs.ext4",
    "touch",
    "rm",
    "rmdir",
    "mv",
    "fingerprint",
    "networkctl",
    "ip",
    "sysctl",
    "icc",
];

pub fn host_exec(args: &Args, mounts: MountsReader<'_>) -> Result<PrivExec, PrivdError> {
    no_extra(args, &["file", "argv"])?;
    let a = string_argv(args.get("argv"), 32)?;
    let name = args.get("file").and_then(Value::as_str).unwrap_or_default();
    if name == "iptables" || name == "ip6tables" {
        return iptables_exec(name, &a);
    }
    if !HOST_FILES.contains(&name) {
        return Err(PrivdError::new(
            ErrorCode::UnknownOp,
            "unknown host operation",
        ));
    }
    host_command(name, &a, mounts)
        .ok_or_else(|| forbidden(format!("{name} with those arguments is not allowed")))
}

fn iptables_exec(file: &str, a: &[String]) -> Result<PrivExec, PrivdError> {
    let x: &[String] = if at(a, 0) == "-w" {
        a.get(1..).unwrap_or_default()
    } else {
        a
    };
    let s = |i: usize| at(x, i);
    let ok = x.len() >= 3
        && s(0) == "-t"
        && matches!(s(1), "nat" | "filter")
        && ((x.len() == 4 && s(2) == "-N" && s(3) == "DOCKER-USER")
            || (x.len() == 6
                && matches!(s(2), "-C" | "-D")
                && EGRESS_PARENTS.contains(&s(3))
                && s(4) == "-j"
                && EGRESS_CHAIN.is_match(s(5)))
            || (x.len() == 7
                && s(2) == "-I"
                && EGRESS_PARENTS.contains(&s(3))
                && s(4) == "1"
                && s(5) == "-j"
                && EGRESS_CHAIN.is_match(s(6)))
            || (x.len() == 4 && matches!(s(2), "-F" | "-X") && EGRESS_CHAIN.is_match(s(3))));
    if !ok {
        return Err(forbidden(format!(
            "{file} with those arguments is not allowed"
        )));
    }
    let bin = if file == "iptables" {
        "/usr/sbin/iptables"
    } else {
        "/usr/sbin/ip6tables"
    };
    let mut argv = vec!["-w".to_owned()];
    argv.extend_from_slice(x);
    Ok(exec(bin, argv, 30_000))
}

static RESTORE_DECL: LazyLock<Regex> =
    LazyLock::new(|| re(r"^:FLAGSHIP-EGRESS(?:6|-NAT|-FWD|-IN) - \[0:0\]$"));
// JavaScript's `.` stops at every line terminator, not only `\n`.
static RESTORE_RULE: LazyLock<Regex> =
    LazyLock::new(|| re("^-A (FLAGSHIP-EGRESS(?:6|-NAT|-FWD|-IN)) ([^\n\r\u{2028}\u{2029}]*)$"));
static RESTORE_BAD_CHAR: LazyLock<Regex> = LazyLock::new(|| re(r"[;`$\\|&<>]"));

/// What follows each occurrence of `word` that starts the text or follows JavaScript `\s`.
fn after_word<'a>(s: &'a str, word: &'a str) -> impl Iterator<Item = &'a str> {
    s.char_indices().filter_map(move |(p, _)| {
        let rest = s.get(p..)?;
        let before_ok = s
            .get(..p)
            .is_some_and(|b| b.chars().next_back().is_none_or(js::is_js_space));
        (before_ok && rest.starts_with(word)).then(|| rest.get(word.len()..).unwrap_or_default())
    })
}

/// `/(^|\s)-j\s+(?!REDIRECT|REJECT|RETURN|ACCEPT)\S+/`
fn jumps_elsewhere(s: &str) -> bool {
    after_word(s, "-j").any(|rest| {
        let target = rest.trim_start_matches(js::is_js_space);
        target.len() < rest.len()
            && !target.is_empty()
            && !["REDIRECT", "REJECT", "RETURN", "ACCEPT"]
                .iter()
                .any(|t| target.starts_with(t))
    })
}

/// `/(^|\s)-g\s/`
fn goes_to(s: &str) -> bool {
    after_word(s, "-g").any(|rest| rest.chars().next().is_some_and(js::is_js_space))
}

pub fn iptables_restore_exec(args: &Args) -> Result<PrivExec, PrivdError> {
    no_extra(args, &["family", "rules"])?;
    let family = args.get("family").and_then(Value::as_f64);
    let four = family == Some(4.0);
    if !four && family != Some(6.0) {
        return Err(bad("family is 4 or 6"));
    }
    let rules = match args.get("rules").and_then(Value::as_str) {
        Some(r) if !r.is_empty() && js::utf16_len(r) <= 256 * 1024 => r,
        _ => return Err(bad("rules must be text")),
    };
    for raw in rules.split('\n') {
        let line = js::trim(raw);
        if line.is_empty() || matches!(line, "COMMIT" | "*nat" | "*filter") {
            continue;
        }
        if RESTORE_DECL.is_match(line) {
            continue;
        }
        if let Some(m) = RESTORE_RULE.captures(line).and_then(|c| c.get(2)) {
            let body = m.as_str();
            if !RESTORE_BAD_CHAR.is_match(body) && !jumps_elsewhere(body) && !goes_to(body) {
                continue;
            }
        }
        return Err(forbidden(format!(
            "rule not allowed: {}",
            js::slice_units(line, 80)
        )));
    }
    let bin = if four {
        "/usr/sbin/iptables-restore"
    } else {
        "/usr/sbin/ip6tables-restore"
    };
    Ok(PrivExec {
        input: Some(rules.to_owned()),
        ..exec(bin, owned(&["-w", "--noflush"]), 30_000)
    })
}

// ── release swap, data wipe, setup steps ──────────────────────────────────

/// The trust a release install is checked against: the running release's own (release/*.json).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseTrust {
    pub keys: Vec<String>,
    pub threshold: u64,
    pub node_floor: String,
    pub min_sequence: u64,
    pub pq_key_ids: Vec<String>,
    pub legacy_manifests: Vec<String>,
}

fn is_hex(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn release_exec(args: &Args, trust: &ReleaseTrust, arch: &str) -> Result<PrivExec, PrivdError> {
    no_extra(args, &["action", "commit", "sha256"])?;
    let commit = match args.get("commit").and_then(Value::as_str) {
        Some(c) if is_hex(c, 40) => c,
        _ => return Err(bad("commit must be 40 hex")),
    };
    let action = args.get("action").and_then(Value::as_str);
    if action == Some("restore") {
        return Ok(exec(
            "/usr/bin/bash",
            vec![
                format!("{RELEASE_REPO}/installer/rollback-box-artifact.sh"),
                commit.to_owned(),
            ],
            20 * 60_000,
        ));
    }
    if action != Some("install") {
        return Err(bad("action is install or restore"));
    }
    let sha = match args.get("sha256").and_then(Value::as_str) {
        Some(s) if is_hex(s, 64) => s,
        _ => return Err(bad("sha256 must be 64 hex")),
    };
    if arch != "amd64" && arch != "arm64" {
        return Err(PrivdError::new(ErrorCode::Failed, "unknown architecture"));
    }
    let short = commit.get(..12).unwrap_or(commit);
    let dir = format!("/var/tmp/.flagship-update-{short}");
    let name = format!("flagship-box-{short}-{arch}");
    let staged = format!("{PRIVD_STATE_DIR}/release");
    let manifest = format!("{staged}/{name}.manifest.json");
    let artifact = format!("{staged}/{name}.tar.gz");
    let mut argv = vec![
        format!("{RELEASE_REPO}/installer/install-box-artifact.sh"),
        "--manifest".into(),
        manifest.clone(),
        "--artifact".into(),
        artifact.clone(),
        "--trust-keys".into(),
        trust.keys.join(","),
        "--threshold".into(),
        trust.threshold.to_string(),
        "--expect-sha256".into(),
        sha.to_owned(),
        "--expect-commit".into(),
        commit.to_owned(),
        "--arch".into(),
        arch.to_owned(),
        "--node-floor".into(),
        trust.node_floor.clone(),
        "--min-sequence".into(),
        trust.min_sequence.to_string(),
    ];
    if !trust.pq_key_ids.is_empty() {
        argv.push("--pq-key-ids".into());
        argv.push(trust.pq_key_ids.join(","));
        if !trust.legacy_manifests.is_empty() {
            argv.push("--legacy-manifests".into());
            argv.push(trust.legacy_manifests.join(","));
        }
    }
    Ok(PrivExec {
        copy_in: vec![
            CopyIn {
                from: format!("{dir}/{name}.manifest.json"),
                to: manifest,
            },
            CopyIn {
                from: format!("{dir}/{name}.tar.gz"),
                to: artifact,
            },
        ],
        ..exec("/usr/bin/bash", argv, 30 * 60_000)
    })
}

pub fn wipe_exec(args: &Args) -> Result<PrivExec, PrivdError> {
    no_extra(args, &["target"])?;
    if args.get("target").and_then(Value::as_str) != Some("data") {
        return Err(bad("target is data"));
    }
    Ok(exec(
        "/usr/bin/rm",
        owned(&["-rf", "--one-file-system", "/var/flagship/data"]),
        30 * 60_000,
    ))
}

pub fn setup_exec(args: &Args) -> Result<PrivExec, PrivdError> {
    no_extra(args, &["step"])?;
    match args.get("step").and_then(Value::as_str) {
        Some(step) if SETUP_STEPS.contains(&step) => Ok(exec(
            "/usr/local/bin/node",
            vec![
                format!("{RELEASE_REPO}/packages/server-daemon/dist/setup.js"),
                step.to_owned(),
            ],
            30 * 60_000,
        )),
        _ => Err(forbidden("unknown setup step")),
    }
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

pub fn nft_exec(args: &Args) -> Result<PrivExec, PrivdError> {
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
    Ok(PrivExec {
        input: Some(script.to_owned()),
        ..exec("/usr/sbin/nft", owned(&["-f", "-"]), 30_000)
    })
}

/// What a request is checked against besides its arguments.
#[derive(Clone, Copy)]
pub struct PolicyContext<'a> {
    pub engine: EngineKind,
    pub mounts: MountsReader<'a>,
    pub trust: &'a ReleaseTrust,
    pub arch: &'a str,
}

impl std::fmt::Debug for PolicyContext<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PolicyContext")
            .field("engine", &self.engine)
            .field("arch", &self.arch)
            .finish_non_exhaustive()
    }
}

/// `validateRequest`: the one exact command a request may run, or a refusal.
pub fn validate_request(
    op: &str,
    args: &Args,
    ctx: &PolicyContext<'_>,
) -> Result<PrivExec, PrivdError> {
    match op {
        "power" => power_exec(args),
        "systemd.restart" => restart_exec(args),
        "systemctl" => systemctl_exec(args),
        "docker" => docker_exec(args, ctx.engine),
        "docker.file" => docker_file_exec(args, ctx.engine),
        "host" => host_exec(args, ctx.mounts),
        "iptables.restore" => iptables_restore_exec(args),
        "nft.apply" => nft_exec(args),
        "release" => release_exec(args, ctx.trust, ctx.arch),
        "wipe" => wipe_exec(args),
        "setup" => setup_exec(args),
        _ => Err(PrivdError::new(ErrorCode::UnknownOp, "unknown operation")),
    }
}
