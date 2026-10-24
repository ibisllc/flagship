//! The v1 `flagship-unseal` command line, reproduced exactly: same flags,
//! stdin/stdout, exit codes (0 or 1) and stderr text as
//! `installer/unseal-helper/main.go`, so this binary can be swapped in at
//! `/boot/flagship-unseal` without touching the shell that calls it.

use crate::goflag::{self, FlagError, Kind, Spec};
use crate::gohex;
use crate::gojson;
use crate::identity;
use crate::lease;
use crate::seal;
use crate::v2::{self, UnlockPolicy};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use zeroize::Zeroizing;

/// The Go FlagSet's name; it prefixes every error line.
pub const PROGRAM: &str = "flagship-unseal";

/// The Go helper's flags, with its usage strings.
pub const SPECS: &[Spec] = &[
    Spec {
        name: "identity-priv-hex",
        kind: Kind::Str,
        usage: "box Ed25519 key seed, 32 bytes hex (tests only: it shows in the process list)",
    },
    Spec {
        name: "identity-pem",
        kind: Kind::Str,
        usage: "path to the box's Ed25519 PKCS#8 PEM key",
    },
    Spec {
        name: "identity-stdin",
        kind: Kind::Bool,
        usage: "read the box's Ed25519 key seed (64 hex chars) from stdin",
    },
    Spec {
        name: "sealed-hex",
        kind: Kind::Str,
        usage: "the sealed blob, hex",
    },
    Spec {
        name: "response",
        kind: Kind::Bool,
        usage: "treat --sealed-hex as a SealedSecretResponse and verify the bound (nonce, purpose)",
    },
    Spec {
        name: "nonce-hex",
        kind: Kind::Str,
        usage: "the request nonce (hex) the box sent; required with --response",
    },
    Spec {
        name: "purpose",
        kind: Kind::Str,
        usage: "the request purpose the box sent (e.g. unlock-key); required with --response",
    },
    Spec {
        name: "response-json",
        kind: Kind::Str,
        usage: "path to a SealedSecretResponse JSON ('-' for stdin); implies --response",
    },
    Spec {
        name: "lease-json",
        kind: Kind::Str,
        usage: "path to an auto-unlock lease JSON ('-' for stdin); checked before it is opened",
    },
    Spec {
        name: "server-domain",
        kind: Kind::Str,
        usage: "this box's FQDN; required with --lease-json",
    },
    Spec {
        name: "owner-pub-hex",
        kind: Kind::Str,
        usage: "the owner key the lease must be signed by, 32 bytes hex; required with --lease-json",
    },
    Spec {
        name: "now-ms",
        kind: Kind::Str,
        usage: "the time to check lease expiry against, epoch ms (default: the clock)",
    },
    Spec {
        name: "raw",
        kind: Kind::Bool,
        usage: "write the raw secret bytes to stdout instead of hex",
    },
    Spec {
        name: "time-floor-file",
        kind: Kind::Str,
        usage: "the daemon's last authenticated time (epoch ms); the clock is never read earlier than it",
    },
    Spec {
        name: "unlock-policy-file",
        kind: Kind::Str,
        usage: "the box's unlock policy file (strict refuses a classical v1 reply or lease)",
    },
    Spec {
        name: "owner-pq-pub-file",
        kind: Kind::Str,
        usage: "the owner's hybrid key (Ed25519 || ML-DSA-65, hex) v2 replies and v3 leases must be signed by",
    },
    Spec {
        name: "reply-kem-key",
        kind: Kind::Str,
        usage: "the per-boot reply key seed (hex) a v2 reply is sealed to",
    },
    Spec {
        name: "lease-kem-key",
        kind: Kind::Str,
        usage: "the lease key seed (hex) a v3 lease is sealed to ('-' for stdin)",
    },
    Spec {
        name: "boot-pq-key",
        kind: Kind::Str,
        usage: "the boot key's ML-DSA-65 seed (hex); required with --v2-request",
    },
    Spec {
        name: "v2-request",
        kind: Kind::Bool,
        usage: "print a hybrid-signed v2 unlock request body and write a fresh reply key to --reply-kem-out",
    },
    Spec {
        name: "reply-kem-out",
        kind: Kind::Str,
        usage: "where --v2-request writes the per-boot reply key seed (created, mode 0600)",
    },
];

fn decode_hex(name: &str, s: &[u8]) -> Result<Vec<u8>, String> {
    gohex::decode(gohex::trim_space(s)).map_err(|e| format!("--{name} is not valid hex: {e}"))
}

/// Go's text for an OS error (`syscall.Errno.Error()`), for the common cases.
fn go_errno_text(e: &std::io::Error) -> String {
    let go = match e.raw_os_error() {
        Some(1) => Some("operation not permitted"),
        Some(2) => Some("no such file or directory"),
        Some(5) => Some("input/output error"),
        Some(6) => Some("no such device or address"),
        Some(12) => Some("cannot allocate memory"),
        Some(13) => Some("permission denied"),
        Some(20) => Some("not a directory"),
        Some(21) => Some("is a directory"),
        Some(17) => Some("file exists"),
        Some(24) => Some("too many open files"),
        _ => None,
    };
    if let Some(t) = go {
        return t.to_owned();
    }
    let s = e.to_string();
    let s = s.split(" (os error").next().unwrap_or_default();
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().chain(c).collect(),
        None => String::new(),
    }
}

fn clock_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(i64::MAX)
}

fn read_all(r: &mut dyn Read, display: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut buf = Zeroizing::new(Vec::new());
    r.read_to_end(&mut buf)
        .map_err(|e| format!("read {display}: {}", go_errno_text(&e)))?;
    Ok(buf)
}

fn read_file(path: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    let os = std::ffi::OsStr::from_bytes(path);
    let display = String::from_utf8_lossy(path).into_owned();
    let mut f =
        std::fs::File::open(os).map_err(|e| format!("open {display}: {}", go_errno_text(&e)))?;
    read_all(&mut f, &display)
}

fn read_file_raw(path: &[u8]) -> std::io::Result<Zeroizing<Vec<u8>>> {
    std::fs::read(std::ffi::OsStr::from_bytes(path)).map(Zeroizing::new)
}

/// The Go helper's `readSeedFile`: a 32-byte seed as hex (one trailing newline), or stdin for `-`.
fn read_seed_file(
    name: &str,
    path: &[u8],
    stdin: &mut dyn Read,
) -> Result<Zeroizing<[u8; 32]>, String> {
    let b = if path == b"-" {
        read_all(&mut (&mut *stdin).take(256), "/dev/stdin")
    } else {
        read_file(path)
    }
    .map_err(|e| format!("reading --{name}: {e}"))?;
    let s = Zeroizing::new(decode_hex(name, &b)?);
    <[u8; 32]>::try_from(s.as_slice())
        .map(Zeroizing::new)
        .map_err(|_| format!("--{name} must hold a 32-byte seed as hex"))
}

fn write_new_0600(path: &[u8], seed: &[u8; 32]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let display = String::from_utf8_lossy(path).into_owned();
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(std::ffi::OsStr::from_bytes(path))
        .map_err(|e| format!("open {display}: {}", go_errno_text(&e)))?;
    let mut line = Zeroizing::new(crate::gohex::encode(seed));
    line.push('\n');
    f.write_all(line.as_bytes())
        .map_err(|e| format!("write {display}: {}", go_errno_text(&e)))
}

fn run_inner(
    args: &[Vec<u8>],
    stdin: &mut dyn Read,
    stdout: &mut dyn Write,
    diag: &mut String,
) -> Result<(), String> {
    let v = goflag::parse(PROGRAM, SPECS, args, diag).map_err(|e| match e {
        FlagError::Help => "flag: help requested".to_owned(),
        FlagError::Failed(m) => m,
    })?;

    let sources = [
        !v.str("identity-priv-hex").is_empty(),
        !v.str("identity-pem").is_empty(),
        v.bool("identity-stdin"),
    ]
    .iter()
    .filter(|&&set| set)
    .count();
    if sources != 1 {
        return Err(
            "give exactly one of --identity-pem, --identity-stdin or --identity-priv-hex".into(),
        );
    }
    let response_json = v.str("response-json");
    let lease_json = v.str("lease-json");
    let lease_kem = v.str("lease-kem-key");
    if v.bool("identity-stdin")
        && (response_json == b"-" || lease_json == b"-" || lease_kem == b"-")
    {
        return Err("--identity-stdin cannot share stdin with a JSON input".into());
    }
    if lease_kem == b"-" && (response_json == b"-" || lease_json == b"-") {
        return Err("--lease-kem-key - cannot share stdin with a JSON input".into());
    }
    let mut now = match v.str("now-ms") {
        b"" => clock_ms(),
        n => core::str::from_utf8(n)
            .ok()
            .and_then(|t| t.parse::<i64>().ok())
            .ok_or("--now-ms is not a number")?,
    };
    if !v.str("time-floor-file").is_empty() {
        let p = std::path::Path::new(std::ffi::OsStr::from_bytes(v.str("time-floor-file")));
        if let Some(f) = crate::unlock::read_time_floor(p).and_then(|f| i64::try_from(f).ok()) {
            now = now.max(f);
        }
    }
    let owner_pq: Option<Vec<u8>> = match v.str("owner-pq-pub-file") {
        b"" => None,
        path => match read_file_raw(path) {
            Ok(b) => {
                let pq = decode_hex("owner-pq-pub-file", &b)
                    .ok()
                    .filter(|k| k.len() == v2::HYBRID_PK_LEN);
                Some(pq.ok_or_else(|| {
                    format!(
                        "--owner-pq-pub-file must hold the owner's {}-byte hybrid key as hex",
                        v2::HYBRID_PK_LEN
                    )
                })?)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                return Err(format!(
                    "reading owner hybrid key: open {}: {}",
                    String::from_utf8_lossy(path),
                    go_errno_text(&e)
                ));
            }
        },
    };
    let policy = match v.str("unlock-policy-file") {
        b"" => UnlockPolicy::Compat,
        path => v2::parse_unlock_policy(
            read_file_raw(path).ok().as_ref().map(|b| b.as_slice()),
            owner_pq.is_some(),
        ),
    };
    let seed: Zeroizing<Vec<u8>> = if !v.str("identity-pem").is_empty() {
        let path = v.str("identity-pem");
        let pem = read_file(path)
            .map_err(|e| format!("reading identity key {}: {e}", goflag::go_quote(path)))?;
        let seed = identity::seed_from_pkcs8_pem_go(&pem).map_err(|e| e.to_string())?;
        Zeroizing::new(seed.to_vec())
    } else if v.bool("identity-stdin") {
        let b = read_all(&mut (&mut *stdin).take(256), "/dev/stdin")
            .map_err(|e| format!("reading identity seed from stdin: {e}"))?;
        Zeroizing::new(decode_hex("identity-stdin", &b)?)
    } else {
        Zeroizing::new(decode_hex("identity-priv-hex", v.str("identity-priv-hex"))?)
    };
    let seed: Zeroizing<[u8; 32]> = match <[u8; 32]>::try_from(seed.as_slice()) {
        Ok(s) => Zeroizing::new(s),
        Err(_) => {
            return Err(format!(
                "the identity seed must be 32 bytes (64 hex chars), got {} bytes",
                seed.len()
            ));
        }
    };

    let secret = if v.bool("v2-request") {
        if v.str("server-domain").is_empty()
            || v.str("nonce-hex").is_empty()
            || v.str("boot-pq-key").is_empty()
            || v.str("reply-kem-out").is_empty()
        {
            return Err("--server-domain, --nonce-hex, --boot-pq-key and --reply-kem-out are required with --v2-request".into());
        }
        let ml = read_seed_file("boot-pq-key", v.str("boot-pq-key"), stdin)?;
        let mut reply = Zeroizing::new([0u8; 32]);
        getrandom::fill(reply.as_mut())
            .map_err(|e| format!("no randomness for the reply key: {e}"))?;
        let body = v2::sign_request_v2(
            &seed,
            &ml,
            &String::from_utf8_lossy(v.str("server-domain")),
            &String::from_utf8_lossy(v.str("nonce-hex")),
            now,
            &reply,
            false,
        )
        .map_err(|e| e.to_string())?;
        write_new_0600(v.str("reply-kem-out"), &reply)
            .map_err(|e| format!("writing the reply key: {e}"))?;
        return writeln!(stdout, "{body}")
            .and_then(|()| stdout.flush())
            .map_err(|e| format!("write /dev/stdout: {}", go_errno_text(&e)));
    } else if !lease_json.is_empty() {
        if v.str("server-domain").is_empty() || v.str("owner-pub-hex").is_empty() {
            return Err(
                "--server-domain and --owner-pub-hex are required with --lease-json".into(),
            );
        }
        let owner = decode_hex("owner-pub-hex", v.str("owner-pub-hex"))?;
        if owner.len() != 32 {
            return Err(format!(
                "--owner-pub-hex must be 32 bytes (64 hex chars), got {} bytes",
                owner.len()
            ));
        }
        let body = if lease_json == b"-" {
            read_all(&mut (&mut *stdin).take(1 << 20), "/dev/stdin")
        } else {
            read_file(lease_json)
        }
        .map_err(|e| format!("reading lease JSON: {e}"))?;
        let lease_seed = match lease_kem {
            b"" => None,
            p => Some(read_seed_file("lease-kem-key", p, stdin)?),
        };
        let _ = lease::TAG_AUTO_UNLOCK_LEASE_V2;
        v2::open_auto_unlock_lease_any(
            &body,
            &seed,
            v.str("server-domain"),
            &owner,
            owner_pq.as_deref(),
            lease_seed.as_deref(),
            policy,
            now,
        )
        .map_err(|e| e.to_string())?
    } else if !response_json.is_empty() {
        let blob = if response_json == b"-" {
            read_all(stdin, "/dev/stdin")
                .map_err(|e| format!("reading response JSON from stdin: {e}"))?
        } else {
            read_file(response_json).map_err(|e| {
                format!(
                    "reading response JSON {}: {e}",
                    goflag::go_quote(response_json)
                )
            })?
        };
        let r = gojson::unmarshal_response(&blob)
            .map_err(|e| format!("parsing SealedSecretResponse JSON: {e}"))?;
        let sealed = decode_hex("sealedHex", &r.sealed_hex)?;
        v2::box_accepts(policy, &sealed).map_err(|e| e.to_string())?;
        if v2::is_v2_sealed(&sealed) {
            let (Some(pq), false, false, true) = (
                owner_pq.as_deref(),
                v.str("reply-kem-key").is_empty(),
                v.str("server-domain").is_empty(),
                r.purpose.as_slice() == b"unlock-key",
            ) else {
                return Err("a v2 reply needs --reply-kem-key, --owner-pq-pub-file and --server-domain, for unlock-key only".into());
            };
            let k = read_seed_file("reply-kem-key", v.str("reply-kem-key"), stdin)?;
            let boot = crate::gohex::encode(
                ed25519_dalek::SigningKey::from_bytes(&seed)
                    .verifying_key()
                    .as_bytes(),
            );
            let key = v2::open_boot_reply_v2(
                &sealed,
                &String::from_utf8_lossy(v.str("server-domain")),
                &boot,
                &String::from_utf8_lossy(&r.request_nonce_hex),
                &k,
                pq,
            )
            .map_err(|e| e.to_string())?;
            let p = std::ffi::OsStr::from_bytes(v.str("reply-kem-key"));
            let _ = std::fs::write(p, [0u8; 65]);
            let _ = std::fs::remove_file(p);
            key
        } else {
            seal::open_sealed_secret_response_bytes(
                &sealed,
                seed.as_slice(),
                &r.request_nonce_hex,
                &r.purpose,
            )
            .map_err(|e| e.to_string())?
        }
    } else if v.bool("response") {
        let sealed_hex = v.str("sealed-hex");
        if sealed_hex.is_empty() {
            return Err("--sealed-hex is required with --response".into());
        }
        if v.str("nonce-hex").is_empty() || v.str("purpose").is_empty() {
            return Err("--nonce-hex and --purpose are required with --response".into());
        }
        let sealed = decode_hex("sealed-hex", sealed_hex)?;
        v2::box_accepts(policy, &sealed).map_err(|e| e.to_string())?;
        seal::open_sealed_secret_response_bytes(
            &sealed,
            seed.as_slice(),
            v.str("nonce-hex"),
            v.str("purpose"),
        )
        .map_err(|e| e.to_string())?
    } else {
        let sealed_hex = v.str("sealed-hex");
        if sealed_hex.is_empty() {
            return Err("--sealed-hex is required (or use --response-json)".into());
        }
        let sealed = decode_hex("sealed-hex", sealed_hex)?;
        v2::box_accepts(policy, &sealed).map_err(|e| e.to_string())?;
        seal::open_sealed_from_ed25519_seed(&sealed, seed.as_slice()).map_err(|e| e.to_string())?
    };

    let written = if v.bool("raw") {
        stdout.write_all(&secret)
    } else {
        let mut line = Zeroizing::new(gohex::encode(&secret));
        line.push('\n');
        stdout.write_all(line.as_bytes())
    };
    written
        .and_then(|()| stdout.flush())
        .map_err(|e| format!("write /dev/stdout: {}", go_errno_text(&e)))
}

/// Run the Go helper's `main`: returns the exit code; stderr gets exactly
/// what the Go binary would print.
pub fn run(
    args: &[Vec<u8>],
    stdin: &mut dyn Read,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let mut diag = String::new();
    let result = run_inner(args, stdin, stdout, &mut diag);
    let _ = stderr.write_all(diag.as_bytes());
    match result {
        Ok(()) => 0,
        Err(msg) => {
            let _ = writeln!(stderr, "{PROGRAM}: {msg}");
            1
        }
    }
}
