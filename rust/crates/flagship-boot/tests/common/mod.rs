//! Test doubles: an in-process boot worker that applies the gate's rules
//! (signature, binding, ±5 min freshness, single-use nonce) and the routes'
//! behaviour, a fake clock, and fixed randomness.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic,
    missing_debug_implementations
)]

use flagship_boot::canonical::{self, RequestRefusal};
use flagship_boot::gohex;
use flagship_boot::seal;
use flagship_boot::unlock::flow::{Clock, Random, Wake};
use flagship_boot::unlock::transport::{HttpResponse, Method, Transport};
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

pub const DOMAIN: &str = "home.alice.flagship.services";
pub const SEED_A: [u8; 32] = [0x0b; 32];
pub const SEED_B: [u8; 32] = [0x0c; 32];
pub const OWNER_SEED: [u8; 32] = [0x07; 32];
pub const LEASE_EXPIRES: u64 = 4_000_000_000_000;

pub fn owner_pub() -> [u8; 32] {
    ed25519_dalek::SigningKey::from_bytes(&OWNER_SEED)
        .verifying_key()
        .to_bytes()
}

/// A lease body as GET /api/boot/lease returns it, signed by `signer`.
pub fn lease_body(
    domain: &str,
    stk_hex: &str,
    sealed: &[u8],
    expires: u64,
    signer: &[u8; 32],
) -> String {
    use ed25519_dalek::Signer;
    let lease_id = "00112233445566778899aabbccddeeff";
    let sealed_hex = gohex::encode(sealed);
    let canonical = format!(
        "flagship/auto-unlock-lease/v2|{domain}|{stk_hex}|{lease_id}|{sealed_hex}|1|{expires}|-1"
    );
    let sig = ed25519_dalek::SigningKey::from_bytes(signer).sign(canonical.as_bytes());
    format!(
        "{{\"serverDomain\":\"{domain}\",\"leaseId\":\"{lease_id}\",\"stkPub\":\"{stk_hex}\",\"sealedKey\":\"{sealed_hex}\",\"issuedAt\":1,\"expiresAt\":{expires},\"maxUses\":null,\"usesConsumed\":0,\"signature\":\"{}\"}}",
        gohex::encode(&sig.to_bytes())
    )
}
pub const T0: u64 = 1_760_000_000_000;

pub fn luks_key() -> Vec<u8> {
    (0..64u32).map(|i| (i * 13 + 7) as u8).collect()
}

pub fn xpub(seed: &[u8; 32]) -> [u8; 32] {
    seal::x25519_public_from_ed25519_seed(seed).unwrap()
}

/// Seals a reply for a request nonce.
pub type BuildReply = Rc<dyn Fn(&str) -> Vec<u8>>;

/// How the worker answers response polls.
#[derive(Clone)]
pub enum Reply {
    /// Never (404 forever).
    Never,
    /// After `after` 404s, a reply sealed by `build(request_nonce_hex)`.
    After { after: u32, build: BuildReply },
    /// After `after` 404s, a 200 with no sealed payload.
    Empty { after: u32 },
    /// After `after` 404s, a v2 reply sealed to the last request's reply key and signed by the
    /// owner's hybrid key (`OWNER_SEED`, `OWNER_PQ_SEED`).
    V2 { after: u32 },
}

/// The owner's ML-DSA seed beside `OWNER_SEED`.
pub const OWNER_PQ_SEED: [u8; 32] = [0x17; 32];
/// The boot key's ML-DSA seed beside `SEED_A`.
pub const BOOT_PQ_SEED: [u8; 32] = [0x1b; 32];

/// The owner's hybrid public key.
pub fn owner_pq() -> Vec<u8> {
    flagship_crypto::HybridSigningKey::from_seeds(&OWNER_SEED, &OWNER_PQ_SEED)
        .unwrap()
        .verifying_key()
        .as_bytes()
        .to_vec()
}

/// A v2 reply as the phone builds it (bootUnlockV2.ts `buildBootReplyV2`).
pub fn v2_reply(nonce_hex: &str, reply_pub_hex: &str, issued_at: u64) -> Vec<u8> {
    use flagship_crypto::seal::{HybridSealPublicKey, SealOptions};
    use sha2::Digest;
    let owner = flagship_crypto::HybridSigningKey::from_seeds(&OWNER_SEED, &OWNER_PQ_SEED).unwrap();
    let boot = flagship_boot::identity::BoxIdentity::from_seed(&SEED_A)
        .pub_hex()
        .to_owned();
    let pk =
        HybridSealPublicKey::from_bytes(&gohex::decode(reply_pub_hex.as_bytes()).unwrap()).unwrap();
    let key = luks_key();
    let stmt = [
        "flagship/boot-reply/v2",
        DOMAIN,
        &boot,
        "unlock-key",
        nonce_hex,
        &gohex::encode(&flagship_crypto::key_id(
            flagship_protocol::SuiteId::HybridSealV1,
            pk.as_bytes(),
        )),
        &gohex::encode(&sha2::Sha512::digest(&key)),
        &issued_at.to_string(),
    ]
    .join("|");
    let sig = owner
        .sign("flagship/boot-reply/v2", stmt.as_bytes())
        .unwrap();
    let mut pt = u16::try_from(key.len()).unwrap().to_be_bytes().to_vec();
    pt.extend_from_slice(&key);
    pt.extend_from_slice(&sig);
    let nonce: [u8; 32] = gohex::decode(nonce_hex.as_bytes())
        .unwrap()
        .try_into()
        .unwrap();
    let opts = SealOptions {
        purpose: "flagship/boot-reply/v2",
        sender_key_id: flagship_crypto::key_id(
            flagship_protocol::SuiteId::HybridSigEd25519MlDsa65V1,
            owner.verifying_key().as_bytes(),
        ),
        issued_at,
        expires_at: None,
        installation_id: None,
        authority_generation: None,
        session_nonce: Some(nonce),
        policy_digest: None,
    };
    let boot_bytes = gohex::decode(boot.as_bytes()).unwrap();
    let ctx: [&[u8]; 4] = [DOMAIN.as_bytes(), &boot_bytes, b"unlock-key", &nonce];
    flagship_crypto::seal::seal(&pk, &opts, &ctx, &pt).unwrap()
}

pub struct Worker {
    pub now: Rc<Cell<u64>>,
    pub stk_hex: String,
    pub lease: Option<Vec<u8>>,
    pub lease_signer: [u8; 32],
    pub lease_stk_hex: Option<String>,
    pub lease_expires: u64,
    pub suspended: bool,
    pub post_status: u16,
    pub refuse_posts: u32,
    pub posts: u32,
    pub reply: Reply,
    pub next_reply: Option<Reply>,
    pub nonces: Vec<String>,
    pub seen: HashSet<String>,
    pub calls: Vec<(Method, String)>,
    pub bodies: Vec<String>,
    pub request_nonce: Option<String>,
    pub polls: u32,
    pub refusals: Vec<String>,
    pub fail_transport_on_poll: Vec<u32>,
}

impl Worker {
    pub fn new(now: Rc<Cell<u64>>) -> Self {
        Self {
            now,
            stk_hex: flagship_boot::identity::BoxIdentity::from_seed(&SEED_A)
                .pub_hex()
                .to_owned(),
            lease: None,
            lease_signer: OWNER_SEED,
            lease_stk_hex: None,
            lease_expires: LEASE_EXPIRES,
            suspended: false,
            post_status: 200,
            refuse_posts: 0,
            posts: 0,
            reply: Reply::Never,
            next_reply: None,
            nonces: Vec::new(),
            seen: HashSet::new(),
            calls: Vec::new(),
            bodies: Vec::new(),
            request_nonce: None,
            polls: 0,
            refusals: Vec::new(),
            fail_transport_on_poll: Vec::new(),
        }
    }

    fn deny(&mut self, status: u16, why: &str) -> HttpResponse {
        self.refusals.push(why.to_owned());
        HttpResponse {
            status,
            body: format!("{{\"error\":\"{why}\"}}").into_bytes(),
        }
    }

    pub fn handle(
        &mut self,
        method: Method,
        url: &str,
        auth: &str,
        body: Option<&str>,
    ) -> Result<HttpResponse, String> {
        let path = url
            .split_once("://")
            .map(|(_, r)| &r[r.find('/').unwrap()..])
            .unwrap()
            .to_owned();
        self.calls.push((method, path.clone()));
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let domain = match parts.as_slice() {
            ["api", "boot", "lease", d] => (*d).to_owned(),
            ["api", "boot", "response", d, _] => (*d).to_owned(),
            ["api", "boot", "request"] => {
                let v: serde_json::Value = serde_json::from_str(body.unwrap_or("{}")).unwrap();
                v["request"]["serverDomain"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()
            }
            _ => {
                return Ok(HttpResponse {
                    status: 404,
                    body: b"{\"error\":\"not found\"}".to_vec(),
                });
            }
        };
        let stk = self.stk_hex.clone();
        match canonical::verify_box_auth(
            auth,
            &stk,
            &domain,
            method.as_str(),
            &path,
            self.now.get(),
        ) {
            Ok(env) => {
                if !self.seen.insert(env.nonce_hex.clone()) {
                    return Ok(self.deny(403, "replayed nonce"));
                }
            }
            Err(RequestRefusal::Stale) => return Ok(self.deny(403, "stale request")),
            Err(RequestRefusal::WrongKey) => {
                return Ok(self.deny(403, "box STK not bound to this server"));
            }
            Err(e) => return Ok(self.deny(403, &format!("{e:?}"))),
        }
        match parts.as_slice() {
            ["api", "boot", "lease", _] => {
                if self.suspended {
                    return Ok(HttpResponse {
                        status: 423,
                        body: b"{\"error\":\"suspended\",\"suspended\":true}".to_vec(),
                    });
                }
                Ok(match &self.lease {
                    Some(l) => HttpResponse {
                        status: 200,
                        body: lease_body(
                            &domain,
                            self.lease_stk_hex.as_deref().unwrap_or(&stk),
                            l,
                            self.lease_expires,
                            &self.lease_signer,
                        )
                        .into_bytes(),
                    },
                    None => HttpResponse {
                        status: 404,
                        body: b"{\"error\":\"no active lease\"}".to_vec(),
                    },
                })
            }
            ["api", "boot", "request"] => {
                let b = body.unwrap_or_default();
                let v: serde_json::Value = serde_json::from_str(b).unwrap();
                let r = &v["request"];
                let ok = canonical::verify_secret_request(
                    r["serverDomain"].as_str().unwrap(),
                    r["stkPub"].as_str().unwrap(),
                    r["purpose"].as_str().unwrap(),
                    r["nonce"].as_str().unwrap(),
                    r["issuedAt"].as_u64().unwrap(),
                    v["signature"].as_str().unwrap(),
                );
                if !ok || r["stkPub"].as_str() != Some(stk.as_str()) {
                    return Ok(self.deny(403, "invalid request signature"));
                }
                self.bodies.push(b.to_owned());
                let n = r["nonce"].as_str().unwrap().to_owned();
                if self.nonces.last() != Some(&n) {
                    self.nonces.push(n.clone());
                }
                self.request_nonce = Some(n);
                self.posts += 1;
                Ok(HttpResponse {
                    status: if self.posts <= self.refuse_posts {
                        403
                    } else {
                        self.post_status
                    },
                    body: b"{\"ok\":true}".to_vec(),
                })
            }
            ["api", "boot", "response", _, nonce] => {
                self.polls += 1;
                if self.fail_transport_on_poll.contains(&self.polls) {
                    return Err("connection reset".into());
                }
                let nonce = (*nonce).to_owned();
                let none = HttpResponse {
                    status: 404,
                    body: b"{\"error\":\"no reply ready\"}".to_vec(),
                };
                match self.reply.clone() {
                    Reply::Never => Ok(none),
                    Reply::Empty { after } if self.polls > after => Ok(HttpResponse {
                        status: 200,
                        body: b"{\"serverDomain\":\"x\",\"sealed\":\"\"}".to_vec(),
                    }),
                    Reply::V2 { after } if self.polls > after => {
                        let last: serde_json::Value =
                            serde_json::from_str(self.bodies.last().unwrap()).unwrap();
                        let reply_pub = last["pq"]["replyKemPubHex"].as_str().unwrap().to_owned();
                        self.reply = self.next_reply.take().unwrap_or(Reply::Never);
                        self.polls = 0;
                        Ok(HttpResponse {
                            status: 200,
                            body: format!(
                                "{{\"serverDomain\":\"{domain}\",\"requestNonceHex\":\"{nonce}\",\"purpose\":\"unlock-key\",\"sealed\":\"{}\",\"issuedAt\":5}}",
                                gohex::encode(&v2_reply(&nonce, &reply_pub, 5))
                            )
                            .into_bytes(),
                        })
                    }
                    Reply::After { after, build } if self.polls > after => {
                        self.reply = self.next_reply.take().unwrap_or(Reply::Never);
                        self.polls = 0;
                        Ok(HttpResponse {
                            status: 200,
                            body: format!(
                                "{{\"serverDomain\":\"{domain}\",\"requestNonceHex\":\"{nonce}\",\"purpose\":\"unlock-key\",\"sealed\":\"{}\",\"issuedAt\":5}}",
                                gohex::encode(&build(&nonce))
                            )
                            .into_bytes(),
                        })
                    }
                    _ => Ok(none),
                }
            }
            _ => unreachable!(),
        }
    }
}

pub struct MockTransport(pub RefCell<Worker>);

impl Transport for MockTransport {
    fn send(
        &self,
        method: Method,
        url: &str,
        authorization: &str,
        json_body: Option<&str>,
    ) -> Result<HttpResponse, String> {
        self.0
            .borrow_mut()
            .handle(method, url, authorization, json_body)
    }
}

pub struct FakeClock {
    pub now: Rc<Cell<u64>>,
    pub waits: RefCell<Vec<u64>>,
    pub manual_on_wait: Option<usize>,
}

impl FakeClock {
    pub fn new(now: Rc<Cell<u64>>) -> Self {
        Self {
            now,
            waits: RefCell::new(Vec::new()),
            manual_on_wait: None,
        }
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> u64 {
        self.now.get()
    }
    fn now_secs(&self) -> u64 {
        self.now.get() / 1000
    }
    fn wait(&self, secs: u64) -> Wake {
        self.waits.borrow_mut().push(secs);
        if self.manual_on_wait == Some(self.waits.borrow().len()) {
            return Wake::Manual;
        }
        self.now.set(self.now.get() + secs * 1000);
        Wake::Elapsed
    }
}

/// Distinct nonces 1, 2, 3, ... (fixed so runs are reproducible).
pub struct CountingRandom(pub Cell<u8>);

impl Random for CountingRandom {
    fn nonce32(&self) -> Result<[u8; 32], String> {
        self.0.set(self.0.get().wrapping_add(1));
        Ok([self.0.get(); 32])
    }
}
