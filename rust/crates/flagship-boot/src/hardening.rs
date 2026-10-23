//! Process hardening for a key holder (IMPLEMENTATION-PLAN.md §5.2): no core
//! dumps, and on Linux not dumpable (no ptrace attach by same-uid processes,
//! `/proc/self/mem` closed). Best effort: a failure is not fatal at boot.

/// Apply what the platform supports.
pub fn harden() {
    #[cfg(target_os = "linux")]
    {
        use rustix::process::{
            DumpableBehavior, Resource, Rlimit, set_dumpable_behavior, setrlimit,
        };
        let _ = setrlimit(
            Resource::Core,
            Rlimit {
                current: Some(0),
                maximum: Some(0),
            },
        );
        let _ = set_dumpable_behavior(DumpableBehavior::NotDumpable);
    }
}
