use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use wasmtime::{Config, Engine, ExternType, Linker, Module, Store, Trap};
use wasmtime_wasi::p1::WasiP1Ctx;
use wasmtime_wasi::p2::pipe::{MemoryInputPipe, MemoryOutputPipe};
use wasmtime_wasi::{FsPerms, I32Exit, WasiCtxBuilder};

use crate::error::{LimitKind, WorkerError};
use crate::hostcalls::{self, CapabilityBroker, HostCallState};
use crate::limits::StoreLimiter;
use crate::manifest::{HostCall, Preopen, PreopenPerms, WasiGrant};

/// The only import module a WASI app may link against. Anything else
/// (sockets extensions, host-specific modules) is refused before linking.
const WASI_P1: &str = "wasi_snapshot_preview1";
const WASM_MAGIC: &[u8; 4] = b"\0asm";
/// Core-module version 1; a component carries a different layer/version.
const CORE_VERSION: [u8; 4] = [1, 0, 0, 0];
/// Fuel units between async yields, so a wall-clock timeout can fire even
/// in a loop that makes no host calls.
const FUEL_YIELD_INTERVAL: u64 = 50_000;

#[derive(Clone, Debug)]
pub struct WorkerConfig {
    /// Largest module (binary or WAT text) the worker will compile.
    pub max_module_bytes: usize,
    /// Runs served at once. Each run makes at most one host call at a time,
    /// so this also bounds concurrent host calls.
    pub max_concurrent_runs: usize,
    /// Epoch tick; wall-clock deadlines are rounded up to whole ticks.
    pub epoch_tick: Duration,
    /// Native stack a guest may use.
    pub max_wasm_stack: usize,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            max_module_bytes: 32 * 1024 * 1024,
            max_concurrent_runs: 4,
            epoch_tick: Duration::from_millis(10),
            max_wasm_stack: 512 * 1024,
        }
    }
}

/// What the broker hands the worker to compile. There is deliberately no
/// variant for a precompiled artifact.
#[derive(Clone, Copy, Debug)]
pub enum ModuleSource<'a> {
    /// A WebAssembly binary (`\0asm`, core module).
    Wasm(&'a [u8]),
    /// WebAssembly text, parsed inside the worker.
    Wat(&'a str),
}

impl ModuleSource<'_> {
    fn bytes(&self) -> &[u8] {
        match self {
            Self::Wasm(b) => b,
            Self::Wat(t) => t.as_bytes(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    /// `_start` returned or the guest called `proc_exit(code)`.
    Code(i32),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunOutcome {
    pub exit: Exit,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub fuel_consumed: u64,
    /// `flagship_v1` host calls the run made.
    pub host_calls: u32,
}

pub(crate) struct Host {
    wasi: WasiP1Ctx,
    limiter: StoreLimiter,
    pub(crate) calls: HostCallState,
}

/// A module compiled by one worker for one installation and one approved
/// digest. It is the only compiled-code cache there is: it lives in the
/// worker's memory, is never written to disk, and [`Worker::run_compiled`]
/// refuses it for any other app, digest or engine.
pub struct CompiledModule {
    app_id: String,
    digest: String,
    module: Module,
}

impl fmt::Debug for CompiledModule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CompiledModule")
            .field("app_id", &self.app_id)
            .field("digest", &self.digest)
            .finish_non_exhaustive()
    }
}

impl CompiledModule {
    pub fn app_id(&self) -> &str {
        &self.app_id
    }

    pub fn digest(&self) -> &str {
        &self.digest
    }
}

/// What one run gets beyond the grant: its stdin (an HTTP request body),
/// per-run variables (the CGI request variables) and the broker that answers
/// its host calls.
#[derive(Clone, Default)]
pub struct RunInput<'a> {
    pub stdin: &'a [u8],
    pub extra_env: &'a [(String, String)],
    pub broker: Option<Arc<dyn CapabilityBroker>>,
}

impl fmt::Debug for RunInput<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RunInput")
            .field("stdin_bytes", &self.stdin.len())
            .field("extra_env", &self.extra_env.len())
            .field("broker", &self.broker.is_some())
            .finish()
    }
}

/// One confined WASI execution engine. It is meant to live in its own
/// process (spawned by the runtime under the app's sandbox profile, no
/// network namespace, only the app's directories mounted); this type is the
/// in-process half that enforces the grant.
pub struct Worker {
    engine: Engine,
    config: WorkerConfig,
    /// The one installation this worker serves, when bound.
    app: Option<String>,
    running: Arc<AtomicUsize>,
    stop_ticker: Arc<AtomicBool>,
    ticker: Option<JoinHandle<()>>,
}

impl fmt::Debug for Worker {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Worker")
            .field("config", &self.config)
            .field("app", &self.app)
            .field("running", &self.running.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop_ticker.store(true, Ordering::Relaxed);
        if let Some(t) = self.ticker.take() {
            let _ = t.join();
        }
    }
}

struct RunPermit(Arc<AtomicUsize>);

impl Drop for RunPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Worker {
    pub fn new(config: WorkerConfig) -> Result<Self, WorkerError> {
        let mut c = Config::new();
        c.consume_fuel(true)
            .epoch_interruption(true)
            .max_wasm_stack(config.max_wasm_stack)
            .wasm_component_model(false)
            .wasm_memory64(false)
            .wasm_multi_memory(false)
            .wasm_stack_switching(false)
            .wasm_backtrace_max_frames(None);
        let engine = Engine::new(&c).map_err(|e| WorkerError::Internal(e.to_string()))?;
        let stop_ticker = Arc::new(AtomicBool::new(false));
        let ticker = {
            let engine = engine.clone();
            let stop = Arc::clone(&stop_ticker);
            let tick = config.epoch_tick;
            std::thread::Builder::new()
                .name("flagship-wasi-epoch".into())
                .spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(tick);
                        engine.increment_epoch();
                    }
                })
                .map_err(|e| WorkerError::Internal(e.to_string()))?
        };
        Ok(Self {
            engine,
            config,
            app: None,
            running: Arc::new(AtomicUsize::new(0)),
            stop_ticker,
            ticker: Some(ticker),
        })
    }

    /// A worker for exactly one installation: it compiles and runs only
    /// grants whose `appId` is `app_id`. The box gives every app its own
    /// worker process, so compiled code is never shared between apps.
    pub fn for_app(config: WorkerConfig, app_id: &str) -> Result<Self, WorkerError> {
        let mut w = Self::new(config)?;
        w.app = Some(app_id.to_owned());
        Ok(w)
    }

    fn check_bound(&self, grant: &WasiGrant) -> Result<(), WorkerError> {
        match &self.app {
            Some(app) if app != grant.app_id() => Err(WorkerError::ModuleNotForThisApp),
            _ => Ok(()),
        }
    }

    fn acquire(&self) -> Result<RunPermit, WorkerError> {
        let max = self.config.max_concurrent_runs;
        self.running
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < max).then(|| n.saturating_add(1))
            })
            .map_err(|_| WorkerError::Busy(max))?;
        Ok(RunPermit(Arc::clone(&self.running)))
    }

    /// Compile untrusted bytes in this worker. Refuses precompiled artifacts
    /// (wasmtime's ELF output), components and anything over the size limit.
    pub fn compile(&self, source: ModuleSource<'_>) -> Result<Module, WorkerError> {
        let module = self.compile_unchecked(source)?;
        check_imports(&module, None)?;
        Ok(module)
    }

    /// Compile `source` for `grant`: its digest must be the approved one, and
    /// it may import only WASI preview 1 and the `flagship_v1` host calls
    /// whose manifest capability the grant holds.
    pub fn compile_for(
        &self,
        grant: &WasiGrant,
        source: ModuleSource<'_>,
    ) -> Result<CompiledModule, WorkerError> {
        self.check_bound(grant)?;
        let digest = sha256_digest(source.bytes());
        if digest != grant.module_digest() {
            return Err(WorkerError::Manifest(
                crate::manifest::ManifestError::DigestNotApproved,
            ));
        }
        let module = self.compile_unchecked(source)?;
        check_imports(&module, Some(grant))?;
        if module.get_export("_start").is_none() {
            return Err(WorkerError::NoEntryPoint);
        }
        Ok(CompiledModule {
            app_id: grant.app_id().to_owned(),
            digest,
            module,
        })
    }

    fn compile_unchecked(&self, source: ModuleSource<'_>) -> Result<Module, WorkerError> {
        let raw = source.bytes();
        if raw.len() > self.config.max_module_bytes {
            return Err(WorkerError::ModuleTooLarge {
                size: raw.len(),
                limit: self.config.max_module_bytes,
            });
        }
        if Engine::detect_precompiled(raw).is_some() {
            return Err(WorkerError::PrecompiledArtifactRefused);
        }
        let binary = match source {
            ModuleSource::Wasm(b) => {
                check_core_module(b)?;
                b.to_vec()
            }
            ModuleSource::Wat(t) => {
                let b = wat::parse_str(t).map_err(|e| WorkerError::Compile(e.to_string()))?;
                check_core_module(&b)?;
                b
            }
        };
        Module::from_binary(&self.engine, &binary).map_err(|e| WorkerError::Compile(e.to_string()))
    }

    /// Compile and run `_start` under `grant`. `preopens` are directories the
    /// broker opened for this run; each must be named by the grant.
    pub fn run(
        &self,
        source: ModuleSource<'_>,
        grant: &WasiGrant,
        preopens: &[Preopen],
        stdin: &[u8],
    ) -> Result<RunOutcome, WorkerError> {
        let compiled = self.compile_for(grant, source)?;
        self.run_compiled(
            &compiled,
            grant,
            preopens,
            RunInput {
                stdin,
                ..RunInput::default()
            },
        )
    }

    /// Run a module this worker compiled for `grant`. A fresh instance and
    /// store per run: nothing a run leaves in memory reaches the next one.
    pub fn run_compiled(
        &self,
        compiled: &CompiledModule,
        grant: &WasiGrant,
        preopens: &[Preopen],
        input: RunInput<'_>,
    ) -> Result<RunOutcome, WorkerError> {
        let _permit = self.acquire()?;
        self.check_bound(grant)?;
        if compiled.app_id != grant.app_id()
            || compiled.digest != grant.module_digest()
            || !Engine::same(compiled.module.engine(), &self.engine)
        {
            return Err(WorkerError::ModuleNotForThisApp);
        }
        for p in preopens {
            if !grant.allows(p) {
                return Err(WorkerError::PreopenNotGranted(p.guest.clone()));
            }
        }
        let module = &compiled.module;

        let limits = *grant.limits();
        let wall = Duration::from_millis(limits.wall_time_ms);
        let stdout = MemoryOutputPipe::new(usize::try_from(limits.stdout_bytes).unwrap_or(0));
        let stderr = MemoryOutputPipe::new(usize::try_from(limits.stderr_bytes).unwrap_or(0));
        let mut b = WasiCtxBuilder::new();
        b.stdin(MemoryInputPipe::new(input.stdin.to_vec()))
            .stdout(stdout.clone())
            .stderr(stderr.clone())
            .arg("app")
            .args(&grant.args)
            .envs(grant.env())
            .envs(input.extra_env)
            .allow_tcp(false)
            .allow_udp(false)
            .allow_ip_name_lookup(false)
            .socket_addr_check(|_, _| Box::pin(async { false }));
        for p in preopens {
            let perms = match p.perms {
                PreopenPerms::ReadOnly => FsPerms::ReadOnly,
                PreopenPerms::ReadWrite => FsPerms::ReadWrite,
            };
            b.preopened_dir(&p.host, &p.guest, perms)
                .map_err(|_| WorkerError::PreopenUnavailable(p.guest.clone()))?;
        }
        let host = Host {
            wasi: b.build_p1(),
            limiter: StoreLimiter::new(&limits),
            calls: HostCallState::new(
                grant.egress_hosts().to_vec(),
                input.broker.clone(),
                Instant::now().checked_add(wall),
            ),
        };

        let mut store = Store::new(&self.engine, host);
        store.limiter(|h| &mut h.limiter);
        store
            .set_fuel(limits.fuel)
            .map_err(|e| WorkerError::Internal(e.to_string()))?;
        store
            .fuel_async_yield_interval(Some(FUEL_YIELD_INTERVAL))
            .map_err(|e| WorkerError::Internal(e.to_string()))?;
        let tick_ms = self.config.epoch_tick.as_millis().max(1);
        let ticks = u64::try_from(wall.as_millis().div_ceil(tick_ms))
            .unwrap_or(u64::MAX)
            .saturating_add(1);
        store.set_epoch_deadline(ticks);
        store.epoch_deadline_trap();

        let mut linker: Linker<Host> = Linker::new(&self.engine);
        wasmtime_wasi::p1::add_to_linker_async(&mut linker, |h| &mut h.wasi)
            .map_err(|e| WorkerError::Internal(e.to_string()))?;
        hostcalls::add_to_linker(&mut linker, grant)?;
        for import in module.imports() {
            if linker.get_by_import(&mut store, &import).is_none() {
                return Err(WorkerError::ImportNotGranted {
                    module: import.module().to_owned(),
                    name: import.name().to_owned(),
                });
            }
        }

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .map_err(|e| WorkerError::Internal(e.to_string()))?;
        let result = rt.block_on(async {
            let run = async {
                let instance = linker.instantiate_async(&mut store, module).await?;
                let start = instance.get_typed_func::<(), ()>(&mut store, "_start")?;
                start.call_async(&mut store, ()).await
            };
            tokio::time::timeout(wall, run).await
        });
        // A host call still running in the blocking pool is abandoned here;
        // the broker bounds it with the run's remaining time.
        rt.shutdown_background();

        let fuel_left = store.get_fuel().unwrap_or(0);
        let fuel_consumed = limits.fuel.saturating_sub(fuel_left);
        let exit = match result {
            Err(_elapsed) => return Err(WorkerError::LimitExceeded(LimitKind::WallTime)),
            Ok(Ok(())) => Exit::Code(0),
            Ok(Err(e)) => {
                if let Some(kind) = store.data().limiter.denied {
                    return Err(WorkerError::LimitExceeded(kind));
                }
                if let Some(code) = e.downcast_ref::<I32Exit>() {
                    Exit::Code(code.0)
                } else if let Some(trap) = e.downcast_ref::<Trap>() {
                    return Err(match trap {
                        Trap::OutOfFuel => WorkerError::LimitExceeded(LimitKind::Fuel),
                        Trap::Interrupt => WorkerError::LimitExceeded(LimitKind::WallTime),
                        other => WorkerError::Trap(other.to_string()),
                    });
                } else {
                    let msg = e.to_string();
                    if msg.contains("resource limit exceeded") {
                        return Err(WorkerError::LimitExceeded(LimitKind::Instances));
                    }
                    return Err(WorkerError::Trap(msg));
                }
            }
        };
        Ok(RunOutcome {
            exit,
            stdout: stdout.contents().to_vec(),
            stderr: stderr.contents().to_vec(),
            fuel_consumed,
            host_calls: store.data().calls.count(),
        })
    }

    /// Runs in progress right now.
    pub fn active_runs(&self) -> usize {
        self.running.load(Ordering::Acquire)
    }

    /// The engine, for producing test fixtures. Not a loading path: the
    /// worker never deserializes what an engine precompiles.
    pub fn engine(&self) -> &Engine {
        &self.engine
    }
}

/// Every import must be a WASI preview 1 function, or a `flagship_v1` host
/// call whose capability `grant` holds. Without a grant no host call passes.
fn check_imports(module: &Module, grant: Option<&WasiGrant>) -> Result<(), WorkerError> {
    for import in module.imports() {
        let is_func = matches!(import.ty(), ExternType::Func(_));
        let refused = || WorkerError::ImportNotGranted {
            module: import.module().to_owned(),
            name: import.name().to_owned(),
        };
        if !is_func {
            return Err(refused());
        }
        if import.module() == WASI_P1 {
            continue;
        }
        if import.module() == HostCall::MODULE {
            let call = HostCall::from_import(import.name()).ok_or_else(refused)?;
            if grant.is_some_and(|g| g.grants(call)) {
                continue;
            }
            return Err(WorkerError::CapabilityNotDeclared {
                call: call.name(),
                capability: match call {
                    HostCall::HttpFetch => "network.egress",
                    HostCall::DbQuery => "data.stores.postgres",
                    HostCall::LastResponse => "network.egress or data.stores.postgres",
                },
            });
        }
        return Err(refused());
    }
    Ok(())
}

fn check_core_module(b: &[u8]) -> Result<(), WorkerError> {
    let magic = b.get(0..4).ok_or(WorkerError::NotWasm)?;
    if magic != WASM_MAGIC {
        return Err(WorkerError::NotWasm);
    }
    let version = b.get(4..8).ok_or(WorkerError::NotWasm)?;
    if version != CORE_VERSION {
        return Err(WorkerError::ComponentRefused);
    }
    Ok(())
}

/// `sha256:<hex>` of the bytes as the broker received them.
pub fn sha256_digest(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    let mut s = String::with_capacity(71);
    s.push_str("sha256:");
    for b in d.iter() {
        s.push(hex_nibble(b >> 4));
        s.push(hex_nibble(b & 0x0f));
    }
    s
}

fn hex_nibble(n: u8) -> char {
    char::from_digit(u32::from(n), 16).unwrap_or('0')
}
