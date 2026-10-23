//! The socket loop shared by both protocols: kernel peer authentication before the first byte,
//! a bounded number of connections, length-prefixed frames, and a per-connection handler.

use crate::peer::{PeerAuthenticator, PeerPolicy};
use crate::wire::FrameReader;
use serde_json::Value;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

/// What a connection does with one frame.
#[derive(Debug)]
pub enum Reply {
    Send(Vec<u8>),
    SendAndClose(Vec<u8>),
    Nothing,
}

pub trait Connection: Send {
    fn on_frame(&mut self, raw: Value) -> Reply;
    /// Close the connection if it has not authenticated in time (privd's hello timer).
    fn deadline_passed(&self, connected_for: Duration) -> bool;
}

pub trait ConnectionFactory: Send + Sync {
    fn open(&self, peer: crate::peer::Peer) -> Box<dyn Connection>;
}

#[derive(Debug, Clone, Copy)]
pub struct ServerLimits {
    pub max_connections: usize,
}

impl Default for ServerLimits {
    fn default() -> Self {
        Self {
            max_connections: 16,
        }
    }
}

/// Serve until `stop` is set. Each connection runs on its own thread; the count is bounded.
pub fn serve(
    listener: UnixListener,
    auth: Arc<dyn PeerAuthenticator>,
    policy: PeerPolicy,
    factory: Arc<dyn ConnectionFactory>,
    limits: ServerLimits,
    stop: Arc<AtomicBool>,
    audit: Arc<crate::audit::Audit>,
) -> std::io::Result<()> {
    listener.set_nonblocking(true)?;
    let live = Arc::new(AtomicUsize::new(0));
    while !stop.load(Ordering::SeqCst) {
        let stream = match listener.accept() {
            Ok((s, _)) => s,
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            Err(_) => continue,
        };
        let peer = match auth.peer(&stream) {
            Ok(p) if policy.allows(&p) => p,
            Ok(p) => {
                let mut m = serde_json::Map::new();
                m.insert("refusedPeer".into(), Value::from(p.uid));
                audit.record(m);
                continue;
            }
            Err(_) => continue,
        };
        if live.load(Ordering::SeqCst) >= limits.max_connections {
            continue;
        }
        live.fetch_add(1, Ordering::SeqCst);
        let conn = factory.open(peer);
        let live2 = Arc::clone(&live);
        let stop2 = Arc::clone(&stop);
        thread::spawn(move || {
            run_connection(stream, conn, &stop2);
            live2.fetch_sub(1, Ordering::SeqCst);
        });
    }
    Ok(())
}

fn run_connection(mut stream: UnixStream, mut conn: Box<dyn Connection>, stop: &AtomicBool) {
    if stream.set_nonblocking(false).is_err()
        || stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .is_err()
    {
        return;
    }
    let started = Instant::now();
    let mut reader = FrameReader::default();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        if stop.load(Ordering::SeqCst) || conn.deadline_passed(started.elapsed()) {
            return;
        }
        let n = match stream.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => n,
            Err(e)
                if matches!(
                    e.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) =>
            {
                continue;
            }
            Err(_) => return,
        };
        let frames = match reader.push(chunk.get(..n).unwrap_or_default()) {
            Ok(f) => f,
            Err(_) => return,
        };
        for raw in frames {
            match conn.on_frame(raw) {
                Reply::Send(bytes) => {
                    if stream.write_all(&bytes).is_err() {
                        return;
                    }
                }
                Reply::SendAndClose(bytes) => {
                    let _ = stream.write_all(&bytes);
                    return;
                }
                Reply::Nothing => {}
            }
        }
    }
}
