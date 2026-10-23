//! The Rust policy tables must be the TS contract's, read from the TS sources themselves.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use std::path::PathBuf;

use flagship_keyd::acme::LETS_ENCRYPT_HOSTS;
use flagship_keyd::policy::{BOX_SIGN_PURPOSES, DEFAULT_RATE_LIMITS, MAX_SIGN_BYTES};
use flagship_keyd::service::SWK_DERIVE_LABELS;
use flagship_keyd::wire::{KEYD_PROTOCOL_VERSION, MAX_FRAME_BYTES, OPS};

fn ts(path: &str) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    std::fs::read_to_string(root.join(path)).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The text between `start` (after `anchor`) and the next `end`.
fn block<'a>(src: &'a str, anchor: &str, start: &str, end: &str) -> &'a str {
    let a = src
        .find(anchor)
        .unwrap_or_else(|| panic!("{anchor} not found"));
    let s = a + src[a..].find(start).unwrap() + start.len();
    let e = s + src[s..].find(end).unwrap();
    &src[s..e]
}

/// Double-quoted string literals, skipping `//` comment lines.
fn strings(block: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in block.lines().filter(|l| !l.trim_start().starts_with("//")) {
        let mut rest = line;
        while let Some(i) = rest.find('"') {
            let tail = &rest[i + 1..];
            let j = tail.find('"').unwrap();
            out.push(tail[..j].to_owned());
            rest = &tail[j + 1..];
        }
    }
    out
}

/// A numeric expression as written in the TS: `2000`, `0.2`, `5 / 3600`, `4 * 1024 * 1024`.
fn eval(expr: &str) -> f64 {
    let expr = expr.trim();
    if let Some((a, b)) = expr.split_once('/') {
        return eval(a) / eval(b);
    }
    expr.split('*')
        .map(|f| {
            f.trim()
                .parse::<f64>()
                .unwrap_or_else(|_| panic!("number {f}"))
        })
        .product()
}

fn constant(src: &str, name: &str) -> f64 {
    let s = block(src, &format!("export const {name}"), "=", ";");
    eval(s)
}

#[test]
fn sign_purposes_match_policy_ts() {
    let src = ts("packages/keyd/src/policy.ts");
    let ts_list = strings(block(&src, "BOX_SIGN_PURPOSES", "new Set([", "]);"));
    assert_eq!(
        ts_list,
        BOX_SIGN_PURPOSES
            .iter()
            .map(|s| (*s).to_owned())
            .collect::<Vec<_>>()
    );
    assert_eq!(constant(&src, "MAX_SIGN_BYTES"), MAX_SIGN_BYTES as f64);
}

#[test]
fn rate_limits_match_policy_ts() {
    let src = ts("packages/keyd/src/policy.ts");
    let body = block(&src, "DEFAULT_RATE_LIMITS", "= {", "};");
    let mut parsed = Vec::new();
    for line in body.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let (key, rest) = line
            .split_once(": {")
            .unwrap_or_else(|| panic!("line {line}"));
        let key = key.trim().trim_matches('"').to_owned();
        let per = rest
            .split("perSecond:")
            .nth(1)
            .unwrap()
            .split(',')
            .next()
            .unwrap();
        let burst = rest
            .split("burst:")
            .nth(1)
            .unwrap()
            .split('}')
            .next()
            .unwrap();
        parsed.push((key, eval(per), eval(burst)));
    }
    let ours: Vec<(String, f64, f64)> = DEFAULT_RATE_LIMITS
        .iter()
        .map(|(k, l)| ((*k).to_owned(), l.per_second, l.burst))
        .collect();
    assert_eq!(parsed, ours);
}

#[test]
fn ops_and_frame_limits_match_wire_ts() {
    let src = ts("packages/keyd/src/wire.ts");
    let ts_ops = strings(block(&src, "export const OPS", "[", "] as const"));
    assert_eq!(
        ts_ops,
        OPS.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>()
    );
    assert_eq!(constant(&src, "MAX_FRAME_BYTES"), MAX_FRAME_BYTES as f64);
    assert_eq!(
        constant(&src, "KEYD_PROTOCOL_VERSION"),
        KEYD_PROTOCOL_VERSION as f64
    );
    // Every error code the TS contract names is one this backend can send.
    let codes = strings(block(&src, "export type KeydErrorCode", "=", ";"));
    let ours = [
        "bad-frame",
        "bad-request",
        "unknown-op",
        "unsupported-version",
        "not-hello",
        "forbidden",
        "rate-limited",
        "not-provisioned",
        "failed",
    ];
    assert_eq!(codes, ours);
}

#[test]
fn derivation_labels_and_acme_hosts_match() {
    let labels = strings(block(
        &ts("packages/protocol/src/opaqueKey.ts"),
        "SWK_DERIVE_LABELS",
        "new Set([",
        "]);",
    ));
    assert_eq!(
        labels,
        SWK_DERIVE_LABELS
            .iter()
            .map(|s| (*s).to_owned())
            .collect::<Vec<_>>()
    );
    let hosts = strings(block(
        &ts("packages/keyd/src/acme.ts"),
        "LETS_ENCRYPT_HOSTS",
        "= [",
        "];",
    ));
    assert_eq!(
        hosts,
        LETS_ENCRYPT_HOSTS
            .iter()
            .map(|s| (*s).to_owned())
            .collect::<Vec<_>>()
    );
}

#[test]
fn every_ts_op_is_answered_by_the_rust_service() {
    // An op the Rust service does not know would fall through to `unknown-op`.
    let mut svc =
        flagship_keyd::service::KeydService::new(&[0x42; 32], None, None, None, None, None);
    for op in OPS {
        let r = svc.handle(op, &serde_json::Map::new());
        if let Err(e) = r {
            assert_ne!(e.code.as_str(), "unknown-op", "{op}");
        }
    }
}
