#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use flagship_broker::peer::{Peer, PeerAuthenticator};
use flagship_broker::podman::EngineKind;
use flagship_broker::policy::{PrivExec, ReleaseTrust};
use flagship_broker::privd::FixedEnvironment;
use flagship_broker::runner::V1Runner;
use flagship_broker::wire::{FrameReader, encode_frame};
use flagship_runtime::exec::{Exec, ExecOutput, Executor};
use serde_json::Value;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// Stands in for SO_PEERCRED, which macOS lacks. Test-only; production uses KernelPeerCredentials.
pub struct FixedPeer(pub u32);

impl PeerAuthenticator for FixedPeer {
    fn peer(&self, _: &UnixStream) -> std::io::Result<Peer> {
        Ok(Peer {
            uid: self.0,
            gid: self.0,
            pid: None,
        })
    }
}

#[derive(Default)]
pub struct Recorder {
    pub ran: Mutex<Vec<Exec>>,
    pub answer: Mutex<Option<ExecOutput>>,
}

impl Executor for Recorder {
    fn run(&self, exec: &Exec) -> ExecOutput {
        self.ran.lock().unwrap().push(exec.clone());
        self.answer.lock().unwrap().clone().unwrap_or(ExecOutput {
            code: Some(0),
            stdout: "done".into(),
            stderr: String::new(),
            timed_out: false,
        })
    }
}

/// Records what the v1 broker would run, and answers as told (default: exit 0, "done").
#[derive(Default)]
pub struct V1Recorder {
    pub ran: Mutex<Vec<PrivExec>>,
    pub answer: Mutex<Option<ExecOutput>>,
}

impl V1Runner for V1Recorder {
    fn run(&self, exec: &PrivExec) -> ExecOutput {
        self.ran.lock().unwrap().push(exec.clone());
        self.answer.lock().unwrap().clone().unwrap_or(ExecOutput {
            code: Some(0),
            stdout: "done".into(),
            stderr: String::new(),
            timed_out: false,
        })
    }
}

pub fn test_trust() -> ReleaseTrust {
    ReleaseTrust {
        keys: vec!["a".repeat(64)],
        threshold: 1,
        node_floor: "24.0.0".into(),
        min_sequence: 3,
        pq_key_ids: Vec::new(),
        legacy_manifests: Vec::new(),
    }
}

pub fn fixed_env(engine: EngineKind) -> FixedEnvironment {
    FixedEnvironment {
        engine,
        mounts: String::new(),
        trust: test_trust(),
        arch: "arm64".into(),
    }
}

static N: AtomicU64 = AtomicU64::new(0);

/// A fresh directory with no symlinks in its path (macOS's /var is one).
pub fn tempdir(tag: &str) -> PathBuf {
    let base = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    let p = base.join(format!(
        "fs-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

pub struct Client {
    s: UnixStream,
    r: FrameReader,
    pending: Vec<Value>,
}

impl Client {
    pub fn connect(path: &std::path::Path) -> Self {
        for _ in 0..200 {
            if let Ok(s) = UnixStream::connect(path) {
                s.set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                return Self {
                    s,
                    r: FrameReader::default(),
                    pending: Vec::new(),
                };
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("no socket");
    }
    pub fn send(&mut self, v: &Value) {
        self.s.write_all(&encode_frame(v).unwrap()).unwrap();
    }
    #[allow(dead_code)]
    pub fn try_send(&mut self, v: &Value) -> std::io::Result<()> {
        self.s.write_all(&encode_frame(v).unwrap())
    }
    pub fn send_raw(&mut self, b: &[u8]) {
        self.s.write_all(b).unwrap();
    }
    /// The next frame, or None once the broker has closed the connection.
    pub fn recv(&mut self) -> Option<Value> {
        let mut buf = [0u8; 65536];
        loop {
            if !self.pending.is_empty() {
                return Some(self.pending.remove(0));
            }
            match self.s.read(&mut buf) {
                Ok(0) | Err(_) => return None,
                Ok(n) => self.pending.extend(self.r.push(&buf[..n]).unwrap()),
            }
        }
    }
    pub fn call(&mut self, v: &Value) -> Value {
        self.send(v);
        self.recv().expect("an answer")
    }
}
