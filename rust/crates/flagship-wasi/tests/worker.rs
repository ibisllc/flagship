//! WAT fixtures against the confined worker: what runs, and what is stopped.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use flagship_wasi::{
    Ceilings, Exit, LimitKind, Limits, MANIFEST_SCHEMA, ModuleSource, Preopen, PreopenPerms,
    WasiCapabilityManifest, WasiGrant, Worker, WorkerConfig, WorkerError, sha256_digest,
};

fn fixture(name: &str) -> String {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    std::fs::read_to_string(p).unwrap()
}

fn grant_for(
    source: &str,
    files: bool,
    limits: Limits,
    env: &[(&str, &str)],
    args: &[&str],
) -> WasiGrant {
    let digest = sha256_digest(source.as_bytes());
    let env: serde_json::Map<String, serde_json::Value> = env
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).into()))
        .collect();
    let m: WasiCapabilityManifest = serde_json::from_value(serde_json::json!({
        "schema": MANIFEST_SCHEMA,
        "module": { "digest": digest },
        "args": args,
        "env": env,
        "data": { "stores": { "files": files } },
        "limits": limits,
    }))
    .unwrap();
    WasiGrant::admit(&m, &digest, &Ceilings::default()).unwrap()
}

fn worker() -> Worker {
    Worker::new(WorkerConfig::default()).unwrap()
}

fn data_preopen(dir: &Path) -> Preopen {
    Preopen {
        guest: "/data".into(),
        host: dir.to_path_buf(),
        perms: PreopenPerms::ReadWrite,
    }
}

#[test]
fn normal_program_writes_its_preopen_and_prints() {
    let w = worker();
    let src = fixture("hello.wat");
    let dir = tempfile::tempdir().unwrap();
    let g = grant_for(&src, true, Limits::default(), &[], &[]);
    let out = w
        .run(
            ModuleSource::Wat(&src),
            &g,
            &[data_preopen(dir.path())],
            b"",
        )
        .unwrap();
    assert_eq!(out.exit, Exit::Code(0));
    assert_eq!(out.stdout, b"hello\n");
    assert_eq!(
        std::fs::read(dir.path().join("out.txt")).unwrap(),
        b"hello\n"
    );
    assert!(out.fuel_consumed > 0);
}

#[test]
fn binary_module_runs_too() {
    let w = worker();
    let wasm = wat::parse_str(fixture("loop.wat").replace("(loop $l (br $l))", "")).unwrap();
    let digest = sha256_digest(&wasm);
    let m: WasiCapabilityManifest = serde_json::from_value(serde_json::json!({
        "schema": MANIFEST_SCHEMA, "module": { "digest": digest },
    }))
    .unwrap();
    let g = WasiGrant::admit(&m, &digest, &Ceilings::default()).unwrap();
    let out = w.run(ModuleSource::Wasm(&wasm), &g, &[], b"").unwrap();
    assert_eq!(out.exit, Exit::Code(0));
}

#[test]
fn infinite_loop_runs_out_of_fuel() {
    let w = worker();
    let src = fixture("loop.wat");
    let g = grant_for(
        &src,
        false,
        Limits {
            fuel: 5_000_000,
            ..Limits::default()
        },
        &[],
        &[],
    );
    let e = w.run(ModuleSource::Wat(&src), &g, &[], b"").unwrap_err();
    assert!(
        matches!(e, WorkerError::LimitExceeded(LimitKind::Fuel)),
        "{e}"
    );
}

#[test]
fn infinite_loop_hits_the_wall_clock_deadline() {
    let w = worker();
    let src = fixture("loop.wat");
    let limits = Limits {
        fuel: u64::MAX / 4,
        wall_time_ms: 300,
        ..Limits::default()
    };
    let g = WasiGrant::admit(
        &serde_json::from_value(serde_json::json!({
            "schema": MANIFEST_SCHEMA,
            "module": { "digest": sha256_digest(src.as_bytes()) },
            "limits": limits,
        }))
        .unwrap(),
        &sha256_digest(src.as_bytes()),
        &Ceilings {
            max: Limits {
                fuel: u64::MAX,
                ..Ceilings::default().max
            },
        },
    )
    .unwrap();
    let t = Instant::now();
    let e = w.run(ModuleSource::Wat(&src), &g, &[], b"").unwrap_err();
    assert!(
        matches!(e, WorkerError::LimitExceeded(LimitKind::WallTime)),
        "{e}"
    );
    assert!(t.elapsed() < Duration::from_secs(5));
}

#[test]
fn blocking_host_call_is_cancelled_at_the_deadline() {
    let w = worker();
    let src = fixture("sleep.wat");
    let g = grant_for(
        &src,
        false,
        Limits {
            wall_time_ms: 300,
            ..Limits::default()
        },
        &[],
        &[],
    );
    let t = Instant::now();
    let e = w.run(ModuleSource::Wat(&src), &g, &[], b"").unwrap_err();
    assert!(
        matches!(e, WorkerError::LimitExceeded(LimitKind::WallTime)),
        "{e}"
    );
    assert!(
        t.elapsed() < Duration::from_secs(5),
        "took {:?}",
        t.elapsed()
    );
}

#[test]
fn memory_bomb_is_denied() {
    let w = worker();
    let src = fixture("membomb.wat");
    let g = grant_for(
        &src,
        false,
        Limits {
            memory_mib: 64,
            ..Limits::default()
        },
        &[],
        &[],
    );
    let e = w.run(ModuleSource::Wat(&src), &g, &[], b"").unwrap_err();
    assert!(
        matches!(e, WorkerError::LimitExceeded(LimitKind::Memory)),
        "{e}"
    );
}

#[test]
fn oversized_initial_memory_is_denied_at_instantiation() {
    let w = worker();
    let src = fixture("bigmem.wat");
    let g = grant_for(
        &src,
        false,
        Limits {
            memory_mib: 64,
            ..Limits::default()
        },
        &[],
        &[],
    );
    let e = w.run(ModuleSource::Wat(&src), &g, &[], b"").unwrap_err();
    assert!(
        matches!(e, WorkerError::LimitExceeded(LimitKind::Memory)),
        "{e}"
    );
}

#[test]
fn table_growth_is_denied() {
    let w = worker();
    let src = fixture("tablebomb.wat");
    let g = grant_for(
        &src,
        false,
        Limits {
            table_elements: 1000,
            ..Limits::default()
        },
        &[],
        &[],
    );
    let e = w.run(ModuleSource::Wat(&src), &g, &[], b"").unwrap_err();
    assert!(
        matches!(e, WorkerError::LimitExceeded(LimitKind::Table)),
        "{e}"
    );
}

#[test]
fn file_outside_the_preopen_is_denied() {
    let w = worker();
    let parent = tempfile::tempdir().unwrap();
    std::fs::write(parent.path().join("secret.txt"), b"no").unwrap();
    let data = parent.path().join("data");
    std::fs::create_dir(&data).unwrap();
    for name in ["escape.wat", "absolute.wat"] {
        let src = fixture(name);
        let g = grant_for(&src, true, Limits::default(), &[], &[]);
        let out = w
            .run(ModuleSource::Wat(&src), &g, &[data_preopen(&data)], b"")
            .unwrap();
        assert_ne!(
            out.exit,
            Exit::Code(0),
            "{name} opened a file outside /data"
        );
    }
}

#[test]
fn preopen_the_grant_does_not_name_is_refused() {
    let w = worker();
    let src = fixture("hello.wat");
    let dir = tempfile::tempdir().unwrap();
    let no_files = grant_for(&src, false, Limits::default(), &[], &[]);
    let e = w
        .run(
            ModuleSource::Wat(&src),
            &no_files,
            &[data_preopen(dir.path())],
            b"",
        )
        .unwrap_err();
    assert!(matches!(e, WorkerError::PreopenNotGranted(_)), "{e}");
    let with_files = grant_for(&src, true, Limits::default(), &[], &[]);
    let etc = Preopen {
        guest: "/etc".into(),
        host: dir.path().into(),
        perms: PreopenPerms::ReadOnly,
    };
    let e = w
        .run(ModuleSource::Wat(&src), &with_files, &[etc], b"")
        .unwrap_err();
    assert!(matches!(e, WorkerError::PreopenNotGranted(_)), "{e}");
    // With no preopen at all, fd 3 does not exist and the program fails.
    let out = w
        .run(ModuleSource::Wat(&src), &with_files, &[], b"")
        .unwrap();
    assert_ne!(out.exit, Exit::Code(0));
}

#[test]
fn network_is_not_available() {
    let w = worker();
    // The only p1 socket call fails: there are no preopened sockets.
    let src = fixture("sock_accept.wat");
    let g = grant_for(&src, false, Limits::default(), &[], &[]);
    let out = w.run(ModuleSource::Wat(&src), &g, &[], b"").unwrap();
    assert_ne!(out.exit, Exit::Code(0));
    // A socket-opening import is never linked.
    let src = fixture("sock_connect.wat");
    let g = grant_for(&src, false, Limits::default(), &[], &[]);
    let e = w.run(ModuleSource::Wat(&src), &g, &[], b"").unwrap_err();
    assert!(
        matches!(e, WorkerError::ImportNotGranted { ref name, .. } if name == "sock_open"),
        "{e}"
    );
    // Nor is any non-WASI host module.
    let src = fixture("env_import.wat");
    let g = grant_for(&src, false, Limits::default(), &[], &[]);
    let e = w.run(ModuleSource::Wat(&src), &g, &[], b"").unwrap_err();
    assert!(
        matches!(e, WorkerError::ImportNotGranted { ref module, .. } if module == "env"),
        "{e}"
    );
}

#[test]
fn env_and_args_are_only_what_was_granted() {
    // The host env is not inherited: this process has PATH, HOME and more;
    // the guest sees only the granted variable.
    let w = worker();
    let src = fixture("environ.wat");
    let g = grant_for(
        &src,
        false,
        Limits::default(),
        &[("LOG_LEVEL", "info")],
        &["--once"],
    );
    let out = w.run(ModuleSource::Wat(&src), &g, &[], b"").unwrap();
    // 1 env var, argc = program name + 1 arg.
    assert_eq!(out.exit, Exit::Code(102));
    let g = grant_for(&src, true, Limits::default(), &[], &[]);
    let dir = tempfile::tempdir().unwrap();
    let out = w
        .run(
            ModuleSource::Wat(&src),
            &g,
            &[data_preopen(dir.path())],
            b"",
        )
        .unwrap();
    // FLAGSHIP_FILES_DIR only.
    assert_eq!(out.exit, Exit::Code(101));
}

#[test]
fn precompiled_artifact_is_refused() {
    let w = worker();
    let wasm = wat::parse_str(fixture("hello.wat")).unwrap();
    let native = w.engine().precompile_module(&wasm).unwrap();
    let e = w.compile(ModuleSource::Wasm(&native)).unwrap_err();
    assert!(matches!(e, WorkerError::PrecompiledArtifactRefused), "{e}");
    // Even when the grant names the artifact's own digest.
    let digest = sha256_digest(&native);
    let m: WasiCapabilityManifest = serde_json::from_value(serde_json::json!({
        "schema": MANIFEST_SCHEMA, "module": { "digest": digest },
    }))
    .unwrap();
    let g = WasiGrant::admit(&m, &digest, &Ceilings::default()).unwrap();
    let e = w
        .run(ModuleSource::Wasm(&native), &g, &[], b"")
        .unwrap_err();
    assert!(matches!(e, WorkerError::PrecompiledArtifactRefused), "{e}");
}

#[test]
fn garbage_and_components_are_refused() {
    let w = worker();
    let e = w.compile(ModuleSource::Wasm(b"#!/bin/sh\n")).unwrap_err();
    assert!(matches!(e, WorkerError::NotWasm), "{e}");
    let component = b"\0asm\x0d\x00\x01\x00";
    let e = w.compile(ModuleSource::Wasm(component)).unwrap_err();
    assert!(matches!(e, WorkerError::ComponentRefused), "{e}");
    let small = Worker::new(WorkerConfig {
        max_module_bytes: 16,
        ..WorkerConfig::default()
    })
    .unwrap();
    let e = small
        .compile(ModuleSource::Wat(&fixture("hello.wat")))
        .unwrap_err();
    assert!(matches!(e, WorkerError::ModuleTooLarge { .. }), "{e}");
}

#[test]
fn module_must_match_the_approved_digest() {
    let w = worker();
    let src = fixture("hello.wat");
    let g = grant_for(&fixture("loop.wat"), false, Limits::default(), &[], &[]);
    let e = w.run(ModuleSource::Wat(&src), &g, &[], b"").unwrap_err();
    assert!(matches!(e, WorkerError::Manifest(_)), "{e}");
}

#[test]
fn concurrent_runs_are_bounded() {
    let w = Arc::new(
        Worker::new(WorkerConfig {
            max_concurrent_runs: 1,
            ..WorkerConfig::default()
        })
        .unwrap(),
    );
    let src = fixture("sleep.wat");
    let g = grant_for(
        &src,
        false,
        Limits {
            wall_time_ms: 1500,
            ..Limits::default()
        },
        &[],
        &[],
    );
    let bg = {
        let (w, src, g) = (Arc::clone(&w), src.clone(), g.clone());
        std::thread::spawn(move || w.run(ModuleSource::Wat(&src), &g, &[], b""))
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while w.active_runs() == 0 && Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert_eq!(w.active_runs(), 1);
    let e = w.run(ModuleSource::Wat(&src), &g, &[], b"").unwrap_err();
    assert!(matches!(e, WorkerError::Busy(1)), "{e}");
    assert!(matches!(
        bg.join().unwrap(),
        Err(WorkerError::LimitExceeded(LimitKind::WallTime))
    ));
    assert_eq!(w.active_runs(), 0);
}
