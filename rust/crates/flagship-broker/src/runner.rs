//! Running one validated v1 command (privd's `realRunner`, `openTransferFds`, `copyInFiles`):
//! a fixed binary from a closed list, an argv, a clean environment, no shell, bounded time and
//! output. Files the daemon hands over are opened by the broker itself, every directory on the way
//! walked without following a link, so a path swapped between the check and the open is refused.

use crate::policy::{DAEMON_TRANSFER_ROOTS, PrivExec, transfer_path};
use flagship_runtime::exec::{ExecOutput, MAX_OUTPUT};
use rustix::fs::{Mode, OFlags, fchown, fstat, openat};
use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Every binary a v1 policy can name. Anything else is refused before it is spawned.
pub const V1_BINARIES: &[&str] = &[
    "/usr/bin/docker",
    "/usr/bin/podman",
    "/usr/bin/systemctl",
    "/usr/sbin/nft",
    "/usr/bin/mount",
    "/usr/bin/umount",
    "/usr/bin/chattr",
    "/usr/sbin/losetup",
    "/usr/sbin/resize2fs",
    "/usr/bin/cp",
    "/usr/bin/du",
    "/usr/bin/chmod",
    "/usr/bin/mkdir",
    "/usr/bin/truncate",
    "/usr/bin/fallocate",
    "/usr/sbin/mkfs.ext4",
    "/usr/bin/touch",
    "/usr/bin/rm",
    "/usr/bin/rmdir",
    "/usr/bin/mv",
    "/bin/sh",
    "/usr/bin/networkctl",
    "/usr/sbin/ip",
    "/usr/sbin/sysctl",
    "/usr/sbin/iptables",
    "/usr/sbin/ip6tables",
    "/usr/sbin/iptables-restore",
    "/usr/sbin/ip6tables-restore",
    "/usr/bin/bash",
    "/usr/local/bin/node",
];

pub trait V1Runner: Send + Sync {
    fn run(&self, e: &PrivExec) -> ExecOutput;
}

/// The daemon's account: the only owner whose files the broker streams.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DaemonAccount {
    pub uid: u32,
    pub gid: u32,
}

/// `daemonAccount`: the account in a passwd file, or `None` (then nothing is streamed).
pub fn daemon_account(name: &str, passwd: &Path) -> Option<DaemonAccount> {
    let text = std::fs::read_to_string(passwd).ok()?;
    text.lines().find_map(|line| {
        let f: Vec<&str> = line.split(':').collect();
        if f.first() != Some(&name) || f.len() < 4 {
            return None;
        }
        Some(DaemonAccount {
            uid: f.get(2)?.parse().ok()?,
            gid: f.get(3)?.parse().ok()?,
        })
    })
}

/// `getent group`: a group's id from a group file.
pub fn group_id(name: &str, group: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(group).ok()?;
    text.lines().find_map(|line| {
        let f: Vec<&str> = line.split(':').collect();
        (f.first() == Some(&name) && f.len() >= 3)
            .then(|| f.get(2).and_then(|g| g.parse().ok()))
            .flatten()
    })
}

fn refuse(m: impl Into<String>) -> String {
    m.into()
}

const DIR_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

/// Open a directory by its canonical path one component at a time, following no link: a
/// component swapped for a link after `canonicalize` makes the walk fail.
fn walk_dir(path: &Path) -> std::io::Result<OwnedFd> {
    let mut fd = openat(rustix::fs::CWD, "/", DIR_FLAGS, Mode::empty())?;
    for c in path.components() {
        match c {
            Component::RootDir => {}
            Component::Normal(n) => fd = openat(&fd, n, DIR_FLAGS, Mode::empty())?,
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "not a canonical path",
                ));
            }
        }
    }
    Ok(fd)
}

fn under_roots(real: &Path) -> bool {
    let s = real.to_string_lossy();
    DAEMON_TRANSFER_ROOTS
        .iter()
        .any(|r| s.starts_with(r) || format!("{s}/").starts_with(r))
}

/// The folder a transfer file lives in, opened safely, and the file's own name.
fn transfer_parent(p: &str) -> Result<(OwnedFd, String), String> {
    let path = PathBuf::from(transfer_path(p).map_err(|e| e.message)?);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| refuse("bad path"))?;
    let dir = path.parent().ok_or_else(|| refuse("bad path"))?;
    let real = std::fs::canonicalize(dir)
        .map_err(|e| format!("that transfer file cannot be used: {e}"))?;
    if !under_roots(&real) {
        return Err(refuse("that file is outside the daemon's transfer folders"));
    }
    let fd = walk_dir(&real).map_err(|e| format!("that transfer file cannot be used: {e}"))?;
    Ok((fd, name))
}

fn is_regular(mode: rustix::fs::RawMode) -> bool {
    rustix::fs::FileType::from_raw_mode(mode) == rustix::fs::FileType::RegularFile
}

/// A regular file the daemon owns, opened read-only without following a link.
fn open_daemon_file(p: &str, account: DaemonAccount, what: &str) -> Result<OwnedFd, String> {
    let (dir, name) = transfer_parent(p)?;
    let fd = openat(
        &dir,
        name.as_str(),
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|e| format!("that transfer file cannot be used: {e}"))?;
    let st = fstat(&fd).map_err(|e| e.to_string())?;
    if !is_regular(st.st_mode) || st.st_uid != account.uid {
        return Err(refuse(format!(
            "the broker {what} only the daemon's own regular files"
        )));
    }
    Ok(fd)
}

/// A new file in a folder the daemon owns, created by the broker and handed to the daemon.
fn create_daemon_file(p: &str, account: DaemonAccount) -> Result<OwnedFd, String> {
    let (dir, name) = transfer_parent(p)?;
    let st = fstat(&dir).map_err(|e| e.to_string())?;
    if st.st_uid != account.uid {
        return Err(refuse(
            "the broker writes only into the daemon's own folders",
        ));
    }
    let fd = openat(
        &dir,
        name.as_str(),
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )
    .map_err(|e| format!("that transfer file cannot be used: {e}"))?;
    fchown(
        &fd,
        Some(rustix::fs::Uid::from_raw(account.uid)),
        Some(rustix::fs::Gid::from_raw(account.gid)),
    )
    .map_err(|e| e.to_string())?;
    Ok(fd)
}

/// `copyInFiles`: the daemon's files copied into the broker's own folder before use.
pub fn copy_in_files(e: &PrivExec, account: Option<DaemonAccount>) -> Result<(), String> {
    if e.copy_in.is_empty() {
        return Ok(());
    }
    let account = account.ok_or_else(|| refuse("the daemon's account does not exist"))?;
    for c in &e.copy_in {
        let to = Path::new(&c.to);
        if let Some(parent) = to.parent() {
            std::os::unix::fs::DirBuilderExt::mode(
                std::fs::DirBuilder::new().recursive(true),
                0o700,
            )
            .create(parent)
            .map_err(|e| e.to_string())?;
        }
        match std::fs::remove_file(to) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        let src = open_daemon_file(&c.from, account, "copies")?;
        let dst = rustix::fs::open(
            to,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        )
        .map_err(|e| e.to_string())?;
        std::io::copy(&mut std::fs::File::from(src), &mut std::fs::File::from(dst))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn drop_copies(e: &PrivExec) {
    for c in &e.copy_in {
        let _ = std::fs::remove_file(&c.to);
    }
}

fn keep_tail(buf: &mut Vec<u8>) {
    if buf.len() > MAX_OUTPUT {
        let cut = buf.len().saturating_sub(MAX_OUTPUT);
        buf.drain(..cut);
    }
}

fn reader<R: Read + Send + 'static>(src: Option<R>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut out = Vec::new();
        let Some(mut src) = src else { return out };
        let mut chunk = [0u8; 8192];
        loop {
            match src.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    out.extend_from_slice(chunk.get(..n).unwrap_or_default());
                    keep_tail(&mut out);
                }
            }
        }
        out
    })
}

fn failed(stderr: String) -> ExecOutput {
    ExecOutput {
        code: None,
        stderr,
        ..ExecOutput::default()
    }
}

/// The real runner. `passwd` names the daemon's account for transfer files.
#[derive(Debug, Clone)]
pub struct SystemRunner {
    pub account_name: String,
    pub passwd: PathBuf,
}

impl Default for SystemRunner {
    fn default() -> Self {
        Self {
            account_name: "flagship".into(),
            passwd: PathBuf::from("/etc/passwd"),
        }
    }
}

impl V1Runner for SystemRunner {
    fn run(&self, e: &PrivExec) -> ExecOutput {
        if !V1_BINARIES.contains(&e.file) {
            return failed(format!("{} is not a pinned binary", e.file));
        }
        let account = daemon_account(&self.account_name, &self.passwd);
        if let Err(m) = copy_in_files(e, account) {
            drop_copies(e);
            return failed(m);
        }
        let opened = (|| -> Result<(Option<OwnedFd>, Option<OwnedFd>), String> {
            if e.stdin_file.is_none() && e.stdout_file.is_none() {
                return Ok((None, None));
            }
            let account = account.ok_or_else(|| refuse("the daemon's account does not exist"))?;
            let stdin = match &e.stdin_file {
                Some(p) => Some(open_daemon_file(p, account, "reads")?),
                None => None,
            };
            let stdout = match &e.stdout_file {
                Some(p) => Some(create_daemon_file(p, account)?),
                None => None,
            };
            Ok((stdin, stdout))
        })();
        let (stdin_fd, stdout_fd) = match opened {
            Ok(fds) => fds,
            Err(m) => {
                drop_copies(e);
                return failed(m);
            }
        };
        let out = spawn(e, stdin_fd, stdout_fd);
        drop_copies(e);
        out
    }
}

fn spawn(e: &PrivExec, stdin_fd: Option<OwnedFd>, stdout_fd: Option<OwnedFd>) -> ExecOutput {
    let mut cmd = Command::new(e.file);
    cmd.args(&e.args)
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LANG", "C")
        .envs(e.env.iter())
        .current_dir("/");
    cmd.stdin(match stdin_fd {
        Some(fd) => Stdio::from(fd),
        None if e.input.is_some() => Stdio::piped(),
        None => Stdio::null(),
    });
    cmd.stdout(match stdout_fd {
        Some(fd) => Stdio::from(fd),
        None => Stdio::piped(),
    });
    cmd.stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => return failed(err.to_string()),
    };
    let writer = match (e.input.clone(), child.stdin.take()) {
        (Some(text), Some(mut stdin)) => Some(thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
        })),
        _ => None,
    };
    let out = reader(child.stdout.take());
    let err = reader(child.stderr.take());
    let deadline = Instant::now().checked_add(Duration::from_millis(e.timeout_ms));
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(_) => break None,
        }
        if deadline.is_none_or(|d| Instant::now() >= d) {
            timed_out = true;
            let _ = child.kill();
            break child.wait().ok();
        }
        thread::sleep(Duration::from_millis(10));
    };
    if let Some(w) = writer {
        let _ = w.join();
    }
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    ExecOutput {
        code: if timed_out {
            None
        } else {
            status.and_then(|s| s.code())
        },
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        timed_out,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::policy::CopyIn;

    fn tmp(tag: &str) -> PathBuf {
        let p = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("fs-runner-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// A folder under the real transfer root, or `None` where /var/tmp is itself a link (macOS).
    fn transfer_test_dir(tag: &str) -> Option<PathBuf> {
        let dir = PathBuf::from(format!(
            "/var/tmp/.flagship-broker-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).ok()?;
        if std::fs::canonicalize(&dir).ok()? != dir {
            let _ = std::fs::remove_dir_all(&dir);
            return None;
        }
        Some(dir)
    }

    #[test]
    fn reads_accounts_and_groups() {
        let d = tmp("acct");
        std::fs::write(
            d.join("passwd"),
            "root:x:0:0::/root:/bin/sh\nflagship:x:994:993::/nonexistent:/usr/sbin/nologin\n",
        )
        .unwrap();
        std::fs::write(d.join("group"), "root:x:0:\nflagship:x:993:\n").unwrap();
        assert_eq!(
            daemon_account("flagship", &d.join("passwd")),
            Some(DaemonAccount { uid: 994, gid: 993 })
        );
        assert_eq!(daemon_account("nobody", &d.join("passwd")), None);
        assert_eq!(group_id("flagship", &d.join("group")), Some(993));
        assert_eq!(group_id("x", &d.join("group")), None);
    }

    #[test]
    fn refuses_a_binary_off_the_list_without_running_it() {
        let out = SystemRunner::default().run(&PrivExec {
            file: "/usr/bin/env",
            ..PrivExec::default()
        });
        assert_eq!(out.code, None);
        assert!(out.stderr.contains("not a pinned binary"));
    }

    #[test]
    fn copies_only_a_regular_file_the_daemon_owns_never_through_a_link() {
        let Some(dir) = transfer_test_dir("copy") else {
            return;
        };
        let stage = tmp("stage");
        let me = DaemonAccount {
            uid: rustix::process::getuid().as_raw(),
            gid: rustix::process::getgid().as_raw(),
        };
        std::fs::write(dir.join("a.tar.gz"), "release").unwrap();
        let ex = |from: &Path, to: &Path| PrivExec {
            copy_in: vec![CopyIn {
                from: from.to_string_lossy().into_owned(),
                to: to.to_string_lossy().into_owned(),
            }],
            ..PrivExec::default()
        };
        copy_in_files(
            &ex(&dir.join("a.tar.gz"), &stage.join("r/a.tar.gz")),
            Some(me),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(stage.join("r/a.tar.gz")).unwrap(),
            "release"
        );
        std::os::unix::fs::symlink("/etc/hosts", dir.join("link")).unwrap();
        assert!(copy_in_files(&ex(&dir.join("link"), &stage.join("l")), Some(me)).is_err());
        let other = DaemonAccount {
            uid: me.uid.saturating_add(1),
            gid: me.gid,
        };
        let e =
            copy_in_files(&ex(&dir.join("a.tar.gz"), &stage.join("o")), Some(other)).unwrap_err();
        assert!(e.contains("daemon's own"), "{e}");
        assert!(copy_in_files(&ex(Path::new("/etc/hosts"), &stage.join("h")), Some(me)).is_err());
        assert!(copy_in_files(&ex(&dir.join("a.tar.gz"), &stage.join("n")), None).is_err());
        // A folder link inside the transfer root that points out of it is refused too.
        std::os::unix::fs::symlink(&stage, dir.join("out")).unwrap();
        std::fs::write(stage.join("mine"), "x").unwrap();
        assert!(copy_in_files(&ex(&dir.join("out/mine"), &stage.join("m")), Some(me)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&stage);
    }

    #[test]
    fn writes_a_new_file_only_in_the_daemons_folder() {
        let Some(dir) = transfer_test_dir("out") else {
            return;
        };
        let me = DaemonAccount {
            uid: rustix::process::getuid().as_raw(),
            gid: rustix::process::getgid().as_raw(),
        };
        let p = dir.join("image.tar").to_string_lossy().into_owned();
        assert!(create_daemon_file(&p, me).is_ok());
        assert!(
            create_daemon_file(&p, me).is_err(),
            "an existing file is never reused"
        );
        let other = DaemonAccount {
            uid: me.uid.saturating_add(1),
            gid: me.gid,
        };
        let q = dir.join("x.tar").to_string_lossy().into_owned();
        assert!(create_daemon_file(&q, other).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn runs_with_a_clean_environment_and_bounded_time() {
        let out = SystemRunner::default().run(&PrivExec {
            file: "/bin/sh",
            args: vec![
                "-c".into(),
                "printf \"$PATH|$PGPASSWORD|$HOME\"; cat".into(),
            ],
            timeout_ms: 5_000,
            input: Some("in".into()),
            env: [("PGPASSWORD".to_owned(), "p".to_owned())]
                .into_iter()
                .collect(),
            ..PrivExec::default()
        });
        assert_eq!(out.code, Some(0));
        assert_eq!(out.stdout, "/usr/sbin:/usr/bin:/sbin:/bin|p|in");
        let slow = SystemRunner::default().run(&PrivExec {
            file: "/bin/sh",
            args: vec!["-c".into(), "sleep 5".into()],
            timeout_ms: 100,
            ..PrivExec::default()
        });
        assert!(slow.timed_out);
        assert_eq!(slow.code, None);
    }
}
