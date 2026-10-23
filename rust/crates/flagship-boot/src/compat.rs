//! The v1 `flagship-unseal` command line, reproduced exactly: same flags,
//! stdin/stdout, exit codes (0 or 1) and stderr text as
//! `installer/unseal-helper/main.go`, so this binary can be swapped in at
//! `/boot/flagship-unseal` without touching the shell that calls it.

use crate::goflag::{self, FlagError, Kind, Spec};
use crate::gohex;
use crate::gojson;
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
        usage: "box Ed25519 identity (STK) seed, 32 bytes hex (64 chars)",
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

    let identity = v.str("identity-priv-hex");
    if identity.is_empty() {
        return Err("--identity-priv-hex is required".into());
    }
    let seed = Zeroizing::new(decode_hex("identity-priv-hex", identity)?);
    if seed.len() != 32 {
        return Err(format!(
            "--identity-priv-hex must be 32 bytes (64 hex chars), got {} bytes",
            seed.len()
        ));
    }

    let response_json = v.str("response-json");
    let secret = if !response_json.is_empty() {
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
        seal::open_sealed_secret_response_bytes(&sealed, &seed, &r.request_nonce_hex, &r.purpose)
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
            &seed,
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
        seal::open_sealed_from_ed25519_seed(&sealed, &seed).map_err(|e| e.to_string())?
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
