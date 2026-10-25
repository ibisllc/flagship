//! `flagship-boot unlock`: the whole early-boot unlock of the initramfs
//! premount (packages/boot-chain/src/unlockPremount.ts: the lease, the
//! relay, the two-tier dispatch, the one-shot lock) plus the cryptsetup
//! hand-off in one process, so no secret crosses argv, the environment or a
//! file. It reads the same `/boot` files the premount reads.
//!
//! ```text
//! flagship-boot unlock --handoff cryptsetup --device DEV --name NAME [options]
//! flagship-boot unlock --handoff stdout [options] | cryptsetup luksOpen --key-file - DEV NAME
//!
//!   --boot-dir DIR            /boot (server-domain, flagship-boot-key.pem, flagship-boot-host,
//!                             flagship-boot-unlock-mode, flagship-boot-allowed-hosts,
//!                             flagship-owner-key.pub, flagship-debug-mode)
//!   --lock-once-marker PATH   presence forces approve (default DIR/flagship-lock-once);
//!                             the caller removes it after a successful mount
//!   --boot-host URL           instead of DIR/flagship-boot-host; https on an approved host
//!   --mode auto|approve       instead of DIR/flagship-boot-unlock-mode (anything else
//!                             in the file, or no file, means approve)
//!   --allow-host HOST         approve another worker host (repeatable); built in:
//!                             boot.flagshipserver.com, boot.gym.flagshipserver.com
//!   --owner-key PATH          owner key file (64 hex); default the marker's directory,
//!                             then DIR, flagship-owner-key.pub; none means no lease
//!   --ca-bundle PEM           trust these roots instead of the built-in Mozilla set
//!   --http-timeout-secs N     per exchange (30, curl --max-time)
//!   --relay-window-secs N     FLAGSHIP_RELAY_WINDOW_SECS, else 604800 (1..604800)
//!   --heartbeat-secs N        FLAGSHIP_RELAY_HEARTBEAT_SECS, else 120 (10..600)
//!   --request-lifetime-secs N FLAGSHIP_RELAY_REQUEST_SECS, else 21600 (2..21600)
//!   --console PATH            'manual' fallback reads PATH, only on a debug burn
//!                             (DIR/flagship-debug-mode exists)
//!   --cryptsetup PATH         cryptsetup binary (default: cryptsetup on PATH)
//!   --allow-loopback-http     tests only
//! ```
//!
//! Overrides outside a range are clamped to it; an environment value that is
//! not a number is ignored, as in the premount.
//!
//! Exit 0 when the volume is open (or the key was written), 1 when no key
//! could be obtained, [`EXIT_RESTART`] (75) when the relay window ended with
//! no reply (the caller restarts the box, which asks again), cryptsetup's own
//! code when it refuses, 64 on bad usage.

pub mod flow;
pub mod handoff;
pub mod policy;
pub mod system;
pub mod transport;

use crate::identity::BoxIdentity;
use flow::{Mode, OsRandom, RelayTiming, Unlocker};
use handoff::Handoff;
use policy::{Endpoint, EndpointPolicy};
use std::ffi::OsStr;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Exit code for a usage error (sysexits `EX_USAGE`; cryptsetup uses 1 to 5).
pub const EXIT_USAGE: i32 = 64;
/// Exit code when the relay window ended with no reply (sysexits
/// `EX_TEMPFAIL`): restart and ask again.
pub const EXIT_RESTART: i32 = 75;

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
    pub mode: Option<Mode>,
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
    /// Request lifetime override.
    pub request_lifetime_secs: Option<u64>,
    /// Owner key file override.
    pub owner_key: Option<PathBuf>,
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
        allow_hosts: Vec::new(),
        ca_bundle: None,
        http_timeout_secs: 30,
        relay_window_secs: None,
        heartbeat_secs: None,
        request_lifetime_secs: None,
        owner_key: None,
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
        if flag == "--allow-loopback-http" {
            o.allow_loopback_http = true;
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
            "--mode" => {
                o.mode = Some(match utf8(&flag, value)?.as_str() {
                    "auto" => Mode::Auto,
                    "approve" => Mode::Approve,
                    v => return Err(format!("--mode must be auto or approve, got {v:?}")),
                })
            }
            "--owner-key" => o.owner_key = Some(path()),
            "--allow-host" => o.allow_hosts.push(utf8(&flag, value)?.to_ascii_lowercase()),
            "--ca-bundle" => o.ca_bundle = Some(path()),
            "--http-timeout-secs" => o.http_timeout_secs = number(&flag, &utf8(&flag, value)?)?,
            "--relay-window-secs" => {
                o.relay_window_secs = Some(number(&flag, &utf8(&flag, value)?)?)
            }
            "--heartbeat-secs" => o.heartbeat_secs = Some(number(&flag, &utf8(&flag, value)?)?),
            "--request-lifetime-secs" => {
                o.request_lifetime_secs = Some(number(&flag, &utf8(&flag, value)?)?)
            }
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

/// The premount's `bounded`: a value that is not a whole number is ignored.
fn env_secs(name: &str) -> Option<u64> {
    let v = std::env::var(name).ok()?;
    if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(v.parse::<u64>().unwrap_or(u64::MAX))
}

/// The premount's `owner_key_hex`: spaces, CR and LF removed, then exactly 64
/// lowercase hex digits.
fn read_owner_key(path: &Path) -> Option<[u8; 32]> {
    let raw = std::fs::read(path).ok()?;
    let k: Vec<u8> = raw
        .into_iter()
        .filter(|b| !matches!(b, b' ' | b'\n' | b'\r'))
        .collect();
    if k.len() != 64 || !k.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    crate::gohex::decode(&k).ok()?.try_into().ok()
}

/// `/boot/flagship-time-floor`: the daemon's last authenticated time (epoch ms, decimal, at most
/// 16 digits, an optional trailing newline). Anything else is ignored: the floor only ever makes
/// the clock read later, and an unreadable one leaves the system clock as it was.
pub fn read_time_floor(path: &Path) -> Option<u64> {
    let raw = std::fs::read(path).ok()?;
    let t = raw.strip_suffix(b"\n").unwrap_or(&raw);
    if t.is_empty() || t.len() > 16 || !t.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(t).ok()?.parse().ok()
}

/// What the run resolved from the options and `/boot`.
#[derive(Debug)]
pub struct Plan {
    /// The box FQDN.
    pub server_domain: String,
    /// The boot key.
    pub identity: BoxIdentity,
    /// The owner key leases must be signed by.
    pub owner_pub: Option<[u8; 32]>,
    /// Whether this is a debug burn (the console fallback is allowed).
    pub debug_burn: bool,
    /// The worker.
    pub endpoint: Endpoint,
    /// The effective mode.
    pub mode: Mode,
    /// Relay timing.
    pub timing: RelayTiming,
    /// Notes for the log (warnings, the mode line).
    pub notes: Vec<String>,
    /// The persisted time floor (`flagship-time-floor`), epoch ms; 0 when there is none.
    pub time_floor_ms: u64,
    /// v2 material on /boot, when the box has it.
    pub pq: Option<flow::PqBoot>,
    /// `flagship-unlock-policy`.
    pub policy: crate::v2::UnlockPolicy,
}

/// A 32-byte seed written as hex (one trailing newline), or nothing.
fn read_seed(path: &Path) -> Option<zeroize::Zeroizing<[u8; 32]>> {
    let raw = zeroize::Zeroizing::new(std::fs::read(path).ok()?);
    let t = raw.strip_suffix(b"\n").unwrap_or(&raw);
    let b = zeroize::Zeroizing::new(crate::gohex::decode(t).ok()?);
    <[u8; 32]>::try_from(b.as_slice())
        .ok()
        .map(zeroize::Zeroizing::new)
}

/// The boot key's v2 files: `flagship-boot-mldsa.key`, `flagship-owner-pq.pub`, and the lease
/// key from the TPM (`flagship-lease-kem.tpm/`) or `flagship-lease-kem.key`.
fn read_pq(dir: &Path, notes: &mut Vec<String>) -> Option<flow::PqBoot> {
    let mldsa_seed = read_seed(&dir.join("flagship-boot-mldsa.key"))?;
    let owner_pq = std::fs::read(dir.join("flagship-owner-pq.pub"))
        .ok()
        .and_then(|b| {
            let t = b.strip_suffix(b"\n").unwrap_or(&b).to_vec();
            crate::gohex::decode(&t)
                .ok()
                .filter(|k| k.len() == crate::v2::HYBRID_PK_LEN)
        });
    let tpm_dir = dir.join("flagship-lease-kem.tpm");
    let lease_seed = if tpm_dir.is_dir() {
        match crate::tpm::unseal_seed(&tpm_dir) {
            Ok(s) => Some(s),
            Err(e) => {
                notes.push(format!(
                    "lease key not released by the TPM ({e}); asking the phone"
                ));
                None
            }
        }
    } else {
        read_seed(&dir.join("flagship-lease-kem.key"))
    };
    Some(flow::PqBoot {
        mldsa_seed,
        owner_pq,
        lease_seed,
    })
}

/// Resolve the boot facts the premount reads.
pub fn plan(o: &Options) -> Result<Plan, String> {
    let dir = &o.boot_dir;
    let mut notes = Vec::new();
    let domain = cat(&dir.join("server-domain")).ok_or("cannot read server-domain")?;
    let server_domain = String::from_utf8(domain).map_err(|_| "server-domain is not UTF-8")?;
    crate::canonical::check_server_domain(&server_domain).map_err(|e| e.to_string())?;

    let pem_path = dir.join("flagship-boot-key.pem");
    let pem = zeroize::Zeroizing::new(
        std::fs::read(&pem_path).map_err(|_| format!("missing {}", pem_path.display()))?,
    );
    let identity = BoxIdentity::from_pkcs8_pem(&pem).map_err(|e| e.to_string())?;

    let host = match &o.boot_host {
        Some(h) => h.clone(),
        None => cat(&dir.join("flagship-boot-host"))
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default(),
    };
    let host = host.strip_suffix('/').unwrap_or(&host).to_owned();
    let mut pol = EndpointPolicy {
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

    // Anything but exactly "auto" asks the phone: a damaged file must never
    // let an approve-only box unlock itself.
    let baseline = match o.mode {
        Some(m) => m,
        None => match cat(&dir.join("flagship-boot-unlock-mode")).as_deref() {
            Some(b"auto") => Mode::Auto,
            Some(b"approve") => Mode::Approve,
            _ => {
                notes.push(
                    "boot-unlock mode file unreadable or unknown; asking the phone".to_owned(),
                );
                Mode::Approve
            }
        },
    };
    let marker = o
        .lock_once_marker
        .clone()
        .unwrap_or_else(|| dir.join("flagship-lock-once"));
    let lock_once = marker.is_file();
    let mode = if lock_once { Mode::Approve } else { baseline };
    if lock_once {
        notes.push("one-shot lock marker present; asking the phone for THIS boot".into());
    }
    let label = |m: Mode| {
        if m == Mode::Approve {
            "approve"
        } else {
            "auto"
        }
    };
    notes.push(format!(
        "boot-unlock mode = {} (baseline={}, lock-once={})",
        label(mode),
        label(baseline),
        if lock_once { "yes" } else { "no" }
    ));

    let owner_pub = match &o.owner_key {
        Some(p) => read_owner_key(p),
        None => marker
            .parent()
            .map(|d| d.join("flagship-owner-key.pub"))
            .and_then(|p| read_owner_key(&p))
            .or_else(|| read_owner_key(&dir.join("flagship-owner-key.pub"))),
    };

    let pq = read_pq(dir, &mut notes);
    let policy = crate::v2::parse_unlock_policy(
        std::fs::read(dir.join("flagship-unlock-policy"))
            .ok()
            .as_deref(),
        pq.is_some(),
    );
    notes.push(format!(
        "unlock policy = {} (v2 material: {})",
        if policy == crate::v2::UnlockPolicy::Strict {
            "strict"
        } else {
            "compat"
        },
        if pq.is_some() { "yes" } else { "no" }
    ));

    let defaults = RelayTiming::default();
    let timing = RelayTiming {
        window_secs: o
            .relay_window_secs
            .or_else(|| env_secs("FLAGSHIP_RELAY_WINDOW_SECS"))
            .unwrap_or(defaults.window_secs),
        heartbeat_secs: o
            .heartbeat_secs
            .or_else(|| env_secs("FLAGSHIP_RELAY_HEARTBEAT_SECS"))
            .unwrap_or(defaults.heartbeat_secs),
        request_lifetime_secs: o
            .request_lifetime_secs
            .or_else(|| env_secs("FLAGSHIP_RELAY_REQUEST_SECS"))
            .unwrap_or(defaults.request_lifetime_secs),
    }
    .clamped();
    Ok(Plan {
        server_domain,
        identity,
        owner_pub,
        debug_burn: dir.join("flagship-debug-mode").is_file(),
        endpoint,
        mode,
        timing,
        notes,
        time_floor_ms: read_time_floor(&dir.join("flagship-time-floor")).unwrap_or(0),
        pq,
        policy,
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
        Some(c) if !p.debug_burn => {
            let _ = writeln!(
                log,
                "flagship: ignoring --console {} (not a debug burn)",
                c.display()
            );
            None
        }
        other => other.clone(),
    };
    let clock = match &console {
        Some(c) => system::SystemClock::with_console(c),
        None => system::SystemClock::new(),
    }
    .with_floor(p.time_floor_ms);
    let mut unlocker = Unlocker {
        server_domain: &p.server_domain,
        identity: &p.identity,
        owner_pub: p.owner_pub,
        endpoint: &p.endpoint,
        transport: &transport,
        clock: &clock,
        random: &OsRandom,
        timing: p.timing,
        console_hint: console.is_some(),
        log,
        pq: p.pq.as_ref(),
        policy: p.policy,
    };
    let key = match unlocker.unlock(p.mode) {
        Ok(k) => k,
        Err(flow::UnlockError::WindowElapsed(_)) => return EXIT_RESTART,
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
