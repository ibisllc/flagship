//! Process hardening for a key holder: no core dumps, and on Linux not dumpable at all (which
//! also refuses same-uid ptrace and /proc/<pid>/mem reads).

use nix::sys::resource::{Resource, setrlimit};

pub fn harden_process() -> nix::Result<()> {
    setrlimit(Resource::RLIMIT_CORE, 0, 0)?;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    nix::sys::prctl::set_dumpable(false)?;
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn is_dumpable() -> nix::Result<bool> {
    nix::sys::prctl::get_dumpable()
}
