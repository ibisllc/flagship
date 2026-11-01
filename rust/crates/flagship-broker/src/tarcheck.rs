//! The archive extraction check (plan G6/R6): a tar is read once, in 512-byte blocks, and refused
//! at the first entry that could reach outside the folder it is unpacked into or exhaust the box.
//!
//! TS twin: `packages/server-daemon/src/serverArchive/tarCheck.ts`. Both pass the shared vectors
//! in `packages/protocol/test-vectors/archive-extraction/vectors.json`, code for code. Rules, in
//! order, per entry: the header (checksum, ustar or GNU magic, octal or base-256 size); GNU `L`/`K`
//! and pax `x` (path, linkpath, size; a `GNU.sparse.*` key makes a sparse file; `g` is
//! unsupported); the entry count; the name (absolute, any `..`, empty); the kind (devices, FIFOs,
//! sparse files; the profile); duplicates and paths through a link; link targets (a symlink is
//! resolved lexically from its folder and may not walk through a link; a hard link names an
//! earlier regular file); the declared sizes; then the data. Memory holds one block, one bounded
//! long name or pax header, and the names seen (bounded by `max_name_total_bytes`).

use std::collections::{BTreeMap, HashSet};
use std::io::{Read, Write};

const BLOCK: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    /// An app's files folder: files, folders, and links that stay inside.
    Volume,
    /// A server archive: regular files only.
    Archive,
}

impl Profile {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "volume" => Some(Self::Volume),
            "archive" => Some(Self::Archive),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_entries: u64,
    pub max_entry_bytes: u64,
    pub max_total_bytes: u64,
    pub max_name_bytes: u64,
    pub max_pax_bytes: u64,
    pub max_name_total_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_entries: 100_000,
            max_entry_bytes: 64 * 1024 * 1024 * 1024,
            max_total_bytes: 512 * 1024 * 1024 * 1024,
            max_name_bytes: 4096,
            max_pax_bytes: 64 * 1024,
            max_name_total_bytes: 32 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    BadHeader,
    Truncated,
    Unsupported,
    TooManyEntries,
    BadName,
    AbsolutePath,
    PathEscape,
    SpecialFile,
    NotAllowed,
    Duplicate,
    ThroughLink,
    SymlinkEscape,
    HardlinkEscape,
    EntryTooLarge,
    TotalTooLarge,
    /// Reading or writing failed for a reason outside the archive.
    Io,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::BadHeader => "bad-header",
            Self::Truncated => "truncated",
            Self::Unsupported => "unsupported",
            Self::TooManyEntries => "too-many-entries",
            Self::BadName => "bad-name",
            Self::AbsolutePath => "absolute-path",
            Self::PathEscape => "path-escape",
            Self::SpecialFile => "special-file",
            Self::NotAllowed => "not-allowed",
            Self::Duplicate => "duplicate",
            Self::ThroughLink => "through-link",
            Self::SymlinkEscape => "symlink-escape",
            Self::HardlinkEscape => "hardlink-escape",
            Self::EntryTooLarge => "entry-too-large",
            Self::TotalTooLarge => "total-too-large",
            Self::Io => "io",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::BadHeader => "a header in the archive is damaged",
            Self::Truncated => "the archive is cut short",
            Self::Unsupported => "the archive holds a kind of entry this server does not unpack",
            Self::TooManyEntries => "the archive holds too many entries",
            Self::BadName => "an entry in the archive has no usable name",
            Self::AbsolutePath => "an entry in the archive names an absolute path",
            Self::PathEscape => "an entry in the archive climbs out of its folder",
            Self::SpecialFile => "the archive holds a device, a pipe or a sparse file",
            Self::NotAllowed => "the archive holds something other than plain files",
            Self::Duplicate => "the archive lists the same path twice",
            Self::ThroughLink => "an entry in the archive goes through a link",
            Self::SymlinkEscape => "a link in the archive points outside its folder",
            Self::HardlinkEscape => "a hard link in the archive points outside its folder",
            Self::EntryTooLarge => "an entry in the archive is larger than it may be",
            Self::TotalTooLarge => "the archive expands to more than it may",
            Self::Io => "the archive could not be read",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    pub entries: u64,
    pub bytes: u64,
}

struct Reader<R> {
    inner: R,
    sink: Option<Box<dyn Write>>,
}

impl<R: Read> Reader<R> {
    /// Exactly `buf.len()` bytes; `Ok(false)` only when the stream ended before the first byte.
    fn exact(&mut self, buf: &mut [u8]) -> Result<bool, Refusal> {
        let mut got = 0usize;
        while got < buf.len() {
            let rest = buf.get_mut(got..).ok_or(Refusal::Io)?;
            match self.inner.read(rest) {
                Ok(0) => {
                    return if got == 0 {
                        Ok(false)
                    } else {
                        Err(Refusal::Truncated)
                    };
                }
                Ok(n) => got = got.checked_add(n).ok_or(Refusal::Io)?,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return Err(Refusal::Io),
            }
        }
        if let Some(w) = self.sink.as_mut() {
            w.write_all(buf).map_err(|_| Refusal::Io)?;
        }
        Ok(true)
    }

    fn skip(&mut self, mut n: u64) -> Result<(), Refusal> {
        let mut buf = vec![0u8; 64 * 1024];
        while n > 0 {
            let take = usize::try_from(n.min(buf.len() as u64)).map_err(|_| Refusal::Io)?;
            let part = buf.get_mut(..take).ok_or(Refusal::Io)?;
            if !self.exact(part)? {
                return Err(Refusal::Truncated);
            }
            n = n.saturating_sub(take as u64);
        }
        Ok(())
    }
}

fn cstr(b: &[u8]) -> Vec<u8> {
    let end = b.iter().position(|c| *c == 0).unwrap_or(b.len());
    b.get(..end).unwrap_or_default().to_vec()
}

fn field(h: &[u8; BLOCK], at: usize, len: usize) -> &[u8] {
    h.get(at..at.saturating_add(len)).unwrap_or_default()
}

const MAX_SAFE: u64 = (1u64 << 53) - 1;

fn parse_size(f: &[u8]) -> Result<u64, Refusal> {
    let first = *f.first().ok_or(Refusal::BadHeader)?;
    if first & 0x80 != 0 {
        if first != 0x80 {
            return Err(Refusal::BadHeader);
        }
        let mut v: u128 = 0;
        for b in f.iter().skip(1) {
            v = (v << 8) | u128::from(*b);
        }
        return u64::try_from(v)
            .ok()
            .filter(|v| *v <= MAX_SAFE)
            .ok_or(Refusal::BadHeader);
    }
    let lead = f.iter().take_while(|c| **c == b' ').count();
    let f = f.get(lead..).unwrap_or_default();
    let end = f.iter().position(|c| *c == 0 || *c == b' ');
    let digits = match end {
        Some(e) => {
            if f.iter().skip(e).any(|c| *c != 0 && *c != b' ') {
                return Err(Refusal::BadHeader);
            }
            f.get(..e).unwrap_or_default()
        }
        None => f,
    };
    let mut v: u64 = 0;
    for c in digits {
        if !(b'0'..=b'7').contains(c) {
            return Err(Refusal::BadHeader);
        }
        v = v
            .checked_mul(8)
            .and_then(|v| v.checked_add(u64::from(c.saturating_sub(b'0'))))
            .ok_or(Refusal::BadHeader)?;
    }
    if v > MAX_SAFE {
        return Err(Refusal::BadHeader);
    }
    Ok(v)
}

fn checksum_ok(h: &[u8; BLOCK]) -> bool {
    let stored = cstr(field(h, 148, 8));
    let text = String::from_utf8_lossy(&stored);
    let text = text.trim();
    if text.is_empty() || text.len() > 7 || !text.bytes().all(|c| (b'0'..=b'7').contains(&c)) {
        return false;
    }
    let Ok(want) = i64::from_str_radix(text, 8) else {
        return false;
    };
    let (mut unsigned, mut signed) = (0i64, 0i64);
    for (i, b) in h.iter().enumerate() {
        let b = if (148..156).contains(&i) { 0x20 } else { *b };
        unsigned = unsigned.saturating_add(i64::from(b));
        signed = signed.saturating_add(i64::from(b as i8));
    }
    want == unsigned || want == signed
}

fn parse_pax(data: &[u8]) -> Result<BTreeMap<Vec<u8>, Vec<u8>>, Refusal> {
    let mut out = BTreeMap::new();
    let mut i = 0usize;
    while i < data.len() {
        if data.get(i) == Some(&0) {
            break;
        }
        let rest = data.get(i..).ok_or(Refusal::BadHeader)?;
        let sp = rest
            .iter()
            .position(|c| *c == b' ')
            .ok_or(Refusal::BadHeader)?;
        if sp > 20 || sp == 0 {
            return Err(Refusal::BadHeader);
        }
        let len_text = rest.get(..sp).ok_or(Refusal::BadHeader)?;
        if !len_text.iter().all(u8::is_ascii_digit) {
            return Err(Refusal::BadHeader);
        }
        let len: usize = std::str::from_utf8(len_text)
            .ok()
            .and_then(|s| s.parse().ok())
            .ok_or(Refusal::BadHeader)?;
        if len <= sp.saturating_add(1)
            || len > rest.len()
            || rest.get(len.saturating_sub(1)) != Some(&b'\n')
        {
            return Err(Refusal::BadHeader);
        }
        let rec = rest
            .get(sp.saturating_add(1)..len.saturating_sub(1))
            .ok_or(Refusal::BadHeader)?;
        let eq = rec
            .iter()
            .position(|c| *c == b'=')
            .ok_or(Refusal::BadHeader)?;
        if eq == 0 {
            return Err(Refusal::BadHeader);
        }
        out.insert(
            rec.get(..eq).unwrap_or_default().to_vec(),
            rec.get(eq.saturating_add(1)..).unwrap_or_default().to_vec(),
        );
        i = i.checked_add(len).ok_or(Refusal::BadHeader)?;
    }
    Ok(out)
}

/// Components with `.` and empty ones dropped; refuses an absolute name and any `..`.
fn components(name: &[u8], absolute: Refusal, escape: Refusal) -> Result<Vec<Vec<u8>>, Refusal> {
    if name.first() == Some(&b'/') {
        return Err(absolute);
    }
    let mut out = Vec::new();
    for c in name.split(|b| *b == b'/') {
        if c.is_empty() || c == b"." {
            continue;
        }
        if c == b".." {
            return Err(escape);
        }
        out.push(c.to_vec());
    }
    Ok(out)
}

fn join(parts: &[Vec<u8>]) -> Vec<u8> {
    parts.join(&b'/')
}

fn round_up(n: u64) -> Result<u64, Refusal> {
    n.checked_add(511)
        .map(|v| v & !511)
        .ok_or(Refusal::BadHeader)
}

fn read_meta<R: Read>(r: &mut Reader<R>, size: u64, max: u64) -> Result<Vec<u8>, Refusal> {
    if size > max {
        return Err(Refusal::BadHeader);
    }
    let padded = usize::try_from(round_up(size)?).map_err(|_| Refusal::BadHeader)?;
    let mut d = vec![0u8; padded];
    if padded > 0 && !r.exact(&mut d)? {
        return Err(Refusal::Truncated);
    }
    d.truncate(usize::try_from(size).map_err(|_| Refusal::BadHeader)?);
    Ok(d)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Dir,
    Symlink,
    Hardlink,
}

/// Check a tar stream.
///
/// # Errors
/// The first [`Refusal`] met.
pub fn check<R: Read>(input: R, profile: Profile, limits: &Limits) -> Result<Summary, Refusal> {
    run(
        Reader {
            inner: input,
            sink: None,
        },
        profile,
        limits,
    )
}

/// Check a tar stream while copying every byte read to `out`, then end `out` with a second zero
/// block, so what was written is exactly what was checked (the broker's private copy).
///
/// # Errors
/// The first [`Refusal`] met; `out` then holds a partial copy the caller must discard.
pub fn check_copy<R: Read>(
    input: R,
    out: Box<dyn Write>,
    profile: Profile,
    limits: &Limits,
) -> Result<Summary, Refusal> {
    let mut reader = Reader {
        inner: input,
        sink: Some(out),
    };
    let s = run_ref(&mut reader, profile, limits)?;
    if let Some(w) = reader.sink.as_mut() {
        w.write_all(&[0u8; BLOCK]).map_err(|_| Refusal::Io)?;
        w.flush().map_err(|_| Refusal::Io)?;
    }
    Ok(s)
}

fn run<R: Read>(mut r: Reader<R>, profile: Profile, limits: &Limits) -> Result<Summary, Refusal> {
    run_ref(&mut r, profile, limits)
}

#[allow(clippy::too_many_lines)]
fn run_ref<R: Read>(
    r: &mut Reader<R>,
    profile: Profile,
    limits: &Limits,
) -> Result<Summary, Refusal> {
    let mut entries: u64 = 0;
    let mut total: u64 = 0;
    let mut name_bytes: u64 = 0;
    let mut seen: HashSet<Vec<u8>> = HashSet::new();
    let mut files: HashSet<Vec<u8>> = HashSet::new();
    let mut links: HashSet<Vec<u8>> = HashSet::new();
    let mut dirs: HashSet<Vec<u8>> = HashSet::new();
    dirs.insert(Vec::new());
    let mut long_name: Option<Vec<u8>> = None;
    let mut long_link: Option<Vec<u8>> = None;
    let mut pax: Option<BTreeMap<Vec<u8>, Vec<u8>>> = None;
    loop {
        let mut h = [0u8; BLOCK];
        if !r.exact(&mut h)? {
            return Err(Refusal::Truncated);
        }
        if h.iter().all(|b| *b == 0) {
            return Ok(Summary {
                entries,
                bytes: total,
            });
        }
        if !checksum_ok(&h) {
            return Err(Refusal::BadHeader);
        }
        let magic = field(&h, 257, 8);
        let posix = magic.starts_with(b"ustar\0");
        if !posix && magic != b"ustar  \0" {
            return Err(Refusal::BadHeader);
        }
        let ty = h.get(156).copied().unwrap_or(0);
        let mut size = parse_size(field(&h, 124, 12))?;

        match ty {
            b'L' | b'K' => {
                let d = cstr(&read_meta(r, size, limits.max_name_bytes)?);
                if ty == b'L' {
                    long_name = Some(d);
                } else {
                    long_link = Some(d);
                }
                continue;
            }
            b'x' | b'g' => {
                let d = read_meta(r, size, limits.max_pax_bytes)?;
                let recs = parse_pax(&d)?;
                if ty == b'g' {
                    return Err(Refusal::Unsupported);
                }
                pax = Some(recs);
                continue;
            }
            _ => {}
        }

        entries = entries.saturating_add(1);
        if entries > limits.max_entries {
            return Err(Refusal::TooManyEntries);
        }

        let mut name = cstr(field(&h, 0, 100));
        let prefix = if posix {
            cstr(field(&h, 345, 155))
        } else {
            Vec::new()
        };
        if !prefix.is_empty() {
            name = [prefix, b"/".to_vec(), name].concat();
        }
        if let Some(n) = long_name.take() {
            name = n;
        }
        let mut link = cstr(field(&h, 157, 100));
        if let Some(l) = long_link.take() {
            link = l;
        }
        let mut sparse = false;
        if let Some(p) = pax.take() {
            if let Some(v) = p.get(b"path".as_slice()) {
                name.clone_from(v);
            }
            if let Some(v) = p.get(b"linkpath".as_slice()) {
                link.clone_from(v);
            }
            if let Some(v) = p.get(b"size".as_slice()) {
                if v.is_empty() || v.len() > 20 || !v.iter().all(u8::is_ascii_digit) {
                    return Err(Refusal::BadHeader);
                }
                size = std::str::from_utf8(v)
                    .ok()
                    .and_then(|s| s.parse::<u64>().ok())
                    .filter(|s| *s <= MAX_SAFE)
                    .ok_or(Refusal::BadHeader)?;
            }
            sparse = p.keys().any(|k| k.starts_with(b"GNU.sparse."));
        }

        if name.is_empty() {
            return Err(Refusal::BadName);
        }
        let parts = components(&name, Refusal::AbsolutePath, Refusal::PathEscape)?;
        let path = join(&parts);

        if sparse || matches!(ty, b'S' | b'3' | b'4' | b'6') {
            return Err(Refusal::SpecialFile);
        }
        let kind = match ty {
            b'0' | 0 | b'7' => Kind::File,
            b'5' => Kind::Dir,
            b'2' => Kind::Symlink,
            b'1' => Kind::Hardlink,
            _ => return Err(Refusal::Unsupported),
        };
        if parts.is_empty() && kind != Kind::Dir {
            return Err(Refusal::BadName);
        }
        if profile == Profile::Archive && (kind != Kind::File || parts.is_empty()) {
            return Err(Refusal::NotAllowed);
        }

        if seen.contains(&path) {
            return Err(Refusal::Duplicate);
        }
        for i in 1..parts.len() {
            if links.contains(&join(parts.get(..i).unwrap_or_default())) {
                return Err(Refusal::ThroughLink);
            }
        }
        if kind == Kind::Symlink && dirs.contains(&path) {
            return Err(Refusal::ThroughLink);
        }

        let mut walked: Vec<Vec<u8>> = Vec::new();
        match kind {
            Kind::Symlink => {
                if link.is_empty() || link.first() == Some(&b'/') {
                    return Err(Refusal::SymlinkEscape);
                }
                let mut at: Vec<Vec<u8>> = parts
                    .get(..parts.len().saturating_sub(1))
                    .unwrap_or_default()
                    .to_vec();
                let steps: Vec<&[u8]> = link
                    .split(|b| *b == b'/')
                    .filter(|c| !c.is_empty() && *c != b".")
                    .collect();
                let last = steps.len().saturating_sub(1);
                for (i, c) in steps.iter().enumerate() {
                    if *c == b".." {
                        if at.pop().is_none() {
                            return Err(Refusal::SymlinkEscape);
                        }
                    } else {
                        at.push(c.to_vec());
                    }
                    if i < last && *c != b".." {
                        let p = join(&at);
                        if links.contains(&p) {
                            return Err(Refusal::ThroughLink);
                        }
                        walked.push(p);
                    }
                }
            }
            Kind::Hardlink => {
                let target = components(&link, Refusal::HardlinkEscape, Refusal::HardlinkEscape)?;
                if target.is_empty() || !files.contains(&join(&target)) {
                    return Err(Refusal::HardlinkEscape);
                }
            }
            Kind::File | Kind::Dir => {}
        }

        if size > limits.max_entry_bytes {
            return Err(Refusal::EntryTooLarge);
        }
        total = total.saturating_add(size);
        if total > limits.max_total_bytes {
            return Err(Refusal::TotalTooLarge);
        }
        name_bytes = name_bytes.saturating_add(path.len() as u64);
        if name_bytes > limits.max_name_total_bytes {
            return Err(Refusal::TooManyEntries);
        }

        for p in walked {
            dirs.insert(p);
        }
        for i in 1..parts.len() {
            dirs.insert(join(parts.get(..i).unwrap_or_default()));
        }
        match kind {
            Kind::Dir => {
                dirs.insert(path.clone());
            }
            Kind::File => {
                files.insert(path.clone());
            }
            Kind::Symlink => {
                links.insert(path.clone());
            }
            Kind::Hardlink => {}
        }
        seen.insert(path);
        r.skip(round_up(size)?)?;
    }
}

/// `{"ok":true,"entries":n,"bytes":n}` or `{"ok":false,"code":…,"message":…}`.
pub fn verdict_json(v: &Result<Summary, Refusal>) -> serde_json::Value {
    match v {
        Ok(s) => serde_json::json!({ "ok": true, "entries": s.entries, "bytes": s.bytes }),
        Err(e) => serde_json::json!({ "ok": false, "code": e.code(), "message": e.message() }),
    }
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

    #[test]
    fn sizes_parse_like_the_twin() {
        assert_eq!(parse_size(b"00000000017\0").unwrap(), 0o17);
        assert_eq!(parse_size(b"        17 \0").unwrap(), 0o17);
        assert!(parse_size(b"0000000009z\0").is_err());
        let mut f = [0u8; 12];
        f[0] = 0x80;
        f[11] = 2;
        assert_eq!(parse_size(&f).unwrap(), 2);
    }

    #[test]
    fn pax_records_need_exact_lengths() {
        assert_eq!(
            parse_pax(b"12 path=abc\n")
                .unwrap()
                .get(b"path".as_slice())
                .unwrap(),
            b"abc"
        );
        assert!(parse_pax(b"99 path=x\n").is_err());
        assert!(parse_pax(b"11 =abcdef\n").is_err());
    }
}
