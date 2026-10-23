//! Who is on the other end of a socket. Identity comes from the kernel (SO_PEERCRED), never from
//! anything the caller writes; a UID in a request grants nothing.

use std::collections::BTreeSet;
use std::io;
use std::os::unix::net::UnixStream;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Peer {
    pub uid: u32,
    pub gid: u32,
    pub pid: Option<i32>,
}

pub trait PeerAuthenticator: Send + Sync {
    fn peer(&self, stream: &UnixStream) -> io::Result<Peer>;
}

/// The kernel's record of the connecting process. Only Linux has it; elsewhere every
/// connection is refused rather than trusted.
#[derive(Debug, Clone, Copy, Default)]
pub struct KernelPeerCredentials;

impl PeerAuthenticator for KernelPeerCredentials {
    #[cfg(target_os = "linux")]
    fn peer(&self, stream: &UnixStream) -> io::Result<Peer> {
        let c = rustix::net::sockopt::socket_peercred(stream)?;
        Ok(Peer {
            uid: c.uid.as_raw(),
            gid: c.gid.as_raw(),
            pid: Some(c.pid.as_raw_nonzero().get()),
        })
    }

    #[cfg(not(target_os = "linux"))]
    fn peer(&self, _stream: &UnixStream) -> io::Result<Peer> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "peer credentials need Linux SO_PEERCRED",
        ))
    }
}

/// Which kernel-reported UIDs may use a socket. Separate sockets get separate policies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerPolicy {
    allowed_uids: BTreeSet<u32>,
}

impl PeerPolicy {
    pub fn uids(uids: impl IntoIterator<Item = u32>) -> Self {
        Self {
            allowed_uids: uids.into_iter().collect(),
        }
    }
    pub fn allows(&self, peer: &Peer) -> bool {
        self.allowed_uids.contains(&peer.uid)
    }
}
