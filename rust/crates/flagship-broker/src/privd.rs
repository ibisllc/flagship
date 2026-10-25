//! The privd v1 contract over a connection: hello first, a closed set of operations, a per
//! connection rate limit, and an audit line per decision (packages/privd/src/server.ts).

use crate::audit::Audit;
use crate::js;
use crate::podman::EngineKind;
use crate::policy::{PolicyContext, PrivExec, ReleaseTrust, validate_request};
use crate::runner::V1Runner;
use crate::server::{Connection, ConnectionFactory, Reply};
use crate::wire::{
    ErrorCode, PRIVD_PROTOCOL_VERSION, PrivdError, Request, Response, ResultBody, echo_id,
    encode_frame, parse_request,
};
use serde_json::{Map, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct V1Limits {
    pub max_per_second: u32,
    pub hello_timeout: Duration,
}

impl Default for V1Limits {
    fn default() -> Self {
        Self {
            max_per_second: 20,
            hello_timeout: Duration::from_secs(5),
        }
    }
}

/// What a request is checked against besides its arguments, read for each request.
pub trait V1Environment: Send + Sync {
    fn engine(&self) -> EngineKind;
    fn mounts(&self) -> String;
    fn trust(&self) -> &ReleaseTrust;
    fn arch(&self) -> &str;
    /// flagship-gpud's attached GPU allocation `id`, from its root-owned run-claims file.
    fn gpu_claim(&self, id: &str) -> Option<crate::policy::GpuRunClaim> {
        crate::policy::gpu_claim_from_file(crate::policy::GPU_RUN_CLAIMS_FILE, id)
    }
}

/// A fixed environment (tests, and the conformance check).
#[derive(Debug, Clone)]
pub struct FixedEnvironment {
    pub engine: EngineKind,
    pub mounts: String,
    pub trust: ReleaseTrust,
    pub arch: String,
}

impl V1Environment for FixedEnvironment {
    fn engine(&self) -> EngineKind {
        self.engine
    }
    fn mounts(&self) -> String {
        self.mounts.clone()
    }
    fn trust(&self) -> &ReleaseTrust {
        &self.trust
    }
    fn arch(&self) -> &str {
        &self.arch
    }
}

pub struct V1Factory {
    pub runner: Arc<dyn V1Runner>,
    pub env: Arc<dyn V1Environment>,
    pub audit: Arc<Audit>,
    pub limits: V1Limits,
}

impl std::fmt::Debug for V1Factory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("V1Factory")
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

impl ConnectionFactory for V1Factory {
    fn open(&self, _peer: crate::peer::Peer) -> Box<dyn Connection> {
        Box::new(V1Connection {
            runner: Arc::clone(&self.runner),
            env: Arc::clone(&self.env),
            audit: Arc::clone(&self.audit),
            limits: self.limits,
            hello: false,
            window: (Instant::now(), 0),
        })
    }
}

impl std::fmt::Debug for V1Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("V1Connection")
            .field("hello", &self.hello)
            .finish_non_exhaustive()
    }
}

pub struct V1Connection {
    runner: Arc<dyn V1Runner>,
    env: Arc<dyn V1Environment>,
    audit: Arc<Audit>,
    limits: V1Limits,
    hello: bool,
    window: (Instant, u32),
}

fn frame(r: &Response) -> Vec<u8> {
    encode_frame(r).unwrap_or_default()
}

/// Map a request to the one command it may run.
pub fn validate(req: &Request, env: &dyn V1Environment) -> Result<PrivExec, PrivdError> {
    let mounts = || env.mounts();
    let gpu = |id: &str| env.gpu_claim(id);
    let ctx = PolicyContext {
        engine: env.engine(),
        mounts: &mounts,
        trust: env.trust(),
        arch: env.arch(),
        gpu: &gpu,
    };
    validate_request(req.op, &req.args, &ctx)
}

/// `maskSecret`: everything after the first `<word>PASSWORD=` (any case, anywhere in the
/// argument: `-ePOSTGRES_PASSWORD=…`, `--env=db_password=…`) never reaches the audit.
pub fn mask_secret(a: &str) -> String {
    static SECRET: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        #[allow(clippy::expect_used)]
        regex::Regex::new(r"([A-Za-z0-9_]*[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd])=(?s:.*)$")
            .expect("a fixed pattern compiles")
    });
    SECRET.replace(a, "${1}=…").into_owned()
}

/// `summary`: what was asked, never the bodies or secrets that came with it. A request whose
/// argv is not a list says only that, since its other fields may carry stdin or a password.
pub fn summary(req: &Request) -> String {
    let argv: Option<Vec<String>> = req.args.get("argv").and_then(Value::as_array).map(|a| {
        a.iter()
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => serde_json::to_string(other).unwrap_or_default(),
            })
            .collect()
    });
    match req.op {
        "docker" | "docker.file" | "systemctl" => argv.map_or_else(
            || "malformed request".to_owned(),
            |a| {
                a.iter()
                    .take(3)
                    .map(|x| mask_secret(x))
                    .collect::<Vec<_>>()
                    .join(" ")
            },
        ),
        "host" => match (argv, req.args.get("file").and_then(Value::as_str)) {
            (Some(a), Some(file)) => format!(
                "{file} {}",
                a.iter().take(2).cloned().collect::<Vec<_>>().join(" ")
            ),
            _ => "malformed request".to_owned(),
        },
        "nft.apply" | "iptables.restore" => "firewall rules".to_owned(),
        _ => {
            let text = serde_json::to_string(&req.args).unwrap_or_default();
            js::slice_units(&text, 120).to_owned()
        }
    }
}

/// Execute a validated request and shape the answer as privd does.
pub fn handle(
    runner: &dyn V1Runner,
    env: &dyn V1Environment,
    audit: &Audit,
    req: &Request,
) -> Response {
    let audit_line = |ok: bool, extra: &[(&str, Value)]| {
        let mut m = Map::new();
        m.insert("op".into(), Value::from(req.op));
        m.insert("ok".into(), Value::from(ok));
        for (k, v) in extra {
            m.insert((*k).to_owned(), v.clone());
        }
        m.insert("what".into(), Value::from(summary(req)));
        audit.record(m);
    };
    let exec = match validate(req, env) {
        Ok(e) => e,
        Err(e) => {
            audit_line(false, &[("code", Value::from(e.code.as_str()))]);
            return Response::err(req.id.into(), e);
        }
    };
    let r = runner.run(&exec);
    audit_line(
        r.code == Some(0),
        &[
            ("exit", r.code.map_or(Value::Null, Value::from)),
            ("timedOut", Value::from(r.timed_out)),
        ],
    );
    if r.timed_out {
        return Response::err(
            req.id.into(),
            PrivdError::new(
                ErrorCode::TimedOut,
                "the command ran too long and was stopped",
            ),
        );
    }
    if r.code != Some(0) {
        let lines: Vec<&str> = js::trim(&r.stderr).split('\n').collect();
        let tail = lines
            .get(lines.len().saturating_sub(4)..)
            .unwrap_or_default()
            .join(" | ");
        let code = r.code.map_or_else(|| "null".to_owned(), |c| c.to_string());
        return Response::err(
            req.id.into(),
            PrivdError::new(
                ErrorCode::Failed,
                format!("exited with code {code}: {}", js::slice_units(&tail, 600)),
            ),
        );
    }
    Response::ok(
        req.id,
        ResultBody::Exec {
            stdout: r.stdout,
            stderr: r.stderr,
        },
    )
}

impl Connection for V1Connection {
    fn deadline_passed(&self, connected_for: Duration) -> bool {
        !self.hello && connected_for >= self.limits.hello_timeout
    }

    fn on_frame(&mut self, raw: Value) -> Reply {
        let req = match parse_request(&raw) {
            Ok(r) => r,
            Err(e) => return Reply::Send(frame(&Response::err(echo_id(&raw), e))),
        };
        let now = Instant::now();
        if now.duration_since(self.window.0) > Duration::from_millis(1000) {
            self.window = (now, 0);
        }
        self.window.1 = self.window.1.saturating_add(1);
        if self.window.1 > self.limits.max_per_second {
            return Reply::Send(frame(&Response::err(
                req.id.into(),
                PrivdError::new(ErrorCode::Forbidden, "slow down"),
            )));
        }
        if req.op == "hello" {
            // `version !== 1` in JavaScript: any JSON number equal to 1 (so 1.0 too), nothing else.
            if req.args.get("version").and_then(Value::as_f64) != Some(1.0) {
                let e = PrivdError::new(
                    ErrorCode::UnsupportedVersion,
                    "this broker speaks version 1 only",
                );
                return Reply::SendAndClose(frame(&Response::err(req.id.into(), e)));
            }
            self.hello = true;
            return Reply::Send(frame(&Response::ok(
                req.id,
                ResultBody::Hello {
                    version: PRIVD_PROTOCOL_VERSION,
                },
            )));
        }
        if !self.hello {
            return Reply::Send(frame(&Response::err(
                req.id.into(),
                PrivdError::new(ErrorCode::NotHello, "say hello first"),
            )));
        }
        Reply::Send(frame(&handle(
            self.runner.as_ref(),
            self.env.as_ref(),
            &self.audit,
            &req,
        )))
    }
}
