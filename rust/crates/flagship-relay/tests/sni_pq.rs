//! SNI extraction from real rustls ClientHellos offering X25519MLKEM768, split at every TCP
//! boundary and fragmented across TLS records.
//!
//! rustls' ring provider has no ML-KEM, so the hybrid group here is a stand-in that puts a
//! 1184-byte ML-KEM-768 encapsulation-key-sized share in front of a real X25519 share, exactly
//! the 1216-byte layout of draft-ietf-tls-ecdhe-mlkem. rustls frames the hello itself (both
//! key shares, extension order, record fragmentation), which is all the SNI parser sees.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use std::sync::Arc;

use flagship_relay::sni::{
    ClientHelloReader, SniLimits, SniStatus, parse_client_hello, parse_client_hello_ts_compat,
};
use rustls::crypto::{ActiveKeyExchange, CryptoProvider, SharedSecret, SupportedKxGroup};
use rustls::{ClientConfig, ClientConnection, NamedGroup, RootCertStore};

const MLKEM768_EK: usize = 1184;

#[derive(Debug)]
struct HybridStandIn;

struct ActiveHybrid {
    classical: Box<dyn ActiveKeyExchange>,
    share: Vec<u8>,
}

impl SupportedKxGroup for HybridStandIn {
    fn start(&self) -> Result<Box<dyn ActiveKeyExchange>, rustls::Error> {
        let classical = rustls::crypto::ring::kx_group::X25519.start()?;
        let mut share: Vec<u8> = (0..MLKEM768_EK).map(|i| (i * 31 + 7) as u8).collect();
        share.extend_from_slice(classical.pub_key());
        Ok(Box::new(ActiveHybrid { classical, share }))
    }
    fn name(&self) -> NamedGroup {
        NamedGroup::X25519MLKEM768
    }
}

impl ActiveKeyExchange for ActiveHybrid {
    fn complete(self: Box<Self>, _peer: &[u8]) -> Result<SharedSecret, rustls::Error> {
        Err(rustls::Error::General(
            "stand-in group never completes".into(),
        ))
    }
    fn hybrid_component(&self) -> Option<(NamedGroup, &[u8])> {
        Some((NamedGroup::X25519, self.classical.pub_key()))
    }
    fn complete_hybrid_component(
        self: Box<Self>,
        peer: &[u8],
    ) -> Result<SharedSecret, rustls::Error> {
        self.classical.complete(peer)
    }
    fn pub_key(&self) -> &[u8] {
        &self.share
    }
    fn group(&self) -> NamedGroup {
        NamedGroup::X25519MLKEM768
    }
}

static HYBRID: HybridStandIn = HybridStandIn;

fn client_hello(sni: &str, max_fragment: Option<usize>, pq: bool) -> Vec<u8> {
    let mut provider = rustls::crypto::ring::default_provider();
    if pq {
        provider.kx_groups.insert(0, &HYBRID);
    }
    let mut cfg = ClientConfig::builder_with_provider(Arc::new(provider) as Arc<CryptoProvider>)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .unwrap()
        .with_root_certificates(RootCertStore::empty())
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    cfg.max_fragment_size = max_fragment;
    let mut conn =
        ClientConnection::new(Arc::new(cfg), sni.to_owned().try_into().unwrap()).unwrap();
    let mut out = Vec::new();
    while conn.wants_write() {
        conn.write_tls(&mut out).unwrap();
    }
    out
}

/// Record layout and the key-share groups/lengths the hello offers.
fn anatomy(raw: &[u8]) -> (usize, Vec<(u16, usize)>) {
    let mut hs = Vec::new();
    let mut p = 0;
    let mut records = 0;
    while p + 5 <= raw.len() {
        let len = usize::from(u16::from_be_bytes([raw[p + 3], raw[p + 4]]));
        hs.extend_from_slice(&raw[p + 5..p + 5 + len]);
        p += 5 + len;
        records += 1;
    }
    let body = &hs[4..];
    let mut q = 34;
    q += 1 + usize::from(body[q]);
    q += 2 + usize::from(u16::from_be_bytes([body[q], body[q + 1]]));
    q += 1 + usize::from(body[q]);
    let end = q + 2 + usize::from(u16::from_be_bytes([body[q], body[q + 1]]));
    q += 2;
    let mut shares = Vec::new();
    while q + 4 <= end {
        let ty = u16::from_be_bytes([body[q], body[q + 1]]);
        let len = usize::from(u16::from_be_bytes([body[q + 2], body[q + 3]]));
        if ty == 51 {
            let mut k = q + 6;
            while k + 4 <= q + 4 + len {
                let g = u16::from_be_bytes([body[k], body[k + 1]]);
                let l = usize::from(u16::from_be_bytes([body[k + 2], body[k + 3]]));
                shares.push((g, l));
                k += 4 + l;
            }
        }
        q += 4 + len;
    }
    (records, shares)
}

fn expect_done(st: &SniStatus, sni: &str, records: usize, what: &str) {
    match st {
        SniStatus::Done(i) => {
            assert_eq!(i.sni.as_deref(), Some(sni), "{what}");
            assert_eq!(i.records, records, "{what}");
        }
        other => panic!("{what}: {other:?}"),
    }
}

/// Every prefix is "need more" (never a rejection), and every 2-way split, byte-at-a-time
/// feed and the one-shot parse all agree.
fn check_all_boundaries(raw: &[u8], sni: &str, records: usize) {
    let l = SniLimits::default();
    for k in 0..raw.len() {
        match parse_client_hello(&raw[..k], l) {
            SniStatus::NeedMore(n) => assert!(n > k && n <= raw.len(), "prefix {k}: need {n}"),
            other => panic!("prefix {k} of {}: {other:?}", raw.len()),
        }
    }
    expect_done(&parse_client_hello(raw, l), sni, records, "one shot");
    for k in 1..raw.len() {
        let mut r = ClientHelloReader::new(l);
        assert!(
            matches!(r.push(&raw[..k]), SniStatus::NeedMore(_)),
            "split {k}"
        );
        expect_done(r.push(&raw[k..]), sni, records, &format!("split at {k}"));
        assert_eq!(r.raw(), raw);
    }
    let mut r = ClientHelloReader::new(l);
    for b in &raw[..raw.len() - 1] {
        assert!(matches!(
            r.push(std::slice::from_ref(b)),
            SniStatus::NeedMore(_)
        ));
    }
    expect_done(
        r.push(&raw[raw.len() - 1..]),
        sni,
        records,
        "byte at a time",
    );
}

const NAME: &str = "Chess.Home.Alice.flagship.services";

#[test]
fn pq_hello_single_record_every_tcp_boundary() {
    let raw = client_hello(NAME, None, true);
    let (records, shares) = anatomy(&raw);
    assert_eq!(records, 1);
    assert!(shares.contains(&(0x11ec, 1216)), "{shares:?}");
    assert!(shares.contains(&(0x001d, 32)), "{shares:?}");
    assert!(
        raw.len() > 1460,
        "the PQ hello must exceed one Ethernet MSS ({} bytes)",
        raw.len()
    );
    check_all_boundaries(&raw, &NAME.to_lowercase(), 1);
    expect_done(
        &parse_client_hello_ts_compat(&raw),
        &NAME.to_lowercase(),
        1,
        "ts compat agrees on one record",
    );
}

#[test]
fn classical_hello_matches_ts_compat_on_every_prefix() {
    let raw = client_hello("home.alice.flagship.services", None, false);
    for k in 0..=raw.len() {
        assert_eq!(
            parse_client_hello(&raw[..k], SniLimits::default()),
            parse_client_hello_ts_compat(&raw[..k]),
            "prefix {k}"
        );
    }
}

#[test]
fn pq_hello_fragmented_across_records() {
    for frag in [32usize, 64, 100, 512, 1000, 1400] {
        let raw = client_hello(NAME, Some(frag), true);
        let (records, shares) = anatomy(&raw);
        assert!(records > 1, "fragment {frag}");
        assert!(shares.contains(&(0x11ec, 1216)));
        check_all_boundaries(&raw, &NAME.to_lowercase(), records);
        assert_eq!(
            parse_client_hello_ts_compat(&raw),
            SniStatus::Reject("handshake length exceeds record"),
            "sni.ts cannot reassemble a hello split at {frag}-byte records"
        );
    }
}

/// Re-frame a hello into records of at most `rec` bytes, with a padding extension (type 21)
/// of `pad` bytes appended (RFC 7685), to reach sizes no current client sends.
fn reframe_with_padding(raw: &[u8], pad: usize, rec: usize) -> Vec<u8> {
    let len = usize::from(u16::from_be_bytes([raw[3], raw[4]]));
    let hs = &raw[5..5 + len];
    let mut body = hs[4..].to_vec();
    let mut q = 34;
    q += 1 + usize::from(body[q]);
    q += 2 + usize::from(u16::from_be_bytes([body[q], body[q + 1]]));
    q += 1 + usize::from(body[q]);
    let exts = usize::from(u16::from_be_bytes([body[q], body[q + 1]])) + 4 + pad;
    body[q..q + 2].copy_from_slice(&(exts as u16).to_be_bytes());
    body.extend_from_slice(&[0, 21]);
    body.extend_from_slice(&(pad as u16).to_be_bytes());
    body.extend(std::iter::repeat_n(0u8, pad));
    let mut msg = vec![1u8];
    msg.extend_from_slice(&(body.len() as u32).to_be_bytes()[1..]);
    msg.extend(body);
    let mut out = Vec::new();
    for c in msg.chunks(rec) {
        out.extend_from_slice(&[0x16, 3, 1]);
        out.extend_from_slice(&(c.len() as u16).to_be_bytes());
        out.extend_from_slice(c);
    }
    out
}

#[test]
fn oversized_hello_spans_two_full_records() {
    let raw = reframe_with_padding(&client_hello(NAME, None, true), 18_000, 16_384);
    let (records, _) = anatomy(&raw);
    assert_eq!(records, 2);
    expect_done(
        &parse_client_hello(&raw, SniLimits::default()),
        &NAME.to_lowercase(),
        2,
        "20 KB hello",
    );
    assert!(matches!(
        parse_client_hello_ts_compat(&raw),
        SniStatus::Reject(_)
    ));
}

#[test]
fn limits_bound_memory_and_records() {
    let raw = reframe_with_padding(&client_hello(NAME, None, true), 18_000, 16_384);
    let small = SniLimits {
        max_raw_bytes: 16 * 1024,
        ..SniLimits::default()
    };
    assert_eq!(
        parse_client_hello(&raw, small),
        SniStatus::Reject("ClientHello exceeds the peek limit")
    );
    let tight = SniLimits {
        max_hello_len: 4096,
        ..SniLimits::default()
    };
    assert_eq!(
        parse_client_hello(&raw, tight),
        SniStatus::Reject("ClientHello exceeds the size limit")
    );
    let tiny = client_hello(NAME, Some(32), true);
    let few = SniLimits {
        max_records: 8,
        ..SniLimits::default()
    };
    assert_eq!(
        parse_client_hello(&tiny, few),
        SniStatus::Reject("ClientHello spans too many records")
    );
}

#[test]
fn non_handshake_record_between_fragments_is_rejected() {
    let raw = client_hello(NAME, Some(512), true);
    let first = 5 + usize::from(u16::from_be_bytes([raw[3], raw[4]]));
    let mut bad = raw[..first].to_vec();
    bad.extend_from_slice(&[0x15, 3, 3, 0, 2, 2, 40]);
    bad.extend_from_slice(&raw[first..]);
    assert_eq!(
        parse_client_hello(&bad, SniLimits::default()),
        SniStatus::Reject("not a TLS handshake record")
    );
    let mut empty = raw[..first].to_vec();
    empty.extend_from_slice(&[0x16, 3, 3, 0, 0]);
    assert_eq!(
        parse_client_hello(&empty, SniLimits::default()),
        SniStatus::Reject("empty handshake record")
    );
}

/// Writes the hellos the TS check (`tools/sni-pq-check.mjs`) runs `sni.ts` against, when
/// FLAGSHIP_WRITE_SNI_VECTORS=1; otherwise checks the committed file still parses here.
#[test]
fn ts_differential_vectors() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/tunnel-protocol/test-vectors/sni-pq-hellos.json"
    );
    if std::env::var("FLAGSHIP_WRITE_SNI_VECTORS").as_deref() == Ok("1") {
        let mut cases = Vec::new();
        let mut add = |name: &str, raw: Vec<u8>| {
            let (records, shares) = anatomy(&raw);
            cases.push(serde_json::json!({
                "name": name,
                "sni": NAME.to_lowercase(),
                "records": records,
                "bytes": raw.len(),
                "keyShares": shares.iter().map(|(g, l)| serde_json::json!({"group": g, "len": l})).collect::<Vec<_>>(),
                "hex": raw.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            }));
        };
        add(
            "rustls classical (x25519), one record",
            client_hello(NAME, None, false),
        );
        add(
            "rustls X25519MLKEM768 + X25519, one record",
            client_hello(NAME, None, true),
        );
        for f in [32usize, 512, 1400] {
            add(
                &format!("rustls X25519MLKEM768, {f}-byte records"),
                client_hello(NAME, Some(f), true),
            );
        }
        add(
            "X25519MLKEM768 padded to ~20 KB, two 16 KiB records",
            reframe_with_padding(&client_hello(NAME, None, true), 18_000, 16_384),
        );
        let doc = serde_json::json!({
            "description": "Real rustls ClientHellos (PQ hybrid share is a 1216-byte stand-in; see rust/crates/flagship-relay/tests/sni_pq.rs). Regenerate with FLAGSHIP_WRITE_SNI_VECTORS=1 cargo test -p flagship-relay --test sni_pq; check sni.ts with node tools/sni-pq-check.mjs.",
            "cases": cases,
        });
        std::fs::write(path, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
    }
    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for c in doc["cases"].as_array().unwrap() {
        let h = c["hex"].as_str().unwrap();
        let raw: Vec<u8> = (0..h.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
            .collect();
        expect_done(
            &parse_client_hello(&raw, SniLimits::default()),
            c["sni"].as_str().unwrap(),
            c["records"].as_u64().unwrap() as usize,
            c["name"].as_str().unwrap(),
        );
    }
}
