//! Differential test against the Go helper itself: build
//! installer/unseal-helper (unmodified) and run the same argv, stdin and files
//! through both binaries, comparing exit code, stdout and stderr byte for
//! byte. Skipped when Go is not installed, unless FLAGSHIP_REQUIRE_GO=1.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::print_stdout
)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const VECTORS: &str =
    include_str!("../../../../packages/protocol/test-vectors/boot-unseal/vectors.json");

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
    cases
}

#[test]
fn the_rust_binary_behaves_like_the_go_helper() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("go-parity");
    std::fs::create_dir_all(&dir).unwrap();
    let Some(go) = build_go(&dir) else { return };
    let rust = PathBuf::from(env!("CARGO_BIN_EXE_flagship-boot"));
    let cases = corpus(&dir);
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
