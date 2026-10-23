//! The real clock, and the optional console fallback.
//!
//! The shell waits with `read -t <backoff> < /dev/console`: any line ends the
//! wait and `manual` drops to the passphrase prompt. When the console cannot
//! be read, `read` returns at once, so today's loop polls with no delay at
//! all. Here an unreadable or closed console falls back to sleeping.

use super::flow::{Clock, Wake};
use std::io::BufRead;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Wall clock plus `thread::sleep`, optionally interruptible by a console.
#[derive(Debug)]
pub struct SystemClock {
    console: Option<Receiver<String>>,
}

impl SystemClock {
    /// No console fallback (production `boot-stage.sh` behaviour).
    pub fn new() -> Self {
        Self { console: None }
    }

    /// Read lines from `console` (e.g. `/dev/console`) during waits.
    pub fn with_console(console: &Path) -> Self {
        let (tx, rx) = mpsc::channel();
        let path = console.to_path_buf();
        let spawned = std::thread::Builder::new()
            .name("console".into())
            .spawn(move || {
                let Ok(f) = std::fs::File::open(&path) else {
                    return;
                };
                for line in std::io::BufReader::new(f).lines() {
                    let Ok(line) = line else { return };
                    if tx.send(line).is_err() {
                        return;
                    }
                }
            });
        Self {
            console: spawned.ok().map(|_| rx),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

fn since_epoch() -> Duration {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
}

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        u64::try_from(since_epoch().as_millis()).unwrap_or(u64::MAX)
    }

    fn now_secs(&self) -> u64 {
        since_epoch().as_secs()
    }

    fn wait(&self, secs: u64) -> Wake {
        let total = Duration::from_secs(secs);
        let start = Instant::now();
        if let Some(rx) = &self.console {
            match rx.recv_timeout(total) {
                Ok(line) if line.trim() == "manual" => return Wake::Manual,
                Ok(_) | Err(RecvTimeoutError::Timeout) => return Wake::Elapsed,
                Err(RecvTimeoutError::Disconnected) => {}
            }
        }
        std::thread::sleep(total.saturating_sub(start.elapsed()));
        Wake::Elapsed
    }
}
