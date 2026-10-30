//! A bounded `tar.gz` reader. The artifact is untrusted until its digest and signatures checked
//! out, and even then nothing it contains may name a path outside the release directory, so this
//! reads the archive itself rather than handing it to `tar`:
//!
//! - regular files, directories and relative symlinks only: hardlinks, devices, FIFOs and every
//!   other type are refused;
//! - no absolute path, no `..` component, no control character, no duplicate entry (every file is
//!   created with `O_EXCL` in a directory that did not exist), and no entry below a symlink;
//! - a symlink target is relative and may climb (`..`) only at its start and only as far as the
//!   release directory, so no chain of links can leave it;
//! - the header checksum is checked; a size, an entry count, a path length and the decompressed
//!   total are capped, so a bomb ends in a refusal, not a full disk.
//!
//! The first path component is stripped (`tar --strip-components=1`), as the shell installer did.

use crate::refusal::Refusal;
use flate2::read::GzDecoder;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

const BLOCK: usize = 512;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_entries: usize,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub max_path_bytes: usize,
    pub max_depth: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_entries: 600_000,
            max_total_bytes: 3 << 30,
            max_file_bytes: 1 << 30,
            max_path_bytes: 1024,
            max_depth: 48,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Extracted {
    pub files: usize,
    pub dirs: usize,
    pub symlinks: usize,
    pub bytes: u64,
}

fn refuse(detail: impl Into<String>) -> Refusal {
    Refusal::with("unsafe-artifact", detail)
}

fn io_refusal(e: &io::Error) -> Refusal {
    Refusal::with("unpack-failed", e.to_string())
}

/// Caps the decompressed stream: a gzip bomb ends here.
struct Capped<R> {
    inner: R,
    left: u64,
}

impl<R: Read> Read for Capped<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        let n64 = u64::try_from(n).unwrap_or(u64::MAX);
        if n64 > self.left {
            return Err(io::Error::other("the archive expands past its limit"));
        }
        self.left = self.left.saturating_sub(n64);
        Ok(n)
    }
}

fn read_block<R: Read>(r: &mut R, block: &mut [u8; BLOCK]) -> io::Result<bool> {
    let mut filled = 0usize;
    while filled < BLOCK {
        let n = r.read(block.get_mut(filled..).unwrap_or(&mut []))?;
        if n == 0 {
            return if filled == 0 {
                Ok(false)
            } else {
                Err(io::Error::new(io::ErrorKind::UnexpectedEof, "short block"))
            };
        }
        filled = filled.saturating_add(n);
    }
    Ok(true)
}

fn cstr(field: &[u8]) -> &[u8] {
    let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
    field.get(..end).unwrap_or(&[])
}

fn octal(field: &[u8]) -> Option<u64> {
    if field.first().is_some_and(|b| b & 0x80 != 0) {
        // base-256: only plain positive values
        let mut v: u64 = u64::from(field.first().copied().unwrap_or(0) & 0x7f);
        for b in field.get(1..)? {
            v = v.checked_mul(256)?.checked_add(u64::from(*b))?;
        }
        return Some(v);
    }
    let s: Vec<u8> = field
        .iter()
        .copied()
        .skip_while(|b| *b == b' ')
        .take_while(|b| matches!(b, b'0'..=b'7'))
        .collect();
    if s.is_empty() {
        return Some(0);
    }
    let mut v: u64 = 0;
    for b in s {
        v = v
            .checked_mul(8)?
            .checked_add(u64::from(b.wrapping_sub(b'0')))?;
    }
    Some(v)
}

fn checksum_ok(block: &[u8; BLOCK]) -> bool {
    let stored = block.get(148..156).and_then(octal);
    let mut sum: u64 = 0;
    for (i, b) in block.iter().enumerate() {
        let v = if (148..156).contains(&i) { b' ' } else { *b };
        sum = sum.saturating_add(u64::from(v));
    }
    stored == Some(sum)
}

fn padded(len: u64) -> u64 {
    len.div_ceil(512).saturating_mul(512)
}

fn read_exact_vec<R: Read>(r: &mut R, len: u64, cap: u64) -> Result<Vec<u8>, Refusal> {
    if len > cap {
        return Err(refuse("a header entry is too large"));
    }
    let n = usize::try_from(len).map_err(|_| refuse("size"))?;
    let mut v = vec![0u8; n];
    r.read_exact(&mut v).map_err(|e| io_refusal(&e))?;
    skip(r, padded(len).saturating_sub(len))?;
    Ok(v)
}

fn skip<R: Read>(r: &mut R, mut n: u64) -> Result<(), Refusal> {
    let mut buf = [0u8; 8192];
    while n > 0 {
        let want = usize::try_from(n.min(8192)).unwrap_or(8192);
        let got = r
            .read(buf.get_mut(..want).unwrap_or(&mut []))
            .map_err(|e| io_refusal(&e))?;
        if got == 0 {
            return Err(refuse("the archive ends inside an entry"));
        }
        n = n.saturating_sub(u64::try_from(got).unwrap_or(0));
    }
    Ok(())
}

fn pax_records(data: &[u8]) -> Option<Vec<(String, Vec<u8>)>> {
    let mut out = Vec::new();
    let mut rest = data;
    while !rest.is_empty() {
        let sp = rest.iter().position(|b| *b == b' ')?;
        let len: usize = std::str::from_utf8(rest.get(..sp)?).ok()?.parse().ok()?;
        if len <= sp.saturating_add(1) || len > rest.len() {
            return None;
        }
        let rec = rest.get(sp.saturating_add(1)..len)?;
        let rec = rec.strip_suffix(b"\n")?;
        let eq = rec.iter().position(|b| *b == b'=')?;
        let key = String::from_utf8(rec.get(..eq)?.to_vec()).ok()?;
        out.push((key, rec.get(eq.saturating_add(1)..)?.to_vec()));
        rest = rest.get(len..)?;
    }
    Some(out)
}

/// A path split into safe components with the first `strip` removed; `None` = skip the entry.
fn components(raw: &[u8], strip: usize, limits: &Limits) -> Result<Option<Vec<String>>, Refusal> {
    if raw.len() > limits.max_path_bytes {
        return Err(refuse("a path is too long"));
    }
    if raw.iter().any(|b| *b < 0x20 || *b == 0x7f) {
        return Err(refuse("a path holds a control character"));
    }
    if raw.first() == Some(&b'/') {
        return Err(refuse("an absolute path"));
    }
    let text = std::str::from_utf8(raw).map_err(|_| refuse("a path is not UTF-8"))?;
    let mut parts: Vec<String> = Vec::new();
    for c in text.split('/') {
        match c {
            "" | "." => {}
            ".." => return Err(refuse("a path climbs out with ..")),
            other => parts.push(other.to_owned()),
        }
    }
    if parts.len() <= strip {
        return Ok(None);
    }
    let kept: Vec<String> = parts.into_iter().skip(strip).collect();
    if kept.len() > limits.max_depth {
        return Err(refuse("a path is too deep"));
    }
    Ok(Some(kept))
}

/// Checks a symlink target and returns it as text.
fn link_target(raw: &[u8], depth_of_link_dir: usize) -> Result<String, Refusal> {
    if raw.is_empty() || raw.iter().any(|b| *b < 0x20 || *b == 0x7f) || raw.first() == Some(&b'/') {
        return Err(refuse(
            "a symlink target is empty, absolute or has a control character",
        ));
    }
    let text = std::str::from_utf8(raw).map_err(|_| refuse("a symlink target is not UTF-8"))?;
    let mut ups = 0usize;
    let mut descended = false;
    for c in text.split('/') {
        match c {
            "" | "." => {}
            ".." if !descended => ups = ups.saturating_add(1),
            ".." => return Err(refuse("a symlink target climbs after descending")),
            _ => descended = true,
        }
    }
    if ups > depth_of_link_dir {
        return Err(refuse("a symlink target leaves the release"));
    }
    Ok(text.to_owned())
}

struct Writer<'a> {
    dest: &'a Path,
    real_dirs: HashSet<PathBuf>,
}

impl Writer<'_> {
    /// Creates the parents of `rel` as real directories; refuses one that is a link.
    fn parents(&mut self, rel: &[String]) -> Result<PathBuf, Refusal> {
        let mut cur = self.dest.to_path_buf();
        let last = rel.len().saturating_sub(1);
        for c in rel.iter().take(last) {
            cur.push(c);
            if self.real_dirs.contains(&cur) {
                continue;
            }
            match fs::symlink_metadata(&cur) {
                Ok(m) if m.file_type().is_dir() => {}
                Ok(_) => return Err(refuse("an entry lies below a file or a link")),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    fs::create_dir(&cur).map_err(|e| io_refusal(&e))?;
                    fs::set_permissions(&cur, fs::Permissions::from_mode(0o755))
                        .map_err(|e| io_refusal(&e))?;
                }
                Err(e) => return Err(io_refusal(&e)),
            }
            self.real_dirs.insert(cur.clone());
        }
        let name = rel.last().ok_or_else(|| refuse("an empty path"))?;
        cur.push(name);
        Ok(cur)
    }
}

/// Unpacks `artifact` (a gzip tar) into the empty directory `dest`.
///
/// # Errors
/// `unsafe-artifact` for anything the rules above refuse, `unpack-failed` for an I/O error.
pub fn extract_tar_gz(
    artifact: &Path,
    dest: &Path,
    strip: usize,
    limits: &Limits,
) -> Result<Extracted, Refusal> {
    let file = File::open(artifact).map_err(|e| io_refusal(&e))?;
    let mut r = Capped {
        inner: GzDecoder::new(file),
        left: limits.max_total_bytes.saturating_add(1 << 24),
    };
    let mut w = Writer {
        dest,
        real_dirs: HashSet::new(),
    };
    let mut stats = Extracted::default();
    let mut entries = 0usize;
    let mut long_name: Option<Vec<u8>> = None;
    let mut long_link: Option<Vec<u8>> = None;
    let mut pax_path: Option<Vec<u8>> = None;
    let mut pax_link: Option<Vec<u8>> = None;
    let mut pax_size: Option<u64> = None;
    let mut block = [0u8; BLOCK];
    let mut zero_blocks = 0u8;
    loop {
        if !read_block(&mut r, &mut block).map_err(|e| io_refusal(&e))? {
            break;
        }
        if block.iter().all(|b| *b == 0) {
            zero_blocks = zero_blocks.saturating_add(1);
            if zero_blocks >= 2 {
                break;
            }
            continue;
        }
        zero_blocks = 0;
        if !checksum_ok(&block) {
            return Err(refuse("a header checksum is wrong"));
        }
        let header_size = block
            .get(124..136)
            .and_then(octal)
            .ok_or_else(|| refuse("a size field is not valid"))?;
        let typeflag = block.get(156).copied().unwrap_or(0);
        match typeflag {
            b'L' => {
                long_name = Some(read_exact_vec(&mut r, header_size, 8192)?);
                continue;
            }
            b'K' => {
                long_link = Some(read_exact_vec(&mut r, header_size, 8192)?);
                continue;
            }
            b'x' => {
                let data = read_exact_vec(&mut r, header_size, 1 << 20)?;
                for (k, v) in
                    pax_records(&data).ok_or_else(|| refuse("a pax header is malformed"))?
                {
                    match k.as_str() {
                        "path" => pax_path = Some(v),
                        "linkpath" => pax_link = Some(v),
                        "size" => {
                            pax_size = std::str::from_utf8(&v).ok().and_then(|s| s.parse().ok());
                        }
                        _ => {}
                    }
                }
                continue;
            }
            b'g' => {
                skip(&mut r, padded(header_size))?;
                continue;
            }
            _ => {}
        }
        entries = entries.saturating_add(1);
        if entries > limits.max_entries {
            return Err(refuse("too many entries"));
        }
        let size = pax_size.take().unwrap_or(header_size);
        let mut name: Vec<u8> = cstr(block.get(0..100).unwrap_or(&[])).to_vec();
        if block.get(257..262) == Some(b"ustar".as_slice()) {
            let prefix = cstr(block.get(345..500).unwrap_or(&[]));
            if !prefix.is_empty() {
                let mut full = prefix.to_vec();
                full.push(b'/');
                full.extend_from_slice(&name);
                name = full;
            }
        }
        if let Some(n) = long_name.take() {
            name = cstr(&n).to_vec();
        }
        if let Some(n) = pax_path.take() {
            name = n;
        }
        let mut link: Vec<u8> = cstr(block.get(157..257).unwrap_or(&[])).to_vec();
        if let Some(n) = long_link.take() {
            link = cstr(&n).to_vec();
        }
        if let Some(n) = pax_link.take() {
            link = n;
        }
        let mode = block.get(100..108).and_then(octal).unwrap_or(0o644);
        let parts = components(&name, strip, limits)?;
        match typeflag {
            b'0' | 0 | b'7' => {
                if size > limits.max_file_bytes {
                    return Err(refuse("a file is too large"));
                }
                stats.bytes = stats.bytes.saturating_add(size);
                if stats.bytes > limits.max_total_bytes {
                    return Err(refuse("the archive is too large"));
                }
                let Some(rel) = parts else {
                    skip(&mut r, padded(size))?;
                    continue;
                };
                let path = w.parents(&rel)?;
                let perm = if mode & 0o111 != 0 { 0o755 } else { 0o644 };
                let mut out = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(perm)
                    .open(&path)
                    .map_err(|e| io_refusal(&e))?;
                let mut left = size;
                let mut buf = vec![0u8; 1 << 16];
                while left > 0 {
                    let want = usize::try_from(left.min(1 << 16)).unwrap_or(1 << 16);
                    let got = r
                        .read(buf.get_mut(..want).unwrap_or(&mut []))
                        .map_err(|e| io_refusal(&e))?;
                    if got == 0 {
                        return Err(refuse("the archive ends inside a file"));
                    }
                    out.write_all(buf.get(..got).unwrap_or(&[]))
                        .map_err(|e| io_refusal(&e))?;
                    left = left.saturating_sub(u64::try_from(got).unwrap_or(0));
                }
                out.flush().map_err(|e| io_refusal(&e))?;
                fs::set_permissions(&path, fs::Permissions::from_mode(perm))
                    .map_err(|e| io_refusal(&e))?;
                skip(&mut r, padded(size).saturating_sub(size))?;
                stats.files = stats.files.saturating_add(1);
            }
            b'5' => {
                skip(&mut r, padded(size))?;
                let Some(rel) = parts else { continue };
                let path = w.parents(&rel)?;
                match fs::symlink_metadata(&path) {
                    Ok(m) if m.file_type().is_dir() => {}
                    Ok(_) => return Err(refuse("a directory entry names a file or a link")),
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {
                        fs::create_dir(&path).map_err(|e| io_refusal(&e))?;
                        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                            .map_err(|e| io_refusal(&e))?;
                    }
                    Err(e) => return Err(io_refusal(&e)),
                }
                w.real_dirs.insert(path);
                stats.dirs = stats.dirs.saturating_add(1);
            }
            b'2' => {
                skip(&mut r, padded(size))?;
                let Some(rel) = parts else { continue };
                let depth = rel.len().saturating_sub(1);
                let target = link_target(&link, depth)?;
                let path = w.parents(&rel)?;
                std::os::unix::fs::symlink(&target, &path).map_err(|e| io_refusal(&e))?;
                stats.symlinks = stats.symlinks.saturating_add(1);
            }
            b'1' => return Err(refuse("a hard link")),
            other => {
                return Err(refuse(format!(
                    "an entry of type {:?} (devices, FIFOs and other special files are refused)",
                    char::from(other)
                )));
            }
        }
    }
    Ok(stats)
}
