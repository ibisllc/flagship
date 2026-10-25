//! A request's verdict as plain JSON, the shape the shared vectors
//! (packages/privd/tests/vectors/v1-policy.json) and the TS broker's check use, so the two brokers
//! can be compared answer for answer. Executes nothing.

use crate::podman::EngineKind;
use crate::policy::{PolicyContext, PrivExec, ReleaseTrust, validate_request};
use serde_json::{Map, Value, json};

/// `{ok:true, exec:{…}}` or `{ok:false, code, message}`.
pub fn verdict(op: &str, args: &Map<String, Value>, ctx: &PolicyContext<'_>) -> Value {
    match validate_request(op, args, ctx) {
        Ok(e) => json!({ "ok": true, "exec": exec_json(&e) }),
        Err(e) => json!({ "ok": false, "code": e.code.as_str(), "message": e.message }),
    }
}

pub fn exec_json(e: &PrivExec) -> Value {
    let mut m = Map::new();
    m.insert("file".into(), Value::from(e.file));
    m.insert("args".into(), Value::from(e.args.clone()));
    m.insert("timeoutMs".into(), Value::from(e.timeout_ms));
    if let Some(i) = &e.input {
        m.insert("input".into(), Value::from(i.clone()));
    }
    if let Some(p) = &e.stdin_file {
        m.insert("stdinFile".into(), Value::from(p.clone()));
    }
    if let Some(p) = &e.stdout_file {
        m.insert("stdoutFile".into(), Value::from(p.clone()));
    }
    if !e.env.is_empty() {
        let env: Map<String, Value> = e
            .env
            .iter()
            .map(|(k, v)| (k.clone(), Value::from(v.clone())))
            .collect();
        m.insert("env".into(), Value::Object(env));
    }
    if !e.copy_in.is_empty() {
        let c: Vec<Value> = e
            .copy_in
            .iter()
            .map(|c| json!({ "from": c.from, "to": c.to }))
            .collect();
        m.insert("copyIn".into(), Value::from(c));
    }
    Value::Object(m)
}

/// The trust in a vector file or a check request (`keys`, `threshold`, `nodeFloor`,
/// `minSequence`, `pqKeyIds`, `legacyManifests`).
pub fn trust_from_json(v: &Value) -> Option<ReleaseTrust> {
    let strings = |k: &str| -> Option<Vec<String>> {
        match v.get(k) {
            None => Some(Vec::new()),
            Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(str::to_owned)).collect(),
            Some(_) => None,
        }
    };
    Some(ReleaseTrust {
        keys: strings("keys")?,
        threshold: v.get("threshold")?.as_u64()?,
        node_floor: v.get("nodeFloor")?.as_str()?.to_owned(),
        min_sequence: v.get("minSequence")?.as_u64()?,
        pq_key_ids: strings("pqKeyIds")?,
        legacy_manifests: strings("legacyManifests")?,
    })
}

/// One check request: `{op, args, engine?, mounts?, arch?, trust?}`, with `trust` an object or
/// `"release"` for the trust compiled into this binary.
pub fn check(line: &Value, release: &ReleaseTrust) -> Value {
    let op = line.get("op").and_then(Value::as_str).unwrap_or_default();
    let empty = Map::new();
    let args = line
        .get("args")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let engine = line
        .get("engine")
        .and_then(Value::as_str)
        .and_then(EngineKind::parse)
        .unwrap_or(EngineKind::Docker);
    let mounts_text = line
        .get("mounts")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mounts = move || mounts_text.clone();
    let arch = line.get("arch").and_then(Value::as_str).unwrap_or("amd64");
    let given = line.get("trust").and_then(trust_from_json);
    let trust = given.as_ref().unwrap_or(release);
    let claims = gpu_claims_from_json(line.get("gpu"));
    let gpu = move |id: &str| claims.get(id).cloned();
    verdict(
        op,
        args,
        &PolicyContext {
            engine,
            mounts: &mounts,
            trust,
            arch,
            gpu: &gpu,
        },
    )
}

/// A corpus case's `gpu`: allocation id → the claim gpud would publish.
pub fn gpu_claims_from_json(
    v: Option<&Value>,
) -> std::collections::BTreeMap<String, crate::policy::GpuRunClaim> {
    v.and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, c)| {
                    serde_json::from_value(c.clone())
                        .ok()
                        .map(|c| (k.clone(), c))
                })
                .collect()
        })
        .unwrap_or_default()
}
