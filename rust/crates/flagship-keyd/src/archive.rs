//! Server-archive keys held by keyd (plan G6/R6), an op-by-op port of `packages/keyd/src/archive.ts`
//! with the same argument checks in the same order, codes and messages. The daemon makes and opens
//! backups through opaque handles; the content key and the deposited account keys stay here.
//! Frames are sealed once each, in order from 0, because the nonce is the frame index.

use std::collections::HashMap;
use std::path::PathBuf;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::crypto::random;
use crate::files::write_atomic;
use crate::obj;
use crate::service::safe_integer;
use crate::wire::{
    Args, ErrorCode, HexBounds, KeydError, KeydResult, hex_arg, no_extra_args, str_arg, to_hex,
};

pub const ARCHIVE_POOL_MAX: usize = 800;
pub const ARCHIVE_MAX_HANDLES: usize = 8;
pub const ARCHIVE_HANDLE_IDLE_MS: i64 = 2 * 60 * 60_000;
pub const ARCHIVE_MAX_FRAME: usize = 1024 * 1024 + 16;
pub const ARCHIVE_MAX_BODY: usize = 256 * 1024;

struct Handle {
    archive_id: String,
    key: Zeroizing<[u8; 32]>,
    next_seal: u64,
    sealed_last: bool,
    used_at: i64,
}

struct PoolKey {
    archive_id: String,
    kek: Zeroizing<[u8; 32]>,
}

pub struct ArchiveKeys {
    pool_path: Option<PathBuf>,
    pool: Vec<PoolKey>,
    handles: HashMap<String, Handle>,
}

impl std::fmt::Debug for ArchiveKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArchiveKeys")
            .field("pool", &self.pool.len())
            .field("handles", &self.handles.len())
            .finish_non_exhaustive()
    }
}

fn is_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

fn key32(b: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut k = Zeroizing::new([0u8; 32]);
    if let Some(src) = b.get(..32) {
        k.copy_from_slice(src);
    }
    k
}

fn auth_failed() -> KeydError {
    KeydError::failed("authentication failed")
}

fn seal(key: &[u8; 32], nonce: &[u8; 12], aad: &str, plain: &[u8]) -> KeydResult<Vec<u8>> {
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| auth_failed())?
        .encrypt(
            &Nonce::from(*nonce),
            Payload {
                msg: plain,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| auth_failed())
}

fn open(key: &[u8; 32], nonce: &[u8; 12], aad: &str, ct: &[u8]) -> KeydResult<Zeroizing<Vec<u8>>> {
    if ct.len() < 16 {
        return Err(auth_failed());
    }
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| auth_failed())?
        .decrypt(
            &Nonce::from(*nonce),
            Payload {
                msg: ct,
                aad: aad.as_bytes(),
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| auth_failed())
}

fn frame_nonce(index: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    if let Some(tail) = n.get_mut(4..) {
        tail.copy_from_slice(&index.to_be_bytes());
    }
    n
}

fn index_arg(a: &Args) -> KeydResult<u64> {
    safe_integer(a.get("index"))
        .ok_or_else(|| KeydError::bad_request("index must be a non-negative integer"))
}

fn last_arg(a: &Args) -> KeydResult<bool> {
    match a.get("last") {
        Some(Value::Bool(b)) => Ok(*b),
        _ => Err(KeydError::bad_request("last must be true or false")),
    }
}

fn id_arg(a: &Args) -> KeydResult<String> {
    let id = str_arg(a, "archiveId", 32)?;
    if !is_id(id) {
        return Err(KeydError::bad_request(
            "archiveId must be 16 bytes of lowercase hex",
        ));
    }
    Ok(id.to_owned())
}

fn nonce12(b: &[u8]) -> [u8; 12] {
    let mut n = [0u8; 12];
    if let Some(src) = b.get(..12) {
        n.copy_from_slice(src);
    }
    n
}

fn rng_failed() -> KeydError {
    KeydError::failed("no randomness")
}

impl ArchiveKeys {
    /// The pool kept at `pool_path` (`archive-keks.json`), or in memory only.
    pub fn load(pool_path: Option<PathBuf>) -> Self {
        let mut pool = Vec::new();
        if let Some(p) = &pool_path
            && let Ok(text) = std::fs::read_to_string(p)
            && let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&text)
            && let Some(Value::Array(keys)) = o.get("keys")
        {
            for k in keys {
                let (Some(id), Some(kek)) = (
                    k.get("archiveId").and_then(Value::as_str),
                    k.get("kekHex").and_then(Value::as_str),
                ) else {
                    continue;
                };
                let Some(bytes) = crate::wire::decode_hex(kek).filter(|b| b.len() == 32) else {
                    continue;
                };
                if is_id(id) {
                    pool.push(PoolKey {
                        archive_id: id.to_owned(),
                        kek: key32(&bytes),
                    });
                }
            }
        }
        Self {
            pool_path,
            pool,
            handles: HashMap::new(),
        }
    }

    fn save(&self) -> KeydResult<()> {
        let Some(p) = &self.pool_path else {
            return Ok(());
        };
        let keys: Vec<Value> = self
            .pool
            .iter()
            .map(|k| serde_json::json!({ "archiveId": k.archive_id, "kekHex": to_hex(k.kek.as_ref()) }))
            .collect();
        let text = Zeroizing::new(serde_json::json!({ "v": 1, "keys": keys }).to_string());
        write_atomic(p, text.as_bytes(), 0o600)
            .map_err(|_| KeydError::failed("could not keep the archive keys"))
    }

    fn prune(&mut self, now: i64) {
        self.handles
            .retain(|_, h| now.saturating_sub(h.used_at) <= ARCHIVE_HANDLE_IDLE_MS);
    }

    fn open_handle(
        &mut self,
        key: Zeroizing<[u8; 32]>,
        archive_id: String,
        now: i64,
    ) -> KeydResult<String> {
        self.prune(now);
        if self.handles.len() >= ARCHIVE_MAX_HANDLES {
            return Err(KeydError::new(
                ErrorCode::RateLimited,
                "too many archive keys are open",
            ));
        }
        let h = to_hex(&random::<16>().map_err(|_| rng_failed())?);
        self.handles.insert(
            h.clone(),
            Handle {
                archive_id,
                key,
                next_seal: 0,
                sealed_last: false,
                used_at: now,
            },
        );
        Ok(h)
    }

    fn handle_mut(&mut self, a: &Args, now: i64) -> KeydResult<&mut Handle> {
        self.prune(now);
        let h = str_arg(a, "handle", 32)?;
        let v = self
            .handles
            .get_mut(h)
            .ok_or_else(|| KeydError::not_provisioned("no such archive key"))?;
        v.used_at = now;
        Ok(v)
    }

    pub fn destroy(&mut self) {
        self.handles.clear();
        self.pool.clear();
    }

    /// One `archive.*` operation.
    ///
    /// # Errors
    /// The same codes and messages as the TS service.
    pub fn handle(&mut self, op: &str, a: &Args, now: i64) -> KeydResult<Args> {
        match op {
            "archive.pool.add" => {
                no_extra_args(a, &["keys"])?;
                let shape = || KeydError::bad_request("keys must be a list of archive keys");
                let keys = match a.get("keys") {
                    Some(Value::Array(k)) if !k.is_empty() && k.len() <= ARCHIVE_POOL_MAX => k,
                    _ => return Err(shape()),
                };
                let mut fresh = Vec::with_capacity(keys.len());
                for k in keys {
                    let Value::Object(o) = k else {
                        return Err(shape());
                    };
                    no_extra_args(o, &["archiveId", "kekHex"])?;
                    let archive_id = id_arg(o)?;
                    let kek = key32(&Zeroizing::new(hex_arg(o, "kekHex", HexBounds::exact(32))?));
                    fresh.push(PoolKey { archive_id, kek });
                }
                for k in fresh {
                    if self.pool.len() >= ARCHIVE_POOL_MAX
                        || self.pool.iter().any(|p| p.archive_id == k.archive_id)
                    {
                        continue;
                    }
                    self.pool.push(k);
                }
                self.save()?;
                Ok(obj! { "size" => self.pool.len() })
            }
            "archive.pool.list" => {
                no_extra_args(a, &[])?;
                let ids: Vec<Value> = self
                    .pool
                    .iter()
                    .map(|k| Value::from(k.archive_id.clone()))
                    .collect();
                Ok(obj! { "archiveIds" => ids })
            }
            "archive.create" => {
                no_extra_args(a, &["archiveId"])?;
                let id = id_arg(a)?;
                let at = self
                    .pool
                    .iter()
                    .position(|k| k.archive_id == id)
                    .ok_or_else(|| KeydError::not_provisioned("no account key for that archive"))?;
                let entry = self.pool.remove(at);
                // The key leaves the pool on disk before it is used, so it is never used twice.
                self.save()?;
                let key = Zeroizing::new(random::<32>().map_err(|_| rng_failed())?);
                let nonce = random::<12>().map_err(|_| rng_failed())?;
                let wrapped = seal(
                    &entry.kek,
                    &nonce,
                    &format!("flagship/server-backup-slot/v2|account|{id}"),
                    key.as_ref(),
                )?;
                drop(entry);
                let handle = self.open_handle(key, id, now)?;
                Ok(obj! {
                    "handle" => handle,
                    "slot" => serde_json::Value::Object(obj! { "kind" => "account", "nonceHex" => to_hex(&nonce), "wrappedHex" => to_hex(&wrapped) }),
                })
            }
            "archive.import" => {
                no_extra_args(a, &["archiveId", "key"])?;
                let id = id_arg(a)?;
                let key = key32(&Zeroizing::new(hex_arg(a, "key", HexBounds::exact(32))?));
                Ok(obj! { "handle" => self.open_handle(key, id, now)? })
            }
            "archive.sealFrame" => {
                no_extra_args(a, &["handle", "index", "last", "plain"])?;
                let h = self.handle_mut(a, now)?;
                let index = index_arg(a)?;
                let last = last_arg(a)?;
                let plain = Zeroizing::new(hex_arg(a, "plain", HexBounds::max(ARCHIVE_MAX_FRAME))?);
                if h.sealed_last || index != h.next_seal {
                    return Err(KeydError::forbidden(
                        "frames are sealed once each, in order",
                    ));
                }
                let aad = format!(
                    "flagship/server-backup-data/v2|{}|{}",
                    h.archive_id,
                    u8::from(last)
                );
                let frame = seal(&h.key, &frame_nonce(index), &aad, &plain)?;
                h.next_seal = index.saturating_add(1);
                if last {
                    h.sealed_last = true;
                }
                Ok(obj! { "frame" => to_hex(&frame) })
            }
            "archive.openFrame" => {
                no_extra_args(a, &["handle", "index", "last", "frame"])?;
                let h = self.handle_mut(a, now)?;
                let index = index_arg(a)?;
                let last = last_arg(a)?;
                let frame = hex_arg(
                    a,
                    "frame",
                    HexBounds::range(16, ARCHIVE_MAX_FRAME.saturating_add(16)),
                )?;
                let aad = format!(
                    "flagship/server-backup-data/v2|{}|{}",
                    h.archive_id,
                    u8::from(last)
                );
                let plain = open(&h.key, &frame_nonce(index), &aad, &frame)?;
                Ok(obj! { "plain" => to_hex(&plain) })
            }
            "archive.sealBody" => {
                no_extra_args(a, &["handle", "body"])?;
                let h = self.handle_mut(a, now)?;
                let body = Zeroizing::new(hex_arg(a, "body", HexBounds::max(ARCHIVE_MAX_BODY))?);
                let nonce = random::<12>().map_err(|_| rng_failed())?;
                let aad = format!("flagship/server-backup-body/v2|{}", h.archive_id);
                let sealed = seal(&h.key, &nonce, &aad, &body)?;
                Ok(obj! { "nonce" => to_hex(&nonce), "sealed" => to_hex(&sealed) })
            }
            "archive.openBody" => {
                no_extra_args(a, &["handle", "nonce", "sealed"])?;
                let h = self.handle_mut(a, now)?;
                let nonce = hex_arg(a, "nonce", HexBounds::exact(12))?;
                let sealed = hex_arg(
                    a,
                    "sealed",
                    HexBounds::range(16, ARCHIVE_MAX_BODY.saturating_add(16)),
                )?;
                let aad = format!("flagship/server-backup-body/v2|{}", h.archive_id);
                let body = open(&h.key, &nonce12(&nonce), &aad, &sealed)?;
                Ok(obj! { "body" => to_hex(&body) })
            }
            "archive.close" => {
                no_extra_args(a, &["handle"])?;
                let h = str_arg(a, "handle", 32)?;
                Ok(obj! { "closed" => self.handles.remove(h).is_some() })
            }
            _ => Err(KeydError::new(ErrorCode::UnknownOp, "unknown operation")),
        }
    }
}
