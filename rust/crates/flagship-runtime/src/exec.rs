//! Running one fixed binary: an absolute path from a closed list, an argument vector, a minimal
//! environment, no shell, bounded time and bounded output (privd's `realRunner`).

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Binaries anything in the platform may run, by absolute path.
pub const PINNED_BINARIES: &[&str] = &[
    "/usr/bin/docker",
    "/usr/bin/podman",
    "/usr/bin/systemctl",
    "/usr/sbin/nft",
];
pub const MAX_OUTPUT: usize = 256 * 1024;
const MINIMAL_ENV: &[(&str, &str)] = &[("PATH", "/usr/sbin:/usr/bin:/sbin:/bin"), ("LANG", "C")];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exec {
    pub file: &'static str,
    pub args: Vec<String>,
    pub timeout: Duration,
    pub input: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ExecOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

pub trait Executor: Send + Sync {
    fn run(&self, exec: &Exec) -> ExecOutput;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemExecutor;

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

impl Executor for SystemExecutor {
    fn run(&self, exec: &Exec) -> ExecOutput {
        if !PINNED_BINARIES.contains(&exec.file) {
            return ExecOutput {
                code: None,
                stderr: format!("{} is not a pinned binary", exec.file),
                ..ExecOutput::default()
            };
        }
        let mut cmd = Command::new(exec.file);
        cmd.args(&exec.args)
            .env_clear()
            .envs(MINIMAL_ENV.iter().copied())
            .current_dir("/");
        cmd.stdin(if exec.input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return ExecOutput {
                    code: None,
                    stderr: e.to_string(),
                    ..ExecOutput::default()
                };
            }
        };
        let writer = match (exec.input.clone(), child.stdin.take()) {
            (Some(text), Some(mut stdin)) => Some(thread::spawn(move || {
                let _ = stdin.write_all(text.as_bytes());
            })),
            _ => None,
        };
        let out = reader(child.stdout.take());
        let err = reader(child.stderr.take());
        let deadline = Instant::now().checked_add(exec.timeout);
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_unpinned_binaries_without_running_them() {
        let out = SystemExecutor.run(&Exec {
            file: "/bin/sh",
            args: vec!["-c".into(), "id".into()],
            timeout: Duration::from_secs(1),
            input: None,
        });
        assert_eq!(out.code, None);
        assert!(out.stderr.contains("not a pinned binary"));
    }
}
