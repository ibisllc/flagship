//! Command line, accepting flagship-tlsd's flags as Go's `flag` package does (`-x v`,
//! `--x v`, `-x=v`, `--x=v`, Go durations such as `10s`), so the systemd unit's `ExecStart`
//! line works unchanged with the binary swapped.

use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use crate::server::{KxPolicy, Limits};

#[derive(Debug, Clone)]
pub struct Args {
    pub listen: String,
    pub keyd: PathBuf,
    pub upstream: PathBuf,
    pub refresh: Duration,
    pub keyd_timeout: Duration,
    pub kx: KxPolicy,
    pub limits: Limits,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            listen: "127.0.0.1:18443".into(),
            keyd: "/run/flagship-keyd/keyd.sock".into(),
            upstream: "/run/flagship-tls/upstream.sock".into(),
            refresh: Duration::from_secs(5),
            keyd_timeout: Duration::from_secs(5),
            kx: KxPolicy::PreferHybrid,
            limits: Limits::default(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct ArgError(pub String);

impl fmt::Display for ArgError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ArgError {}

pub const USAGE: &str =
    "flagship-ingress [--listen ADDR] [--keyd SOCK] [--upstream SOCK] [--max-conns N]
  [--handshake-timeout D] [--refresh D] [--head-timeout D] [--max-header-line N]
  [--max-header-bytes N] [--idle-timeout D] [--drain-timeout D] [--keyd-timeout D]
  [--kx prefer-hybrid|require-hybrid]
Durations are Go-style (10s, 500ms, 15m, 1m30s); 0 disables the head guard or the idle timeout.";

pub fn parse<I: IntoIterator<Item = String>>(argv: I) -> Result<Args, ArgError> {
    let mut a = Args::default();
    let mut it = argv.into_iter();
    while let Some(raw) = it.next() {
        let flag = raw
            .strip_prefix("--")
            .or_else(|| raw.strip_prefix('-'))
            .ok_or_else(|| ArgError(format!("unexpected argument {raw}")))?;
        let (name, inline) = match flag.split_once('=') {
            Some((n, v)) => (n.to_owned(), Some(v.to_owned())),
            None => (flag.to_owned(), None),
        };
        if name == "h" || name == "help" {
            return Err(ArgError(USAGE.into()));
        }
        let value = match inline {
            Some(v) => v,
            None => it
                .next()
                .ok_or_else(|| ArgError(format!("flag needs a value: -{name}")))?,
        };
        let l = &mut a.limits;
        match name.as_str() {
            "listen" => a.listen = value,
            "keyd" => a.keyd = value.into(),
            "upstream" => a.upstream = value.into(),
            "max-conns" => l.max_conns = count(&name, &value, 1)?,
            "handshake-timeout" => l.handshake_timeout = positive(&name, &value)?,
            "refresh" => a.refresh = positive(&name, &value)?,
            "head-timeout" => l.head_timeout = duration(&name, &value)?,
            "max-header-line" => l.max_header_line = count(&name, &value, 256)?,
            "max-header-bytes" => l.max_header_bytes = count(&name, &value, 1024)?,
            "idle-timeout" => l.idle_timeout = duration(&name, &value)?,
            "drain-timeout" => l.drain_timeout = duration(&name, &value)?,
            "keyd-timeout" => a.keyd_timeout = positive(&name, &value)?,
            "kx" => {
                a.kx = match value.as_str() {
                    "prefer-hybrid" => KxPolicy::PreferHybrid,
                    "require-hybrid" => KxPolicy::RequireHybrid,
                    _ => {
                        return Err(ArgError(format!(
                            "-kx: {value} is not prefer-hybrid or require-hybrid"
                        )));
                    }
                }
            }
            _ => {
                return Err(ArgError(format!(
                    "flag provided but not defined: -{name}\n{USAGE}"
                )));
            }
        }
    }
    Ok(a)
}

fn count(name: &str, v: &str, min: usize) -> Result<usize, ArgError> {
    match v.parse::<usize>() {
        Ok(n) if n >= min => Ok(n),
        _ => Err(ArgError(format!(
            "-{name}: {v} is not a number of at least {min}"
        ))),
    }
}

fn positive(name: &str, v: &str) -> Result<Duration, ArgError> {
    let d = duration(name, v)?;
    if d.is_zero() {
        return Err(ArgError(format!("-{name} must be above zero")));
    }
    Ok(d)
}

fn duration(name: &str, v: &str) -> Result<Duration, ArgError> {
    parse_go_duration(v).ok_or_else(|| ArgError(format!("-{name}: invalid duration {v}")))
}

/// Go's `time.ParseDuration` for non-negative values: `0`, or numbers with units ns, us, µs,
/// ms, s, m, h, concatenated (`1h2m3.5s`).
pub fn parse_go_duration(s: &str) -> Option<Duration> {
    if s == "0" {
        return Some(Duration::ZERO);
    }
    let mut rest = s.strip_prefix('+').unwrap_or(s);
    if rest.is_empty() {
        return None;
    }
    let mut total = 0f64;
    while !rest.is_empty() {
        let num_end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(rest.len());
        let (num, tail) = rest.split_at(num_end);
        if num.is_empty() || num == "." {
            return None;
        }
        let n: f64 = num.parse().ok()?;
        let unit_end = tail
            .find(|c: char| c.is_ascii_digit() || c == '.')
            .unwrap_or(tail.len());
        let (unit, next) = tail.split_at(unit_end);
        let scale = match unit {
            "ns" => 1e-9,
            "us" | "µs" | "μs" => 1e-6,
            "ms" => 1e-3,
            "s" => 1.0,
            "m" => 60.0,
            "h" => 3600.0,
            _ => return None,
        };
        total += n * scale;
        rest = next;
    }
    if !total.is_finite() || total > 1e9 {
        return None;
    }
    Some(Duration::from_secs_f64(total))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;

    fn argv(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn takes_the_tlsd_unit_exec_line() {
        let a = parse(argv("--listen 127.0.0.1:18443 --keyd /run/flagship-keyd/keyd.sock --upstream /run/flagship-tls/upstream.sock")).unwrap();
        assert_eq!(a.listen, "127.0.0.1:18443");
        assert_eq!(a.keyd, PathBuf::from("/run/flagship-keyd/keyd.sock"));
        assert_eq!(a.upstream, PathBuf::from("/run/flagship-tls/upstream.sock"));
        let b = parse(argv("-max-conns=10 -handshake-timeout 2s --refresh=250ms --idle-timeout 0 --kx require-hybrid")).unwrap();
        assert_eq!(b.limits.max_conns, 10);
        assert_eq!(b.limits.handshake_timeout, Duration::from_secs(2));
        assert_eq!(b.refresh, Duration::from_millis(250));
        assert!(b.limits.idle_timeout.is_zero());
        assert_eq!(b.kx, KxPolicy::RequireHybrid);
        assert!(parse(argv("--nope 1")).is_err());
        assert!(parse(argv("--max-conns 0")).is_err());
        assert!(parse(argv("--handshake-timeout 0")).is_err());
        assert!(parse(argv("--listen")).is_err());
    }

    #[test]
    fn go_durations() {
        assert_eq!(parse_go_duration("10s"), Some(Duration::from_secs(10)));
        assert_eq!(parse_go_duration("1m30s"), Some(Duration::from_secs(90)));
        assert_eq!(parse_go_duration("1.5h"), Some(Duration::from_secs(5400)));
        assert_eq!(parse_go_duration("500ms"), Some(Duration::from_millis(500)));
        assert_eq!(parse_go_duration("0"), Some(Duration::ZERO));
        assert_eq!(parse_go_duration("10"), None);
        assert_eq!(parse_go_duration("-1s"), None);
        assert_eq!(parse_go_duration(""), None);
        assert_eq!(parse_go_duration("5d"), None);
    }
}
