//! A faithful copy of Go's `flag.FlagSet` parsing (ContinueOnError) for the
//! handful of string and bool flags the v1 helper defines: `-x v`, `--x v`,
//! `-x=v`, bool `-x` / `-x=false`, `--` terminator, first non-flag stops
//! parsing, `-h`/`-help` asks for usage, last occurrence wins. Error text and
//! the usage block match Go's so stderr is the same as the Go binary's.

use core::fmt;

/// A flag's type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Takes a value (`-x v` or `-x=v`).
    Str,
    /// `-x` means true; `-x=false` sets it explicitly.
    Bool,
}

/// One defined flag.
#[derive(Debug, Clone, Copy)]
pub struct Spec {
    /// Name without dashes.
    pub name: &'static str,
    /// Value kind.
    pub kind: Kind,
    /// Usage line.
    pub usage: &'static str,
}

/// A parse failure. `Help` is Go's `flag.ErrHelp`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlagError {
    /// `-h` or `-help` (usage already printed).
    Help,
    /// Any other failure; the message was already printed with the usage.
    Failed(String),
}

impl fmt::Display for FlagError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Help => f.write_str("flag: help requested"),
            Self::Failed(m) => f.write_str(m),
        }
    }
}

/// Parsed values: string flags as raw bytes, bool flags as bools.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Values {
    strs: Vec<(&'static str, Vec<u8>)>,
    bools: Vec<(&'static str, bool)>,
}

impl Values {
    /// A string flag's value, empty when unset (Go's default).
    pub fn str(&self, name: &str) -> &[u8] {
        self.strs
            .iter()
            .rev()
            .find(|(n, _)| *n == name)
            .map_or(&[], |(_, v)| v.as_slice())
    }

    /// A bool flag's value, false when unset.
    pub fn bool(&self, name: &str) -> bool {
        self.bools
            .iter()
            .rev()
            .find(|(n, _)| *n == name)
            .is_some_and(|(_, v)| *v)
    }
}

/// `strconv.ParseBool`.
fn parse_bool(s: &[u8]) -> Option<bool> {
    match s {
        b"1" | b"t" | b"T" | b"TRUE" | b"true" | b"True" => Some(true),
        b"0" | b"f" | b"F" | b"FALSE" | b"false" | b"False" => Some(false),
        _ => None,
    }
}

/// Go's `%q` (strconv.Quote) on bytes, close enough for argument echoes:
/// ASCII is exact; invalid UTF-8 is `\x..`; non-ASCII control and space
/// characters are `\u....`.
pub fn go_quote(s: &[u8]) -> String {
    let mut out = String::from("\"");
    for chunk in s.utf8_chunks() {
        for c in chunk.valid().chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\u{7}' => out.push_str("\\a"),
                '\u{8}' => out.push_str("\\b"),
                '\u{c}' => out.push_str("\\f"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                '\u{b}' => out.push_str("\\v"),
                c if c.is_ascii() && (c.is_ascii_graphic() || c == ' ') => out.push(c),
                c if c.is_ascii() => out.push_str(&format!("\\x{:02x}", u32::from(c))),
                c if c.is_control() || c.is_whitespace() => {
                    if u32::from(c) > 0xffff {
                        out.push_str(&format!("\\U{:08x}", u32::from(c)));
                    } else {
                        out.push_str(&format!("\\u{:04x}", u32::from(c)));
                    }
                }
                c => out.push(c),
            }
        }
        for b in chunk.invalid() {
            out.push_str(&format!("\\x{b:02x}"));
        }
    }
    out.push('"');
    out
}

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

/// Go's `defaultUsage` + `PrintDefaults` for a named FlagSet.
pub fn usage(set_name: &str, specs: &[Spec]) -> String {
    let mut sorted: Vec<&Spec> = specs.iter().collect();
    sorted.sort_by(|a, b| a.name.cmp(b.name));
    let mut out = format!("Usage of {set_name}:\n");
    for s in sorted {
        let mut line = format!("  -{}", s.name);
        if s.kind == Kind::Str {
            line.push_str(" string");
        }
        if line.len() <= 4 {
            line.push('\t');
        } else {
            line.push_str("\n    \t");
        }
        line.push_str(&s.usage.replace('\n', "\n    \t"));
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// Parse `args` as Go's `FlagSet.Parse` would. Diagnostics (and the usage
/// block) are appended to `diag`, as Go writes them to the set's output.
pub fn parse(
    set_name: &str,
    specs: &[Spec],
    args: &[Vec<u8>],
    diag: &mut String,
) -> Result<Values, FlagError> {
    let mut values = Values::default();
    let mut rest = args;
    let fail = |diag: &mut String, msg: String| {
        diag.push_str(&msg);
        diag.push('\n');
        diag.push_str(&usage(set_name, specs));
        FlagError::Failed(msg)
    };
    while let Some((arg, tail)) = rest.split_first() {
        let s = arg.as_slice();
        if s.len() < 2 || s.first() != Some(&b'-') {
            break;
        }
        let mut minuses = 1usize;
        if s.get(1) == Some(&b'-') {
            minuses = 2;
            if s.len() == 2 {
                break;
            }
        }
        let name_full = s.get(minuses..).unwrap_or_default();
        if matches!(name_full.first(), None | Some(b'-') | Some(b'=')) {
            return Err(fail(diag, format!("bad flag syntax: {}", lossy(s))));
        }
        rest = tail;
        let (name, value) = match name_full.iter().skip(1).position(|&b| b == b'=') {
            Some(p) => {
                let at = p.saturating_add(1);
                (
                    name_full.get(..at).unwrap_or_default(),
                    Some(name_full.get(at.saturating_add(1)..).unwrap_or_default()),
                )
            }
            None => (name_full, None),
        };
        let Some(spec) = specs.iter().find(|sp| sp.name.as_bytes() == name) else {
            if name == b"help" || name == b"h" {
                diag.push_str(&usage(set_name, specs));
                return Err(FlagError::Help);
            }
            return Err(fail(
                diag,
                format!("flag provided but not defined: -{}", lossy(name)),
            ));
        };
        match spec.kind {
            Kind::Bool => {
                let v = match value {
                    Some(v) => match parse_bool(v) {
                        Some(b) => b,
                        None => {
                            return Err(fail(
                                diag,
                                format!(
                                    "invalid boolean value {} for -{}: parse error",
                                    go_quote(v),
                                    spec.name
                                ),
                            ));
                        }
                    },
                    None => true,
                };
                values.bools.push((spec.name, v));
            }
            Kind::Str => {
                let v = match value {
                    Some(v) => v.to_vec(),
                    None => match rest.split_first() {
                        Some((next, tail)) => {
                            rest = tail;
                            next.clone()
                        }
                        None => {
                            return Err(fail(
                                diag,
                                format!("flag needs an argument: -{}", spec.name),
                            ));
                        }
                    },
                };
                values.strs.push((spec.name, v));
            }
        }
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    const SPECS: &[Spec] = &[
        Spec {
            name: "a",
            kind: Kind::Str,
            usage: "an a",
        },
        Spec {
            name: "flag",
            kind: Kind::Bool,
            usage: "a bool",
        },
    ];

    fn args(v: &[&str]) -> Vec<Vec<u8>> {
        v.iter().map(|s| s.as_bytes().to_vec()).collect()
    }

    #[test]
    fn parses_like_go() {
        let mut d = String::new();
        let v = parse(
            "t",
            SPECS,
            &args(&["--a", "-x", "-flag", "--a=y", "rest", "-a", "z"]),
            &mut d,
        )
        .unwrap();
        assert_eq!(v.str("a"), b"y");
        assert!(v.bool("flag"));
        let v = parse("t", SPECS, &args(&["-flag=false", "--", "-a", "z"]), &mut d).unwrap();
        assert!(!v.bool("flag"));
        assert_eq!(v.str("a"), b"");
        assert!(d.is_empty());
    }

    #[test]
    fn fails_like_go() {
        let mut d = String::new();
        assert_eq!(
            parse("t", SPECS, &args(&["-b"]), &mut d),
            Err(FlagError::Failed(
                "flag provided but not defined: -b".into()
            ))
        );
        assert_eq!(
            d,
            "flag provided but not defined: -b\nUsage of t:\n  -a string\n    \tan a\n  -flag\n    \ta bool\n"
        );
        let mut d = String::new();
        assert_eq!(
            parse("t", SPECS, &args(&["-a"]), &mut d),
            Err(FlagError::Failed("flag needs an argument: -a".into()))
        );
        assert_eq!(
            parse("t", SPECS, &args(&["-flag=x"]), &mut d),
            Err(FlagError::Failed(
                "invalid boolean value \"x\" for -flag: parse error".into()
            ))
        );
        assert_eq!(
            parse("t", SPECS, &args(&["---a"]), &mut d),
            Err(FlagError::Failed("bad flag syntax: ---a".into()))
        );
        assert_eq!(
            parse("t", SPECS, &args(&["-=a"]), &mut d),
            Err(FlagError::Failed("bad flag syntax: -=a".into()))
        );
        assert_eq!(
            parse("t", SPECS, &args(&["--help"]), &mut d),
            Err(FlagError::Help)
        );
        assert_eq!(
            parse("t", SPECS, &args(&["-h=1"]), &mut d),
            Err(FlagError::Help)
        );
    }
}
