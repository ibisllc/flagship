//! P04 acceptance tests at the worker: the SDK fixture app (Rust, built for
//! wasm32-wasip1 by `rust/wasi-sdk/build-fixtures.sh`) served over HTTP,
//! infinite loops and memory bombs stopped per request, host calls refused
//! unless declared, compiled modules bound to one app, and data surviving a
//! backup and restore of the app's files folder.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use flagship_wasi::{
    AppServer, BrokerError, CapabilityBroker, Ceilings, HostCall, Limits, MANIFEST_SCHEMA,
    ModuleSource, Preopen, PreopenPerms, ServerLimits, WasiCapabilityManifest, WasiGrant, Worker,
    WorkerConfig, WorkerError, sha256_digest,
};
use serde_json::{Value, json};

fn fixture_bytes(name: &str) -> Vec<u8> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}

fn fixture_app() -> Vec<u8> {
    fixture_bytes("sdk-wasi-fixture.wasm")
}

fn hostcalls_app() -> Vec<u8> {
    fixture_bytes("sdk-wasi-hostcalls.wasm")
}

fn manifest(app: &str, module: &[u8], extra: Value) -> WasiCapabilityManifest {
    let mut m = json!({
        "schema": MANIFEST_SCHEMA,
        "appId": app,
        "world": "http-proxy",
        "module": { "digest": sha256_digest(module) },
    });
    if let (Some(obj), Some(more)) = (m.as_object_mut(), extra.as_object()) {
        for (k, v) in more {
            obj.insert(k.clone(), v.clone());
        }
    }
    serde_json::from_value(m).unwrap()
}

fn grant(app: &str, module: &[u8], extra: Value) -> WasiGrant {
    let m = manifest(app, module, extra);
    WasiGrant::admit(&m, &sha256_digest(module), &Ceilings::default()).unwrap()
}

#[derive(Debug, Default)]
struct FakeBroker {
    seen: Mutex<Vec<(HostCall, Value)>>,
    deny: bool,
}

impl CapabilityBroker for FakeBroker {
    fn call(
        &self,
        call: HostCall,
        request: &[u8],
        _timeout: Duration,
    ) -> Result<Vec<u8>, BrokerError> {
        let req: Value = serde_json::from_slice(request).unwrap();
        self.seen.lock().unwrap().push((call, req.clone()));
        if self.deny {
            return Err(BrokerError::Denied(
                "the owner has not approved this host".into(),
            ));
        }
        Ok(match call {
            HostCall::HttpFetch => json!({ "status": 200, "headers": {}, "body": format!("fetched {}", req["url"].as_str().unwrap()) }),
            HostCall::DbQuery => json!({ "rows": [{ "n": 1 }], "rowCount": 1 }),
            HostCall::LastResponse => json!(null),
        }
        .to_string()
        .into_bytes())
    }
}

struct Started {
    addr: SocketAddr,
}

fn start(
    app: &str,
    module: &[u8],
    extra: Value,
    files: Option<&Path>,
    broker: Option<Arc<dyn CapabilityBroker>>,
) -> Started {
    let g = grant(app, module, extra);
    let worker = Worker::for_app(WorkerConfig::default(), app).unwrap();
    let compiled = worker.compile_for(&g, ModuleSource::Wasm(module)).unwrap();
    let preopens = files
        .map(|d| {
            vec![Preopen {
                guest: "/data".into(),
                host: d.to_path_buf(),
                perms: PreopenPerms::ReadWrite,
            }]
        })
        .unwrap_or_default();
    let server = Arc::new(
        AppServer::new(
            worker,
            compiled,
            g,
            preopens,
            broker,
            ServerLimits::default(),
        )
        .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        let stop = AtomicBool::new(false);
        let _ = server.serve(&listener, &stop);
    });
    Started { addr }
}

/// (status, headers, body) for a raw request.
fn send(addr: SocketAddr, raw: &str) -> (u16, Vec<(String, String)>, String) {
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    s.write_all(raw.as_bytes()).unwrap();
    let mut r = BufReader::new(s);
    let mut status_line = String::new();
    r.read_line(&mut status_line).unwrap();
    let status: u16 = status_line.split(' ').nth(1).unwrap().parse().unwrap();
    let mut headers = Vec::new();
    loop {
        let mut l = String::new();
        r.read_line(&mut l).unwrap();
        let l = l.trim_end().to_owned();
        if l.is_empty() {
            break;
        }
        let (k, v) = l.split_once(": ").unwrap();
        headers.push((k.to_owned(), v.to_owned()));
    }
    let mut body = String::new();
    r.read_to_string(&mut body).unwrap();
    (status, headers, body)
}

fn get(addr: SocketAddr, path: &str) -> (u16, String) {
    let (s, _, b) = send(addr, &format!("GET {path} HTTP/1.1\r\nHost: app\r\n\r\n"));
    (s, b)
}

fn files_extra() -> Value {
    json!({ "data": { "stores": { "files": true } } })
}

#[test]
fn sdk_fixture_serves_http_with_identity_and_files() {
    let dir = tempfile::tempdir().unwrap();
    let app = fixture_app();
    let s = start("alice-notes", &app, files_extra(), Some(dir.path()), None);
    let (st, body) = get(s.addr, "/");
    assert_eq!(st, 200);
    assert!(
        body.starts_with("flagship wasi fixture\nvisitor: anonymous"),
        "{body}"
    );
    let (st, h, _) = send(
        s.addr,
        "POST /notes HTTP/1.1\r\nHost: app\r\nContent-Length: 5\r\n\r\nhello",
    );
    assert_eq!(st, 303);
    assert!(h.iter().any(|(k, v)| k == "Location" && v == "/"));
    // Chunked bodies (how a proxy forwards a stream) work too.
    let (st, _, _) = send(
        s.addr,
        "POST /notes HTTP/1.1\r\nHost: app\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nworld\r\n0\r\n\r\n",
    );
    assert_eq!(st, 303);
    assert_eq!(get(s.addr, "/notes"), (200, "hello\nworld\n".into()));
    assert_eq!(get(s.addr, "/count").1, "1\n");
    assert_eq!(get(s.addr, "/count").1, "2\n");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("count")).unwrap(),
        "2"
    );
    let (st, _, body) = send(
        s.addr,
        "GET /whoami HTTP/1.1\r\nHost: app\r\nX-Flagship-Visitor: member\r\nX-Flagship-User: u-7f\r\nX-Flagship-Role: manager\r\n\r\n",
    );
    assert_eq!(st, 200);
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        v,
        json!({ "visitor": "member", "user": "u-7f", "role": "manager" })
    );
    let env: Value = serde_json::from_str(&get(s.addr, "/env").1).unwrap();
    assert_eq!(env["filesDir"], "/data");
    // HEAD reaches the app as HEAD (this one routes only GET) and the answer carries no body.
    let (st, h, body) = send(s.addr, "HEAD / HTTP/1.1\r\nHost: app\r\n\r\n");
    assert_eq!((st, body.as_str()), (404, ""));
    assert!(h.iter().any(|(k, v)| k == "Content-Length" && v == "10"));
    assert_eq!(get(s.addr, "/nope").0, 404);
}

#[test]
fn infinite_loop_is_stopped_by_fuel_and_by_the_clock_and_the_app_keeps_serving() {
    let app = fixture_app();
    let fuel = Limits {
        fuel: 200_000_000,
        ..Limits::default()
    };
    let s = start("alice-spin", &app, json!({ "limits": fuel }), None, None);
    let (st, body) = get(s.addr, "/spin");
    assert_eq!(
        (st, body.as_str()),
        (503, "The app ran out of fuel on this request.\n")
    );
    assert_eq!(get(s.addr, "/healthz"), (200, "ok\n".into()));

    let clock = Limits {
        fuel: 100_000_000_000,
        wall_time_ms: 400,
        ..Limits::default()
    };
    let s = start("alice-spin2", &app, json!({ "limits": clock }), None, None);
    let started = std::time::Instant::now();
    let (st, body) = get(s.addr, "/spin");
    assert_eq!(
        (st, body.as_str()),
        (503, "The app ran out of wall-time on this request.\n")
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(get(s.addr, "/healthz").0, 200);
}

#[test]
fn memory_bomb_is_stopped_at_the_memory_limit() {
    let app = fixture_app();
    let small = Limits {
        memory_mib: 16,
        ..Limits::default()
    };
    let s = start("alice-grow", &app, json!({ "limits": small }), None, None);
    let (st, body) = get(s.addr, "/grow");
    assert_eq!(
        (st, body.as_str()),
        (503, "The app ran out of memory on this request.\n")
    );
    assert_eq!(get(s.addr, "/healthz").0, 200);
}

#[test]
fn host_calls_are_refused_unless_the_manifest_declares_them() {
    let app = hostcalls_app();
    let w = Worker::for_app(WorkerConfig::default(), "alice-hc").unwrap();
    let none = grant("alice-hc", &app, json!({}));
    let err = w.compile_for(&none, ModuleSource::Wasm(&app)).unwrap_err();
    assert!(
        matches!(err, WorkerError::CapabilityNotDeclared { .. }),
        "{err}"
    );
    assert!(err.to_string().contains("does not declare"), "{err}");
    // Egress alone is not enough: the module also imports db_query.
    let egress_only = grant(
        "alice-hc",
        &app,
        json!({ "network": { "egress": ["api.example.com"] } }),
    );
    let err = w
        .compile_for(&egress_only, ModuleSource::Wasm(&app))
        .unwrap_err();
    assert!(
        matches!(
            err,
            WorkerError::CapabilityNotDeclared {
                call: "db_query",
                capability: "data.stores.postgres"
            }
        ),
        "{err}"
    );
    let both = grant(
        "alice-hc",
        &app,
        json!({ "network": { "egress": ["api.example.com"] }, "data": { "stores": { "postgres": true } } }),
    );
    assert!(w.compile_for(&both, ModuleSource::Wasm(&app)).is_ok());
}

#[test]
fn declared_host_calls_go_through_the_broker_and_undeclared_hosts_never_reach_it() {
    let app = hostcalls_app();
    let broker = Arc::new(FakeBroker::default());
    let extra = json!({ "network": { "egress": ["api.example.com"] }, "data": { "stores": { "postgres": true } } });
    let s = start("alice-hc2", &app, extra.clone(), None, Some(broker.clone()));
    let (st, body) = get(s.addr, "/fetch?url=https%3A%2F%2Fapi.example.com%2Fv1");
    assert_eq!(st, 200, "{body}");
    assert!(
        body.contains("fetched https://api.example.com/v1"),
        "{body}"
    );
    let (st, body) = get(s.addr, "/fetch?url=https%3A%2F%2Fevil.example%2F");
    assert_eq!(st, 403, "{body}");
    assert!(body.contains("not in this app's network.egress"), "{body}");
    let (st, body) = get(s.addr, "/db?sql=select%201%20as%20n");
    assert_eq!(st, 200);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["rowCount"], 1);
    let seen = broker.seen.lock().unwrap();
    assert_eq!(
        seen.len(),
        2,
        "the undeclared host never reached the broker"
    );
    assert_eq!(seen[0].0, HostCall::HttpFetch);
    assert_eq!(
        seen[1],
        (
            HostCall::DbQuery,
            json!({ "sql": "select 1 as n", "params": [] })
        )
    );
    drop(seen);

    let denying = Arc::new(FakeBroker {
        deny: true,
        ..FakeBroker::default()
    });
    let s = start("alice-hc3", &app, extra, None, Some(denying));
    let (st, body) = get(s.addr, "/fetch?url=https%3A%2F%2Fapi.example.com%2F");
    assert_eq!(st, 403);
    assert!(body.contains("not approved"), "{body}");
}

#[test]
fn compiled_modules_are_bound_to_one_app_and_one_worker() {
    let app = fixture_app();
    let ga = grant("alice-a", &app, json!({}));
    let gb = grant("bob-b", &app, json!({}));
    let wa = Worker::for_app(WorkerConfig::default(), "alice-a").unwrap();
    let wb = Worker::for_app(WorkerConfig::default(), "bob-b").unwrap();
    let ca = wa.compile_for(&ga, ModuleSource::Wasm(&app)).unwrap();
    let cb = wb.compile_for(&gb, ModuleSource::Wasm(&app)).unwrap();
    assert_eq!(ca.digest(), cb.digest(), "same bytes");
    // B's worker never runs A's compiled code, under either grant.
    for g in [&ga, &gb] {
        let e = wb
            .run_compiled(&ca, g, &[], flagship_wasi::RunInput::default())
            .unwrap_err();
        assert!(matches!(e, WorkerError::ModuleNotForThisApp), "{e}");
    }
    // A bound worker refuses to compile for another app.
    assert!(matches!(
        wa.compile_for(&gb, ModuleSource::Wasm(&app)),
        Err(WorkerError::ModuleNotForThisApp)
    ));
    // Even an unbound worker refuses a module another engine compiled.
    let free = Worker::new(WorkerConfig::default()).unwrap();
    let e = free
        .run_compiled(&ca, &ga, &[], flagship_wasi::RunInput::default())
        .unwrap_err();
    assert!(matches!(e, WorkerError::ModuleNotForThisApp), "{e}");
    // Each works for its own app.
    let env = [
        ("REQUEST_METHOD".to_owned(), "GET".to_owned()),
        ("PATH_INFO".to_owned(), "/healthz".to_owned()),
    ];
    for (w, c, g) in [(&wa, &ca, &ga), (&wb, &cb, &gb)] {
        let out = w
            .run_compiled(
                c,
                g,
                &[],
                flagship_wasi::RunInput {
                    stdin: b"",
                    extra_env: &env,
                    broker: None,
                },
            )
            .unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).ends_with("ok\n"));
    }
    // A precompiled artifact of the same app is never accepted as a module.
    let native = wa.engine().precompile_module(&app).unwrap();
    let gn = grant("alice-a", &native, json!({}));
    assert!(matches!(
        wa.compile_for(&gn, ModuleSource::Wasm(&native)),
        Err(WorkerError::PrecompiledArtifactRefused)
    ));
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let t = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &t);
        } else {
            std::fs::copy(e.path(), t).unwrap();
        }
    }
}

#[test]
fn backup_and_restore_of_its_data() {
    let app = fixture_app();
    let live = tempfile::tempdir().unwrap();
    let s = start("alice-bk", &app, files_extra(), Some(live.path()), None);
    send(
        s.addr,
        "POST /notes HTTP/1.1\r\nHost: a\r\nContent-Length: 8\r\n\r\nkeep me!",
    );
    get(s.addr, "/count");
    get(s.addr, "/count");
    // The box's backup is a copy of the app's files folder (a tar of the
    // volume); restore writes it into a fresh folder for a new worker.
    let backup = tempfile::tempdir().unwrap();
    copy_dir(live.path(), backup.path());
    let restored = tempfile::tempdir().unwrap();
    copy_dir(backup.path(), restored.path());
    drop(live);
    let s2 = start("alice-bk", &app, files_extra(), Some(restored.path()), None);
    assert_eq!(get(s2.addr, "/notes"), (200, "keep me!\n".into()));
    assert_eq!(get(s2.addr, "/count").1, "3\n");
}

#[test]
fn hostile_requests_get_errors_not_runs() {
    let app = fixture_app();
    let s = start("alice-hostile", &app, json!({}), None, None);
    let big = format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(20_000));
    assert_eq!(send(s.addr, &big).0, 431);
    assert_eq!(
        send(
            s.addr,
            "GET / HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n"
        )
        .0,
        400
    );
    assert_eq!(send(s.addr, "GET http://other/ HTTP/1.1\r\n\r\n").0, 400);
    assert_eq!(get(s.addr, "/healthz").0, 200);
}

// ── the worker process itself, as the box's unit starts it ──────────────────

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn write_config(
    dir: &Path,
    module: &[u8],
    extra: Value,
    port: u16,
    cap: Option<&Path>,
    files: Option<&Path>,
) -> PathBuf {
    let module_path = dir.join("module.wasm");
    std::fs::write(&module_path, module).unwrap();
    let m = manifest("alice-proc", module, extra);
    let mut c = json!({
        "schema": "flagship/wasi-worker/v1",
        "manifest": m,
        "approvedDigest": sha256_digest(module),
        "modulePath": module_path,
        "listen": format!("127.0.0.1:{port}"),
        "env": { "FLAGSHIP_APP_ID": "alice-proc" },
    });
    if let Some(cap) = cap {
        c["capSocket"] = json!(cap);
    }
    if let Some(f) = files {
        c["filesDir"] = json!(f);
    }
    let p = dir.join("worker.json");
    std::fs::write(&p, c.to_string()).unwrap();
    p
}

fn wait_up(port: u16) {
    for _ in 0..200 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("worker never listened");
}

#[test]
fn worker_process_checks_serves_and_takes_its_secrets_from_the_box() {
    use std::os::unix::net::UnixListener;
    let bin = env!("CARGO_BIN_EXE_flagship-wasi-worker");
    let dir = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let cap = dir.path().join("cap.sock");
    let listener = UnixListener::bind(&cap).unwrap();
    let hellos = Arc::new(Mutex::new(0u32));
    let h2 = hellos.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let mut c = conn.unwrap();
            let mut line = String::new();
            BufReader::new(c.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            let req: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(req["op"], "hello");
            *h2.lock().unwrap() += 1;
            let reply = json!({ "ok": true, "result": { "env": { "FLAGSHIP_PG_URL": "postgresql://secret" } } });
            c.write_all(format!("{reply}\n").as_bytes()).unwrap();
        }
    });
    let port = free_port();
    let app = fixture_app();
    let cfg = write_config(
        dir.path(),
        &app,
        files_extra(),
        port,
        Some(&cap),
        Some(files.path()),
    );

    let check = std::process::Command::new(bin)
        .args(["check", "--config"])
        .arg(&cfg)
        .output()
        .unwrap();
    assert!(
        check.status.success(),
        "{}",
        String::from_utf8_lossy(&check.stderr)
    );
    let line: Value = serde_json::from_slice(&check.stdout).unwrap();
    assert_eq!(line["digest"], sha256_digest(&app));

    let mut child = std::process::Command::new(bin)
        .args(["serve", "--config"])
        .arg(&cfg)
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    wait_up(port);
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let env: Value = serde_json::from_str(&get(addr, "/env").1).unwrap();
    assert_eq!(
        env,
        json!({ "appId": "alice-proc", "filesDir": "/data", "pgUrlSet": true })
    );
    assert_eq!(get(addr, "/count").1, "1\n");
    child.kill().unwrap();
    let _ = child.wait();
    assert_eq!(*hellos.lock().unwrap(), 1);
    // The secret never touched the config file.
    assert!(!std::fs::read_to_string(&cfg).unwrap().contains("secret"));

    // A module that imports an undeclared host call never gets to serve.
    let dir2 = tempfile::tempdir().unwrap();
    let cfg2 = write_config(
        dir2.path(),
        &hostcalls_app(),
        json!({}),
        free_port(),
        None,
        None,
    );
    let out = std::process::Command::new(bin)
        .args(["check", "--config"])
        .arg(&cfg2)
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("does not declare"));
    // Not loopback: refused.
    let cfg3 = dir2.path().join("bad.json");
    let mut c: Value = serde_json::from_str(&std::fs::read_to_string(&cfg2).unwrap()).unwrap();
    c["listen"] = json!("0.0.0.0:8080");
    c["manifest"] = serde_json::to_value(manifest("alice-proc", &app, json!({}))).unwrap();
    c["approvedDigest"] = json!(sha256_digest(&app));
    std::fs::write(dir2.path().join("module.wasm"), &app).unwrap();
    std::fs::write(&cfg3, c.to_string()).unwrap();
    let out = std::process::Command::new(bin)
        .args(["check", "--config"])
        .arg(&cfg3)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&out.stderr).contains("loopback"));
}

#[test]
fn committed_fixtures_match_their_recorded_hashes() {
    let sums = String::from_utf8(fixture_bytes("FIXTURES.sha256")).unwrap();
    let mut want = BTreeMap::new();
    for line in sums.lines() {
        let (h, name) = line.split_once("  ").unwrap();
        want.insert(name.to_owned(), h.to_owned());
    }
    for name in ["sdk-wasi-fixture.wasm", "sdk-wasi-hostcalls.wasm"] {
        let got = sha256_digest(&fixture_bytes(name));
        assert_eq!(
            got.strip_prefix("sha256:"),
            want.get(name).map(String::as_str),
            "{name}"
        );
    }
}
