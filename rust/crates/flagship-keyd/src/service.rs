//! The operations keyd answers, an op-by-op port of `packages/keyd/src/service.ts`. The order
//! of argument checks follows the TS evaluation order, so the same bad request gets the same
//! error code from either backend.

use std::path::PathBuf;

use ed25519_dalek::Signer;
use serde_json::Value;
use zeroize::Zeroizing;

use crate::acme::{AcmeAccount, AcmeRequest};
use crate::crypto::{Key32, gcm_open, gcm_seal, hkdf32, open_sealed, sha256};
use crate::files::save_key_file;
use crate::obj;
use crate::policy::{BOX_SIGN_PURPOSES, check_sign};
use crate::tls::TlsKeys;
use crate::wire::{
    Args, ErrorCode, HexBounds, KEYD_PROTOCOL_VERSION, KeydError, KeydResult, PEM_MAX, hex_arg,
    no_extra_args, pem_arg, str_arg, string_list, to_hex,
};

/// The only labels a workload-key derivation may use (`SWK_DERIVE_LABELS` in opaqueKey.ts).
pub const SWK_DERIVE_LABELS: &[&str] = &[
    "flagship.chunk.v1",
    "flagship.llm.v1",
    "flagship.tls.v1",
    "flagship.pb-manifest.v1",
    "flagship/peer-backup-key/v1",
    "flagship.app-secret.v1",
];

const APP_COPY_ENV_PREFIX: &[u8] = b"flagship/app-copy-env/v1|";
const BULK: usize = 3 * 1024 * 1024;

/// Where provisioned keys are written (`fileKeyStore`); `None` keeps them in memory only.
pub type KeyStoreDir = Option<PathBuf>;

pub struct KeydService {
    signing: Option<ed25519_dalek::SigningKey>,
    pub_hex: String,
    swk: Option<Key32>,
    cgk: Option<Key32>,
    store: KeyStoreDir,
    tls: Option<TlsKeys>,
    acme: Option<AcmeAccount>,
}

impl std::fmt::Debug for KeydService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeydService")
            .field("public_key", &self.pub_hex)
            .field("has_swk", &self.swk.is_some())
            .field("has_cgk", &self.cgk.is_some())
            .finish_non_exhaustive()
    }
}

pub struct Handled {
    pub result: Args,
    pub purpose: Option<String>,
}

impl std::fmt::Debug for Handled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Handled")
            .field("purpose", &self.purpose)
            .finish_non_exhaustive()
    }
}

fn done(result: Args) -> KeydResult<Handled> {
    Ok(Handled {
        result,
        purpose: None,
    })
}

fn auth_failed() -> KeydError {
    KeydError::failed("authentication failed")
}

fn key32(b: &[u8]) -> Key32 {
    let mut k = Zeroizing::new([0u8; 32]);
    if let Some(src) = b.get(..32) {
        k.copy_from_slice(src);
    }
    k
}

impl KeydService {
    pub fn new(
        identity_seed: &[u8; 32],
        swk: Option<Key32>,
        cgk: Option<Key32>,
        store: KeyStoreDir,
        tls: Option<TlsKeys>,
        acme: Option<AcmeAccount>,
    ) -> Self {
        let signing = ed25519_dalek::SigningKey::from_bytes(identity_seed);
        let pub_hex = to_hex(signing.verifying_key().as_bytes());
        Self {
            signing: Some(signing),
            pub_hex,
            swk,
            cgk,
            store,
            tls,
            acme,
        }
    }

    pub fn public_key_hex(&self) -> &str {
        &self.pub_hex
    }

    /// Drop every key (each type zeroizes itself on drop).
    pub fn destroy(&mut self) {
        self.signing = None;
        self.swk = None;
        self.cgk = None;
        if let Some(t) = &mut self.tls {
            t.destroy();
        }
        if let Some(a) = &mut self.acme {
            a.destroy();
        }
    }

    fn stk(&self) -> KeydResult<&ed25519_dalek::SigningKey> {
        self.signing
            .as_ref()
            .ok_or_else(|| KeydError::failed("internal error"))
    }
    fn swk(&self) -> KeydResult<&[u8; 32]> {
        self.swk
            .as_deref()
            .ok_or_else(|| KeydError::not_provisioned("no SWK provisioned"))
    }
    fn cgk(&self) -> KeydResult<&[u8; 32]> {
        self.cgk
            .as_deref()
            .ok_or_else(|| KeydError::not_provisioned("no CGK provisioned"))
    }
    fn tls(&self) -> KeydResult<&TlsKeys> {
        self.tls
            .as_ref()
            .ok_or_else(|| KeydError::not_provisioned("this keyd serves no TLS keys"))
    }
    fn tls_mut(&mut self) -> KeydResult<&mut TlsKeys> {
        self.tls
            .as_mut()
            .ok_or_else(|| KeydError::not_provisioned("this keyd serves no TLS keys"))
    }
    fn acme(&self) -> KeydResult<&AcmeAccount> {
        self.acme
            .as_ref()
            .ok_or_else(|| KeydError::not_provisioned("this keyd serves no ACME account"))
    }
    fn acme_mut(&mut self) -> KeydResult<&mut AcmeAccount> {
        self.acme
            .as_mut()
            .ok_or_else(|| KeydError::not_provisioned("this keyd serves no ACME account"))
    }

    fn status(&self) -> Args {
        obj! { "publicKey" => self.pub_hex.clone(), "hasSwk" => self.swk.is_some(), "hasCgk" => self.cgk.is_some() }
    }

    /// `#req(a, name)`: the single bulk argument of a seal/encrypt operation.
    fn bulk(a: &Args, name: &str) -> KeydResult<Zeroizing<Vec<u8>>> {
        no_extra_args(a, &[name])?;
        hex_arg(a, name, HexBounds::range(0, BULK)).map(Zeroizing::new)
    }

    pub fn handle(&mut self, op: &str, a: &Args) -> KeydResult<Handled> {
        match op {
            "hello" => {
                no_extra_args(a, &["v", "component"])?;
                if a.get("v").and_then(Value::as_f64) != Some(1.0) {
                    return Err(KeydError::new(
                        ErrorCode::UnsupportedVersion,
                        "keyd speaks protocol 1 only",
                    ));
                }
                str_arg(a, "component", 64)?;
                let mut r = obj! { "v" => KEYD_PROTOCOL_VERSION };
                r.extend(self.status());
                done(r)
            }
            "status" => {
                no_extra_args(a, &[])?;
                done(self.status())
            }
            "sign" => {
                no_extra_args(a, &["msg"])?;
                let msg = hex_arg(a, "msg", HexBounds::min(1))?;
                let purpose = check_sign(&msg, &self.pub_hex, BOX_SIGN_PURPOSES)?;
                let sig = self.stk()?.sign(&msg);
                Ok(Handled {
                    result: obj! { "sig" => to_hex(&sig.to_bytes()) },
                    purpose: Some(purpose),
                })
            }
            "unseal" => {
                no_extra_args(a, &["blob"])?;
                let blob = hex_arg(a, "blob", HexBounds::range(44, 1024 * 1024))?;
                let plain = open_sealed(&blob, self.stk()?)
                    .map_err(|_| KeydError::failed("could not open the blob"))?;
                done(obj! { "plain" => to_hex(&plain) })
            }
            "swk.hkdf" => {
                // Only the labels the box derives; a compromised daemon cannot choose its own subkey.
                no_extra_args(a, &["salt", "info"])?;
                let info = str_arg(a, "info", 128)?;
                if !SWK_DERIVE_LABELS.contains(&info) {
                    return Err(KeydError::forbidden("that derivation label is not allowed"));
                }
                let salt = hex_arg(a, "salt", HexBounds::max(512))?;
                done(obj! { "key" => to_hex(hkdf32(self.swk()?, &salt, info.as_bytes()).as_ref()) })
            }
            "swk.seal" => {
                let pt = Self::bulk(a, "pt")?;
                let key = hkdf32(self.swk()?, &[], b"flagship.llm.v1");
                let (nonce, ct) =
                    gcm_seal(&key, &pt).map_err(|_| KeydError::failed("internal error"))?;
                done(obj! { "ciphertext" => to_hex(&ct), "nonce" => to_hex(&nonce) })
            }
            "swk.open" => {
                no_extra_args(a, &["ciphertext", "nonce"])?;
                let ct = hex_arg(a, "ciphertext", HexBounds::range(16, BULK))?;
                let nonce = hex_arg(a, "nonce", HexBounds::exact(12))?;
                let key = hkdf32(self.swk()?, &[], b"flagship.llm.v1");
                let pt = gcm_open(&key, &nonce, &ct).map_err(|_| auth_failed())?;
                done(obj! { "pt" => to_hex(&pt) })
            }
            "swk.encryptChunk" => {
                let pt = Self::bulk(a, "pt")?;
                let content_hash = sha256(&pt);
                let key = hkdf32(self.swk()?, &content_hash, b"flagship.chunk.v1");
                let (nonce, ct) =
                    gcm_seal(&key, &pt).map_err(|_| KeydError::failed("internal error"))?;
                done(
                    obj! { "ciphertext" => to_hex(&ct), "nonce" => to_hex(&nonce), "contentHash" => to_hex(&content_hash) },
                )
            }
            "swk.decryptChunk" => {
                no_extra_args(a, &["ciphertext", "nonce", "contentHash"])?;
                let ct = hex_arg(a, "ciphertext", HexBounds::range(16, BULK))?;
                let nonce = hex_arg(a, "nonce", HexBounds::exact(12))?;
                let content_hash = hex_arg(a, "contentHash", HexBounds::exact(32))?;
                let key = hkdf32(self.swk()?, &content_hash, b"flagship.chunk.v1");
                let pt = gcm_open(&key, &nonce, &ct).map_err(|_| auth_failed())?;
                done(obj! { "pt" => to_hex(&pt) })
            }
            "swk.deriveServiceSecret" => {
                no_extra_args(a, &["serviceId"])?;
                let swk = self.swk()?;
                let id = str_arg(a, "serviceId", 200)?;
                done(
                    obj! { "secret" => to_hex(hkdf32(swk, id.as_bytes(), b"flagship.app-secret.v1").as_ref()) },
                )
            }
            "swk.deriveTlsKey" => {
                no_extra_args(a, &["serverId"])?;
                let id = str_arg(a, "serverId", 253)?;
                done(
                    obj! { "key" => to_hex(hkdf32(self.swk()?, id.as_bytes(), b"flagship.tls.v1").as_ref()) },
                )
            }
            "swk.deriveBackupManifestKey" => {
                no_extra_args(a, &[])?;
                done(
                    obj! { "key" => to_hex(hkdf32(self.swk()?, &[], b"flagship.pb-manifest.v1").as_ref()) },
                )
            }
            "cgk.seal" => {
                let pt = Self::bulk(a, "pt")?;
                let (nonce, ct) =
                    gcm_seal(self.cgk()?, &pt).map_err(|_| KeydError::failed("internal error"))?;
                done(obj! { "blob" => to_hex(&[&nonce[..], &ct].concat()) })
            }
            "cgk.open" => {
                let blob = Self::bulk(a, "blob")?;
                let cgk = self.cgk()?;
                let (nonce, ct) = blob.split_at_checked(12).ok_or_else(auth_failed)?;
                let pt = gcm_open(cgk, nonce, ct).map_err(|_| auth_failed())?;
                done(obj! { "pt" => to_hex(&pt) })
            }
            "cgk.deriveAppCopyEnvKey" => {
                no_extra_args(a, &["info"])?;
                let info = hex_arg(a, "info", HexBounds::range(1, 512))?;
                // TextDecoder drops one leading BOM before the prefix check; the HKDF input keeps it.
                let text = info.strip_prefix(&[0xef, 0xbb, 0xbf][..]).unwrap_or(&info);
                if !text.starts_with(APP_COPY_ENV_PREFIX) {
                    return Err(KeydError::forbidden(
                        "app-copy env key info must be purpose-tagged",
                    ));
                }
                done(obj! { "key" => to_hex(hkdf32(self.cgk()?, &[], &info).as_ref()) })
            }
            "tls.createKey" => {
                no_extra_args(a, &["names"])?;
                let names = string_list(a.get("names"))?;
                let (handle, spki) = self.tls_mut()?.create_key(&names)?;
                done(obj! { "handle" => handle, "spki" => spki })
            }
            "tls.csr" => {
                no_extra_args(a, &["handle"])?;
                let tls = self.tls()?;
                done(obj! { "csr" => to_hex(&tls.csr(str_arg(a, "handle", 32)?)?) })
            }
            "tls.install" => {
                no_extra_args(a, &["handle", "chain"])?;
                let chain = pem_arg(a, "chain", PEM_MAX)?;
                let tls = self.tls_mut()?;
                let (not_before, not_after, names) =
                    tls.install(str_arg(a, "handle", 32)?, chain)?;
                done(obj! { "notBefore" => not_before, "notAfter" => not_after, "names" => names })
            }
            "tls.activate" => {
                no_extra_args(a, &["handle"])?;
                let tls = self.tls_mut()?;
                tls.activate(str_arg(a, "handle", 32)?)?;
                done(obj! { "active" => true })
            }
            "tls.active" => {
                no_extra_args(a, &[])?;
                done(obj! { "active" => self.tls()?.active() })
            }
            "tls.sign" => {
                no_extra_args(a, &["handle", "digest"])?;
                let digest = hex_arg(a, "digest", HexBounds::range(32, 48))?;
                let tls = self.tls()?;
                done(obj! { "sig" => to_hex(&tls.sign(str_arg(a, "handle", 32)?, &digest)?) })
            }
            "tls.list" => {
                no_extra_args(a, &[])?;
                let tls = self.tls()?;
                done(obj! { "keys" => tls.list(), "allowedNames" => tls.names() })
            }
            "tls.remove" => {
                no_extra_args(a, &["handle"])?;
                let tls = self.tls_mut()?;
                tls.remove(str_arg(a, "handle", 32)?)?;
                done(obj! { "removed" => true })
            }
            "acme.create" => {
                no_extra_args(a, &[])?;
                self.acme_mut()?.create()?;
                done(obj! { "jwk" => self.acme()?.jwk()? })
            }
            "acme.importGranted" => {
                // The owner sealed the account key to this box's identity; keyd opens it and keeps it.
                no_extra_args(a, &["blob"])?;
                let blob = hex_arg(a, "blob", HexBounds::range(44, 64 * 1024))?;
                let plain = open_sealed(&blob, self.stk()?)
                    .map_err(|_| KeydError::failed("could not open the granted account key"))?;
                let pem = Zeroizing::new(String::from_utf8_lossy(&plain).into_owned());
                self.acme_mut()?.import_pem(&pem)?;
                done(obj! { "jwk" => self.acme()?.jwk()? })
            }
            "acme.jwk" => {
                no_extra_args(a, &[])?;
                let acct = self.acme()?;
                let mut r = obj! { "present" => acct.present() };
                if acct.present() {
                    r.insert("jwk".into(), acct.jwk()?);
                    r.insert("thumbprint".into(), Value::from(acct.thumbprint()?));
                }
                done(r)
            }
            "acme.sign" => {
                no_extra_args(
                    a,
                    &[
                        "kind",
                        "url",
                        "nonce",
                        "kid",
                        "contact",
                        "names",
                        "handle",
                        "certificate",
                        "reason",
                    ],
                )?;
                let req = acme_request(a)?;
                let acct = self.acme()?;
                let tls = self.tls()?;
                done(acct.sign(&req, tls)?)
            }
            "provision.swk" | "provision.cgk" => {
                no_extra_args(a, &["key"])?;
                let which = if op == "provision.swk" { "swk" } else { "cgk" };
                let key = key32(&Zeroizing::new(hex_arg(a, "key", HexBounds::exact(32))?));
                let current = if which == "swk" { &self.swk } else { &self.cgk };
                // A key is provisioned once. Replacing one is a restore or replacement workflow
                // (a new keyd state), never a request over the socket.
                if let Some(cur) = current {
                    if cur.as_ref() == key.as_ref() {
                        return done(obj! { "stored" => false, "already" => true });
                    }
                    return Err(KeydError::forbidden(format!(
                        "{which} is already provisioned"
                    )));
                }
                if let Some(dir) = &self.store {
                    save_key_file(dir, which, &key)
                        .map_err(|_| KeydError::failed("internal error"))?;
                }
                if which == "swk" {
                    self.swk = Some(key);
                } else {
                    self.cgk = Some(key);
                }
                done(obj! { "stored" => true })
            }
            _ => Err(KeydError::new(ErrorCode::UnknownOp, "unknown operation")),
        }
    }
}

/// The ACME request named by `kind`, with `service.ts`'s argument checks in its order.
fn acme_request(a: &Args) -> KeydResult<AcmeRequest> {
    let kind = str_arg(a, "kind", 24)?;
    let url = str_arg(a, "url", 512)?.to_owned();
    let nonce = str_arg(a, "nonce", 128)?.to_owned();
    let kid = || str_arg(a, "kid", 512).map(str::to_owned);
    Ok(match kind {
        "newAccount" => AcmeRequest::NewAccount {
            url,
            nonce,
            contact: str_arg(a, "contact", 256)?.to_owned(),
        },
        "newOrder" => {
            let names = string_list(a.get("names"))?;
            AcmeRequest::NewOrder {
                url,
                nonce,
                kid: kid()?,
                names,
            }
        }
        "postAsGet" => AcmeRequest::PostAsGet {
            url,
            nonce,
            kid: kid()?,
        },
        "challenge" => AcmeRequest::Challenge {
            url,
            nonce,
            kid: kid()?,
        },
        "finalize" => {
            let kid = kid()?;
            AcmeRequest::Finalize {
                url,
                nonce,
                kid,
                handle: str_arg(a, "handle", 32)?.to_owned(),
            }
        }
        "revoke" => {
            let kid = kid()?;
            let certificate_der = hex_arg(a, "certificate", HexBounds::range(64, 16 * 1024))?;
            let reason = a.get("reason").and_then(Value::as_f64).unwrap_or(0.0);
            AcmeRequest::Revoke {
                url,
                nonce,
                kid,
                certificate_der,
                reason,
            }
        }
        _ => return Err(KeydError::bad_request("unknown ACME request kind")),
    })
}
