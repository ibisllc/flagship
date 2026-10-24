//! Differential test against the Go helper itself: build
//! installer/unseal-helper (unmodified) and run the same argv, stdin and files
//! through both binaries, comparing exit code, stdout and stderr byte for
//! byte. Skipped when Go is not installed, unless FLAGSHIP_REQUIRE_GO=1.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic,
    clippy::print_stdout
)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const VECTORS: &str =
    include_str!("../../../../packages/protocol/test-vectors/boot-unseal/vectors.json");
const BOOT_KEY_VECTORS: &str =
    include_str!("../../../../packages/protocol/test-vectors/boot-key/vectors.json");

fn find_go() -> Option<PathBuf> {
    [
        "go",
        "/opt/homebrew/bin/go",
        "/usr/local/go/bin/go",
        "/usr/local/bin/go",
        "/usr/bin/go",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|g| {
        Command::new(g)
            .arg("version")
            .output()
            .is_ok_and(|o| o.status.success())
    })
}

fn build_go(dir: &Path) -> Option<PathBuf> {
    let Some(go) = find_go() else {
        assert!(
            std::env::var("FLAGSHIP_REQUIRE_GO").as_deref() != Ok("1"),
            "Go is required (FLAGSHIP_REQUIRE_GO=1)"
        );
        println!("go not found: skipping the Go differential test");
        return None;
    };
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../installer/unseal-helper");
    let out = dir.join("flagship-unseal-go");
    let st = Command::new(go)
        .args(["build", "-mod=readonly", "-trimpath", "-o"])
        .arg(&out)
        .arg(".")
        .current_dir(src)
        .env("CGO_ENABLED", "0")
        .status()
        .unwrap();
    assert!(st.success(), "go build failed");
    Some(out)
}

#[derive(Debug, PartialEq, Eq)]
struct Outcome {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

fn run(bin: &Path, args: &[Vec<u8>], stdin: &[u8], cwd: &Path) -> Outcome {
    use std::os::unix::ffi::OsStrExt;
    let mut child = Command::new(bin)
        .args(args.iter().map(|a| std::ffi::OsStr::from_bytes(a)))
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let _ = child.stdin.take().unwrap().write_all(stdin);
    let o = child.wait_with_output().unwrap();
    Outcome {
        code: o.status.code(),
        stdout: o.stdout,
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
    }
}

struct Case {
    name: String,
    args: Vec<Vec<u8>>,
    stdin: Vec<u8>,
    same_stderr: bool,
}

fn case(name: &str, args: &[&str]) -> Case {
    Case {
        name: name.into(),
        args: args.iter().map(|a| a.as_bytes().to_vec()).collect(),
        stdin: Vec::new(),
        same_stderr: true,
    }
}

fn stdin_case(name: &str, args: &[&str], stdin: &[u8], same_stderr: bool) -> Case {
    Case {
        stdin: stdin.to_vec(),
        same_stderr,
        ..case(name, args)
    }
}

fn corpus(dir: &Path) -> Vec<Case> {
    let v: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
    let mut cases = Vec::new();
    let a_seed = v["boxes"]["A"]["seedHex"].as_str().unwrap().to_owned();
    let mut lease_hex = String::new();
    let mut resp = (String::new(), String::new());
    for c in v["unseal"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let id = c["identityPrivHex"].as_str().unwrap();
        let sealed = c["sealedHex"].as_str().unwrap();
        if name == "lease-ok" {
            lease_hex = sealed.to_owned();
        }
        if c["kind"] == "raw" {
            cases.push(case(
                name,
                &["--identity-priv-hex", id, "--sealed-hex", sealed],
            ));
            cases.push(case(
                &format!("{name} raw"),
                &["-identity-priv-hex", id, "-sealed-hex", sealed, "-raw"],
            ));
        } else {
            let (n, p) = (
                c["nonceHex"].as_str().unwrap(),
                c["purpose"].as_str().unwrap(),
            );
            if name == "response-ok" {
                resp = (sealed.to_owned(), n.to_owned());
            }
            cases.push(case(
                name,
                &[
                    "--identity-priv-hex",
                    id,
                    "--sealed-hex",
                    sealed,
                    "--response",
                    "--nonce-hex",
                    n,
                    "--purpose",
                    p,
                ],
            ));
            let json = format!(
                "{{\"serverDomain\":\"home.alice.flagship.services\",\"requestNonceHex\":\"{n}\",\"purpose\":\"{p}\",\"sealedHex\":\"{sealed}\",\"issuedAt\":0}}"
            );
            cases.push(stdin_case(
                &format!("{name} json stdin"),
                &["--identity-priv-hex", id, "--response-json", "-"],
                json.as_bytes(),
                true,
            ));
            let file = dir.join(format!("{name}.json"));
            std::fs::write(&file, &json).unwrap();
            cases.push(case(
                &format!("{name} json file"),
                &[
                    "--identity-priv-hex",
                    id,
                    "--response-json",
                    file.to_str().unwrap(),
                ],
            ));
        }
    }
    let s = a_seed.as_str();
    let l = lease_hex.as_str();
    let (rs, rn) = (resp.0.as_str(), resp.1.as_str());
    let upper = s.to_ascii_uppercase();
    let padded = format!(" \t{s}\n");
    let cli_cases: Vec<(&str, Vec<&str>)> = vec![
        ("no args", vec![]),
        ("missing identity", vec!["--sealed-hex", l]),
        (
            "empty identity",
            vec!["--identity-priv-hex", "", "--sealed-hex", l],
        ),
        (
            "bad identity hex",
            vec!["--identity-priv-hex", "zz", "--sealed-hex", l],
        ),
        (
            "odd identity hex",
            vec!["--identity-priv-hex", "abc", "--sealed-hex", l],
        ),
        (
            "non-ascii identity",
            vec!["--identity-priv-hex", "é0", "--sealed-hex", l],
        ),
        (
            "short identity",
            vec!["--identity-priv-hex", "abcd", "--sealed-hex", l],
        ),
        (
            "upper-case identity",
            vec!["--identity-priv-hex", &upper, "--sealed-hex", l],
        ),
        (
            "whitespace identity",
            vec!["--identity-priv-hex", &padded, "--sealed-hex", l],
        ),
        (
            "equals form",
            vec!["--identity-priv-hex=x", "--sealed-hex", l],
        ),
        ("missing sealed", vec!["--identity-priv-hex", s]),
        (
            "bad sealed hex",
            vec!["--identity-priv-hex", s, "--sealed-hex", "0g"],
        ),
        (
            "odd sealed hex",
            vec!["--identity-priv-hex", s, "--sealed-hex", "000"],
        ),
        (
            "response no nonce",
            vec![
                "--identity-priv-hex",
                s,
                "--sealed-hex",
                rs,
                "--response",
                "--purpose",
                "unlock-key",
            ],
        ),
        (
            "response no sealed",
            vec![
                "--identity-priv-hex",
                s,
                "--response",
                "--nonce-hex",
                rn,
                "--purpose",
                "unlock-key",
            ],
        ),
        (
            "response bad nonce text",
            vec![
                "--identity-priv-hex",
                s,
                "--sealed-hex",
                rs,
                "--response",
                "--nonce-hex",
                "zz",
                "--purpose",
                "unlock-key",
            ],
        ),
        (
            "response=false treats as raw",
            vec![
                "--identity-priv-hex",
                s,
                "--sealed-hex",
                rs,
                "--response=false",
            ],
        ),
        (
            "response=1",
            vec![
                "--identity-priv-hex",
                s,
                "--sealed-hex",
                rs,
                "--response=1",
                "--nonce-hex",
                rn,
                "--purpose",
                "unlock-key",
            ],
        ),
        (
            "raw=t",
            vec!["--identity-priv-hex", s, "--sealed-hex", l, "--raw=t"],
        ),
        (
            "bad bool",
            vec!["--identity-priv-hex", s, "--sealed-hex", l, "--raw=yes"],
        ),
        (
            "unknown flag",
            vec!["--identity-priv-hex", s, "--sealed-hex", l, "--bogus"],
        ),
        ("help", vec!["--help"]),
        ("h", vec!["-h"]),
        ("h with value", vec!["-h=1"]),
        ("needs argument", vec!["--identity-priv-hex"]),
        ("bad syntax", vec!["---identity-priv-hex", s]),
        ("equals first", vec!["-=x"]),
        (
            "terminator",
            vec!["--identity-priv-hex", s, "--", "--sealed-hex", l],
        ),
        (
            "positional stops parsing",
            vec!["--identity-priv-hex", s, "extra", "--sealed-hex", l],
        ),
        (
            "single dash value",
            vec!["--identity-priv-hex", s, "--sealed-hex", "-"],
        ),
        (
            "last wins",
            vec![
                "--identity-priv-hex",
                "00",
                "--identity-priv-hex",
                s,
                "--sealed-hex",
                "00",
                "--sealed-hex",
                l,
            ],
        ),
        (
            "json wins over sealed",
            vec![
                "--identity-priv-hex",
                s,
                "--sealed-hex",
                l,
                "--response-json",
                "/nonexistent/x.json",
            ],
        ),
        (
            "json directory",
            vec!["--identity-priv-hex", s, "--response-json", "/"],
        ),
    ];
    for (n, a) in cli_cases {
        cases.push(case(n, &a));
    }
    let json = |body: &str| body.replace("SEALED", rs).replace("NONCE", rn);
    let json_cases: Vec<(&str, String, bool)> = vec![
        ("json null", "null".into(), true),
        ("json array", "[]".into(), true),
        ("json string", "\"x\"".into(), true),
        ("json number", "12".into(), true),
        ("json empty object", "{}".into(), true),
        (
            "json case-insensitive keys",
            json(r#"{"REQUESTNONCEHEX":"NONCE","Purpose":"unlock-key","sealedhex":"SEALED"}"#),
            true,
        ),
        (
            "json duplicate keys, last wins",
            json(
                r#"{"requestNonceHex":"00","requestNonceHex":"NONCE","purpose":"unlock-key","sealedHex":"SEALED","purpose":null}"#,
            ),
            true,
        ),
        (
            "json long-s and kelvin fold",
            json(r#"{"requestNonceHex":"NONCE","purpose":"unlock-key","ſealedHex":"SEALED"}"#),
            true,
        ),
        (
            "json unknown nested keys",
            json(
                r#"{"x":[1,{"y":[true,null,1e400]}],"requestNonceHex":"NONCE","purpose":"unlock-key","sealedHex":"SEALED"}"#,
            ),
            true,
        ),
        (
            "json issuedAt float",
            json(
                r#"{"requestNonceHex":"NONCE","purpose":"unlock-key","sealedHex":"SEALED","issuedAt":1.5}"#,
            ),
            true,
        ),
        (
            "json issuedAt string",
            json(
                r#"{"requestNonceHex":"NONCE","purpose":"unlock-key","sealedHex":"SEALED","issuedAt":"1"}"#,
            ),
            true,
        ),
        (
            "json issuedAt overflow",
            json(
                r#"{"requestNonceHex":"NONCE","purpose":"unlock-key","sealedHex":"SEALED","issuedAt":9223372036854775808}"#,
            ),
            true,
        ),
        (
            "json issuedAt negative zero",
            json(
                r#"{"requestNonceHex":"NONCE","purpose":"unlock-key","sealedHex":"SEALED","issuedAt":-0}"#,
            ),
            true,
        ),
        (
            "json purpose number",
            json(r#"{"requestNonceHex":"NONCE","purpose":7,"sealedHex":"SEALED"}"#),
            true,
        ),
        (
            "json purpose object",
            json(r#"{"requestNonceHex":"NONCE","purpose":{},"sealedHex":"SEALED"}"#),
            true,
        ),
        (
            "json two type errors, first reported",
            json(r#"{"purpose":[],"issuedAt":true}"#),
            true,
        ),
        (
            "json lone surrogate in an unused field",
            json(
                r#"{"serverDomain":"\ud800","requestNonceHex":"NONCE","purpose":"unlock-key","sealedHex":"SEALED"}"#,
            ),
            true,
        ),
        (
            "json escaped purpose",
            json(r#"{"requestNonceHex":"NONCE","purpose":"unlock-key","sealedHex":"SEALED"}"#),
            true,
        ),
        (
            "json sealed with spaces",
            json(r#"{"requestNonceHex":"NONCE","purpose":"unlock-key","sealedHex":"  SEALED\n"}"#),
            true,
        ),
        (
            "json sealed bad hex",
            json(r#"{"requestNonceHex":"NONCE","purpose":"unlock-key","sealedHex":"zz"}"#),
            true,
        ),
        (
            "json whitespace around",
            json(
                " \n{\"requestNonceHex\":\"NONCE\",\"purpose\":\"unlock-key\",\"sealedHex\":\"SEALED\"}\r\n\t",
            ),
            true,
        ),
        ("json truncated", "{\"purpose\":".into(), true),
        ("json empty input", String::new(), true),
        ("json trailing garbage", "{} x".into(), false),
        ("json bad token", "{\"a\":tru}".into(), false),
    ];
    for (n, body, same) in json_cases {
        cases.push(stdin_case(
            n,
            &["--identity-priv-hex", s, "--response-json", "-"],
            body.as_bytes(),
            same,
        ));
    }
    let mut bad_utf8 = json(r#"{"requestNonceHex":"NONCE","purpose":"unlock-key","sealedHex":"SEALED","serverDomain":"X"}"#).into_bytes();
    let at = bad_utf8.iter().rposition(|&b| b == b'X').unwrap();
    bad_utf8.splice(at..=at, [0xff, 0xe2, 0x82]);
    cases.push(stdin_case(
        "json invalid utf-8 in an unused field",
        &["--identity-priv-hex", s, "--response-json", "-"],
        &bad_utf8,
        true,
    ));
    cases.extend(identity_and_lease_cases(dir, s, l));
    cases
}

fn pem(der: &[u8]) -> String {
    use base64ct::{Base64, Encoding};
    format!(
        "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
        Base64::encode_string(der)
    )
}

fn write(dir: &Path, name: &str, body: &[u8]) -> String {
    let p = dir.join(name);
    std::fs::write(&p, body).unwrap();
    p.to_str().unwrap().to_owned()
}

/// --identity-pem, --identity-stdin, the one-source rule, and --lease-json
/// through every boot-key lease vector plus the decoder's edge cases.
fn identity_and_lease_cases(dir: &Path, a_seed: &str, lease_hex: &str) -> Vec<Case> {
    const V1: [u8; 16] = [
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    let mut der = V1.to_vec();
    der.extend_from_slice(&flagship_boot::gohex::decode(a_seed.as_bytes()).unwrap());
    let good = write(dir, "a.pem", pem(&der).as_bytes());
    let crlf = write(
        dir,
        "a-crlf.pem",
        format!("junk\r\n{}", pem(&der).replace('\n', "\r\n\t ")).as_bytes(),
    );
    let mut v2 = der.clone();
    v2[1] = 0x51;
    v2[4] = 0x01;
    let v2 = write(dir, "v2.pem", pem(&v2).as_bytes());
    let short = write(dir, "short.pem", pem(&der[..47]).as_bytes());
    let not_pem = write(dir, "not.pem", b"hello");
    let reversed = write(
        dir,
        "reversed.pem",
        b"-----END PRIVATE KEY-----\n-----BEGIN PRIVATE KEY-----\n",
    );
    let bad_b64 = write(
        dir,
        "bad64.pem",
        b"-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----\n",
    );
    let l = lease_hex;
    let id_cases: Vec<(&str, Vec<&str>, &[u8])> = vec![
        (
            "pem file",
            vec!["--identity-pem", &good, "--sealed-hex", l],
            b"",
        ),
        (
            "pem crlf and junk",
            vec!["--identity-pem", &crlf, "--sealed-hex", l],
            b"",
        ),
        (
            "pem v2 refused",
            vec!["--identity-pem", &v2, "--sealed-hex", l],
            b"",
        ),
        (
            "pem short",
            vec!["--identity-pem", &short, "--sealed-hex", l],
            b"",
        ),
        (
            "pem not pem",
            vec!["--identity-pem", &not_pem, "--sealed-hex", l],
            b"",
        ),
        (
            "pem end before begin",
            vec!["--identity-pem", &reversed, "--sealed-hex", l],
            b"",
        ),
        (
            "pem bad base64",
            vec!["--identity-pem", &bad_b64, "--sealed-hex", l],
            b"",
        ),
        (
            "pem missing file",
            vec!["--identity-pem", "/nonexistent/k.pem", "--sealed-hex", l],
            b"",
        ),
        (
            "pem directory",
            vec!["--identity-pem", "/", "--sealed-hex", l],
            b"",
        ),
        (
            "stdin seed",
            vec!["--identity-stdin", "--sealed-hex", l],
            a_seed.as_bytes(),
        ),
        (
            "stdin seed newline",
            vec!["--identity-stdin", "--sealed-hex", l, "--raw"],
            format!(" {a_seed}\n").as_bytes().to_vec().leak(),
        ),
        (
            "stdin seed bad hex",
            vec!["--identity-stdin", "--sealed-hex", l],
            b"xyz",
        ),
        (
            "stdin seed short",
            vec!["--identity-stdin", "--sealed-hex", l],
            b"abcd",
        ),
        (
            "stdin seed empty",
            vec!["--identity-stdin", "--sealed-hex", l],
            b"",
        ),
        (
            "stdin seed over the limit",
            vec!["--identity-stdin", "--sealed-hex", l],
            "0".repeat(300).into_bytes().leak(),
        ),
        (
            "stdin=false is no source",
            vec!["--identity-stdin=false", "--sealed-hex", l],
            b"",
        ),
        (
            "two sources",
            vec![
                "--identity-pem",
                &good,
                "--identity-stdin",
                "--sealed-hex",
                l,
            ],
            a_seed.as_bytes(),
        ),
        (
            "hex and pem",
            vec![
                "--identity-priv-hex",
                a_seed,
                "--identity-pem",
                &good,
                "--sealed-hex",
                l,
            ],
            b"",
        ),
        (
            "three sources",
            vec![
                "--identity-priv-hex",
                a_seed,
                "--identity-pem",
                &good,
                "--identity-stdin",
            ],
            b"",
        ),
        (
            "shared stdin response",
            vec!["--identity-stdin", "--response-json", "-"],
            a_seed.as_bytes(),
        ),
        (
            "shared stdin lease",
            vec![
                "--identity-stdin",
                "--lease-json",
                "-",
                "--server-domain",
                "x",
                "--owner-pub-hex",
                "00",
            ],
            a_seed.as_bytes(),
        ),
    ];
    let mut cases: Vec<Case> = id_cases
        .into_iter()
        .map(|(n, a, input)| stdin_case(n, &a, input, true))
        .collect();

    let v: serde_json::Value = serde_json::from_str(BOOT_KEY_VECTORS).unwrap();
    let boot_seed = v["bootKeySeedHex"].as_str().unwrap().to_owned();
    let owner = v["ownerPubHex"].as_str().unwrap().to_owned();
    let domain = v["serverDomain"].as_str().unwrap().to_owned();
    let now = v["lease"]["now"].as_i64().unwrap().to_string();
    let mut valid = String::new();
    for c in v["lease"]["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let body = c["lease"].to_string();
        if name == "valid" {
            valid = body.clone();
        }
        let file = write(
            dir,
            &format!("lease-{}.json", name.replace(' ', "-")),
            body.as_bytes(),
        );
        let base = [
            "--identity-priv-hex",
            &boot_seed,
            "--server-domain",
            &domain,
            "--owner-pub-hex",
            &owner,
            "--now-ms",
            &now,
        ];
        let mut a = base.to_vec();
        a.extend(["--lease-json", &file]);
        cases.push(case(&format!("lease {name}"), &a));
        let mut a = base.to_vec();
        a.extend(["--lease-json", "-", "--raw"]);
        cases.push(stdin_case(
            &format!("lease {name} stdin raw"),
            &a,
            body.as_bytes(),
            true,
        ));
    }
    let valid_file = write(dir, "lease-valid-copy.json", valid.as_bytes());
    let vf = valid_file.as_str();
    let (bs, ow, dm, nw) = (
        boot_seed.as_str(),
        owner.as_str(),
        domain.as_str(),
        now.as_str(),
    );
    let upper_domain = dm.to_ascii_uppercase();
    let upper_owner = ow.to_ascii_uppercase();
    let lease_cli: Vec<(&str, Vec<&str>)> = vec![
        (
            "lease no server-domain",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                vf,
                "--owner-pub-hex",
                ow,
            ],
        ),
        (
            "lease no owner",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                vf,
                "--server-domain",
                dm,
            ],
        ),
        (
            "lease empty server-domain",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                vf,
                "--server-domain",
                "",
                "--owner-pub-hex",
                ow,
            ],
        ),
        (
            "lease bad owner hex",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                vf,
                "--server-domain",
                dm,
                "--owner-pub-hex",
                "zz",
            ],
        ),
        (
            "lease short owner",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                vf,
                "--server-domain",
                dm,
                "--owner-pub-hex",
                "abcd",
            ],
        ),
        (
            "lease upper-case owner",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                vf,
                "--server-domain",
                dm,
                "--owner-pub-hex",
                &upper_owner,
                "--now-ms",
                nw,
            ],
        ),
        (
            "lease upper-case domain",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                vf,
                "--server-domain",
                &upper_domain,
                "--owner-pub-hex",
                ow,
                "--now-ms",
                nw,
            ],
        ),
        (
            "lease bad now-ms",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                vf,
                "--server-domain",
                dm,
                "--owner-pub-hex",
                ow,
                "--now-ms",
                "soon",
            ],
        ),
        (
            "lease float now-ms",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                vf,
                "--server-domain",
                dm,
                "--owner-pub-hex",
                ow,
                "--now-ms",
                "1.5",
            ],
        ),
        (
            "lease plus now-ms",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                vf,
                "--server-domain",
                dm,
                "--owner-pub-hex",
                ow,
                "--now-ms",
                "+1760000060000",
            ],
        ),
        (
            "lease negative now-ms",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                vf,
                "--server-domain",
                dm,
                "--owner-pub-hex",
                ow,
                "--now-ms",
                "-5",
            ],
        ),
        (
            "lease at expiry",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                vf,
                "--server-domain",
                dm,
                "--owner-pub-hex",
                ow,
                "--now-ms",
                "1760604800000",
            ],
        ),
        (
            "lease by the clock",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                vf,
                "--server-domain",
                dm,
                "--owner-pub-hex",
                ow,
            ],
        ),
        (
            "lease missing file",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                "/nonexistent/l.json",
                "--server-domain",
                dm,
                "--owner-pub-hex",
                ow,
            ],
        ),
        (
            "lease directory",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                "/",
                "--server-domain",
                dm,
                "--owner-pub-hex",
                ow,
            ],
        ),
        (
            "lease wins over response-json",
            vec![
                "--identity-priv-hex",
                bs,
                "--lease-json",
                vf,
                "--response-json",
                "/nonexistent",
                "--server-domain",
                dm,
                "--owner-pub-hex",
                ow,
                "--now-ms",
                nw,
            ],
        ),
        (
            "lease other box key",
            vec![
                "--identity-priv-hex",
                a_seed,
                "--lease-json",
                vf,
                "--server-domain",
                dm,
                "--owner-pub-hex",
                ow,
                "--now-ms",
                nw,
            ],
        ),
        ("lease identity checked first", vec!["--lease-json", vf]),
    ];
    for (n, a) in lease_cli {
        cases.push(case(n, &a));
    }
    let lease: serde_json::Value = serde_json::from_str(&valid).unwrap();
    let field = |k: &str| lease[k].to_string();
    let edit = |f: &dyn Fn(&mut serde_json::Map<String, serde_json::Value>)| {
        let mut m = lease.as_object().unwrap().clone();
        f(&mut m);
        serde_json::Value::Object(m).to_string()
    };
    let json_bodies: Vec<(&str, String)> = vec![
        ("lease json null", "null".into()),
        ("lease json array", "[]".into()),
        ("lease json empty object", "{}".into()),
        ("lease json truncated", valid[..valid.len() - 1].to_owned()),
        ("lease json trailing garbage", format!("{valid} x")),
        ("lease json empty input", String::new()),
        (
            "lease json folded keys",
            valid
                .replace("\"serverDomain\"", "\"SERVERDOMAIN\"")
                .replace("\"sealedKey\"", "\"\u{17f}ealedKey\""),
        ),
        (
            "lease json later null unsets",
            format!("{},\"leaseId\":null}}", &valid[..valid.len() - 1]),
        ),
        (
            "lease json later duplicate wins",
            format!("{{\"signature\":\"00\",{}", &valid[1..]),
        ),
        (
            "lease json duplicate bad last",
            format!("{},\"stkPub\":\"00\"}}", &valid[..valid.len() - 1]),
        ),
        (
            "lease json maxUses string",
            edit(&|m| {
                m.insert("maxUses".into(), "3".into());
            }),
        ),
        (
            "lease json issuedAt float",
            edit(&|m| {
                m.insert("issuedAt".into(), serde_json::json!(1.5));
            }),
        ),
        (
            "lease json issuedAt overflow",
            valid.replace(&field("issuedAt"), "9223372036854775808"),
        ),
        (
            "lease json expiresAt string",
            edit(&|m| {
                m.insert("expiresAt".into(), "1".into());
            }),
        ),
        (
            "lease json leaseId number",
            edit(&|m| {
                m.insert("leaseId".into(), 7.into());
            }),
        ),
        (
            "lease json leaseId with pipe",
            edit(&|m| {
                m.insert("leaseId".into(), "a|b".into());
            }),
        ),
        (
            "lease json leaseId empty",
            edit(&|m| {
                m.insert("leaseId".into(), "".into());
            }),
        ),
        (
            "lease json domain with control",
            edit(&|m| {
                m.insert("serverDomain".into(), "a\u{1}b".into());
            }),
        ),
        (
            "lease json no issuedAt",
            edit(&|m| {
                m.remove("issuedAt");
            }),
        ),
        (
            "lease json no maxUses",
            edit(&|m| {
                m.remove("maxUses");
            }),
        ),
        (
            "lease json short stkPub",
            edit(&|m| {
                m.insert("stkPub".into(), "abcd".into());
            }),
        ),
        (
            "lease json odd sealedKey",
            edit(&|m| {
                m.insert("sealedKey".into(), "abc".into());
            }),
        ),
        (
            "lease json empty sealedKey",
            edit(&|m| {
                m.insert("sealedKey".into(), "".into());
            }),
        ),
        (
            "lease json upper-case hex",
            edit(&|m| {
                for k in ["stkPub", "sealedKey", "signature"] {
                    let up = m[k].as_str().unwrap().to_ascii_uppercase();
                    m.insert(k.into(), up.into());
                }
            }),
        ),
        (
            "lease json short sealedKey",
            edit(&|m| {
                m.insert("sealedKey".into(), "00".repeat(20).into());
            }),
        ),
        (
            "lease json unknown fields",
            edit(&|m| {
                m.insert("extra".into(), serde_json::json!([1, {"a": null}]));
            }),
        ),
    ];
    for (n, body) in json_bodies {
        cases.push(stdin_case(
            n,
            &[
                "--identity-priv-hex",
                bs,
                "--lease-json",
                "-",
                "--server-domain",
                dm,
                "--owner-pub-hex",
                ow,
                "--now-ms",
                nw,
            ],
            body.as_bytes(),
            true,
        ));
    }
    cases
}

/// Boot unlock v2 flags: refusals (a successful reply open deletes its key, so only the lease
/// succeeds here) and the v2 request's errors.
fn v2_cases(dir: &Path) -> Vec<Case> {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/test-vectors/boot-unlock-v2/vectors.json"
    );
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    let k = |a: &str, b: &str| v["keys"][a][b].as_str().unwrap().to_owned();
    let owner = write(
        dir,
        "v2-owner.pq",
        format!("{}\n", k("owner", "publicKey")).as_bytes(),
    );
    let short = write(dir, "v2-owner-short.pq", b"abcd\n");
    let reply = write(
        dir,
        "v2-reply.key",
        format!("{}\n", k("replyKem", "seed")).as_bytes(),
    );
    let other = write(
        dir,
        "v2-other.key",
        format!("{}\n", k("otherKem", "seed")).as_bytes(),
    );
    let lease_key = write(
        dir,
        "v2-lease.key",
        format!("{}\n", k("leaseKem", "seed")).as_bytes(),
    );
    let boot_pq = write(
        dir,
        "v2-boot.pq",
        format!("{}\n", k("boot", "mldsaSeed")).as_bytes(),
    );
    let strict = write(dir, "v2-strict", b"strict\n");
    let junk = write(dir, "v2-junk", b"maybe");
    let exists = write(dir, "v2-exists.key", b"x");
    let floor = write(dir, "v2-floor", b"9999999999999\n");
    let domain = v["serverDomain"].as_str().unwrap().to_owned();
    let nonce = v["reply"]["ctx"]["nonceHex"].as_str().unwrap().to_owned();
    let reply_json = |sealed: &str| {
        format!(
            "{{\"serverDomain\":\"{domain}\",\"requestNonceHex\":\"{nonce}\",\"purpose\":\"unlock-key\",\"sealedHex\":\"{sealed}\",\"issuedAt\":1}}"
        )
    };
    let mut cases = Vec::new();
    let edseed = k("boot", "edSeed");
    for c in v["reply"]["cases"].as_array().unwrap() {
        if c["expect"] == "ok" || c["expect"] == "accept-v1" {
            continue;
        }
        let f = write(
            dir,
            &format!("v2-reply-{}.json", cases.len()),
            reply_json(c["sealed"].as_str().unwrap()).as_bytes(),
        );
        cases.push(case(
            &format!("v2 reply {}", c["name"]),
            &[
                "--identity-priv-hex",
                &edseed,
                "--response-json",
                &f,
                "--server-domain",
                &domain,
                "--reply-kem-key",
                &reply,
                "--owner-pq-pub-file",
                &owner,
                "--unlock-policy-file",
                &strict,
            ],
        ));
    }
    let ok = write(
        dir,
        "v2-reply-ok.json",
        reply_json(v["reply"]["sealed"].as_str().unwrap()).as_bytes(),
    );
    let base = [
        "--identity-priv-hex",
        edseed.as_str(),
        "--response-json",
        ok.as_str(),
        "--server-domain",
        domain.as_str(),
    ];
    fn with<'a>(base: &[&'a str], extra: &[&'a str]) -> Vec<&'a str> {
        [base, extra].concat()
    }
    cases.push(case(
        "v2 reply to another reply key",
        &with(
            &base,
            &["--reply-kem-key", &other, "--owner-pq-pub-file", &owner],
        ),
    ));
    cases.push(case(
        "v2 reply without a reply key",
        &with(&base, &["--owner-pq-pub-file", &owner]),
    ));
    cases.push(case(
        "v2 reply without the owner key file",
        &with(
            &base,
            &[
                "--reply-kem-key",
                &reply,
                "--owner-pq-pub-file",
                "/nonexistent/owner.pq",
            ],
        ),
    ));
    cases.push(case(
        "v2 reply short owner key",
        &with(
            &base,
            &["--reply-kem-key", &reply, "--owner-pq-pub-file", &short],
        ),
    ));
    cases.push(case(
        "v2 junk policy with v2 material",
        &[
            "--identity-priv-hex",
            &edseed,
            "--sealed-hex",
            &"09".repeat(124),
            "--owner-pq-pub-file",
            &owner,
            "--unlock-policy-file",
            &junk,
        ],
    ));
    cases.push(case(
        "v2 junk policy without v2 material",
        &[
            "--identity-priv-hex",
            &edseed,
            "--sealed-hex",
            &"09".repeat(124),
            "--unlock-policy-file",
            &junk,
        ],
    ));
    let l = &v["lease"];
    let lease_body = format!(
        "{{\"serverDomain\":\"{domain}\",\"leaseId\":\"{}\",\"stkPub\":\"{}\",\"sealedKey\":\"{}\",\"issuedAt\":{},\"expiresAt\":{},\"signature\":\"{}\"}}",
        l["fields"]["leaseId"].as_str().unwrap(),
        k("boot", "pubHex"),
        l["sealedKey"].as_str().unwrap(),
        l["fields"]["issuedAt"],
        l["fields"]["expiresAt"],
        "00".repeat(64)
    );
    let lease = write(dir, "v2-lease.json", lease_body.as_bytes());
    let now = (l["fields"]["issuedAt"].as_i64().unwrap() + 1).to_string();
    let lb = [
        "--identity-priv-hex",
        edseed.as_str(),
        "--lease-json",
        lease.as_str(),
        "--server-domain",
        domain.as_str(),
        "--owner-pub-hex",
        &"ab".repeat(32),
        "--owner-pq-pub-file",
        owner.as_str(),
        "--unlock-policy-file",
        strict.as_str(),
        "--now-ms",
        now.as_str(),
    ];
    cases.push(case(
        "v3 lease opens",
        &[&lb[..], &["--lease-kem-key", &lease_key]].concat(),
    ));
    cases.push(stdin_case(
        "v3 lease key on stdin",
        &[&lb[..], &["--lease-kem-key", "-"]].concat(),
        format!("{}\n", k("leaseKem", "seed")).as_bytes(),
        true,
    ));
    cases.push(case(
        "v3 lease past the time floor",
        &[
            &lb[..],
            &["--lease-kem-key", &lease_key, "--time-floor-file", &floor],
        ]
        .concat(),
    ));
    cases.push(case(
        "v3 lease with another lease key",
        &[&lb[..], &["--lease-kem-key", &other]].concat(),
    ));
    cases.push(case("v3 lease without a lease key", &lb));
    cases.push(case(
        "v3 lease and JSON on stdin",
        &[
            "--identity-priv-hex",
            &edseed,
            "--lease-json",
            "-",
            "--lease-kem-key",
            "-",
        ],
    ));
    let rq = [
        "--identity-priv-hex",
        edseed.as_str(),
        "--v2-request",
        "--server-domain",
        domain.as_str(),
        "--nonce-hex",
        nonce.as_str(),
    ];
    cases.push(case("v2 request without its flags", &rq));
    cases.push(case(
        "v2 request onto an existing reply key",
        &[
            &rq[..],
            &["--boot-pq-key", &boot_pq, "--reply-kem-out", &exists],
        ]
        .concat(),
    ));
    cases.push(case(
        "v2 request with a bad boot pq key",
        &[
            &rq[..],
            &["--boot-pq-key", &short, "--reply-kem-out", "/nonexistent/x"],
        ]
        .concat(),
    ));
    cases.push(case(
        "v2 request with a missing boot pq key",
        &[
            &rq[..],
            &[
                "--boot-pq-key",
                "/nonexistent/pq",
                "--reply-kem-out",
                "/nonexistent/x",
            ],
        ]
        .concat(),
    ));
    cases.push(case(
        "now-ms not a number",
        &[
            "--identity-priv-hex",
            &edseed,
            "--sealed-hex",
            "00",
            "--now-ms",
            "soon",
        ],
    ));
    cases
}

#[test]
fn the_rust_binary_behaves_like_the_go_helper() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("go-parity");
    std::fs::create_dir_all(&dir).unwrap();
    let Some(go) = build_go(&dir) else { return };
    let rust = PathBuf::from(env!("CARGO_BIN_EXE_flagship-boot"));
    let mut cases = corpus(&dir);
    cases.extend(v2_cases(&dir));
    let mut failures = Vec::new();
    for c in &cases {
        let g = run(&go, &c.args, &c.stdin, &dir);
        let r = run(&rust, &c.args, &c.stdin, &dir);
        let same = if c.same_stderr {
            g == r
        } else {
            g.code == r.code && g.stdout == r.stdout
        };
        if !same {
            failures.push(format!("{}:\n  go:   {g:?}\n  rust: {r:?}", c.name));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
    println!("{} cases identical in Go and Rust", cases.len());
}
