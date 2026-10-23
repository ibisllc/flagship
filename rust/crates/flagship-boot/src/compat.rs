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
use std::io::{Read, Write};
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
    use std::os::unix::ffi::OsStrExt;
    let os = std::ffi::OsStr::from_bytes(path);
    let display = String::from_utf8_lossy(path).into_owned();
    let mut f =
        std::fs::File::open(os).map_err(|e| format!("open {display}: {}", go_errno_text(&e)))?;
    read_all(&mut f, &display)
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
    if v.bool("identity-stdin") && (response_json == b"-" || lease_json == b"-") {
        return Err("--identity-stdin cannot share stdin with a JSON input".into());
    }
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

    let secret = if !lease_json.is_empty() {
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
        let now = match v.str("now-ms") {
            b"" => clock_ms(),
            n => core::str::from_utf8(n)
                .ok()
                .and_then(|t| t.parse::<i64>().ok())
                .ok_or("--now-ms is not a number")?,
        };
        let body = if lease_json == b"-" {
            read_all(&mut (&mut *stdin).take(1 << 20), "/dev/stdin")
        } else {
            read_file(lease_json)
        }
        .map_err(|e| format!("reading lease JSON: {e}"))?;
        lease::open_auto_unlock_lease(&body, &seed, v.str("server-domain"), &owner, now)
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
        seal::open_sealed_secret_response_bytes(
            &sealed,
            seed.as_slice(),
            &r.request_nonce_hex,
            &r.purpose,
        )
        .map_err(|e| e.to_string())?
    } else if v.bool("response") {
        let sealed_hex = v.str("sealed-hex");
        if sealed_hex.is_empty() {
            return Err("--sealed-hex is required with --response".into());
        }
        if v.str("nonce-hex").is_empty() || v.str("purpose").is_empty() {
            return Err("--nonce-hex and --purpose are required with --response".into());
        }
        let sealed = decode_hex("sealed-hex", sealed_hex)?;
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
