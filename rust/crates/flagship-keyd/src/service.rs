//! The operations keyd answers, an op-by-op port of `packages/keyd/src/service.ts`. The order
//! of argument checks follows the TS evaluation order, so the same bad request gets the same
//! error code from either backend.

use std::path::PathBuf;

use ed25519_dalek::Signer;
use serde_json::Value;
use zeroize::Zeroizing;

use crate::acme::{AcmeAccount, AcmeRequest};
use crate::crypto::{Key32, gcm_open, gcm_seal, hkdf32, hmac_sha256, open_sealed, sha256};
use crate::files::save_key_file;
use crate::obj;
use crate::policy::{
    BOX_SIGN_PURPOSES, SWK_HKDF_LABELS, UNSEAL_PURPOSES, check_sign, check_sign_with,
    is_pairing_order, is_service_id,
};
use crate::tls::{
    TlsKeys, is_ecdhe_params, tls12_server_signed_message, tls13_server_signed_message,
};
use crate::wire::{
    Args, ErrorCode, HexBounds, KEYD_PROTOCOL_VERSION, KeydError, KeydResult, PEM_MAX, hex_arg,
    no_extra_args, pem_arg, str_arg, string_list, to_hex,
};
use flagship_crypto::HybridSigningKey;
use flagship_protocol::parse::{TagNamespace, validate_purpose_tag};

const GOSSIP_TAG: &str = "flagship/gossip/v2|";
const ACCESS_SYNC_TAG: &str = "flagship/access-sync/v1|";
const ACCESS_SYNC_KEY_INFO: &[u8] = b"flagship/access-sync/key/v1";
const MAX_MAC_BYTES: usize = 64 * 1024;
const APP_COPY_ENV_PREFIX: &[u8] = b"flagship/app-copy-env/v1|";
const BULK: usize = 3 * 1024 * 1024;

/// Where provisioned keys are written (`fileKeyStore`); `None` keeps them in memory only.
pub type KeyStoreDir = Option<PathBuf>;

pub struct KeydService {
    signing: Option<ed25519_dalek::SigningKey>,
    pub_hex: String,
    /// The STK AND its ML-DSA-65 key (`identity-mldsa.key`), for `sign.hybrid`.
    hybrid: Option<HybridSigningKey>,
    mldsa_pub_hex: Option<String>,
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
            hybrid: None,
            mldsa_pub_hex: None,
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

    /// Adds the STK's ML-DSA-65 seed (TS `pqSeed`), so `pq.status` and `sign.hybrid` answer.
    ///
    /// # Errors
    /// A message when the seeds do not make a valid hybrid key.
    pub fn with_pq_seed(mut self, pq_seed: &[u8; 32]) -> Result<Self, String> {
        let stk = Zeroizing::new(self.stk().map_err(|e| e.message)?.to_bytes());
        let key = HybridSigningKey::from_seeds(&stk, pq_seed).map_err(|e| e.to_string())?;
        let ml = key
            .verifying_key()
            .as_bytes()
            .get(32..)
            .map(to_hex)
            .ok_or("bad hybrid key")?;
        self.mldsa_pub_hex = Some(ml);
        self.hybrid = Some(key);
        Ok(self)
    }

    /// Drop every key (each type zeroizes itself on drop).
    pub fn destroy(&mut self) {
        self.signing = None;
        self.hybrid = None;
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
    fn mldsa_pub_hex(&self) -> KeydResult<&str> {
        self.mldsa_pub_hex
            .as_deref()
            .ok_or_else(|| KeydError::not_provisioned("no ML-DSA key provisioned"))
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
            "pq.status" => {
                no_extra_args(a, &[])?;
                let ml = self.mldsa_pub_hex()?.to_owned();
                done(obj! { "publicKey" => self.pub_hex.clone(), "mldsaPublicKey" => ml })
            }
            "sign.hybrid" => {
                // The same purpose list as `sign`, signed with the STK AND its ML-DSA-65 key
                // (flagship/hybrid-sig/ed25519-mldsa65/v1, purpose = the message's own tag).
                no_extra_args(a, &["msg"])?;
                let msg = hex_arg(a, "msg", HexBounds::min(1))?;
                let ml = self.mldsa_pub_hex()?;
                let purpose = check_sign_with(&msg, &self.pub_hex, BOX_SIGN_PURPOSES, Some(ml))?;
                if validate_purpose_tag(&purpose, TagNamespace::Flagship).is_err() {
                    return Err(KeydError::forbidden("that purpose has no hybrid form"));
                }
                let key = self
                    .hybrid
                    .as_ref()
                    .ok_or_else(|| KeydError::failed("internal error"))?;
                let sig = key
                    .sign(&purpose, &msg)
                    .map_err(|_| KeydError::failed("could not sign"))?;
                Ok(Handled {
                    result: obj! { "sig" => to_hex(&sig) },
                    purpose: Some(purpose),
                })
            }
            "unseal" => {
                // Only a sealed message the daemon must read, checked by its shape once opened; a
                // sealed key never comes back out (provision.* and acme.importGranted keep those).
                no_extra_args(a, &["blob", "purpose"])?;
                let blob = hex_arg(a, "blob", HexBounds::range(44, 1024 * 1024))?;
                let purpose = str_arg(a, "purpose", 32)?;
                if !UNSEAL_PURPOSES.contains(&purpose) {
                    return Err(KeydError::forbidden(
                        "keyd opens no sealed message of that kind",
                    ));
                }
                let plain = open_sealed(&blob, self.stk()?)
                    .map_err(|_| KeydError::failed("could not open the blob"))?;
                if !is_pairing_order(&plain) {
                    return Err(KeydError::forbidden(
                        "the sealed message is not a pairing order",
                    ));
                }
                done(obj! { "plain" => to_hex(&plain) })
            }
            "swk.hkdf" => {
                // Only the two fixed, unsalted subkeys the daemon needs; the chunk, LLM, app-secret
                // and TLS-at-rest subkeys stay behind their own operations.
                no_extra_args(a, &["salt", "info"])?;
                let info = str_arg(a, "info", 128)?;
                if !SWK_HKDF_LABELS.contains(&info) {
                    return Err(KeydError::forbidden("that derivation label is not allowed"));
                }
                let salt = hex_arg(a, "salt", HexBounds::max(0))?;
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
                if !is_service_id(id) {
                    return Err(KeydError::bad_request(
                        "serviceId must be <creator>--<slug> or <slug>",
                    ));
                }
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
            "cgk.gossipMac" | "cgk.accessSyncMac" => {
                // Only the box's own two gossip message kinds, so the CGK is no general MAC oracle.
                no_extra_args(a, &["msg"])?;
                let msg = hex_arg(a, "msg", HexBounds::range(1, MAX_MAC_BYTES))?;
                let gossip = op == "cgk.gossipMac";
                let tag: &str = if gossip { GOSSIP_TAG } else { ACCESS_SYNC_TAG };
                if !msg.starts_with(tag.as_bytes()) {
                    return Err(KeydError::forbidden(format!(
                        "the gossip key MACs {} messages only",
                        tag.trim_end_matches('|')
                    )));
                }
                let cgk = self.cgk()?;
                let mac = if gossip {
                    hmac_sha256(cgk, &msg)
                } else {
                    hmac_sha256(hkdf32(cgk, &[], ACCESS_SYNC_KEY_INFO).as_ref(), &msg)
                };
                done(obj! { "mac" => to_hex(&mac) })
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
                // keyd builds the signed input from the TLS fields: the certificate key signs TLS
                // 1.3 CertificateVerify and TLS 1.2 ServerKeyExchange inputs and nothing else.
                let handle = str_arg(a, "handle", 32)?;
                let version = str_arg(a, "tls", 8)?;
                let message = match version {
                    "1.3" => {
                        no_extra_args(a, &["handle", "tls", "transcriptHash"])?;
                        let th = hex_arg(a, "transcriptHash", HexBounds::range(32, 48))?;
                        if th.len() != 32 && th.len() != 48 {
                            return Err(KeydError::bad_request(
                                "transcriptHash must be 32 or 48 bytes",
                            ));
                        }
                        tls13_server_signed_message(&th)
                    }
                    "1.2" => {
                        no_extra_args(
                            a,
                            &["handle", "tls", "clientRandom", "serverRandom", "params"],
                        )?;
                        let cr = hex_arg(a, "clientRandom", HexBounds::exact(32))?;
                        let sr = hex_arg(a, "serverRandom", HexBounds::exact(32))?;
                        let params = hex_arg(a, "params", HexBounds::range(4, 4 + 133))?;
                        if !is_ecdhe_params(&params) {
                            return Err(KeydError::bad_request(
                                "params must be named-curve ECDHE parameters",
                            ));
                        }
                        tls12_server_signed_message(&cr, &sr, &params)
                    }
                    _ => return Err(KeydError::bad_request("tls must be 1.3 or 1.2")),
                };
                let tls = self.tls()?;
                done(obj! { "sig" => to_hex(&tls.sign_handshake(handle, &message)?) })
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
                // `sealed`: the owner's delivery sealed to this box, opened and kept here so it never
                // passes through the daemon. `key`: a key the daemon already holds, moved in.
                no_extra_args(a, &["key", "sealed"])?;
                let which = if op == "provision.swk" { "swk" } else { "cgk" };
                if a.contains_key("key") == a.contains_key("sealed") {
                    return Err(KeydError::bad_request("give key or sealed"));
                }
                let key = if a.contains_key("sealed") {
                    let sealed = hex_arg(a, "sealed", HexBounds::range(44, 1024))?;
                    let plain = open_sealed(&sealed, self.stk()?)
                        .map_err(|_| KeydError::failed("could not open the sealed key"))?;
                    if plain.len() != 32 {
                        return Err(KeydError::failed("the sealed key is not 32 bytes"));
                    }
                    key32(&plain)
                } else {
                    key32(&Zeroizing::new(hex_arg(a, "key", HexBounds::exact(32))?))
                };
                let current = if which == "swk" { &self.swk } else { &self.cgk };
                // A key is provisioned once. Replacing one is a restore or replacement workflow
                // (a new keyd state, made offline by root), never a request over the socket.
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
