//! `flagship-gpud`: the accelerator broker. Root; owns the allocation
//! journal, the CDI spec directory, VFIO binding and MIG administration.
//! The daemon reaches it on a Unix socket (kernel peer credentials, a UID
//! allowlist, privd's framing: 4-byte big-endian length then JSON, `hello`
//! first).
//!
//! ```text
//! flagship-gpud serve --state <dir> --socket <path> [--allow-uid <n>]... [host flags]
//! flagship-gpud probe [host flags]            inventory of this host, no state kept
//! flagship-gpud self-test [--podman <path>]   the simulated-device matrix
//! flagship-gpud verify-catalog --catalog <file> --trust <file> [--min-serial <n>]
//! flagship-gpud verify-report --kind vector-add|mlp|scrub --api <cuda|hip|sycl|rocm|xpu> --file <json>
//!   [--memory-mib <n>]                        a check workload's report against its fixture
//! flagship-gpud reference-clip --width <w> --height <h> --frames <n>   the source clip, raw YUV
//! flagship-gpud verify-render --width <w> --height <h> --file <ppm>
//! flagship-gpud verify-transcode --width <w> --height <h> --frames <n> --file <yuv>
//!
//! host flags: --catalog <file> --trust <file> --engine <path> --nvidia-smi <path>
//!   --nvidia-ctk <path> --rocm-smi <path> --amd-smi <path> --xpu-smi <path>
//!   --runsc-version <v> --cdi-generator <v> --vm-runtime-version <v>
//!   --rocm-version <v> --level-zero-version <v>
//! ```

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use flagship_gpu::attach::RuntimeNames;
use flagship_gpu::catalog::{CatalogEnvelope, HostFacts, VerifiedCatalog};
use flagship_gpu::catalog_trust::{CatalogTrust, ReleaseKeyVerifier};
use flagship_gpu::host::{EngineRuntime, EngineScrubRunner};
use flagship_gpu::provider::PinnedTools;
use flagship_gpu::service::{CatalogSource, GpuService, ServiceConfig, ServiceParts};
use flagship_gpu::vfio::{RealSysfs, VfioHost};
use serde_json::{Value, json};

const MAX_FRAME: usize = 1 << 20;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn out(v: &Value) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

fn fail(msg: &str) -> ! {
    let _ = writeln!(std::io::stderr().lock(), "flagship-gpud: {msg}");
    std::process::exit(2)
}

struct Flags {
    values: BTreeMap<String, Vec<String>>,
}

impl Flags {
    fn parse(args: &[String]) -> Self {
        let mut values: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut it = args.iter();
        while let Some(a) = it.next() {
            if let Some(k) = a.strip_prefix("--") {
                let v = it.next().cloned().unwrap_or_default();
                values.entry(k.to_owned()).or_default().push(v);
            } else {
                fail(&format!("unexpected argument {a}"));
            }
        }
        Self { values }
    }

    fn one(&self, k: &str) -> Option<String> {
        self.values.get(k).and_then(|v| v.last().cloned())
    }

    fn path(&self, k: &str) -> Option<PathBuf> {
        self.one(k).map(PathBuf::from).filter(|p| p.is_absolute())
    }
}

fn read_trim(p: &str) -> Option<String> {
    fs::read_to_string(p).ok().map(|s| s.trim().to_owned())
}

fn host_facts(f: &Flags) -> HostFacts {
    let sig = read_trim("/sys/module/module/parameters/sig_enforce").as_deref() == Some("Y")
        || read_trim("/sys/kernel/security/lockdown")
            .is_some_and(|s| s.contains("[integrity]") || s.contains("[confidentiality]"));
    HostFacts {
        kernel: read_trim("/proc/sys/kernel/osrelease").unwrap_or_default(),
        module_signing_enforced: sig,
        runsc: f.one("runsc-version"),
        cdi_generator: f.one("cdi-generator"),
        vm_runtime: f.one("vm-runtime-version"),
    }
}

fn load_catalog(f: &Flags, state: Option<&Path>) -> CatalogSource {
    let (Some(cp), Some(tp)) = (f.path("catalog"), f.path("trust")) else {
        return CatalogSource::Missing;
    };
    let Ok(text) = fs::read_to_string(&cp) else {
        return CatalogSource::Missing;
    };
    let trust = match fs::read_to_string(&tp)
        .map_err(|e| e.to_string())
        .and_then(|t| CatalogTrust::from_trust_json(&t))
    {
        Ok(t) => t,
        Err(e) => return CatalogSource::Invalid(format!("trust file: {e}")),
    };
    let env: CatalogEnvelope = match serde_json::from_str(&text) {
        Ok(e) => e,
        Err(e) => return CatalogSource::Invalid(e.to_string()),
    };
    let floor_file = state.map(|s| s.join("catalog-serial"));
    let floor: u64 = floor_file
        .as_ref()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    match VerifiedCatalog::open(&env, &ReleaseKeyVerifier::new(trust, now_ms()), floor) {
        Ok(c) => {
            if let Some(p) = floor_file
                && c.serial() > floor
            {
                let _ = fs::write(p, c.serial().to_string());
            }
            CatalogSource::Loaded(c)
        }
        Err(e) => CatalogSource::Invalid(e.to_string()),
    }
}

fn service(f: &Flags, state: PathBuf) -> Result<GpuService, String> {
    let tools = Arc::new(PinnedTools {
        nvidia_smi: f.path("nvidia-smi"),
        nvidia_ctk: f.path("nvidia-ctk"),
        rocm_smi: f.path("rocm-smi"),
        amd_smi: f.path("amd-smi"),
        xpu_smi: f.path("xpu-smi"),
        timeout: Duration::from_secs(30),
    });
    let engine = f
        .path("engine")
        .unwrap_or_else(|| PathBuf::from("/usr/bin/podman"));
    let names = RuntimeNames::default();
    let runtime = Arc::new(EngineRuntime {
        engine: engine.clone(),
        timeout: Duration::from_secs(60),
        proc_root: "/proc".into(),
    });
    let scrub = Arc::new(EngineScrubRunner::new(
        engine,
        names.clone(),
        tools.clone(),
        VfioHost::system(),
    ));
    let parts = ServiceParts {
        tools,
        runtime,
        scrub,
        sysfs_writer: Arc::new(RealSysfs),
        packages: Some(Arc::new(flagship_gpu::host::AptPackages::default())),
    };
    let catalog = load_catalog(f, Some(&state));
    let mut cfg = ServiceConfig::system(state, catalog, host_facts(f));
    cfg.names = names;
    cfg.rocm_version = f.one("rocm-version");
    cfg.level_zero_version = f.one("level-zero-version");
    GpuService::new(cfg, parts)
}

fn read_frame(s: &mut impl Read) -> Option<Value> {
    let mut head = [0u8; 4];
    s.read_exact(&mut head).ok()?;
    let n = usize::try_from(u32::from_be_bytes(head)).ok()?;
    if n == 0 || n > MAX_FRAME {
        return None;
    }
    let mut body = vec![0u8; n];
    s.read_exact(&mut body).ok()?;
    serde_json::from_slice(&body).ok()
}

fn write_frame(s: &mut impl Write, v: &Value) -> bool {
    let body = v.to_string().into_bytes();
    let Ok(n) = u32::try_from(body.len()) else {
        return false;
    };
    s.write_all(&n.to_be_bytes()).is_ok() && s.write_all(&body).is_ok()
}

#[cfg(target_os = "linux")]
fn peer_uid(s: &std::os::unix::net::UnixStream) -> Option<u32> {
    rustix::net::sockopt::socket_peercred(s)
        .ok()
        .map(|c| c.uid.as_raw())
}

#[cfg(not(target_os = "linux"))]
fn peer_uid(_s: &std::os::unix::net::UnixStream) -> Option<u32> {
    None
}

fn serve(f: &Flags) -> ! {
    let state = f
        .path("state")
        .unwrap_or_else(|| fail("--state <absolute dir> is required"));
    let socket = f
        .path("socket")
        .unwrap_or_else(|| fail("--socket <absolute path> is required"));
    let allowed: Vec<u32> = f
        .values
        .get("allow-uid")
        .map(|v| v.iter().filter_map(|s| s.parse().ok()).collect())
        .unwrap_or_else(|| vec![0]);
    let svc = Arc::new(Mutex::new(service(f, state).unwrap_or_else(|e| fail(&e))));
    let _ = fs::remove_file(&socket);
    if let Some(d) = socket.parent() {
        let _ = fs::create_dir_all(d);
    }
    let listener = std::os::unix::net::UnixListener::bind(&socket)
        .unwrap_or_else(|e| fail(&format!("bind: {}", e.kind())));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The kernel's peer credentials and the uid allowlist decide who may talk; the mode only
        // lets an allowed non-root daemon reach the socket at all.
        let _ = fs::set_permissions(&socket, fs::Permissions::from_mode(0o666));
    }
    let ticker = Arc::clone(&svc);
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(2));
            if let Ok(mut s) = ticker.lock() {
                let _ = s.tick(now_ms());
            }
        }
    });
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else {
            continue;
        };
        if !peer_uid(&stream).is_some_and(|u| allowed.contains(&u)) {
            continue;
        }
        let svc = Arc::clone(&svc);
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(300)));
            let mut hello = false;
            while let Some(req) = read_frame(&mut stream) {
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                let op = req
                    .get("op")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let args = req.get("args").cloned().unwrap_or_else(|| json!({}));
                let reply = if op == "hello" {
                    if args.get("version").and_then(Value::as_u64) == Some(1) {
                        hello = true;
                        json!({"id": id, "ok": true, "result": {"version": 1, "service": "flagship-gpud"}})
                    } else {
                        json!({"id": id, "ok": false, "code": "unsupported-version", "message": "this service speaks version 1"})
                    }
                } else if !hello {
                    json!({"id": id, "ok": false, "code": "not-hello", "message": "say hello first"})
                } else {
                    match svc.lock() {
                        Ok(mut s) => match s.handle(&op, &args) {
                            Ok(r) => json!({"id": id, "ok": true, "result": r}),
                            Err(e) => {
                                json!({"id": id, "ok": false, "code": e.code, "message": e.message})
                            }
                        },
                        Err(_) => {
                            json!({"id": id, "ok": false, "code": "failed", "message": "service lock poisoned"})
                        }
                    }
                };
                if !write_frame(&mut stream, &reply) {
                    return;
                }
            }
        });
    }
    std::process::exit(0)
}

fn num(f: &Flags, k: &str) -> u32 {
    f.one(k)
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| fail(&format!("--{k} <number> is required")))
}

fn verify_report(f: &Flags) {
    use flagship_gpu::numerics::{MlpReport, VectorAddReport, verify_mlp, verify_vector_add};
    let text =
        fs::read_to_string(f.one("file").unwrap_or_default()).unwrap_or_else(|_| fail("--file"));
    let api = f.one("api").unwrap_or_default();
    let r = match f.one("kind").as_deref() {
        Some("vector-add") => serde_json::from_str::<VectorAddReport>(text.trim())
            .map_err(|e| e.to_string())
            .and_then(|r| verify_vector_add(&r, &api)),
        Some("mlp") => serde_json::from_str::<MlpReport>(text.trim())
            .map_err(|e| e.to_string())
            .and_then(|r| verify_mlp(&r, &api)),
        Some("scrub") => {
            let mib: u64 = f
                .one("memory-mib")
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(|| fail("--memory-mib"));
            serde_json::from_str::<flagship_gpu::scrub::ScrubReport>(text.trim())
                .map_err(|e| e.to_string())
                .and_then(|r| flagship_gpu::scrub::judge(&r, mib.saturating_mul(1024 * 1024)))
        }
        _ => fail("--kind vector-add|mlp|scrub"),
    };
    match r {
        Ok(()) => out(&json!({"ok": true})),
        Err(e) => {
            out(&json!({"ok": false, "reason": e}));
            std::process::exit(1);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((cmd, rest)) = args.split_first() else {
        fail("usage: flagship-gpud serve|probe|self-test|verify-catalog ...");
    };
    let f = Flags::parse(rest);
    match cmd.as_str() {
        "serve" => serve(&f),
        "probe" => {
            let dir =
                std::env::temp_dir().join(format!("flagship-gpud-probe-{}", std::process::id()));
            let r = service(&f, dir.clone()).map(|s| s.inventory());
            let _ = fs::remove_dir_all(&dir);
            match r {
                Ok(v) => out(&v),
                Err(e) => fail(&e),
            }
        }
        "self-test" => {
            let report = flagship_gpu::selftest::run(f.path("podman").as_deref());
            out(&serde_json::to_value(&report).unwrap_or(Value::Null));
            if report.failed > 0 {
                std::process::exit(1);
            }
        }
        "verify-catalog" => match load_catalog(&f, None) {
            CatalogSource::Loaded(c) => out(
                &json!({"ok": true, "serial": c.serial(), "digest": c.digest(), "entries": c.entries().iter().map(|e| e.id.clone()).collect::<Vec<_>>()}),
            ),
            CatalogSource::Missing => fail("no catalog or trust file"),
            CatalogSource::Invalid(e) => {
                out(&json!({"ok": false, "reason": e}));
                std::process::exit(1);
            }
        },
        "verify-report" => verify_report(&f),
        "reference-clip" => {
            let (w, h, n) = (num(&f, "width"), num(&f, "height"), num(&f, "frames"));
            let clip = flagship_gpu::media::reference_clip(w, h, n);
            let _ = std::io::stdout().lock().write_all(&clip);
        }
        "verify-render" => {
            let spec = flagship_gpu::media::RenderSpec {
                api: flagship_gpu::media::GraphicsApi::Egl,
                width: num(&f, "width"),
                height: num(&f, "height"),
            };
            let bytes =
                fs::read(f.one("file").unwrap_or_default()).unwrap_or_else(|_| fail("--file"));
            match flagship_gpu::media::verify_render(&spec, &bytes) {
                Ok(v) => out(
                    &json!({"ok": true, "meanAbsError": v.mean_abs_error, "mismatchedFraction": v.mismatched_fraction}),
                ),
                Err(e) => {
                    out(&json!({"ok": false, "reason": e.to_string()}));
                    std::process::exit(1);
                }
            }
        }
        "verify-transcode" => {
            let spec = flagship_gpu::media::TranscodeSpec {
                codec: flagship_gpu::media::Codec::H264,
                op: flagship_gpu::media::VideoOp::RoundTrip,
                width: num(&f, "width"),
                height: num(&f, "height"),
                frames: num(&f, "frames"),
            };
            let bytes =
                fs::read(f.one("file").unwrap_or_default()).unwrap_or_else(|_| fail("--file"));
            match flagship_gpu::media::verify_transcode(&spec, &bytes) {
                Ok(p) => out(&json!({"ok": true, "psnrDb": p})),
                Err(e) => {
                    out(&json!({"ok": false, "reason": e.to_string()}));
                    std::process::exit(1);
                }
            }
        }
        other => fail(&format!("unknown command {other}")),
    }
}
