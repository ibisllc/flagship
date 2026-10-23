//! `flagship-boot unlock`: the whole early-boot unlock (the shell's
//! `unlock_via_box_lease` / `unlock_via_relay` dispatch plus the cryptsetup
//! hand-off) in one process, so no secret crosses argv, the environment or
//! a file. It reads the same `/boot` files the shell reads.
//!
//! ```text
//! flagship-boot unlock --handoff cryptsetup --device DEV --name NAME [options]
//! flagship-boot unlock --handoff stdout [options] | cryptsetup luksOpen --key-file - DEV NAME
//!
//!   --boot-dir DIR            /boot (server-domain, identity.pem, flagship-boot-host,
//!                             flagship-boot-unlock-mode, flagship-boot-allowed-hosts)
//!   --lock-once-marker PATH   presence forces approve (default DIR/flagship-lock-once);
//!                             the caller removes it after a successful mount
//!   --boot-host URL           instead of DIR/flagship-boot-host
//!   --mode auto|approve       instead of DIR/flagship-boot-unlock-mode
//!   --policy compat|strict    strict: refuse unapproved hosts, treat an unknown mode
//!                             as approve, console fallback only on a debug burn
//!   --allow-host HOST         approve another worker host (repeatable)
//!   --ca-bundle PEM           trust these roots instead of the built-in Mozilla set
//!   --http-timeout-secs N     per exchange (30, curl --max-time)
//!   --relay-window-secs N     FLAGSHIP_RELAY_WINDOW_SECS, else 31536000
//!   --heartbeat-secs N        FLAGSHIP_RELAY_HEARTBEAT_SECS, else 120
//!   --console PATH            'manual' fallback reads PATH (the premount uses /dev/console)
//!   --cryptsetup PATH         cryptsetup binary (default: cryptsetup on PATH)
//!   --allow-loopback-http     tests only
//! ```
//!
//! Exit 0 when the volume is open (or the key was written), 1 when no key
//! could be obtained, cryptsetup's own code when it refuses, 64 on bad usage.

pub mod flow;
pub mod handoff;
pub mod policy;
pub mod system;
pub mod transport;

use crate::identity::BoxIdentity;
use flow::{Mode, OsRandom, RelayTiming, Unlocker};
use handoff::Handoff;
use policy::{Endpoint, EndpointPolicy, Enforcement};
use std::ffi::OsStr;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Exit code for a usage error (sysexits `EX_USAGE`; cryptsetup uses 1 to 5).
pub const EXIT_USAGE: i32 = 64;

/// Parsed `unlock` options.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// The `/boot` directory.
    pub boot_dir: PathBuf,
    /// One-shot lock marker.
    pub lock_once_marker: Option<PathBuf>,
    /// Worker origin override.
    pub boot_host: Option<String>,
    /// Mode override.
    pub mode: Option<String>,
    /// Compat or strict.
    pub enforcement: Enforcement,
    /// Extra approved hosts.
    pub allow_hosts: Vec<String>,
    /// PEM roots.
    pub ca_bundle: Option<PathBuf>,
    /// Per-exchange timeout.
    pub http_timeout_secs: u64,
    /// Relay window override.
    pub relay_window_secs: Option<u64>,
    /// Heartbeat override.
    pub heartbeat_secs: Option<u64>,
    /// Console fallback source.
    pub console: Option<PathBuf>,
    /// Where the key goes.
    pub handoff: Handoff,
    /// Tests only.
    pub allow_loopback_http: bool,
}

fn utf8(flag: &str, v: &[u8]) -> Result<String, String> {
    String::from_utf8(v.to_vec()).map_err(|_| format!("{flag} must be UTF-8"))
}

fn number(flag: &str, v: &str) -> Result<u64, String> {
    v.parse::<u64>()
        .map_err(|_| format!("{flag} must be a whole number of seconds, got {v:?}"))
}

/// Parse `unlock`'s arguments (`--flag value` or `--flag=value`).
pub fn parse_options(args: &[Vec<u8>]) -> Result<Options, String> {
    let mut boot_dir = PathBuf::from("/boot");
    let mut o = Options {
        boot_dir: boot_dir.clone(),
        lock_once_marker: None,
        boot_host: None,
        mode: None,
        enforcement: Enforcement::Compat,
        allow_hosts: Vec::new(),
        ca_bundle: None,
        http_timeout_secs: 30,
        relay_window_secs: None,
        heartbeat_secs: None,
        console: None,
        handoff: Handoff::Stdout,
        allow_loopback_http: false,
    };
    let mut handoff: Option<String> = None;
    let mut cryptsetup = PathBuf::from("cryptsetup");
    let mut device: Option<PathBuf> = None;
    let mut name: Option<String> = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.iter().position(|&b| b == b'=') {
            Some(p) => (
                arg.get(..p).unwrap_or_default(),
                arg.get(p.saturating_add(1)..),
            ),
            None => (arg.as_slice(), None),
        };
        let flag = String::from_utf8_lossy(flag).into_owned();
        if flag == "--strict-endpoints" || flag == "--allow-loopback-http" {
            if flag == "--allow-loopback-http" {
                o.allow_loopback_http = true;
            } else {
                o.enforcement = Enforcement::Strict;
            }
            continue;
        }
        let value: &[u8] = match inline {
            Some(v) => v,
            None => it
                .next()
                .map(Vec::as_slice)
                .ok_or_else(|| format!("{flag} needs a value"))?,
        };
        let path = || PathBuf::from(OsStr::from_bytes(value));
        match flag.as_str() {
            "--boot-dir" => boot_dir = path(),
            "--lock-once-marker" => o.lock_once_marker = Some(path()),
            "--boot-host" => o.boot_host = Some(utf8(&flag, value)?),
            "--mode" => o.mode = Some(utf8(&flag, value)?),
            "--policy" => {
                o.enforcement = match utf8(&flag, value)?.as_str() {
                    "compat" => Enforcement::Compat,
                    "strict" => Enforcement::Strict,
                    v => return Err(format!("--policy must be compat or strict, got {v:?}")),
                }
            }
            "--allow-host" => o.allow_hosts.push(utf8(&flag, value)?.to_ascii_lowercase()),
            "--ca-bundle" => o.ca_bundle = Some(path()),
            "--http-timeout-secs" => o.http_timeout_secs = number(&flag, &utf8(&flag, value)?)?,
            "--relay-window-secs" => {
                o.relay_window_secs = Some(number(&flag, &utf8(&flag, value)?)?)
            }
            "--heartbeat-secs" => o.heartbeat_secs = Some(number(&flag, &utf8(&flag, value)?)?),
            "--console" => o.console = Some(path()),
            "--handoff" => handoff = Some(utf8(&flag, value)?),
            "--cryptsetup" => cryptsetup = path(),
            "--device" => device = Some(path()),
            "--name" => name = Some(utf8(&flag, value)?),
            _ => return Err(format!("unknown option {flag}")),
        }
    }
    o.boot_dir = boot_dir;
    if o.http_timeout_secs == 0 {
        return Err("--http-timeout-secs must be at least 1".into());
    }
    o.handoff = match handoff.as_deref() {
        Some("stdout") => Handoff::Stdout,
        Some("cryptsetup") => {
            let device = device.ok_or("--handoff cryptsetup needs --device")?;
            let name = name.ok_or("--handoff cryptsetup needs --name")?;
            if name.is_empty() || name.contains(['/', '\0']) {
                return Err("--name must be a mapper name".into());
            }
            Handoff::Cryptsetup {
                program: cryptsetup,
                device,
                name,
            }
        }
        Some(v) => return Err(format!("--handoff must be cryptsetup or stdout, got {v:?}")),
        None => return Err("--handoff cryptsetup|stdout is required".into()),
    };
    Ok(o)
}

/// `$(cat FILE)`: the bytes with every trailing newline removed.
fn cat(path: &Path) -> Option<Vec<u8>> {
    let mut b = std::fs::read(path).ok()?;
    while b.last() == Some(&b'\n') {
        b.pop();
    }
    Some(b)
}

fn env_secs(name: &str) -> Result<Option<u64>, String> {
    match std::env::var(name) {
        Ok(v) => number(name, &v).map(Some),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err(format!("{name} must be a whole number of seconds"))
        }
    }
}

/// What the run resolved from the options and `/boot`.
#[derive(Debug)]
pub struct Plan {
    /// The box FQDN.
    pub server_domain: String,
    /// The STK.
    pub identity: BoxIdentity,
    /// The worker.
    pub endpoint: Endpoint,
    /// The effective mode.
    pub mode: Mode,
    /// Relay timing.
    pub timing: RelayTiming,
    /// Notes for the log (warnings, the mode line).
    pub notes: Vec<String>,
}

/// Resolve the boot facts the shell reads, under the chosen policy.
pub fn plan(o: &Options) -> Result<Plan, String> {
    let dir = &o.boot_dir;
    let mut notes = Vec::new();
    let domain = cat(&dir.join("server-domain")).ok_or("cannot read server-domain")?;
    let server_domain = String::from_utf8(domain).map_err(|_| "server-domain is not UTF-8")?;
    crate::canonical::check_server_domain(&server_domain).map_err(|e| e.to_string())?;

    let pem_path = dir.join("identity.pem");
    let pem = zeroize::Zeroizing::new(
        std::fs::read(&pem_path).map_err(|_| format!("missing {}", pem_path.display()))?,
    );
    let identity = BoxIdentity::from_pkcs8_pem(&pem).map_err(|e| e.to_string())?;

    let host = match &o.boot_host {
        Some(h) => h.clone(),
        None => match cat(&dir.join("flagship-boot-host")) {
            Some(b) => String::from_utf8(b).map_err(|_| "flagship-boot-host is not UTF-8")?,
            None => policy::DEFAULT_BOOT_HOST.to_owned(),
        },
    };
    let host = host.strip_suffix('/').unwrap_or(&host).to_owned();
    let mut pol = EndpointPolicy {
        enforcement: o.enforcement,
        allow_loopback_http: o.allow_loopback_http,
        ..EndpointPolicy::default()
    };
    pol.allowed_hosts.extend(o.allow_hosts.iter().cloned());
    if let Some(list) = cat(&dir.join("flagship-boot-allowed-hosts")) {
        let list = String::from_utf8_lossy(&list).into_owned();
        pol.allowed_hosts.extend(
            list.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(str::to_ascii_lowercase),
        );
    }
    let endpoint = pol.resolve(&host).map_err(|e| e.to_string())?;
    if !endpoint.approved {
        notes.push(format!(
            "boot host {} is not on the approved list; using it (compat policy)",
            endpoint.host
        ));
    }

    let baseline = match &o.mode {
        Some(m) => m.clone(),
        None => cat(&dir.join("flagship-boot-unlock-mode")).map_or_else(
            || "auto".to_owned(),
            |b| String::from_utf8_lossy(&b).into_owned(),
        ),
    };
    let baseline_mode = match baseline.as_str() {
        "approve" => Mode::Approve,
        "auto" => Mode::Auto,
        other if o.enforcement == Enforcement::Strict => {
            notes.push(format!(
                "unknown boot-unlock mode {other:?}; asking the phone (strict policy)"
            ));
            Mode::Approve
        }
        other => {
            notes.push(format!(
                "unknown boot-unlock mode {other:?}; treating it as auto, as the shell does"
            ));
            Mode::Auto
        }
    };
    let marker = o
        .lock_once_marker
        .clone()
        .unwrap_or_else(|| dir.join("flagship-lock-once"));
    let lock_once = marker.is_file();
    let mode = if lock_once {
        Mode::Approve
    } else {
        baseline_mode
    };
    if lock_once {
        notes.push("one-shot lock marker present — forcing approve relay for THIS boot".into());
    }
    let label = |m: Mode| {
        if m == Mode::Approve {
            "approve"
        } else {
            "auto"
        }
    };
    notes.push(format!(
        "boot-unlock mode = {} (baseline={baseline}, lock-once={})",
        label(mode),
        if lock_once { "yes" } else { "no" }
    ));

    let defaults = RelayTiming::default();
    let timing = RelayTiming {
        window_secs: match o.relay_window_secs {
            Some(s) => s,
            None => env_secs("FLAGSHIP_RELAY_WINDOW_SECS")?.unwrap_or(defaults.window_secs),
        },
        heartbeat_secs: match o.heartbeat_secs {
            Some(s) => s,
            None => env_secs("FLAGSHIP_RELAY_HEARTBEAT_SECS")?.unwrap_or(defaults.heartbeat_secs),
        },
    };
    Ok(Plan {
        server_domain,
        identity,
        endpoint,
        mode,
        timing,
        notes,
    })
}

/// `flagship-boot unlock ...`: returns the exit code.
pub fn main(args: &[Vec<u8>], log: &mut dyn Write) -> i32 {
    let o = match parse_options(args) {
        Ok(o) => o,
        Err(e) => {
            let _ = writeln!(log, "flagship-boot unlock: {e}");
            return EXIT_USAGE;
        }
    };
    let p = match plan(&o) {
        Ok(p) => p,
        Err(e) => {
            let _ = writeln!(log, "flagship: {e}");
            return 1;
        }
    };
    for n in &p.notes {
        let _ = writeln!(log, "flagship: {n}");
    }
    let ca = match &o.ca_bundle {
        Some(path) => match std::fs::read(path) {
            Ok(b) => Some(b),
            Err(e) => {
                let _ = writeln!(log, "flagship: cannot read {}: {e}", path.display());
                return 1;
            }
        },
        None => None,
    };
    let transport = match transport::UreqTransport::new(
        Duration::from_secs(o.http_timeout_secs),
        ca.as_deref(),
        o.allow_loopback_http,
    ) {
        Ok(t) => t,
        Err(e) => {
            let _ = writeln!(log, "flagship: {e}");
            return 1;
        }
    };
    let console = match &o.console {
        Some(c)
            if o.enforcement == Enforcement::Strict
                && !o.boot_dir.join("flagship-debug-mode").is_file() =>
        {
            let _ = writeln!(
                log,
                "flagship: ignoring --console {} (strict policy, not a debug burn)",
                c.display()
            );
            None
        }
        other => other.clone(),
    };
    let clock = match &console {
        Some(c) => system::SystemClock::with_console(c),
        None => system::SystemClock::new(),
    };
    let mut unlocker = Unlocker {
        server_domain: &p.server_domain,
        identity: &p.identity,
        endpoint: &p.endpoint,
        transport: &transport,
        clock: &clock,
        random: &OsRandom,
        timing: p.timing,
        console_hint: console.is_some(),
        log,
    };
    let key = match unlocker.unlock(p.mode) {
        Ok(k) => k,
        Err(_) => return 1,
    };
    match handoff::hand_off(&key, &o.handoff) {
        Ok(()) => {
            let _ = writeln!(unlocker.log, "flagship: unlock key handed to cryptsetup");
            0
        }
        Err(e) => {
            let _ = writeln!(unlocker.log, "flagship: {}", e.message);
            e.code
        }
    }
}
